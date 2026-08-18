import type { Address, ShippingOption, WarehouseStock } from '@doge-buddy/supplier'

/**
 * Pure inputs for `planFulfillment`. Assembling these (DB reads, Shopify/CJ calls) is entirely
 * the caller's job — this module does no I/O, so gate logic is deterministic and unit-testable
 * without a database.
 */
export interface FulfillmentInputs {
  order: {
    isTest: boolean
    totalCents: number
    shippingAddress: Address
    lineItems: { variantGid: string; quantity: number }[]
  }
  settings: {
    killswitch: boolean
    fulfillmentEnabled: boolean
    pausedForFunds: boolean
    spendCapPerOrderCents: number
    marginFloorBps: number
    promisedMaxDays: number
  }
  mappings: Map<string, { supplierVariantId: string; supplierCostCents: number }> // key: variantGid
  stock: Map<string, WarehouseStock[]> // key: supplierVariantId
  freightOptions: ShippingOption[]
  walletAvailableCents: number
}

export type NeedsAttentionReason =
  | 'unmapped_item'
  | 'stockout'
  | 'no_us_stock'
  | 'no_freight_in_window'
  | 'cap_exceeded'
  | 'wallet_insufficient'
  | 'margin_below_floor'

export type Decision =
  | { kind: 'skip_test' }
  | { kind: 'requeue'; reason: 'killswitch' | 'fulfillment_disabled' | 'paused_for_funds'; delaySeconds: number }
  | { kind: 'needs_attention'; reason: NeedsAttentionReason; detail: string }
  | {
      kind: 'proceed'
      logisticName: string
      freightCents: number
      supplierItemsCents: number
      projectedTotalCents: number
      items: { supplierVariantId: string; quantity: number }[]
    }

/** Every requeue decision in gate 2 uses the same delay: retry the whole plan in 5 minutes. */
const REQUEUE_DELAY_SECONDS = 300

/**
 * Decides what to do with an order at fulfillment time. Gate order is normative:
 *   1. is_test        — test orders never reach the supplier, full stop.
 *   2. killswitch / fulfillment disabled / paused for funds — requeue, don't fail.
 *   3. unmapped line items — an item with no supplier mapping can't be sourced; needs a human.
 *
 * Gates 4-6 (stock/freight window, spend cap + wallet, margin floor) land in the next task in
 * this same file. Until then, any input that clears gates 1-3 falls through to a temporary
 * `proceed` built from the first freight option — Task 5 replaces this stub with the real gates.
 */
export function planFulfillment(inputs: FulfillmentInputs): Decision {
  // Gate 1: test orders are simulated end-to-end but must never touch the real supplier.
  if (inputs.order.isTest) {
    return { kind: 'skip_test' }
  }

  // Gate 2: global stop conditions. Each has its own reason so an operator (or a human reading
  // the queue) can tell at a glance why an order is parked, without digging into settings.
  if (inputs.settings.killswitch) {
    return { kind: 'requeue', reason: 'killswitch', delaySeconds: REQUEUE_DELAY_SECONDS }
  }
  if (!inputs.settings.fulfillmentEnabled) {
    return { kind: 'requeue', reason: 'fulfillment_disabled', delaySeconds: REQUEUE_DELAY_SECONDS }
  }
  if (inputs.settings.pausedForFunds) {
    return { kind: 'requeue', reason: 'paused_for_funds', delaySeconds: REQUEUE_DELAY_SECONDS }
  }

  // Gate 3: every line item must resolve to a supplier variant before we can price or source it.
  for (const item of inputs.order.lineItems) {
    if (!inputs.mappings.has(item.variantGid)) {
      return {
        kind: 'needs_attention',
        reason: 'unmapped_item',
        detail: `No supplier mapping for line item ${item.variantGid}`,
      }
    }
  }

  // gates 4-6 land in the next task — temporary fallthrough so gates 1-3 are testable in isolation.
  const freight = inputs.freightOptions[0]
  const items = inputs.order.lineItems.map((item) => {
    // Safe: gate 3 above already guaranteed every lineItem has a mapping.
    const mapping = inputs.mappings.get(item.variantGid)!
    return { supplierVariantId: mapping.supplierVariantId, quantity: item.quantity }
  })
  const supplierItemsCents = inputs.order.lineItems.reduce((sum, item) => {
    const mapping = inputs.mappings.get(item.variantGid)!
    return sum + mapping.supplierCostCents * item.quantity
  }, 0)
  const freightCents = freight?.priceCents ?? 0

  return {
    kind: 'proceed',
    logisticName: freight?.name ?? 'unknown',
    freightCents,
    supplierItemsCents,
    projectedTotalCents: freightCents + supplierItemsCents,
    items,
  }
}
