import {
  agentRuns,
  auditLog,
  gmailSyncState,
  productScores,
  products,
  productVariants,
  proposals,
  supplierOrders,
  supportTickets,
  webhookEvents,
} from '@doge-buddy/db'
import { and, count, desc, eq, gt, gte, isNotNull, sql } from 'drizzle-orm'
import { AGENT_RUN_AUDIT_ACTION } from '../../jobs/support-agent-run.ts'
import { SOURCING_WORKFLOW } from '../../sourcing/pipeline.ts'
import type { WorkflowMode } from '../../settings.ts'
import type { AdminDeps } from './routes.ts'

/** The single-row primary key of `gmail_sync_state` (same convention as ingest.ts's and
 * support-poll-gmail.ts's own local copies of this constant — no shared export exists yet). */
const GMAIL_SYNC_STATE_ID = 1

export interface HealthStrip {
  /** null => 'n/a' on the page: no getWalletBalance dep wired, or the live call threw. */
  walletCents: number | null
  /** The `fulfillment.wallet_alert_threshold_cents` setting, read fresh every load — the strip
   * renders a visible below-threshold indicator when `walletCents` is known and under this. */
  walletAlertThresholdCents: number
  /** pgboss.job rows in state IN ('created','retry','active'); 0 if the pgboss schema doesn't exist yet. */
  queueDepth: number
  lastWebhookAt: Date | null
  killswitch: boolean
  fulfillmentEnabled: boolean
  pausedForFunds: boolean
  pendingProposals: number
  /** `gmail_sync_state.last_success_at` — null when the poll has never once succeeded (including
   * when the row doesn't exist yet, e.g. a fresh database before the first poll cycle). */
  supportPollLastSuccessAt: Date | null
  /** `gmail_sync_state.consecutive_failures` — 0 when the row doesn't exist yet. */
  supportPollConsecutiveFailures: number
  /** Count of `support.agent_run` audit rows since UTC midnight — the same counter
   * `jobs/support-agent-run.ts`'s `SUPPORT_AGENT_MAX_RUNS_PER_DAY` global cap enforces, read fresh
   * for display (not cached from the job's own count). */
  supportAgentRunsToday: number
  /** The newest `agent_runs` row with `workflow = 'support'`, when one exists — null before the
   * support agent has ever run. */
  supportAgentLastRun: { status: string; startedAt: Date } | null
  /** The newest `product_scores.score_date` (a `YYYY-MM-DD` text value, Postgres `date`), or null
   * before the scoring job has ever run (no `product_scores` rows at all yet). */
  scoringLastRunDate: string | null
  /** Count of `product_scores` rows on `scoringLastRunDate` — 0 when `scoringLastRunDate` is
   * null. */
  scoringProductsScored: number
  /** Count of `support_tickets` rows with `status = 'escalated'` — the Needs-you card's own live
   * count, read fresh (not the nav badge's cached copy). */
  escalatedTickets: number
  /** Count of `supplier_orders` rows with `status = 'needs_attention'`. */
  ordersNeedsAttention: number
  /** The newest `agent_runs` row with `workflow = SOURCING_WORKFLOW` — null before the sourcing
   * pipeline has ever run. */
  sourcingLastRun: { status: string; startedAt: Date } | null
  /** The newest `audit_log.created_at` where `action = 'inventory.synced'` — null before the
   * inventory sync has ever run. */
  inventorySyncLastAt: Date | null
  /** True when an `alert.inventory_sync_degraded` audit row (written by `alerts.ts`'s `alert`
   * helper for kind `inventory_sync_degraded`) is newer than `inventorySyncLastAt` — or any such
   * row exists at all when `inventorySyncLastAt` is null (never synced). */
  inventorySyncDegraded: boolean
  /** Count of `products` rows with `status = 'active'`. */
  activeProducts: number
  /** Count of `product_variants` rows joined to an active product with a non-null
   * `shopify_inventory_item_gid` — i.e. variants Shopify inventory tracking actually covers. */
  trackedVariants: number
  /** The newest active product, by `created_at` — null when there are no active products yet. */
  latestListing: { title: string; handle: string | null; createdAt: Date } | null
  /** The four workflow `.mode` settings, read fresh every load. */
  modes: { sourcing: WorkflowMode; supportReply: WorkflowMode; refund: WorkflowMode; deprecation: WorkflowMode }
}

