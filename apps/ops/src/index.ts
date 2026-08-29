import { createDb } from '@doge-buddy/db'
import { createGmailAuth, createGmailClient } from '@doge-buddy/gmail'
import {
  findProductByHandle,
  fulfillmentCreate,
  fulfillmentTrackingInfoUpdate,
  listPublications,
  orderFulfillmentOrders,
  orderRefundState,
  ordersUpdatedSince,
  productSet,
  productVariantsByProductId,
  publishablePublish,
  publishableUnpublish,
  refundCreate,
  ShopifyAdminClient,
  ShopifyTokenManager,
} from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient, MockSupplierAdapter, type SupplierAdapter } from '@doge-buddy/supplier'
import { sweepOrphanRuns } from './agents/lifecycle.ts'
import { createPgSessionStore } from './agents/session-store.ts'
import { createAlerter, type AlertSeverity } from './alerts.ts'
import { loadConfig } from './config.ts'
import type { ReconcileDeps } from './fulfillment/run-reconcile.ts'
import type { ShopifyFulfillmentOps } from './fulfillment/run-sync-tracking.ts'
import type { ActionRouteDeps } from './http/actions.ts'
import type { AdminDeps } from './http/admin/routes.ts'
import type { WebhookDeps } from './http/webhooks.ts'
import { cjDisputePollHandler, type DisputePollDeps } from './jobs/cj-dispute-poll.ts'
import { cjWalletMonitorHandler, type WalletMonitorDeps } from './jobs/cj-wallet-monitor.ts'
import { fulfillmentReconcileHandler } from './jobs/fulfillment-reconcile.ts'
import { proposalExpireSweepHandler } from './jobs/proposal-expire-sweep.ts'
import { scoringNightlyHandler, SCORING_NIGHTLY_QUEUE, type ScoringNightlyDeps } from './jobs/scoring-nightly.ts'
import { scoringWeeklyHandler, SCORING_WEEKLY_QUEUE, type ScoringWeeklyDeps } from './jobs/scoring-weekly-digest.ts'
import { shopifyWebhookAudit } from './jobs/shopify-webhook-audit.ts'
import { sourcingWeeklyHandler } from './jobs/sourcing-weekly.ts'
import { supportAgentRunHandler, SUPPORT_AGENT_QUEUE, type SupportAgentJobDeps } from './jobs/support-agent-run.ts'
import { supportPollGmailHandler, SUPPORT_POLL_QUEUE, type SupportPollDeps } from './jobs/support-poll-gmail.ts'
import { loadDotEnv } from './load-env.ts'
import { createNoopNotifier, type NotifyOwner } from './notify/notify.ts'
import { createTelegramNotifier } from './notify/telegram.ts'
import type { ProposalShopifyOps, RefundOps } from './proposals/run-apply.ts'
import { submitProposal, type SubmitProposalDeps } from './proposals/submit.ts'
import { runDeprecationJudge } from './scoring/judge.ts'
import { createQueueRetrying, registerCron, startQueue, type Queue } from './queue.ts'
import { buildServer } from './server.ts'
import { createSettings } from './settings.ts'
import type { SourcingPipelineDeps } from './sourcing/pipeline.ts'
import { createSerpApiTrends } from './sourcing/trends.ts'
import { DrizzleCjTokenStore } from './stores/cj-token-store.ts'
import { createAnthropicTriageCall } from './support/triage.ts'

loadDotEnv(import.meta.url)

const config = loadConfig(process.env)
const { db, pool } = createDb(config.databaseUrl, { connectionTimeoutMillis: 5000 })
const settings = createSettings(db)

const cjAdapter = config.cj
  ? new CJSupplierAdapter({
      client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
      openId: config.cj.openId,
    })
  : undefined

// FULFILLMENT_SUPPLIER picks which SupplierAdapter backs the fulfillment queues. loadConfig's
// zod schema already guarantees `config.cj` is set whenever fulfillmentSupplier is 'cj' — this
// check is a second, defense-in-depth guard in case that invariant is ever broken by a future
// change to config.ts, rather than a path expected to actually trigger today.
let supplierAdapter: SupplierAdapter
if (config.fulfillmentSupplier === 'cj') {
  if (!cjAdapter) {
    throw new Error('FULFILLMENT_SUPPLIER=cj but no CJ adapter was constructed (config.cj is missing)')
  }
  supplierAdapter = cjAdapter
} else {
  supplierAdapter = new MockSupplierAdapter()
}

