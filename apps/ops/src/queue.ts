import { createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import PgBoss from 'pg-boss'
import type { createAlerter } from './alerts.ts'
import type { PlaceOrderDeps } from './fulfillment/run-place-order.ts'
import { type ShopifyFulfillmentOps, type SyncTrackingDeps } from './fulfillment/run-sync-tracking.ts'
import type { SendOpts } from './fulfillment/types.ts'
import { demoPingHandler } from './jobs/demo-ping.ts'
import { fulfillmentPayOrderHandler } from './jobs/fulfillment-pay-order.ts'
import { fulfillmentPlaceOrderHandler } from './jobs/fulfillment-place-order.ts'
import { fulfillmentSyncTrackingHandler } from './jobs/fulfillment-sync-tracking.ts'
import { proposalApplyHandler } from './jobs/proposal-apply.ts'
import { webhookProcessHandler } from './jobs/webhook-process.ts'
import type { ApplyProposalDeps, ProposalShopifyOps } from './proposals/run-apply.ts'
import type { createSettings } from './settings.ts'

export interface FulfillmentQueueDeps {
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  /**
   * Shopify fulfillment operations backing `fulfillment.sync-tracking` (Task 13). Optional here
   * purely so tests that never touch that queue (e.g. `queue-fulfillment.test.ts`'s place-order
   * wiring checks) don't need to supply one — when omitted, `startQueue` below wires a stub that
   * throws `'shopify not configured'` on any call, same as `index.ts` does when `config.shopify`
   * is unset (see that file's own stub for the production-path reasoning). `fulfillment.reconcile`
   * (Task 14) needs the same interface too, but its own `shopifyOps` is assembled independently by
   * `index.ts` (which registers that queue's worker directly), not threaded through here.
   */
  shopify?: ShopifyFulfillmentOps
  /**
   * Shopify operations backing `proposal.apply`'s `new_listing` pipeline (Task 6). Optional for
   * the same reason `shopify` above is: when omitted, `startQueue` wires a stub that throws
   * `'shopify not configured'` on any call, same as `index.ts`'s own `config.shopify`-gated stub.
   */
  proposalShopify?: ProposalShopifyOps
}

export interface Queue {
  boss: PgBoss
  ready: () => boolean
  stop: () => Promise<void>
}

const PLACE_ORDER_QUEUE = 'fulfillment.place-order'
const PAY_ORDER_QUEUE = 'fulfillment.pay-order'
const SYNC_TRACKING_QUEUE = 'fulfillment.sync-tracking'
const RECONCILE_QUEUE = 'fulfillment.reconcile'
const WALLET_MONITOR_QUEUE = 'cj.wallet-monitor'
const PROPOSAL_APPLY_QUEUE = 'proposal.apply'

/**
 * `boss.createQueue` for a brand-new queue name runs DDL (creates the queue's partition table +
 * indexes) after an `INSERT ... ON CONFLICT DO NOTHING`. If two processes race to create the
 * *same never-before-seen* queue at the same time — multiple ops instances cold-booting against
 * a fresh database, or (as observed) parallel test files each calling `startQueue` — Postgres can
 * raise a deadlock (40P01) or serialization failure (40001) on that DDL. Once the queue exists,
 * every future call is a fast no-op, so this only ever matters on first boot; retrying a few
 * times with a short backoff is safe and sufficient.
 */
async function createQueueRetrying(boss: PgBoss, name: string, options?: PgBoss.Queue): Promise<void> {
  const RETRYABLE_CODES = new Set(['40P01', '40001'])
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; ; attempt++) {
    try {
      await boss.createQueue(name, options)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

export async function startQueue(connectionString: string, deps: FulfillmentQueueDeps): Promise<Queue> {
  const boss = new PgBoss(connectionString)
  const { db, pool } = createDb(connectionString)
  let running = false

  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  running = true

  // pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
  // this only forwards `opts` when the caller actually passed one.
  const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
    if (opts) {
      await boss.send(name, data, opts)
    } else {
      await boss.send(name, data)
    }
  }

  const placeOrderDeps: PlaceOrderDeps = {
    db,
    adapter: deps.adapter,
    settings: deps.settings,
    alert: deps.alert,
    enqueue,
  }

  // No-config fallback: mirrors `index.ts`'s own `config.shopify`-gated stub so a caller that
  // doesn't wire `deps.shopify` (unconfigured Shopify creds, or a test that never exercises this
  // queue) still gets a `FulfillmentQueueDeps.shopify`-shaped object — one that fails loudly (job
  // retries, then dead-letters) instead of throwing a `TypeError` on a missing method.
  const shopifyNotConfigured = (): Promise<never> => Promise.reject(new Error('shopify not configured'))
  const syncTrackingDeps: SyncTrackingDeps = {
    db,
    alert: deps.alert,
    shopifyOps: deps.shopify ?? {
      orderFulfillmentOrders: shopifyNotConfigured,
      fulfillmentCreate: shopifyNotConfigured,
      fulfillmentTrackingInfoUpdate: shopifyNotConfigured,
      ordersUpdatedSince: shopifyNotConfigured,
    },
  }

  // Same no-config fallback shape as `syncTrackingDeps` just above, for the `proposal.apply`
  // pipeline's own Shopify surface (`ProposalShopifyOps`, Task 6).
  const applyProposalDeps: ApplyProposalDeps = {
    db,
    alert: deps.alert,
    shopify: deps.proposalShopify ?? {
      findProductByHandle: shopifyNotConfigured,
      productSet: shopifyNotConfigured,
      listPublications: shopifyNotConfigured,
      publishablePublish: shopifyNotConfigured,
      productVariantsByProductId: shopifyNotConfigured,
    },
  }

  await createQueueRetrying(boss, 'demo.ping')
  await boss.work('demo.ping', demoPingHandler(db))

  await createQueueRetrying(boss, 'webhook.shopify.process')
  await boss.work('webhook.shopify.process', webhookProcessHandler({ db, enqueue, alert: deps.alert }, 'shopify'))

  await createQueueRetrying(boss, 'webhook.cj.process')
  await boss.work('webhook.cj.process', webhookProcessHandler({ db, enqueue, alert: deps.alert }, 'cj'))

  // The three fulfillment queues below use `policy: 'singleton'` because every producer that
  // enqueues into them sets a `singletonKey` (order gid / supplier_orders row id) expecting
  // pg-boss to keep at most one ACTIVE job per key at a time — enforced by a unique index scoped
  // to `policy = 'singleton'` (pg-boss's default 'standard' policy applies no such constraint at
  // all). `createQueue` is idempotent (first call wins the policy for a given queue name for
  // good), so getting this right here matters. Note this dedupes concurrent *execution*, not the
  // `send()` itself: a second send with the same key while the first is active still succeeds
  // and queues normally — it just won't be picked up until the active one leaves that state.
  await createQueueRetrying(boss, PLACE_ORDER_QUEUE, { name: PLACE_ORDER_QUEUE, policy: 'singleton' })
  await boss.work(PLACE_ORDER_QUEUE, fulfillmentPlaceOrderHandler(placeOrderDeps))

  // `{ includeMetadata: true }` is required here (unlike the place-order worker above): the
  // pay-order handler's retry-exhaustion dead-letter hook needs `job.retryCount`/`retryLimit`,
  // which only `JobWithMetadata` (not the plain `Job` the 1-arg `work()` overload hands back)
  // carries — see the handler's own doc comment in jobs/fulfillment-pay-order.ts.
  await createQueueRetrying(boss, PAY_ORDER_QUEUE, { name: PAY_ORDER_QUEUE, policy: 'singleton' })
  await boss.work(PAY_ORDER_QUEUE, { includeMetadata: true }, fulfillmentPayOrderHandler(placeOrderDeps))

  await createQueueRetrying(boss, SYNC_TRACKING_QUEUE, { name: SYNC_TRACKING_QUEUE, policy: 'singleton' })
  await boss.work(SYNC_TRACKING_QUEUE, fulfillmentSyncTrackingHandler(syncTrackingDeps))

  // `proposal.apply` (Task 6): `singleton` for the same reason as the three fulfillment queues
  // above — every send sets `singletonKey: proposalId` (`submit.ts`'s `enqueueProposalApply`), so
  // at most one ACTIVE apply job per proposal at a time. `{ includeMetadata: true }` for the same
  // reason as `PAY_ORDER_QUEUE` above: the handler's retry-exhaustion dead-letter hook needs
  // `job.retryCount`/`retryLimit`, which only `JobWithMetadata` carries — see
  // jobs/proposal-apply.ts's own doc comment.
  await createQueueRetrying(boss, PROPOSAL_APPLY_QUEUE, { name: PROPOSAL_APPLY_QUEUE, policy: 'singleton' })
  await boss.work(PROPOSAL_APPLY_QUEUE, { includeMetadata: true }, proposalApplyHandler(applyProposalDeps))

  // No singletonKey producer for either queue (both are cron-driven sweeps, not per-entity jobs),
  // so the default 'standard' policy is correct — left unspecified deliberately.
  //
  // RECONCILE_QUEUE's DDL is created here (eagerly, at boot, alongside the other fulfillment
  // queues) but its worker and hourly schedule are registered by `index.ts` via `registerCron` —
  // not here — because `registerCron` bundles create + work + schedule in one call and calling
  // `boss.work` a second time for the same queue name would just be a redundant second poller.
  // `createQueueRetrying` is idempotent, so index.ts's own call is a safe no-op on top of this one.
  await createQueueRetrying(boss, RECONCILE_QUEUE)

  // No `boss.work()` call here — same reasoning as RECONCILE_QUEUE just above: `registerCron`
  // (called by index.ts, Task 15) bundles create + work + schedule in one call, and calling
  // `boss.work` a second time for the same queue name would just register a redundant second
  // poller. `createQueueRetrying` is idempotent, so index.ts's own call is a safe no-op on top of
  // this one.
  await createQueueRetrying(boss, WALLET_MONITOR_QUEUE)

  return {
    boss,
    ready: () => running,
    stop: async () => {
      running = false
      await boss.stop({ graceful: true, wait: true })
      await pool.end()
    },
  }
}

/**
 * Per-cron queue options (`registerCron`'s `opts` param). Currently just the two knobs Phase 5's
 * `sourcing.weekly` cron needs to pin away from pg-boss defaults (retryLimit 2, a 15-minute
 * expiry) — extend as more crons need more `PgBoss.Queue` fields.
 */
export interface CronJobOptions {
  retryLimit?: number
  expireInSeconds?: number
}

/**
 * Creates a queue (if needed), registers its worker, and schedules it on a cron. Used for
 * recurring jobs like `shopify.webhook-audit` that aren't triggered by application events.
 *
 * `opts` (optional) pins queue-level settings — e.g. `retryLimit`/`expireInSeconds` — that
 * diverge from pg-boss's defaults. Omitted `opts` is today's behavior exactly: `createQueueRetrying`
 * still creates the queue with no options, same as every existing caller. When `opts` is given,
 * `createQueueRetrying(boss, name, { name, ...opts })` covers the *first-ever* create, but
 * `createQueue` is idempotent — if the queue already exists (e.g. `startQueue` or an earlier
 * `registerCron` call created it first with defaults), that create is a silent no-op and the
 * options never apply. So follow up with `boss.updateQueue(name, { name, ...opts })`, which pg-boss
 * always applies (update, not create-if-missing) and makes the settings stick either way.
 */
export async function registerCron<ReqData extends object = object>(
  boss: PgBoss,
  name: string,
  cron: string,
  handler: PgBoss.WorkHandler<ReqData>,
  opts?: CronJobOptions,
): Promise<void> {
  await createQueueRetrying(boss, name, opts ? { name, ...opts } : undefined)
  if (opts) {
    await boss.updateQueue(name, { name, ...opts })
  }
  await boss.work(name, handler)
  await boss.schedule(name, cron)
}
