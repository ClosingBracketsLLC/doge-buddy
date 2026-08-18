import { auditLog, type createDb, supplierOrders } from '@doge-buddy/db'
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
 * Records one row's caught resume-enqueue failure — same shape as `run-reconcile.ts`'s own
 * `auditRowFailure`: a durable `audit_log` row (action `wallet_monitor.row_failed`) plus the loop
 * that caught it moving on to the next row instead of aborting the rest of the resume batch.
 */
async function auditRowFailure(db: Db, supplierOrderRowId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await db.insert(auditLog).values({
    actor: 'system',
    action: 'wallet_monitor.row_failed',
    entityType: 'supplier_order',
    entityId: supplierOrderRowId,
    detail: { message },
  })
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
 *      blocking on funds for; if the wallet now covers all of them combined, every one of those
 *      rows gets its `fulfillment.pay-order` job re-enqueued (same singletonKey + retry shape
 *      place-order/pay-order already use everywhere) — each row's enqueue is isolated in its own
 *      try/catch, so one row's failure doesn't stop the rest of the batch — and the pause is
 *      lifted only once at least one row actually got re-enqueued (a fully-failed batch leaves the
 *      pause in place and alerts instead; see the ordering comment further down for why). If the
 *      wallet does not yet cover the full sum, nothing is enqueued and the pause simply stays in
 *      effect until a later run (or a bigger top-up) clears it.
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

  // Enqueue every row BEFORE clearing the pause flag, with each row isolated in its own
  // try/catch (same pattern as `run-reconcile.ts`'s sweeps) — one row's enqueue failure doesn't
  // stop the rest of the batch from being resumed; it's counted and audit-logged
  // (`wallet_monitor.row_failed`) instead.
  //
  // This ordering is the mirror image of `run-pay-order.ts`'s alert-before-flag reasoning (see
  // that file's own doc comment on the `insufficient_balance` branch): there, setting the pause
  // flag closes a gate on a FUTURE check (`executePayOrder`'s own settings gate), so whatever must
  // survive that gate closing (the alert) has to happen first. Here, clearing the pause flag
  // closes the ONE gate (`if (!paused) return`, above) that lets a future wallet-monitor tick ever
  // look at `awaiting_funds` rows again — so any row not yet successfully enqueued by the time the
  // flag flips to false would never get another automatic chance; it would sit dead until sweep
  // 4's ~7-day overdue sweep eventually parks it `needs_attention`. Enqueue-first, flag-last means
  // the worst crash outcome (a crash between one row's successful enqueue and the flag write) is a
  // harmless re-enqueue of an already-queued row on the next tick (`singletonKey` makes re-sends
  // safe) — never a silently stranded one.
  let resumedCount = 0
  let failedCount = 0
  for (const row of awaitingRows) {
    try {
      await deps.enqueue(
        PAY_ORDER_QUEUE,
        { supplierOrderRowId: row.id },
        { singletonKey: row.id, ...FULFILLMENT_RETRY_OPTS },
      )
      resumedCount += 1
    } catch (err) {
      failedCount += 1
      await auditRowFailure(deps.db, row.id, err)
    }
  }

  // Every row that needed enqueuing failed to enqueue — leave the pause in place rather than
  // clearing it over a batch nothing actually got queued for. The next tick re-evaluates the same
  // rows from scratch (still `awaiting_funds`, still summed fresh); `singletonKey` makes retrying
  // the same rows' sends safe even if some of THIS batch's failures were transient partial
  // successes on pg-boss's side.
  if (awaitingRows.length > 0 && resumedCount === 0) {
    await deps.alert('warning', 'wallet_resume_failed', { failures: failedCount })
    return
  }

  await deps.settings.set('fulfillment.paused_for_funds', false)
  await deps.alert('info', 'wallet_recovered', { resumedCount, failedCount, availableCents })
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
