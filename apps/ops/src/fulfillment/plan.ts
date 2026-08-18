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
 *   4. US stock        — every supplier variant needs enough US stock to cover total demand.
 *   5. freight window   — cheapest freight option that still lands within the promised window.
 *   6. money            — spend cap, then wallet balance, then margin floor, in that order.
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
  // Resolved once into `resolvedItems`, reused by gates 4-6 below — no repeated map lookups, and
  // no `mappings.get(...)!` assertions past this point (this loop is the only place that needs one,
  // and only implicitly: a miss here returns immediately instead of falling through).
  const resolvedItems: { supplierVariantId: string; supplierCostCents: number; quantity: number }[] = []
  for (const item of inputs.order.lineItems) {
    const mapping = inputs.mappings.get(item.variantGid)
    if (!mapping) {
      return {
        kind: 'needs_attention',
        reason: 'unmapped_item',
        detail: `No supplier mapping for line item ${item.variantGid}`,
      }
    }
    resolvedItems.push({
      supplierVariantId: mapping.supplierVariantId,
      supplierCostCents: mapping.supplierCostCents,
      quantity: item.quantity,
    })
  }

  // Gate 4: US stock must cover total demand per supplier variant. Two line items that resolve
  // to the same supplier variant share one stock pool, so needed quantity is summed across line
  // items before comparing to stock — checking each line item in isolation would miss the case
  // where each individually fits but their combined demand doesn't.
  const neededBySupplierVariant = new Map<string, number>()
  for (const item of resolvedItems) {
    neededBySupplierVariant.set(
      item.supplierVariantId,
      (neededBySupplierVariant.get(item.supplierVariantId) ?? 0) + item.quantity,
    )
  }
  for (const [supplierVariantId, needed] of neededBySupplierVariant) {
    const usEntries = (inputs.stock.get(supplierVariantId) ?? []).filter((entry) => entry.countryCode === 'US')
    if (usEntries.length === 0) {
      return {
        kind: 'needs_attention',
        reason: 'no_us_stock',
        detail: `No US stock entry for supplier variant ${supplierVariantId}`,
      }
    }
    if (!usEntries.some((entry) => entry.quantity >= needed)) {
      return {
        kind: 'needs_attention',
        reason: 'stockout',
        detail: `Insufficient US stock for supplier variant ${supplierVariantId}: need ${needed}`,
      }
    }
  }

  // Gate 5: cheapest freight option that still lands within the promised window. An order with no
  // option in the window is a hard stop, not a silent fallback to whatever option came first.
  const eligibleFreight = inputs.freightOptions.filter((option) => option.maxDays <= inputs.settings.promisedMaxDays)
  if (eligibleFreight.length === 0) {
    return {
      kind: 'needs_attention',
      reason: 'no_freight_in_window',
      detail: `No freight option lands within ${inputs.settings.promisedMaxDays} days`,
    }
  }
  let chosenFreight = eligibleFreight[0]!
  for (const option of eligibleFreight.slice(1)) {
    if (option.priceCents < chosenFreight.priceCents) {
      chosenFreight = option
    }
  }

  // Gate 6: money checks, in order — spend cap, then wallet balance, then margin floor (the
  // price-drift trap: supplier cost can rise between listing time and order time).
  const supplierItemsCents = resolvedItems.reduce((sum, item) => sum + item.supplierCostCents * item.quantity, 0)
  const freightCents = chosenFreight.priceCents
  const projectedTotalCents = supplierItemsCents + freightCents

  if (projectedTotalCents > inputs.settings.spendCapPerOrderCents) {
    return {
      kind: 'needs_attention',
      reason: 'cap_exceeded',
      detail: `Projected total ${projectedTotalCents}c exceeds spend cap ${inputs.settings.spendCapPerOrderCents}c`,
    }
  }
  if (projectedTotalCents > inputs.walletAvailableCents) {
    return {
      kind: 'needs_attention',
      reason: 'wallet_insufficient',
      detail: `Projected total ${projectedTotalCents}c exceeds wallet balance ${inputs.walletAvailableCents}c`,
    }
  }
  // Integer basis-point math, floored (never rounded), so a margin that's a hair under the floor
  // never gets rounded up into a false pass.
  const marginBps = Math.floor(((inputs.order.totalCents - projectedTotalCents) * 10_000) / inputs.order.totalCents)
  if (marginBps < inputs.settings.marginFloorBps) {
    return {
      kind: 'needs_attention',
      reason: 'margin_below_floor',
      detail: `Margin ${marginBps}bps is below floor ${inputs.settings.marginFloorBps}bps`,
    }
  }

  // items is aggregated per supplierVariantId from the same neededBySupplierVariant map gate 4
  // already built (not a fresh map over resolvedItems) — two line items resolving to the same
  // supplier variant must collapse into one entry with the summed quantity here. Emitting one row
  // per line item would let a duplicate supplierVariantId reach the supplier's order API, which
  // is an unverified hazard for CJ (controller ruling, Task 5 review).
  return {
    kind: 'proceed',
    logisticName: chosenFreight.name,
    freightCents,
    supplierItemsCents,
    projectedTotalCents,
    items: [...neededBySupplierVariant].map(([supplierVariantId, quantity]) => ({ supplierVariantId, quantity })),
  }
}
