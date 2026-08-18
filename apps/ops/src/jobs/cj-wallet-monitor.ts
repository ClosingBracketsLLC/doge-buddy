import { type createDb, supplierOrders } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { createAlerter } from '../alerts.ts'
import { FULFILLMENT_RETRY_OPTS } from '../fulfillment/run-place-order.ts'
import type { SendOpts } from '../fulfillment/types.ts'
import type { createSettings } from '../settings.ts'

type Db = ReturnType<typeof createDb>['db']

const PAY_ORDER_QUEUE = 'fulfillment.pay-order'

export interface WalletMonitorDeps {
  db: Db
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
}

/**
 * `cj.wallet-monitor` (Task 15) — the counterpart to `run-pay-order.ts`'s pause-for-funds
 * (Task 11): every 4 hours, checks the supplier wallet balance and does two independent things
 * with it:
 *
 *   1. Low-balance alert: `availableCents` below `fulfillment.wallet_alert_threshold_cents` fires
 *      a `wallet_low` critical alert, regardless of whether the system is currently paused — an
 *      operator watching the balance trend wants this warning even before a pause is triggered.
 *      This is a distinct alert kind from `run-pay-order.ts`'s `wallet_empty` (fired the moment a
 *      payment attempt actually fails on insufficient balance); keeping them separate lets an
 *      operator tell "balance is getting low" apart from "a payment just failed for real".
 *
 *   2. Auto-resume: only attempted when `fulfillment.paused_for_funds` is already true. Every
 *      `supplier_orders` row sitting in `awaiting_funds` is a payment this system is currently
 *      blocking on funds for; if the wallet now covers all of them combined, the pause is lifted
 *      and every one of those rows gets its `fulfillment.pay-order` job re-enqueued (same
 *      singletonKey + retry shape place-order/pay-order already use everywhere) so each one gets
 *      its own fresh payment attempt rather than waiting on whatever requeue delay it was already
 *      sitting on. If the wallet does not yet cover the full sum, nothing is enqueued and the
 *      pause simply stays in effect until a later run (or a bigger top-up) clears it.
 */
export async function executeWalletMonitor(deps: WalletMonitorDeps): Promise<void> {
  const { availableCents } = await deps.adapter.getBalance()

  const thresholdCents = await deps.settings.get('fulfillment.wallet_alert_threshold_cents')
  if (availableCents < thresholdCents) {
    await deps.alert('critical', 'wallet_low', { availableCents, thresholdCents })
  }

  const paused = await deps.settings.get('fulfillment.paused_for_funds')
  if (!paused) return // nothing parked on funds — no resume check to run

  const awaitingRows = await deps.db.select().from(supplierOrders).where(eq(supplierOrders.status, 'awaiting_funds'))

  // A NULL total_amount_cents means this particular row's cost genuinely isn't known (e.g. it
  // reached `awaiting_funds` before pricing was ever recorded on it) — there's no safe number to
  // substitute. Rather than guess (and risk resuming payment attempts the wallet can't actually
  // cover) or silently resume only the rows we CAN price (an inconsistent partial recovery), any
  // single unknown-amount row blocks resuming ALL of them, deterministically, until an operator
  // resolves the unpriced row.
  if (awaitingRows.some((row) => row.totalAmountCents == null)) {
    await deps.alert('warning', 'wallet_resume_blocked', { reason: 'unknown_amounts' })
    return
  }

  const totalOwedCents = awaitingRows.reduce((sum, row) => sum + row.totalAmountCents!, 0)
  if (availableCents < totalOwedCents) return // still short — stays paused, nothing enqueued

  await deps.settings.set('fulfillment.paused_for_funds', false)
  for (const row of awaitingRows) {
    await deps.enqueue(
      PAY_ORDER_QUEUE,
      { supplierOrderRowId: row.id },
      { singletonKey: row.id, ...FULFILLMENT_RETRY_OPTS },
    )
  }
  await deps.alert('info', 'wallet_recovered', { resumedCount: awaitingRows.length, availableCents })
}

/**
 * Worker callback for the `cj.wallet-monitor` cron queue. Same thin-adapter shape as
 * `fulfillmentReconcileHandler` (jobs/fulfillment-reconcile.ts): the job payload carries no data
 * (this is a cron trigger, not a per-entity job) — all of the actual logic lives in
 * `executeWalletMonitor` above, not here.
 */
export function cjWalletMonitorHandler(deps: WalletMonitorDeps) {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    for (const _job of jobs) {
      await executeWalletMonitor(deps)
    }
  }
}