/** UTC-midnight cutoff for "today", mirroring `jobs/support-agent-run.ts`'s own local (unexported)
 * `utcMidnight` helper — no shared export exists yet, same convention as this file's
 * `GMAIL_SYNC_STATE_ID` copy above. */
function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Live CJ wallet balance for the dashboard strip. `deps.getWalletBalance` is optional (most
 * deploys won't have it wired until the CJ adapter is live) and a live API call can fail
 * transiently — either case degrades to `null` ('n/a' on the page) rather than ever throwing out
 * of this loader and into the route handler.
 */
async function loadWalletCents(deps: AdminDeps): Promise<number | null> {
  if (!deps.getWalletBalance) return null
  try {
    const { availableCents } = await deps.getWalletBalance()
    return availableCents
  } catch {
    return null
  }
}

/**
 * pg-boss's own schema, queried directly — drizzle has no typed model for it (it's owned and
 * migrated by the pg-boss library, not this app's schema.ts). node-postgres's `db.execute(sql\`...\`)`
 * returns pg's own `QueryResult`: the row lives at `result.rows[0]`, NOT the result itself (the
 * Plan A `db.execute` lesson — treating the result as if it *were* the row array silently reads
 * `undefined` off every property instead of erroring). Wrapped in try/catch: a fresh database that
 * has never started the queue has no `pgboss` schema at all yet, and this dashboard must still
 * render (queueDepth 0, not a 500) before the queue's first boot.
 */
async function loadQueueDepth(db: AdminDeps['db']): Promise<number> {
  try {
    const result = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active')`,
    )
    return result.rows[0]?.n ?? 0
  } catch {
    return 0
  }
}

/**
 * `gmail_sync_state` is a singleton row (id=1) written by support-poll-gmail.ts's `recordSuccess`
 * / `recordFailure` — before the first poll cycle ever runs (fresh database) the row doesn't
 * exist at all, so this degrades to `{ null, 0 }` rather than throwing.
 */
async function loadSupportPollState(
  db: AdminDeps['db'],
): Promise<{ lastSuccessAt: Date | null; consecutiveFailures: number }> {
  const [row] = await db
    .select({ lastSuccessAt: gmailSyncState.lastSuccessAt, consecutiveFailures: gmailSyncState.consecutiveFailures })
    .from(gmailSyncState)
    .where(eq(gmailSyncState.id, GMAIL_SYNC_STATE_ID))
  return { lastSuccessAt: row?.lastSuccessAt ?? null, consecutiveFailures: row?.consecutiveFailures ?? 0 }
}

/**
 * The support agent's budget row: today's spend-row count (the same `AGENT_RUN_AUDIT_ACTION` rows
 * `jobs/support-agent-run.ts`'s global cap counts, since UTC midnight) plus the newest
 * `workflow = 'support'` `agent_runs` row's status/startedAt, when one exists.
 */
