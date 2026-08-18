import type PgBoss from 'pg-boss'
import type { PlaceOrderDeps } from '../fulfillment/run-place-order.ts'

/**
 * Worker callback for the `fulfillment.pay-order` queue.
 *
 * Shell only: `executePayOrder` (the real payment executor) lands in Task 11, in a new
 * `run-pay-order.ts`. This throws deliberately instead of no-op'ing or faking a result — paying
 * a supplier order moves real money, so pretending success (or silently doing nothing) here
 * would be worse than an obvious, loud failure. Wiring is complete now: Task 11 only needs to
 * swap this function's body for a call to the real executor; the queue, dedupe, and retry
 * plumbing around it already work.
 */
export function fulfillmentPayOrderHandler(_deps: PlaceOrderDeps) {
  return async (_jobs: PgBoss.Job<{ supplierOrderRowId: string }>[]): Promise<void> => {
    throw new Error('executePayOrder lands in Task 11')
  }
}