// `queue` is assigned only after `app` (below) exists — `startQueue` needs `app.log` (via the
// alerter) as one of its own dependencies, so building the server has to come first. The
// webhook route's `enqueue` closes over this `let` binding rather than an already-assigned
// value; that's safe because webhook routes only ever run at request time, which is after
// `app.listen()`, which is itself after `queue` is assigned below. Same closure, same safety
// argument for the action routes' and admin routes' `enqueue` (both request-time-only consumers).
let queue: Queue

// pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
// this only forwards `opts` when the caller actually passed one.
const enqueue: WebhookDeps['enqueue'] = async (name, data, opts) => {
  if (opts) {
    await queue.boss.send(name, data, opts)
  } else {
    await queue.boss.send(name, data)
  }
}

const webhookDeps: WebhookDeps = {
  db,
  enqueue,
  ...(config.shopify ? { shopifyWebhookSecret: config.shopify.webhookSecret } : {}),
  ...(cjAdapter
    ? {
        cjVerify: (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) =>
          cjAdapter.verifyWebhook(rawBody, headers),
        cjParse: (rawBody: Buffer) => cjAdapter.parseWebhook(rawBody),
      }
    : {}),
}

// `actions` (ActionRouteDeps, Task 5) needs `alert`, but the real alerter needs `app.log` — which
// only exists once `buildServer` below has already constructed `app`. Same trick as `queue`/
// `enqueue` just above: declare a `let` for the real alerter and assign it right after `app`
// exists (see `alertImpl = createAlerter(db, app.log)` below); `alert` here is a thin closure over
// that binding. Safe for the same reason `enqueue`'s closure over `queue` is safe — action routes
// (and, likewise, admin routes below) only ever run at request time, which is after
// `app.listen()`, which is itself after `alertImpl` is assigned.
let alertImpl: ReturnType<typeof createAlerter>
const alert = (severity: AlertSeverity, kind: string, detail: Record<string, unknown>): Promise<void> =>
  alertImpl(severity, kind, detail)

const actionDeps: ActionRouteDeps = { db, enqueue, alert }

// Owner-notification seam for the proposal pipeline (Task 6): Telegram when configured, else the
// alert-and-false noop fallback (`createNoopNotifier`). Built here (rather than down by
// `shopifyOps`/`proposalShopify`, which it doesn't depend on) so it's available for `adminDeps`
// just below — its first real consumer is the admin magic-link login route (`POST /admin/login`),
// which calls `deps.notify(...)` to deliver the login link.
const notify: NotifyOwner = config.telegram
  ? createTelegramNotifier({ ...config.telegram, alert })
  : createNoopNotifier(alert)

// AdminDeps (Plan B): same db/settings/enqueue/alert bindings as actionDeps, plus `notify` (the
// magic-link login send) and `adminBaseUrl` (the login link's own host, same value actions.ts's
// one-click links already assume is reachable). `getWalletBalance` is optional on AdminDeps — the
// dashboard's health strip shows 'n/a' without it — so it's a conditional spread rather than
// `cjAdapter ? (() => cjAdapter.getBalance()) : undefined`, keeping exactOptionalPropertyTypes
// happy the same way `webhookDeps` above handles its own optional fields.
const adminDeps: AdminDeps = {
  db, settings, enqueue, alert, notify,
  adminBaseUrl: config.adminBaseUrl!,
  ...(cjAdapter ? { getWalletBalance: () => cjAdapter.getBalance() } : {}),
}

// Both `/a/:proposalId/approve|reject` (Plan A) and `/admin/...` (Plan B) are gated on
// `ADMIN_BASE_URL` per spec §7 — those links/pages are only ever generated (and only ever meant
// to be reachable) once an admin base URL is configured, same conditional-spread style as
// `webhookDeps` above. One shared gate: either both register, or neither does.
const app = buildServer({
  pool, isQueueReady: () => queue.ready(), webhooks: webhookDeps,
  ...(config.adminBaseUrl ? { actions: actionDeps, admin: adminDeps } : {}),
})

