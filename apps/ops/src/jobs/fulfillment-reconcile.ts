import type PgBoss from 'pg-boss'
import { executeReconcile, type ReconcileDeps } from '../fulfillment/run-reconcile.ts'

/**
 * Worker callback for the `fulfillment.reconcile` cron queue. Thin adapter, same shape as every
 * other queue wrapper in this directory: the job payload carries no data (this is a cron trigger,
 * not a per-entity job) — all four sweeps' logic lives in `run-reconcile.ts`, not here.
 */
export function fulfillmentReconcileHandler(deps: ReconcileDeps) {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    for (const _job of jobs) {
      await executeReconcile(deps)
    }
  }
}