async function loadSupportAgentState(
  db: AdminDeps['db'],
): Promise<{ runsToday: number; lastRun: { status: string; startedAt: Date } | null }> {
  const midnight = utcMidnight(new Date())
  const [countRow] = await db
    .select({ value: count() })
    .from(auditLog)
    .where(and(eq(auditLog.action, AGENT_RUN_AUDIT_ACTION), gte(auditLog.createdAt, midnight)))
  const [lastRunRow] = await db
    .select({ status: agentRuns.status, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(eq(agentRuns.workflow, 'support'))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1)
  return { runsToday: countRow?.value ?? 0, lastRun: lastRunRow ?? null }
}

/**
 * Task 11 (scoring): the newest `product_scores.score_date` and how many products were scored on
 * that date — a two-query pattern (max date, then a count filtered to it) mirroring this file's
 * own `loadSupportAgentState` above, rather than one clever aggregate query. `{ null, 0 }` before
 * the scoring job has ever run (no `product_scores` rows exist yet), same "not yet run" idiom as
 * `loadSupportPollState`'s own null/0 default.
 */
async function loadScoringState(db: AdminDeps['db']): Promise<{ lastRunDate: string | null; productsScored: number }> {
  const [latest] = await db
    .select({ scoreDate: productScores.scoreDate })
    .from(productScores)
    .orderBy(desc(productScores.scoreDate))
    .limit(1)
  if (!latest) return { lastRunDate: null, productsScored: 0 }

  const [countRow] = await db
    .select({ value: count() })
    .from(productScores)
    .where(eq(productScores.scoreDate, latest.scoreDate))
  return { lastRunDate: latest.scoreDate, productsScored: countRow?.value ?? 0 }
}

/** Count of `support_tickets` rows with `status = 'escalated'` — degrades to 0 on any query error
 * so a bad index/connection blip on this one card never 500s the whole home page. */
async function loadEscalatedTickets(db: AdminDeps['db']): Promise<number> {
  try {
    const [row] = await db.select({ value: count() }).from(supportTickets).where(eq(supportTickets.status, 'escalated'))
    return row?.value ?? 0
  } catch {
    return 0
  }
}

/** Count of `supplier_orders` rows with `status = 'needs_attention'`. */
async function loadOrdersNeedsAttention(db: AdminDeps['db']): Promise<number> {
  try {
    const [row] = await db.select({ value: count() }).from(supplierOrders).where(eq(supplierOrders.status, 'needs_attention'))
    return row?.value ?? 0
  } catch {
    return 0
  }
}

/** The newest `agent_runs` row for the sourcing pipeline's own workflow — null before it has ever
 * run. */
async function loadSourcingLastRun(db: AdminDeps['db']): Promise<{ status: string; startedAt: Date } | null> {
  try {
    const [row] = await db
      .select({ status: agentRuns.status, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(eq(agentRuns.workflow, SOURCING_WORKFLOW))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1)
    return row ?? null
  } catch {
    return null
  }
}

/**
 * Inventory sync state: the newest `inventory.synced` audit row's timestamp, plus whether a
 * degraded-sync alert has fired more recently than that (or at all, when no sync has ever
 * succeeded). `alerts.ts`'s `alert()` helper writes every alert as an `audit_log` row with
 * `action = 'alert.' + kind` and `detail = { severity, ...detail }` — this reads that same shape
 * for `kind = 'inventory_sync_degraded'` rather than a dedicated table, since no shared export of
 * the alert kind constant exists yet.
 */
async function loadInventorySyncState(db: AdminDeps['db']): Promise<{ lastAt: Date | null; degraded: boolean }> {
  try {
    const [syncedRow] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(eq(auditLog.action, 'inventory.synced'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1)
    const lastAt = syncedRow?.createdAt ?? null

    const degradedConditions = [eq(auditLog.action, 'alert.inventory_sync_degraded')]
    if (lastAt) degradedConditions.push(gt(auditLog.createdAt, lastAt))
    const [degradedRow] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(...degradedConditions))
      .limit(1)

    return { lastAt, degraded: degradedRow !== undefined }
  } catch {
    return { lastAt: null, degraded: false }
  }
}

/** Catalog snapshot: active product count, tracked-variant count (variants of an active product
 * with Shopify inventory tracking wired), and the newest active listing. */
async function loadCatalogState(db: AdminDeps['db']): Promise<{
  activeProducts: number
  trackedVariants: number
  latestListing: { title: string; handle: string | null; createdAt: Date } | null
}> {
  try {
    const [activeRow] = await db.select({ value: count() }).from(products).where(eq(products.status, 'active'))
    const [trackedRow] = await db
      .select({ value: count() })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(products.status, 'active'), isNotNull(productVariants.shopifyInventoryItemGid)))
    const [latestRow] = await db
      .select({ title: products.title, handle: products.handle, createdAt: products.createdAt })
      .from(products)
      .where(eq(products.status, 'active'))
      .orderBy(desc(products.createdAt))
      .limit(1)

    return {
      activeProducts: activeRow?.value ?? 0,
      trackedVariants: trackedRow?.value ?? 0,
      latestListing: latestRow ? { title: latestRow.title ?? '', handle: latestRow.handle, createdAt: latestRow.createdAt } : null,
    }
  } catch {
    return { activeProducts: 0, trackedVariants: 0, latestListing: null }
  }
}

