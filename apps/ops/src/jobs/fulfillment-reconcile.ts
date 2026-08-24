import type PgBoss from 'pg-boss'
import { sweepOrphanRuns } from '../agents/lifecycle.ts'
import { executeReconcile, type ReconcileDeps } from '../fulfillment/run-reconcile.ts'

/**
 * Worker callback for the `fulfillment.reconcile` cron queue. Thin adapter, same shape as every
 * other queue wrapper in this directory: the job payload carries no data (this is a cron trigger,
 * not a per-entity job) — all four sweeps' logic lives in `run-reconcile.ts`, not here.
 *
 * Also runs `sweepOrphanRuns` here (spec §Stage 3 mandates it "at ops boot AND in the hourly
 * reconcile cron" — FIX C1). It runs FIRST and `.catch`-guarded so (a) a sweep failure can never
 * break the order reconciliation below, and (b) a wedged `agent_runs` row still heals within ≤1h
 * even in a deployment where a reconcile sweep itself throws (e.g. Shopify not configured). The
 * `deps` already carry the `db` + `alert` the sweep needs.
 */
export function fulfillmentReconcileHandler(deps: ReconcileDeps) {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    await sweepOrphanRuns(deps.db, deps.alert).catch(() => {})
    for (const _job of jobs) {
      await executeReconcile(deps)
    }
  }
}
