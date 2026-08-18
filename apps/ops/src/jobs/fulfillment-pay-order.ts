import type PgBoss from 'pg-boss'
import { deadLetterPayOrder, executePayOrder } from '../fulfillment/run-pay-order.ts'
import type { PlaceOrderDeps } from '../fulfillment/run-place-order.ts'

/**
 * Only the fields this handler actually reads off a pg-boss job — a strict structural subset of
 * `PgBoss.JobWithMetadata<T>`, same spirit as `fulfillment/types.ts`'s `SendOpts` being a subset
 * of `PgBoss.SendOptions`. Keeps test fixtures (and this file) from having to fake out the dozen
 * metadata fields (`state`, `priority`, `singletonOn`, ...) this handler never looks at.
 */
type PayOrderJob = Pick<
  PgBoss.JobWithMetadata<{ supplierOrderRowId: string }>,
  'id' | 'name' | 'data' | 'retryCount' | 'retryLimit'
>

/**
 * Worker callback for the `fulfillment.pay-order` queue. Thin adapter over the real executor
 * (`run-pay-order.ts`) with one piece of job-lifecycle logic that can't live in the executor
 * itself: retry-exhaustion dead-lettering.
 *
 * `executePayOrder` throws on any non-`insufficient_balance` `payOrder` failure so pg-boss's
 * bounded retries (`retryLimit: 5`, set on every `fulfillment.pay-order` send — see
 * `run-place-order.ts`'s `FULFILLMENT_RETRY_OPTS`) apply. But once pg-boss has exhausted those
 * retries, the row would otherwise sit forever in `confirmed`/`awaiting_funds` with no operator
 * signal — pg-boss's own `failed` state is not visible anywhere a human looks. This wrapper is
 * registered via `boss.work(PAY_ORDER_QUEUE, { includeMetadata: true }, ...)` (queue.ts) so pg-boss
 * hands it `JobWithMetadata`, which — unlike the plain `Job` the place-order handler gets — carries
 * `retryCount`/`retryLimit`. `retryCount >= retryLimit` on the attempt that just threw is exactly
 * pg-boss's own "will this be retried again?" condition (see `failJobs` in pg-boss's plans.js:
 * a failure only re-queues as `retry` when `retry_count < retry_limit`, else it goes `failed`
 * for good) — so checking it here, before rethrowing, reliably fires the dead-letter transition
 * on the same attempt pg-boss gives up on, and never on an attempt that still has retries left.
 */
export function fulfillmentPayOrderHandler(deps: PlaceOrderDeps) {
  return async (jobs: PayOrderJob[]): Promise<void> => {
    for (const job of jobs) {
      try {
        await executePayOrder(deps, job.data.supplierOrderRowId)
      } catch (err) {
        if (job.retryCount >= job.retryLimit) {
          try {
            await deadLetterPayOrder(deps, job.data.supplierOrderRowId, err)
          } catch (dlqErr) {
            // Best-effort: never let a failure in the dead-letter transition itself swallow the
            // original error below — pg-boss still needs to see this job fail either way.
            console.error('[fulfillment.pay-order] dead-letter transition failed', dlqErr)
          }
        }
        throw err
      }
    }
  }
}