// Loud on purpose: which adapter actually backs the money path is the single most important fact
// about this boot, and it's driven by an env var (`FULFILLMENT_SUPPLIER`) that's easy to leave
// (or accidentally set) wrong — a silent mock boot in a real deployment would mock-fulfill every
// real paid order with no error, no crash, nothing but a quiet no-op against CJ.
app.log.info({ supplier: supplierAdapter.key }, 'fulfillment supplier adapter')
if (supplierAdapter.key === 'mock' && config.shopify) {
  app.log.warn(
    'FULFILLMENT_SUPPLIER=mock with Shopify configured — real paid orders would be mock-fulfilled',
  )
}

if (config.anthropic) app.log.info('sourcing agent: ANTHROPIC_API_KEY configured')
else app.log.warn('sourcing agent DISABLED: ANTHROPIC_API_KEY not set — sourcing.weekly cron will not register')
if (config.serpapi) app.log.info('sourcing agent: SERPAPI_KEY configured (trends stage armed)')
else app.log.warn('sourcing trends stage disabled: SERPAPI_KEY not set — runs proceed without google_trends signals')

if (config.gmail) app.log.info('support: Gmail service-account configured (ingest armed)')
else app.log.warn('support poll DISABLED: Gmail env not set — support.poll-gmail cron registers but no-ops (one info alert at boot)')
if (config.anthropic) app.log.info('support: ANTHROPIC_API_KEY configured (triage armed)')
else app.log.warn('support triage DISABLED: ANTHROPIC_API_KEY not set — poll ingests/escalates but skips triage (one info alert at boot)')

alertImpl = createAlerter(db, app.log)

// Built here — before `startQueue` — because the `fulfillment.sync-tracking` queue it wires needs
// a `shopifyOps` dep at registration time, not just at cron time (unlike the webhook-audit cron
// below, which only needs the client once `adminBaseUrl` is also known). `shopifyClient` is
// `undefined` whenever `config.shopify` is unset (dev without Shopify creds) — `shopifyOps` falls
// back to a stub that throws `'shopify not configured'` on any call in that case, so a
// `fulfillment.sync-tracking` job simply fails/retries (and eventually needs an operator) rather
// than crashing on a missing method.
const shopifyClient = config.shopify
  ? new ShopifyAdminClient({
      shopDomain: config.shopify.shopDomain,
      tokenManager: new ShopifyTokenManager({
        shopDomain: config.shopify.shopDomain,
        clientId: config.shopify.clientId,
        clientSecret: config.shopify.clientSecret,
      }),
    })
  : undefined

const shopifyNotConfigured = (): Promise<never> => Promise.reject(new Error('shopify not configured'))
const shopifyOps: ShopifyFulfillmentOps = shopifyClient
  ? {
      orderFulfillmentOrders: (orderGid) => orderFulfillmentOrders(shopifyClient, orderGid),
      fulfillmentCreate: (args) => fulfillmentCreate(shopifyClient, args),
      fulfillmentTrackingInfoUpdate: (gid, tracking) => fulfillmentTrackingInfoUpdate(shopifyClient, gid, tracking),
      ordersUpdatedSince: (sinceIso) => ordersUpdatedSince(shopifyClient, sinceIso),
    }
  : {
      orderFulfillmentOrders: shopifyNotConfigured,
      fulfillmentCreate: shopifyNotConfigured,
      fulfillmentTrackingInfoUpdate: shopifyNotConfigured,
      ordersUpdatedSince: shopifyNotConfigured,
    }

// Same shape as `shopifyOps` just above, for `proposal.apply`'s `new_listing` pipeline (Task 6).
const proposalShopify: ProposalShopifyOps = shopifyClient
  ? {
      findProductByHandle: (handle) => findProductByHandle(shopifyClient, handle),
      productSet: (input) => productSet(shopifyClient, input),
      listPublications: () => listPublications(shopifyClient),
      publishablePublish: (productId, publicationId) => publishablePublish(shopifyClient, productId, publicationId),
      publishableUnpublish: (productId, publicationId) => publishableUnpublish(shopifyClient, productId, publicationId),
      productVariantsByProductId: (productGid) => productVariantsByProductId(shopifyClient, productGid),
    }
  : {
      findProductByHandle: shopifyNotConfigured,
      productSet: shopifyNotConfigured,
      listPublications: shopifyNotConfigured,
      publishablePublish: shopifyNotConfigured,
      publishableUnpublish: shopifyNotConfigured,
      productVariantsByProductId: shopifyNotConfigured,
    }

