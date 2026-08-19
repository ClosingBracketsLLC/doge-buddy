import type { SupplierOrderStatusValue } from '@doge-buddy/supplier'
import { canTransition, type SupplierOrderStatusDb } from './transitions.ts'

/**
 * Collapses CJ's own order-status vocabulary (`SupplierOrderStatusValue` — already normalized
 * from CJ's raw string by the adapter's `mapCjOrderStatus`) down to the only `supplier_orders`
 * statuses a CJ ORDER webhook is ever allowed to drive: `shipped`, `delivered`, `cancelled`.
 *
 * Every other CJ value (`created`, `unpaid`, `pending`, `processing`, `unknown`) maps to `null` —
 * "not a signal the router acts on" — because those earlier stages of the CJ order lifecycle are
 * already driven authoritatively by our own place/pay executors (`run-place-order.ts` /
 * `run-pay-order.ts`); a webhook is a hint on top of that, never the source of truth for the
 * money-path states. The caller (webhook-process.ts) treats a `null` result the same way it
 * treats a `canTransition` failure: audit `webhook.ignored`, never throw.
 *
 * Pure and total — every `SupplierOrderStatusValue` member is covered explicitly (no `default`),
 * so a future addition to that union fails typecheck here instead of silently falling through.
 */
export function mapCjStatus(value: SupplierOrderStatusValue): SupplierOrderStatusDb | null {
  switch (value) {
    case 'shipped':
      return 'shipped'
    case 'delivered':
      return 'delivered'
    case 'cancelled':
      return 'cancelled'
    case 'created':
    case 'unpaid':
    case 'pending':
    case 'processing':
    case 'unknown':
      return null
    default: {
      const exhaustive: never = value
      throw new Error(`unhandled SupplierOrderStatusValue: ${exhaustive}`)
    }
  }
}

/** What `resolveCjTransition` decided to do with a mapped CJ status, or `null` for "ignore". */
export interface CjTransitionDecision {
  to: SupplierOrderStatusDb
  /** Set only for the cancelled-fallback case below — the direct-transition case leaves the
   *  row's existing `lastError` (if any) alone. */
  lastError?: string
  /** True when this decision took the fallback branch (CJ cancelled, direct transition illegal,
   *  parked `needs_attention` instead) — the caller uses this to decide whether to also fire the
   *  `supplier_cancelled` alert, since the ordinary direct-transition case doesn't alert. */
  isCancelledFallback: boolean
}

/**
 * Shared by both `mapCjStatus` consumers (the CJ ORDER webhook router and reconcile's sweep 3
 * status-drift poll) — same decision, same reasons, one place to keep them in sync.
 *
 * Ordinary case: `mapped` is a legal direct move from `current` per `transitions.ts`'s matrix —
 * apply it as-is.
 *
 * CJ-cancelled fallback: CJ reports `cancelled`, but the row's current status can't reach
 * `cancelled` directly — only `needs_attention` can transition there (see `LEGAL_TRANSITIONS`).
 * Without this fallback, an active row (e.g. `paid`) CJ cancelled on their end would just sit
 * `webhook.ignored` / undetected by sweep 3, staying in its stale active status until sweep 4's
 * overdue check eventually notices — no earlier than `fulfillment.promised_max_days` days later,
 * and even then mislabeled `overdue` rather than reflecting the real reason. Instead, when
 * `needs_attention` IS a legal move from `current`, park there immediately with a `lastError`
 * that says what actually happened, so an operator sees it right away.
 *
 * Returns `null` when neither move is legal (e.g. a terminal row like `delivered`, which has no
 * legal outgoing transitions at all) — caller treats that exactly like today: ignore, no write.
 */
export function resolveCjTransition(
  current: SupplierOrderStatusDb,
  mapped: SupplierOrderStatusDb,
): CjTransitionDecision | null {
  if (canTransition(current, mapped)) {
    return { to: mapped, isCancelledFallback: false }
  }
  if (mapped === 'cancelled' && canTransition(current, 'needs_attention')) {
    return {
      to: 'needs_attention',
      lastError: `supplier_cancelled: CJ reports order cancelled (was ${current})`,
      isCancelledFallback: true,
    }
  }
  return null
}