/** The four workflow `.mode` settings, read fresh every load — degrades to every default's
 * 'manual' (matching `SETTINGS_DEFAULTS`) rather than throwing. */
async function loadModes(
  deps: AdminDeps,
): Promise<{ sourcing: WorkflowMode; supportReply: WorkflowMode; refund: WorkflowMode; deprecation: WorkflowMode }> {
  try {
    const [sourcing, supportReply, refund, deprecation] = await Promise.all([
      deps.settings.get('workflow.sourcing.mode'),
      deps.settings.get('workflow.support_reply.mode'),
      deps.settings.get('workflow.refund.mode'),
      deps.settings.get('workflow.deprecation.mode'),
    ])
    return { sourcing, supportReply, refund, deprecation }
  } catch {
    return { sourcing: 'manual', supportReply: 'manual', refund: 'manual', deprecation: 'manual' }
  }
}

/** The dashboard's top-of-page health strip: wallet, queue depth, last webhook, the three kill switches, pending proposals. */
export async function loadHealthStrip(deps: AdminDeps): Promise<HealthStrip> {
  const [
    walletCents,
    walletAlertThresholdCents,
    queueDepth,
    lastWebhookRows,
    killswitch,
    fulfillmentEnabled,
    pausedForFunds,
    pendingRows,
    supportPollState,
    supportAgentState,
    scoringState,
    escalatedTickets,
    ordersNeedsAttention,
    sourcingLastRun,
    inventorySyncState,
    catalogState,
    modes,
  ] = await Promise.all([
    loadWalletCents(deps),
    deps.settings.get('fulfillment.wallet_alert_threshold_cents'),
    loadQueueDepth(deps.db),
    deps.db
      .select({ receivedAt: webhookEvents.receivedAt })
      .from(webhookEvents)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(1),
    deps.settings.get('killswitch.global'),
    deps.settings.get('workflow.fulfillment.enabled'),
    deps.settings.get('fulfillment.paused_for_funds'),
    deps.db.select({ value: count() }).from(proposals).where(eq(proposals.status, 'pending')),
    loadSupportPollState(deps.db),
    loadSupportAgentState(deps.db),
    loadScoringState(deps.db),
    loadEscalatedTickets(deps.db),
    loadOrdersNeedsAttention(deps.db),
    loadSourcingLastRun(deps.db),
    loadInventorySyncState(deps.db),
    loadCatalogState(deps.db),
    loadModes(deps),
  ])

  return {
    walletCents,
    walletAlertThresholdCents,
    queueDepth,
    lastWebhookAt: lastWebhookRows[0]?.receivedAt ?? null,
    killswitch,
    fulfillmentEnabled,
    pausedForFunds,
    pendingProposals: pendingRows[0]?.value ?? 0,
    supportPollLastSuccessAt: supportPollState.lastSuccessAt,
    supportPollConsecutiveFailures: supportPollState.consecutiveFailures,
    supportAgentRunsToday: supportAgentState.runsToday,
    supportAgentLastRun: supportAgentState.lastRun,
    scoringLastRunDate: scoringState.lastRunDate,
    scoringProductsScored: scoringState.productsScored,
    escalatedTickets,
    ordersNeedsAttention,
    sourcingLastRun,
    inventorySyncLastAt: inventorySyncState.lastAt,
    inventorySyncDegraded: inventorySyncState.degraded,
    activeProducts: catalogState.activeProducts,
    trackedVariants: catalogState.trackedVariants,
    latestListing: catalogState.latestListing,
    modes,
  }
}