// Same shape again, for `proposal.apply`'s `refund` executor (Task 16). `null` — not a
// throwing stub — when Shopify is unconfigured: `applyRefund` checks for exactly that and fails the
// proposal loudly (owner `notify()`) rather than throwing, retrying and dead-lettering its way to
// the same place. This one MOVES MONEY, so it stays a hand-picked two-method surface.
const refundOps: RefundOps | null = shopifyClient
  ? {
      orderRefundState: (orderGid) => orderRefundState(shopifyClient, orderGid),
      refundCreate: (input, idempotencyKey) => refundCreate(shopifyClient, input, idempotencyKey),
    }
  : null

// Built here — before `startQueue` — because `proposal.apply`'s `support_reply` executor
// (Task 15) needs a `gmail` dep at registration time via `ApplyProposalDeps`, same reasoning as
// `shopifyClient` above. `null` whenever `config.gmail` is unset (dev without Gmail creds) —
// `startQueue` defaults `ApplyProposalDeps.gmail` to `null` in that case, and `applySupportReply`
// fails loudly (alert) on a `null` gmail rather than throwing a `TypeError`. This is the SAME
// client instance `supportPollDeps`/`supportAgentDeps` further below also use — constructing it
// once here rather than twice.
const gmailClient = config.gmail
  ? createGmailClient({
      auth: createGmailAuth({
        saEmail: config.gmail.saEmail,
        saKey: config.gmail.saKey,
        impersonate: config.gmail.impersonate,
      }),
      fromAddress: config.gmail.supportAddress,
    })
  : null

queue = await startQueue(config.databaseUrl, {
  adapter: supplierAdapter, settings, alert, shopify: shopifyOps, proposalShopify,
  gmail: gmailClient, supportAddress: config.gmail?.supportAddress ?? '', notify,
  adminBaseUrl: config.adminBaseUrl ?? '',
  refundOps,
})

// Task 11's day-claim breaker self-heal: flip any `agent_runs` row left stuck in 'running' past
// `ORPHAN_AFTER_MINUTES` (a crashed process that never reached a terminal status) to 'aborted' once
// at boot, on top of the sweep `claimDailyRun` already runs before every claim — so a stale row
// left over from before this process last restarted doesn't sit around looking in-progress until
// the next claim attempt happens to come along. Non-fatal: a sweep failure here must not block the
// rest of boot (queue/cron registration, `app.listen`), since `claimDailyRun` will simply retry the
// sweep on its own next call regardless.
sweepOrphanRuns(db, alert).catch(() => app.log.warn('orphan sweep failed at boot'))

// `fulfillment.reconcile` (Task 14): the hourly four-sweep reconciliation job. Registered
// unconditionally (unlike the `shopify.webhook-audit` cron below, which needs `adminBaseUrl` too)
// — sweeps 2-4 need no Shopify config at all, and sweep 1's `ordersUpdatedSince` already degrades
// to a loud per-run failure (via `shopifyOps`'s own `shopifyNotConfigured` stub) rather than a
// silent no-op when Shopify creds aren't set. `registerCron` creates the queue (idempotent — it's
// already created by `startQueue` above), registers this as its sole worker, and schedules it.
const reconcileDeps: ReconcileDeps = { db, adapter: supplierAdapter, settings, alert, enqueue, shopifyOps, now: () => new Date() }
await registerCron(queue.boss, 'fulfillment.reconcile', '0 * * * *', fulfillmentReconcileHandler(reconcileDeps))

// `cj.wallet-monitor` (Task 15): 4-hourly wallet balance check — alerts when the supplier
// balance runs low and auto-resumes any `supplier_orders` rows parked `awaiting_funds` once the
// wallet recovers enough to cover them. Registered unconditionally, same as `fulfillment.reconcile`
// just above — it needs no Shopify config at all, only the supplier adapter/settings/alert/enqueue
// deps `queue` already provides by this point.
const walletMonitorDeps: WalletMonitorDeps = { db, adapter: supplierAdapter, settings, alert, enqueue }
await registerCron(queue.boss, 'cj.wallet-monitor', '0 */4 * * *', cjWalletMonitorHandler(walletMonitorDeps))

