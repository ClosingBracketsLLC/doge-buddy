import type { SupplierOrderStatusValue } from '@doge-buddy/supplier'
import type { SupplierOrderStatusDb } from './transitions.ts'

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
