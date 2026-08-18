/**
 * pg-boss send options threaded through every `enqueue` call across the fulfillment pipeline
 * (webhook router, place/pay/sync-tracking jobs, reconcile sweeps). Kept as a small local type
 * — a strict structural subset of `PgBoss.SendOptions` — so callers don't need to depend on
 * pg-boss's full option surface for the handful of fields this codebase actually sets.
 */
export type SendOpts = {
  singletonKey?: string
  retryLimit?: number
  retryBackoff?: boolean
  retryDelay?: number
  startAfter?: number
}