// `cj.dispute-poll` (Task 17): 6-hourly poll of every open CJ dispute recorded on an applied
// `refund` proposal (`apply-refund.ts`'s best-effort `openCjDispute` step) — once CJ reports a
// terminal outcome, writes a terminal marker into the proposal's payload so it drops out of
// selection for good. Registered unconditionally, same as `cj.wallet-monitor` just above — it
// needs only the supplier adapter/alert deps `queue` already provides by this point.
const disputePollDeps: DisputePollDeps = { db, adapter: supplierAdapter, alert }
await registerCron(queue.boss, 'cj.dispute-poll', '0 */6 * * *', cjDisputePollHandler(disputePollDeps))

// `proposal.expire-sweep` (Task 7): daily proposal expiry sweep — transitions any pending
// proposals that have expired to 'expired' status and audits each transition.
await registerCron(queue.boss, 'proposal.expire-sweep', '30 6 * * *', proposalExpireSweepHandler(db))

// `scoring.nightly` (Phase 7, Task 7): nightly product-scoring sweep — computes and upserts one
// `product_scores` row per active product for today's UTC date (`computeProductScores`, Task 6),
// gated on `killswitch.global`/`workflow.scoring.enabled` inside `executeScoringNightly` itself.
// Registered unconditionally, same as `cj.dispute-poll`/`proposal.expire-sweep` above — unlike
// `sourcing.weekly` below, this cron has NO LLM step, so there is nothing here for
// `ANTHROPIC_API_KEY` to gate.
const scoringNightlyDeps: ScoringNightlyDeps = { db, settings, alert }
await registerCron(queue.boss, SCORING_NIGHTLY_QUEUE, '0 3 * * *', scoringNightlyHandler(scoringNightlyDeps))
app.log.info(`${SCORING_NIGHTLY_QUEUE} cron ARMED — 03:00 UTC daily`)

// `scoring.weekly-digest` (Phase 7, Task 9): the Monday deprecation digest — pre-revenue gate,
// freshness guard, cooldown-aware candidate selection, the Sonnet spare-judge, and a re-runnable
// notify. Registered UNCONDITIONALLY (same as `scoring.nightly` above): unlike `sourcing.weekly`,
// the LLM step here is INTERNAL and optional — the digest's own body gates the judge on
// `scoring.judge_enabled && anthropicConfigured` and proceeds deterministically without it, so
// there is nothing for `ANTHROPIC_API_KEY` to gate at the cron-registration level. `submitDeps` is
// the same db/settings/notify/enqueue/alert(/adminBaseUrl) bundle every other submitter is built
// from; `anthropicConfigured` mirrors the support/sourcing gate (`Boolean(config.anthropic)`).
const scoringSubmitDeps: SubmitProposalDeps = {
  db, settings, notify, enqueue, alert,
  ...(config.adminBaseUrl ? { adminBaseUrl: config.adminBaseUrl } : {}),
}
const scoringWeeklyDeps: ScoringWeeklyDeps = {
  db, settings, alert, notify,
  adminBaseUrl: config.adminBaseUrl ?? '',
  submit: submitProposal,
  submitDeps: scoringSubmitDeps,
  judge: runDeprecationJudge,
  anthropicConfigured: Boolean(config.anthropic),
}
await registerCron(queue.boss, SCORING_WEEKLY_QUEUE, '0 14 * * 1', scoringWeeklyHandler(scoringWeeklyDeps))
app.log.info(`${SCORING_WEEKLY_QUEUE} cron ARMED — Mondays 14:00 UTC`)

if (config.shopify && config.adminBaseUrl && shopifyClient) {
  const { adminBaseUrl } = config
  await registerCron(queue.boss, 'shopify.webhook-audit', '0 6 * * *', async () => {
    await shopifyWebhookAudit({ client: shopifyClient, adminBaseUrl, db })
  })
} else if (config.shopify) {
  // Shopify creds are configured but ADMIN_BASE_URL isn't, so the daily webhook-audit cron
  // (self-healing for dropped/misdirected subscriptions) never gets registered — a production
  // deploy could silently lose this safety net, so make it loud instead of silent.
  app.log.warn('shopify webhook-audit cron disabled: ADMIN_BASE_URL not set')
}

