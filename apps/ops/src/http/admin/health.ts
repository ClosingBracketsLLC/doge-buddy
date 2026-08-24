import { proposals, webhookEvents } from '@doge-buddy/db'
import { count, desc, eq, sql } from 'drizzle-orm'
import type { AdminDeps } from './routes.ts'

export interface HealthStrip {
  /** null => 'n/a' on the page: no getWalletBalance dep wired, or the live call threw. */
  walletCents: number | null
  /** pgboss.job rows in state IN ('created','retry','active'); 0 if the pgboss schema doesn't exist yet. */
  queueDepth: number
  lastWebhookAt: Date | null
  killswitch: boolean
  fulfillmentEnabled: boolean
  pausedForFunds: boolean
  pendingProposals: number
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

/** The dashboard's top-of-page health strip: wallet, queue depth, last webhook, the three kill switches, pending proposals. */
export async function loadHealthStrip(deps: AdminDeps): Promise<HealthStrip> {
  const [walletCents, queueDepth, lastWebhookRows, killswitch, fulfillmentEnabled, pausedForFunds, pendingRows] =
    await Promise.all([
      loadWalletCents(deps),
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
    ])

  return {
    walletCents,
    queueDepth,
    lastWebhookAt: lastWebhookRows[0]?.receivedAt ?? null,
    killswitch,
    fulfillmentEnabled,
    pausedForFunds,
    pendingProposals: pendingRows[0]?.value ?? 0,
  }
}
