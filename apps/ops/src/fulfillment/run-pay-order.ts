import { auditLog, type createDb, orders, supplierOrders } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { applyTransition } from './transitions.ts'
import { FULFILLMENT_RETRY_OPTS, parkNeedsAttention, type PlaceOrderDeps } from './run-place-order.ts'

type Db = ReturnType<typeof createDb>['db']
type OrderRow = typeof orders.$inferSelect
type SupplierOrderRow = typeof supplierOrders.$inferSelect

const PAY_ORDER_QUEUE = 'fulfillment.pay-order'

/** Same 5-minute delay `run-place-order.ts`'s gate-2 requeue uses — one settings recheck cadence. */
const SETTINGS_REQUEUE_DELAY_SECONDS = 300

/** A `supplier_orders.status` this executor is willing to spend money from. */
type PayableStatus = 'confirmed' | 'awaiting_funds'

function isPayable(status: SupplierOrderRow['status']): status is PayableStatus {
  return status === 'confirmed' || status === 'awaiting_funds'
}

async function loadRows(
  db: Db,
  supplierOrderRowId: string,
): Promise<{ orderRow: OrderRow; supplierOrderRow: SupplierOrderRow } | undefined> {
  const [supplierOrderRow] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, supplierOrderRowId))
  if (!supplierOrderRow) return undefined

  const [orderRow] = await db.select().from(orders).where(eq(orders.id, supplierOrderRow.orderId))
  if (!orderRow) return undefined

  return { orderRow, supplierOrderRow }
}

/**
 * Re-enqueues this same pay-order job 5 minutes out and audits why, without touching
 * `supplier_orders.status` — mirrors `run-place-order.ts`'s gate-2 requeue shape exactly (see
 * `dispatchDecision`'s `'requeue'` case) so an operator reading `audit_log` sees the same
 * `fulfillment.requeued` action for both stages of the pipeline; `stage` in `detail`
 * disambiguates which one fired.
 */
async function requeueSettingsBlocked(
  deps: PlaceOrderDeps,
  orderRow: OrderRow,
  supplierOrderRowId: string,
  reason: 'killswitch' | 'fulfillment_disabled' | 'paused_for_funds',
): Promise<void> {
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'fulfillment.requeued',
    entityType: 'order',
    entityId: orderRow.id,
    detail: { stage: 'pay_order', reason, delaySeconds: SETTINGS_REQUEUE_DELAY_SECONDS, supplierOrderRowId },
  })
  await deps.enqueue(
    PAY_ORDER_QUEUE,
    { supplierOrderRowId },
    { startAfter: SETTINGS_REQUEUE_DELAY_SECONDS, singletonKey: supplierOrderRowId, ...FULFILLMENT_RETRY_OPTS },
  )
}

/**
 * Pay-order executor: the sole entry point that spends wallet balance to pay for an already
 * placed-and-confirmed supplier order. Like `executePlaceOrder`, every status write goes through
 * `applyTransition` — nothing here ever assigns `.status` directly.
 *
 * Retry-exhaustion (a non-balance `payOrder` failure on the job's final pg-boss attempt) is
 * deliberately NOT handled in here: this function only ever throws on that failure so pg-boss's
 * bounded retries apply, and it has no visibility into `job.retryCount`/`retryLimit` (those live
 * on the pg-boss job object, not in this function's `supplierOrderRowId`-only signature). The
 * dead-letter transition to `needs_attention` on the last attempt is the job wrapper's job — see
 * `deadLetterPayOrder` below and `jobs/fulfillment-pay-order.ts`.
 */
