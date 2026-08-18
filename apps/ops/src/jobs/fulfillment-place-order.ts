import type PgBoss from 'pg-boss'
import { executePlaceOrder, type PlaceOrderDeps } from '../fulfillment/run-place-order.ts'

/**
 * Worker callback for the `fulfillment.place-order` queue. Thin adapter: pulls `orderGid` off
 * each job's payload and hands it straight to the real executor (`run-place-order.ts`) — every
 * bit of placement logic, resume semantics, and money-gate enforcement lives there, not here.
 */
export function fulfillmentPlaceOrderHandler(deps: PlaceOrderDeps) {
  return async (jobs: PgBoss.Job<{ orderGid: string }>[]): Promise<void> => {
    for (const job of jobs) {
      await executePlaceOrder(deps, job.data.orderGid)
    }
  }
}
