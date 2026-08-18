import type PgBoss from 'pg-boss'
import { executeSyncTracking, type SyncTrackingDeps } from '../fulfillment/run-sync-tracking.ts'

/**
 * Worker callback for the `fulfillment.sync-tracking` queue. Thin adapter: pulls
 * `supplierOrderRowId` off each job's payload and hands it straight to the real executor
 * (`run-sync-tracking.ts`) — every bit of sync/idempotency logic lives there, not here.
 */
export function fulfillmentSyncTrackingHandler(deps: SyncTrackingDeps) {
  return async (jobs: PgBoss.Job<{ supplierOrderRowId: string }>[]): Promise<void> => {
    for (const job of jobs) {
      await executeSyncTracking(deps, job.data.supplierOrderRowId)
    }
  }
}