export async function executePayOrder(deps: PlaceOrderDeps, supplierOrderRowId: string): Promise<void> {
  const rows = await loadRows(deps.db, supplierOrderRowId)
  if (!rows) {
    // Missing row is a hard failure — the job retries rather than silently no-op'ing (same
    // stance `executePlaceOrder` takes for a missing `orders` row).
    throw new Error(`supplier_orders row not found: ${supplierOrderRowId}`)
  }
  const { orderRow, supplierOrderRow } = rows

  // Step 1: only a row sitting in `confirmed` or `awaiting_funds` is ours to pay right now.
  // Anything else (already `paid`, parked `needs_attention`, `cancelled`, etc.) means another
  // caller already owns this row's next move — audit that we saw it and get out, no throw (this
  // is not an error condition, just a stale/duplicate job delivery).
  if (!isPayable(supplierOrderRow.status)) {
    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: 'fulfillment.pay_order_skipped',
      entityType: 'order',
      entityId: orderRow.id,
      detail: { supplierOrderRowId, status: supplierOrderRow.status },
    })
    return
  }
  const fromStatus: PayableStatus = supplierOrderRow.status

  // Step 2: re-check the global gates fresh (not whatever they were when this job was enqueued —
  // could be minutes or hours ago). Blocked → requeue self 5 minutes out and return; this is the
  // seam that lets `fulfillment.paused_for_funds` (set below on insufficient balance) actually
  // pause payment attempts until a wallet-monitor job clears it, without failing the job.
  const killswitch = await deps.settings.get('killswitch.global')
  const fulfillmentEnabled = await deps.settings.get('workflow.fulfillment.enabled')
  const pausedForFunds = await deps.settings.get('fulfillment.paused_for_funds')
  if (killswitch || !fulfillmentEnabled || pausedForFunds) {
    const reason = killswitch ? 'killswitch' : !fulfillmentEnabled ? 'fulfillment_disabled' : 'paused_for_funds'
    await requeueSettingsBlocked(deps, orderRow, supplierOrderRowId, reason)
    return
  }

  if (!supplierOrderRow.shipmentOrderId) {
    throw new Error(`supplier_orders row ${supplierOrderRowId} is missing shipment_order_id`)
  }

  // Step 3: the actual spend.
  const result = await deps.adapter.payOrder(supplierOrderRow.shipmentOrderId)

  if (result.paid) {
    await applyTransition(deps.db, supplierOrderRowId, fromStatus, 'paid', { paidAt: new Date() })
    return
  }

  if (result.failureReason === 'insufficient_balance') {
    // `awaiting_funds -> awaiting_funds` is not a legal transition (self-transitions never are —
    // see transitions.ts) and would throw if attempted, so only transition when we're not there
    // already: a job resumed from a prior insufficient-balance run lands here a second (or Nth)
    // time with `fromStatus === 'awaiting_funds'`, and that's a no-op by design, not an error.
    if (fromStatus === 'confirmed') {
      await applyTransition(deps.db, supplierOrderRowId, 'confirmed', 'awaiting_funds')
    }

    // Order matters here for crash-safety: alert BEFORE setting the pause flag, not after.
    //   - Crash after the transition above but before the alert/flag: the row is `awaiting_funds`,
    //     the flag is still false, no alert fired yet. A retry (or a resumed job) re-enters this
    //     same branch with `fromStatus === 'awaiting_funds'` (a no-op transition) and fires the
    //     alert then. Recoverable.
    //   - Crash after the alert but before the flag: the operator was already notified; a retry
    //     just fires a second (harmless, idempotent-in-effect) alert and then sets the flag.
    //     Recoverable.
    //   - The one ordering that is NOT safe is setting the flag first: a crash in the window
    //     between setting `fulfillment.paused_for_funds = true` and firing the alert would leave
    //     the system silently paused forever — step 2's settings gate above short-circuits BEFORE
    //     `payOrder` is ever called again on any future attempt, so this branch (and its alert)
    //     would never run again to fire the alert retroactively. Alert-first means the worst crash
    //     outcome is a duplicate alert, never a silent one.
    await deps.alert('critical', 'wallet_empty', { supplierOrderRowId })
    await deps.settings.set('fulfillment.paused_for_funds', true)
    return
  }

  // Any other failure reason: bounded pg-boss retries handle it, not us. Never transitions
  // `.status` here — the row stays exactly where it was (`confirmed`/`awaiting_funds`) so the
  // next retry attempt (or, on final-attempt exhaustion, the job wrapper's dead-letter hook)
  // re-reads the same authoritative state instead of racing ahead of it.
  throw new Error(
    `payOrder failed for supplier_orders row ${supplierOrderRowId}: ${result.failureReason ?? 'unknown reason'}`,
  )
}

/**
 * Called by the job wrapper (`jobs/fulfillment-pay-order.ts`) only when `executePayOrder` threw
 * AND pg-boss's own retry-exhaustion check (`job.retryCount >= job.retryLimit`) says this was the
 * last attempt it will make. Re-reads the row fresh (rather than trusting whatever the caller
 * still has in scope) because time has passed since the throw — a concurrent writer could have
 * already moved the row off `confirmed`/`awaiting_funds` (e.g. an operator manually intervened
 * mid-retry-window), in which case there is nothing left to dead-letter.
 */
export async function deadLetterPayOrder(deps: PlaceOrderDeps, supplierOrderRowId: string, err: unknown): Promise<void> {
  const rows = await loadRows(deps.db, supplierOrderRowId)
  if (!rows) return
  const { orderRow, supplierOrderRow } = rows
  if (!isPayable(supplierOrderRow.status)) return

  const message = err instanceof Error ? err.message : String(err)
  await parkNeedsAttention(deps, orderRow, supplierOrderRow, supplierOrderRow.status, 'pay_order_failed', message)
}