// `sourcing.weekly` (Phase 5, Task 14): gated on `ANTHROPIC_API_KEY` (Task 4) — the disabled-warn
// for the absent-key case already lives in that config log block above. `trends` is its own
// independent gate (Task 7's SerpApi adapter, only when `SERPAPI_KEY` is also set) — its own
// disabled-warn lives in the same log block; a missing SerpApi key degrades the run (Stage 3
// skipped, `trends_stage_skipped` alert) rather than blocking the cron entirely. `retryLimit: 0` /
// `expireInSeconds: 3600` (Task 5's `registerCron` options, Decision 11) mean a stuck or thrown run
// is never silently retried — `claimDailyRun`'s same-day breaker is the only thing standing between
// this cron and a second paid run today, so a blind retry would be actively dangerous here.
if (config.anthropic) {
  // A FACTORY, not a single baked-in instance (FIX C2): `createSerpApiTrends` enforces its
  // per-run SerpApi request cap via a closure counter that never resets, so reusing one instance
  // across weekly runs would accumulate it and permanently trip (~week 4), silently nulling the
  // trends stage. Constructing a fresh provider per run resets that counter every run.
  const trendsFactory = (): ReturnType<typeof createSerpApiTrends> | null =>
    config.serpapi ? createSerpApiTrends({ apiKey: config.serpapi.apiKey }) : null
  const sourcingDeps: SourcingPipelineDeps = {
    db, adapter: supplierAdapter, settings, alert, enqueue, notify, adminBaseUrl: config.adminBaseUrl, trendsFactory,
  }
  await registerCron(queue.boss, 'sourcing.weekly', '0 13 * * 1', sourcingWeeklyHandler(sourcingDeps), {
    retryLimit: 0,
    expireInSeconds: 3600,
  })
  app.log.info('sourcing.weekly cron ARMED — Mondays 13:00 UTC, sonnet-5, $2.00 stop-loss')
}

// `support.poll-gmail` (Phase 6A, Task 12): the minute-cadence Gmail poll — ingest → triage →
// escalate. Registered UNCONDITIONALLY (unlike `sourcing.weekly` above, which needs
// `ANTHROPIC_API_KEY` just to register at all) — this cron's own handler is what degrades
// gracefully when `config.gmail`/`config.anthropic` are absent (a once-per-boot info alert and a
// no-op return, per its own doc comment), so there is nothing unsafe about it running at all times
// even in a dev boot with no Gmail creds. `policy: 'singleton'` + `singletonKey` (spec §2 header)
// are load-bearing: pg-boss hard-floors cron schedules at one fire/minute, and a plain 'standard'
// queue has no overlap protection at all — without singleton dedup, a slow poll could still be
// running when the next minute's schedule fires a second one on top of it. That overlap protection
// is a CHECK-then-ACT (pg-boss checks no job with this singletonKey is already active, then
// inserts) — it assumes nothing OTHER than this one singleton queue can start a second concurrent
// poll; it is not a general mutex.
//
// `expireInSeconds: 300` (IMPORTANT 4c — was 120, too tight against the pipeline's own worst-case
// latency): every Gmail call now carries its own 20s timeout with one retry (packages/gmail's
// `client.ts`, ~40s worst case per call across a resync's several calls) and `runTriage`'s own
// TRIAGE_CYCLE_DEADLINE_MS caps the triage stage at 60s — 300s keeps a wide margin over the
// pipeline's own worst-case rather than the two racing on the same order of magnitude, while
// staying well under pg-boss's 15-minute default. `retryLimit: 0` (the cadence itself IS the
// retry — see the handler's own doc comment) bounds how long a Railway hard-kill mid-poll can
// black out ingest to this same window.
//
// `gmailClient` itself is built earlier now (above `startQueue`) — `proposal.apply`'s
// `support_reply` executor (Task 15) needs it too, via `ApplyProposalDeps`; this poll and
// `supportAgentDeps` below just reuse that same instance.
const triageCall = config.anthropic ? createAnthropicTriageCall({ apiKey: config.anthropic.apiKey }) : null

