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
    /** The window THIS leg's buyer was actually shown — the slowest `delivery_max_days` among the
     *  leg's variants, falling back to the `fulfillment.promised_max_days` setting only for
     *  pre-pivot rows that store no window. Never a site-wide promise (spec 2026-09-06 §5). */
    promisedMaxDays: number
  }
  mappings: Map<string, { supplierVariantId: string; supplierCostCents: number }> // key: variantGid
  /** The warehouse THIS leg ships from ('US' | 'CN'). Gate 4 checks stock here and nowhere else,
   *  and the caller must have quoted `freightOptions` from the same origin — a quote from anywhere
   *  else prices a shipment we will never make. */
  origin: string
  /** Cents this customer order's OTHER legs have already committed (spec 2026-09-06 R3). Gates 6's
   *  cap and margin checks add it to this leg's projected total: checking either per leg would let
   *  a two-leg order spend the cap twice, or pass a margin floor the order as a whole fails.
   *  Deliberately NOT added to the wallet check — the balance is re-read before each leg and
   *  already reflects the earlier spend, so adding it again would double-count it. */
  committedCents: number
  stock: Map<string, WarehouseStock[]> // key: supplierVariantId
  freightOptions: ShippingOption[]
  walletAvailableCents: number
}

export type NeedsAttentionReason =
  | 'unmapped_item'
  | 'stockout'
  | 'no_origin_stock'
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
 *   4. origin stock    — every supplier variant needs enough stock IN THE LEG'S OWN warehouse
 *                        to cover total demand.
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

  // Gate 4: stock in the LEG'S OWN warehouse must cover total demand per supplier variant. Two
  // line items that resolve
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
    const originEntries = (inputs.stock.get(supplierVariantId) ?? []).filter((entry) => entry.countryCode === inputs.origin)
    if (originEntries.length === 0) {
      return {
        kind: 'needs_attention',
        reason: 'no_origin_stock',
        detail: `No ${inputs.origin} stock entry for supplier variant ${supplierVariantId}`,
      }
    }
    if (!originEntries.some((entry) => entry.quantity >= needed)) {
      return {
        kind: 'needs_attention',
        reason: 'stockout',
        detail: `Insufficient ${inputs.origin} stock for supplier variant ${supplierVariantId}: need ${needed}`,
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

  // Spec 2026-09-06 R3: the cap and the floor are promises about the whole CUSTOMER order, so both
  // gate on this leg's cost PLUS what the order's other legs already committed. The wallet check
  // between them stays per leg — its number was re-read after that spend.
  const orderProjectedCents = inputs.committedCents + projectedTotalCents

  if (orderProjectedCents > inputs.settings.spendCapPerOrderCents) {
    return {
      kind: 'needs_attention',
      reason: 'cap_exceeded',
      detail: `Order total ${orderProjectedCents}c (this leg ${projectedTotalCents}c + ${inputs.committedCents}c already committed) exceeds spend cap ${inputs.settings.spendCapPerOrderCents}c`,
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
  const marginBps = Math.floor(((inputs.order.totalCents - orderProjectedCents) * 10_000) / inputs.order.totalCents)
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
