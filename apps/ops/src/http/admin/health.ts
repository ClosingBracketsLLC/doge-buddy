import { agentRuns, auditLog, gmailSyncState, proposals, webhookEvents } from '@doge-buddy/db'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { AGENT_RUN_AUDIT_ACTION } from '../../jobs/support-agent-run.ts'
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
  }
}