// `support.agent-run` (Phase 6B, Tasks 11-13): the per-ticket agent job the poll's 4th stage
// (`support/agent-select.ts`) enqueues. `anthropicConfigured` mirrors the poll's own triage gate
// just above (`Boolean(config.anthropic)`) — same env, same "armed or not" question, asked again
// here because the job checks it independently at claim time (spec §1 step 1).
const supportAgentDeps: SupportAgentJobDeps = {
  db,
  settings,
  alert,
  notify,
  adminBaseUrl: config.adminBaseUrl!,
  adapter: supplierAdapter,
  enqueue,
  sessionStore: createPgSessionStore(db),
  anthropicConfigured: Boolean(config.anthropic),
}
// `policy: 'stately'` is load-bearing here (fix round 1, CRITICAL-1a — was `'singleton'`, ruled
// wrong): this queue's sole producer (`enqueueSupportAgentRun`) sets `singletonKey: ticketId` on
// every send, expecting pg-boss to keep at most one job per ticket *outstanding* at a time —
// created-or-active, not just active. pg-boss's `'singleton'` policy only indexes/dedupes the
// ACTIVE state (empirically confirmed: a second `send()` with the same key while the first is
// merely queued — not yet active — still enqueues a duplicate), so a burst of selection cycles
// (`agent-select.ts`, once a minute) or a retried claim could stack up more than one pending job
// for the same ticket. `'stately'` dedupes across BOTH `created` and `active` states for a given
// key, which is what "at most one outstanding run per ticket" actually requires; `claimTicket`'s
// row lock inside the job remains the airtight per-ticket mutex regardless.
//
// `createQueueRetrying` (not a bare `boss.createQueue`) guards the same first-boot concurrent-DDL
// race as every other queue below. `createQueue` is idempotent and a no-op on a queue that already
// exists (e.g. from before this fix, when it was created with `'singleton'`), so the explicit
// `updateQueue` follow-up is required to make `'stately'` actually stick on redeploy — the same
// two-call pattern `registerCron` documents and uses for the exact same reason (see this file's own
// doc comment on `CronJobOptions`/`registerCron` in queue.ts).
await createQueueRetrying(queue.boss, SUPPORT_AGENT_QUEUE, { name: SUPPORT_AGENT_QUEUE, policy: 'stately' })
await queue.boss.updateQueue(SUPPORT_AGENT_QUEUE, { name: SUPPORT_AGENT_QUEUE, policy: 'stately' })
// `batchSize: 1` is pinned explicitly (not just relying on pg-boss's own default of 1): the job's
// `removeLocalSessionMirror()` does a best-effort `rm -rf` of the WHOLE shared SDK session-mirror
// directory after every run, not just the run's own subdirectory — see that function's doc comment
// in `jobs/support-agent-run.ts`. A batch >1 (or a second concurrent worker on this queue) would
// let one run's cleanup delete another's live mirror out from under it.
await queue.boss.work(SUPPORT_AGENT_QUEUE, { batchSize: 1 }, supportAgentRunHandler(supportAgentDeps))
app.log.info(`${SUPPORT_AGENT_QUEUE} worker ARMED — stately, batch size 1`)

const supportPollDeps: SupportPollDeps = {
  db,
  gmail: gmailClient,
  supportAddress: config.gmail?.supportAddress ?? '',
  settings,
  alert,
  notify,
  adminBaseUrl: config.adminBaseUrl!,
  triageCall,
  enqueue,
}
await registerCron(queue.boss, SUPPORT_POLL_QUEUE, '* * * * *', supportPollGmailHandler(supportPollDeps), {
  policy: 'singleton',
  singletonKey: SUPPORT_POLL_QUEUE,
  expireInSeconds: 300,
  retryLimit: 0,
})
app.log.info(`${SUPPORT_POLL_QUEUE} cron ARMED — every minute, singleton`)

await app.listen({ port: config.port, host: config.host })
app.log.info(`ops listening on :${config.port}`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info(`${signal} received, shutting down`)

  let ok = true

  try {
    await app.close()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error closing server during shutdown')
  }

  try {
    await queue.stop()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error stopping queue during shutdown')
  }

  try {
    await pool.end()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error closing db pool during shutdown')
  }

  process.exit(ok ? 0 : 1)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
