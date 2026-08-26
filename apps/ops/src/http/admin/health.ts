import { gmailSyncState, proposals, webhookEvents } from '@doge-buddy/db'
import { count, desc, eq, sql } from 'drizzle-orm'
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
  }
}
