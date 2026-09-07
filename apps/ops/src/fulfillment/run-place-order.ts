import {
  auditLog,
  type createDb,
  orders,
  productVariants,
  supplierOrders,
  supplierVariantMappings,
} from '@doge-buddy/db'
import type { Address, SupplierAdapter, WarehouseStock } from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import type { createAlerter } from '../alerts.ts'
import type { createSettings } from '../settings.ts'
import type { ShopifyOrderPaidPayload } from './order-upsert.ts'
import { planFulfillment, type Decision, type FulfillmentInputs } from './plan.ts'
import { applyTransition, type SupplierOrderStatusDb } from './transitions.ts'
import type { SendOpts } from './types.ts'

type Db = ReturnType<typeof createDb>['db']
type OrderRow = typeof orders.$inferSelect
type SupplierOrderRow = typeof supplierOrders.$inferSelect

/** What `loadMappings` resolves per line item: the supplier variant to order, its cost, and the
 *  two facts the 2026-09-06 split turns on — which warehouse ships it, and the delivery window
 *  its buyer was actually shown. */
interface MappingRow {
  supplierVariantId: string
  supplierCostCents: number
  warehouseCountry: string
  deliveryMaxDays: number | null
}

/** One warehouse's worth of a customer order: the line items that ship from it, and the window
 *  their buyers were shown. `promisedMaxDays` is the SLOWEST of those windows — the leg ships
 *  together, so its promise is its slowest item — or null when every item in it predates the
 *  stored window and must fall back to `fulfillment.promised_max_days`. */
interface Leg {
  origin: string
  lineItems: { variantGid: string; quantity: number }[]
  promisedMaxDays: number | null
}

export interface PlaceOrderDeps {
  db: Db
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
}

/**
 * Send options for the fulfillment queues this executor enqueues into (design spec, exact).
 * Exported so `run-pay-order.ts` (Task 11) can apply the identical retry/backoff shape to its
 * own self-requeues (paused settings) — one literal, not a second copy drifting out of sync.
 */
export const FULFILLMENT_RETRY_OPTS: SendOpts = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }

/** The warehouse an order-level park is recorded against when there is no leg to speak of (no
 *  usable address, an unmapped item). Matches the `supplier_orders.warehouse_country` default, so
 *  a single-origin US order's row is bit-for-bit what it was before the split. */
const DEFAULT_ORIGIN = 'US'

const PLACE_ORDER_QUEUE = 'fulfillment.place-order'
const PAY_ORDER_QUEUE = 'fulfillment.pay-order'

/**
 * `supplier_orders.idempotency_key` = `db-` + digits of the Shopify order gid + the leg's
 * warehouse (Global Constraints, extended by the 2026-09-06 origin split), e.g.
 * `gid://shopify/Order/123`'s CN leg -> `db-123-CN`. Deterministic, short, CJ-safe, and distinct
 * per leg — two legs of one customer order ARE two independent CJ orders.
 */
function idempotencyKeyFor(orderGid: string, origin: string): string {
  return `db-${orderGid.replace(/\D/g, '')}-${origin}`
}

async function auditSkippedTest(db: Db, orderRow: OrderRow): Promise<void> {
  await db.insert(auditLog).values({
    actor: 'system',
    action: 'fulfillment.skipped_test',
    entityType: 'order',
    entityId: orderRow.id,
    detail: { orderGid: orderRow.shopifyOrderGid },
  })
}

async function enqueuePayOrder(deps: PlaceOrderDeps, supplierOrderRowId: string): Promise<void> {
  await deps.enqueue(
    PAY_ORDER_QUEUE,
    { supplierOrderRowId },
    { singletonKey: supplierOrderRowId, ...FULFILLMENT_RETRY_OPTS },
  )
}

/**
 * Loads the (order, supplier) `supplier_orders` row, creating it as `pending` with its
 * deterministic idempotency key if it doesn't exist yet. The unique index on
 * `(order_id, supplier)` makes the insert safe to race: if another writer created the row
 * between our SELECT and INSERT, `onConflictDoNothing` no-ops and we re-read it.
 */
async function loadOrCreateSupplierOrder(
  db: Db,
  orderRow: OrderRow,
  supplier: SupplierAdapter['key'],
  origin: string,
): Promise<SupplierOrderRow> {
  const whereLeg = and(
    eq(supplierOrders.orderId, orderRow.id),
    eq(supplierOrders.supplier, supplier),
    eq(supplierOrders.warehouseCountry, origin),
  )
  const [existing] = await db.select().from(supplierOrders).where(whereLeg)
  if (existing) return existing

  const [inserted] = await db
    .insert(supplierOrders)
    .values({
      orderId: orderRow.id,
      supplier,
      warehouseCountry: origin,
      idempotencyKey: idempotencyKeyFor(orderRow.shopifyOrderGid, origin),
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [supplierOrders.orderId, supplierOrders.supplier, supplierOrders.warehouseCountry],
    })
    .returning()
  if (inserted) return inserted

  const [row] = await db.select().from(supplierOrders).where(whereLeg)
  return row!
}

/** Normalizes a Shopify REST line item's numeric `variant_id` into the full gid used everywhere else. */
function extractLineItems(orderRow: OrderRow): { variantGid: string; quantity: number }[] {
  const payload = (orderRow.rawPayload ?? {}) as ShopifyOrderPaidPayload
  const lineItems = payload.line_items ?? []
  return lineItems.map((item) => ({
    variantGid: `gid://shopify/ProductVariant/${item.variant_id}`,
    quantity: item.quantity,
  }))
}

/**
 * Joins `supplier_variant_mappings` + `product_variants.supplier_cost_cents` by variant gid, for
 * the given supplier. A mapping with a null `supplier_cost_cents` (cost not yet known) is
 * deliberately excluded rather than defaulted to 0 — that would silently misprice the order — so
 * it falls through to the planner's gate-3 unmapped-item check exactly like a missing mapping.
 */
async function loadMappings(
  db: Db,
  supplier: SupplierAdapter['key'],
  lineItems: { variantGid: string; quantity: number }[],
): Promise<Map<string, MappingRow>> {
  const map = new Map<string, MappingRow>()
  const gids = [...new Set(lineItems.map((item) => item.variantGid))]
  if (gids.length === 0) return map

  const rows = await db
    .select({
      shopifyVariantGid: productVariants.shopifyVariantGid,
      supplierCostCents: productVariants.supplierCostCents,
      supplierVariantId: supplierVariantMappings.supplierVariantId,
      warehouseCountry: supplierVariantMappings.warehouseCountry,
      deliveryMaxDays: supplierVariantMappings.deliveryMaxDays,
    })
    .from(supplierVariantMappings)
    .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(and(inArray(productVariants.shopifyVariantGid, gids), eq(supplierVariantMappings.supplier, supplier)))

  for (const row of rows) {
    if (row.shopifyVariantGid == null || row.supplierCostCents == null) continue
    map.set(row.shopifyVariantGid, {
      supplierVariantId: row.supplierVariantId,
      supplierCostCents: row.supplierCostCents,
      warehouseCountry: row.warehouseCountry,
      deliveryMaxDays: row.deliveryMaxDays,
    })
  }
  return map
}

/**
 * Sums quantity per supplierVariantId across the order's (mapped) line items. Used to gather
 * `getVariantStock`/`quoteShipping` inputs deduplicated per supplier variant — the same class of
 * duplicate-row hazard the controller flagged for the planner's `proceed.items` (Task 5 review)
 * applies equally to a freight quote or a repeated stock lookup, so this executor never sends a
 * supplier variant id more than once per call either. Line items with no mapping are skipped here
 * — the planner's gate 3 independently reports those as `unmapped_item` from the raw line items.
 */
function aggregateNeeded(
  lineItems: { variantGid: string; quantity: number }[],
  mappings: Map<string, MappingRow>,
): Map<string, number> {
  const needed = new Map<string, number>()
  for (const item of lineItems) {
    const mapping = mappings.get(item.variantGid)
    if (!mapping) continue
    needed.set(mapping.supplierVariantId, (needed.get(mapping.supplierVariantId) ?? 0) + item.quantity)
  }
  return needed
}

/**
 * Groups mapped line items by their mapping's warehouse. CJ takes one origin and one carrier per
 * order, so a cart that mixes warehouses cannot be expressed as a single supplier order — it
 * becomes one leg per warehouse (owner ruling, spec 2026-09-06 R1).
 *
 * US first, then everything else alphabetically. The order is deliberate, not cosmetic: under a
 * tight wallet or spend cap the FAST leg is the one that gets placed, so the customer sees
 * something arrive quickly while the slow leg is resolved by hand.
 */
function groupLegs(lineItems: { variantGid: string; quantity: number }[], mappings: Map<string, MappingRow>): Leg[] {
  const byOrigin = new Map<string, Leg>()
  for (const item of lineItems) {
    const mapping = mappings.get(item.variantGid)
    if (!mapping) continue // unmapped items are handled by the caller, before any leg is placed
    const leg = byOrigin.get(mapping.warehouseCountry) ?? {
      origin: mapping.warehouseCountry,
      lineItems: [],
      promisedMaxDays: null,
    }
    leg.lineItems.push(item)
    if (mapping.deliveryMaxDays != null) {
      leg.promisedMaxDays = Math.max(leg.promisedMaxDays ?? 0, mapping.deliveryMaxDays)
    }
    byOrigin.set(mapping.warehouseCountry, leg)
  }
  return [...byOrigin.values()].sort((a, b) =>
    a.origin === b.origin ? 0 : a.origin === 'US' ? -1 : b.origin === 'US' ? 1 : a.origin.localeCompare(b.origin),
  )
}

/**
 * What this order's OTHER legs have already committed to spend (spec 2026-09-06 R3). The spend cap
 * and the margin floor are promises about the whole CUSTOMER order, so both must count it —
 * checking either per leg would let a two-leg order spend the cap twice, or pass a margin floor
 * the order as a whole fails.
 *
 * `pending` rows never reached the supplier and `cancelled`/`failed` ones had their money come
 * back, so neither commits anything. Everything else does — including a row parked into
 * `needs_attention` AFTER its placement, whose money is very much spent.
 */
async function committedCentsForOtherLegs(db: Db, orderId: string, exceptRowId: string): Promise<number> {
  const rows = await db
    .select({ id: supplierOrders.id, status: supplierOrders.status, totalAmountCents: supplierOrders.totalAmountCents })
    .from(supplierOrders)
    .where(eq(supplierOrders.orderId, orderId))

  let total = 0
  for (const row of rows) {
    if (row.id === exceptRowId) continue
    if (row.status === 'pending' || row.status === 'cancelled' || row.status === 'failed') continue
    total += row.totalAmountCents ?? 0
  }
  return total
}

/**
 * Transitions the row to `needs_attention` (from any status the legal-transition matrix allows
 * into `needs_attention` — `pending`/`created` for this module's own callers, plus
 * `confirmed`/`awaiting_funds` for `run-pay-order.ts`'s (Task 11) retry-exhaustion dead-letter),
 * persists `lastError = '<reason>: <detail>'`, and alerts. Shared by the planner's own
 * `needs_attention` decision, the post-create spend-cap re-check, the missing-shipping-address
 * guard, and the pay-order dead-letter hook — all park the order identically, so this is the one
 * place that shape is defined. Exported for that reuse.
 */
export async function parkNeedsAttention(
  deps: PlaceOrderDeps,
  orderRow: OrderRow,
  supplierOrderRow: SupplierOrderRow,
  from: 'pending' | 'created' | 'confirmed' | 'awaiting_funds',
  reason: string,
  detail: string,
): Promise<void> {
  await applyTransition(deps.db, supplierOrderRow.id, from, 'needs_attention', {
    lastError: `${reason}: ${detail}`,
  })
  await deps.alert('warning', 'fulfillment_needs_attention', {
    orderId: orderRow.id,
    orderGid: orderRow.shopifyOrderGid,
    supplierOrderRowId: supplierOrderRow.id,
    reason,
    detail,
  })
}

/**
 * Re-checks the actual placed total against the *current* spend cap, then either parks the order
 * (`created -> needs_attention`, no confirm) or confirms it and enqueues payment.
 *
 * This runs from two call sites with identical safety requirements: immediately after a fresh
 * `placeOrder` call, and when resuming a job whose row is already `created` (crash between the
 * transition-to-created and the confirm call). Re-deriving the check from the persisted
 * `totalAmountCents` and a freshly-read setting — rather than only checking once, in memory,
 * right after `placeOrder` — means a crash in that exact window still gets the cap enforced on
 * resume, instead of silently skipping straight to confirm.
 */
async function confirmOrPark(deps: PlaceOrderDeps, orderRow: OrderRow, supplierOrderRow: SupplierOrderRow): Promise<void> {
  const spendCapCents = await deps.settings.get('fulfillment.spend_cap_per_order_cents')
  // Spec 2026-09-06 R3: the cap is a promise about the whole customer order, so the post-create
  // re-check counts this order's other legs exactly as the pre-place check did.
  const committedCents = await committedCentsForOtherLegs(deps.db, orderRow.id, supplierOrderRow.id)
  const totalAmountCents = (supplierOrderRow.totalAmountCents ?? 0) + committedCents

  if (totalAmountCents > spendCapCents) {
    const detail = `order total ${totalAmountCents}c (incl. ${committedCents}c on other legs) exceeds spend cap ${spendCapCents}c`
    await parkNeedsAttention(deps, orderRow, supplierOrderRow, 'created', 'cap_exceeded_post_create', detail)
    return
  }

  if (!supplierOrderRow.supplierOrderId) {
    throw new Error(`supplier_orders row ${supplierOrderRow.id} is 'created' but missing supplier_order_id`)
  }
  await deps.adapter.confirmOrder(supplierOrderRow.supplierOrderId)
  await applyTransition(deps.db, supplierOrderRow.id, 'created', 'confirmed')
  await enqueuePayOrder(deps, supplierOrderRow.id)
}

async function dispatchDecision(
  deps: PlaceOrderDeps,
  orderRow: OrderRow,
  supplierOrderRow: SupplierOrderRow,
  decision: Decision,
  shippingAddress: Address,
  origin: string,
  promisedMaxDays: number,
): Promise<void> {
  switch (decision.kind) {
    case 'skip_test':
      // Unreachable in practice (step 1's shell guard already returned before we got here) —
      // kept as the planner-side half of the double guard the brief calls for.
      await auditSkippedTest(deps.db, orderRow)
      return

    case 'requeue':
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: 'fulfillment.requeued',
        entityType: 'order',
        entityId: orderRow.id,
        detail: { reason: decision.reason, delaySeconds: decision.delaySeconds },
      })
      await deps.enqueue(
        PLACE_ORDER_QUEUE,
        { orderGid: orderRow.shopifyOrderGid },
        { startAfter: decision.delaySeconds, singletonKey: orderRow.shopifyOrderGid, ...FULFILLMENT_RETRY_OPTS },
      )
      return

    case 'needs_attention':
      await parkNeedsAttention(deps, orderRow, supplierOrderRow, 'pending', decision.reason, decision.detail)
      return

    case 'proceed': {
      const result = await deps.adapter.placeOrder({
        idempotencyKey: supplierOrderRow.idempotencyKey,
        shippingAddress,
        items: decision.items,
        logisticName: decision.logisticName,
        // This leg's own warehouse: stock was verified there and freight was quoted from there.
        fromCountry: origin,
      })
      await applyTransition(deps.db, supplierOrderRow.id, 'pending', 'created', {
        // The promise this placement was judged against, recorded as made: the overdue sweep
        // reads it back instead of re-deriving a window that may have changed since.
        promisedMaxDays,
        supplierOrderId: result.supplierOrderId,
        shipmentOrderId: result.shipmentOrderId,
        logisticName: decision.logisticName,
        productAmountCents: result.productAmountCents,
        postageAmountCents: result.postageAmountCents,
        totalAmountCents: result.totalAmountCents,
      })
      await confirmOrPark(deps, orderRow, {
        ...supplierOrderRow,
        status: 'created',
        supplierOrderId: result.supplierOrderId,
        shipmentOrderId: result.shipmentOrderId ?? null,
        totalAmountCents: result.totalAmountCents,
      })
      return
    }
  }
}

/**
 * Resume-aware place-order executor: the sole entry point that turns a paid Shopify order into a
 * placed (and confirmed) supplier order. Safe to call repeatedly for the same `orderGid` — job
 * retries, crash recovery, and duplicate webhook deliveries all resume from whatever
 * `supplier_orders.status` currently holds instead of redoing completed work.
 *
 * This is the single most safety-critical path in the app: it spends real money against a real
 * supplier balance. Every status write goes through `applyTransition` (the sole legal writer);
 * nothing here ever assigns `.status` directly.
 */
export async function executePlaceOrder(deps: PlaceOrderDeps, orderGid: string): Promise<void> {
  const [orderRow] = await deps.db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
  if (!orderRow) {
    // Missing row is a hard failure — the job retries rather than silently no-op'ing.
    throw new Error(`orders row not found for gid ${orderGid}`)
  }

  // Step 1's shell guard: is_test orders never reach the supplier, full stop — checked here,
  // before any supplier_orders row exists and before any adapter method is called, so a test
  // order can never place a real (or even mock-store-tracked) order. The planner re-checks the
  // same fact below (unreachable from here, but a real double guard against a future caller that
  // skips this function's early return).
  if (orderRow.isTest) {
    await auditSkippedTest(deps.db, orderRow)
    return
  }

  // orders.shipping_address is stored ALREADY-NORMALIZED into the Address shape by
  // upsertOrderFromPaidPayload (via shopifyRestAddressToAddress) — this is a plain read, not a
  // reshape. A null value means the order arrived with no usable shipping address (missing,
  // malformed REST payload, or a required field absent) and must be parked for a human rather
  // than let a raw TypeError crash the job (or a garbage address reach quoteShipping/placeOrder)
  // when its fields are read below. Checked before any gather-inputs I/O: zero adapter calls.
  const shippingAddress = orderRow.shippingAddress as Address | null
  const lineItems = extractLineItems(orderRow)
  const mappings = await loadMappings(deps.db, deps.adapter.key, lineItems)

  if (!shippingAddress) {
    const row = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key, DEFAULT_ORIGIN)
    if (row.status === 'pending') {
      await parkNeedsAttention(deps, orderRow, row, 'pending', 'missing_address', 'order has no usable shipping address')
    }
    return
  }

  // An UNMAPPED line item parks the WHOLE order without placing anything. This is deliberately
  // NOT the partial-placement rule (spec R2), which covers a leg that cannot ship for SUPPLY
  // reasons: an unmapped item means we cannot resolve what the customer actually bought, and
  // spending money on the half we do understand is the wrong call on incomplete information.
  // Parked on the default-origin row so the shape matches the pre-split behaviour exactly.
  const unmapped = lineItems.filter((item) => !mappings.has(item.variantGid))
  if (unmapped.length > 0) {
    const row = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key, DEFAULT_ORIGIN)
    if (row.status === 'pending') {
      await parkNeedsAttention(
        deps,
        orderRow,
        row,
        'pending',
        'unmapped_item',
        `No supplier mapping for ${unmapped.map((item) => item.variantGid).join(', ')}`,
      )
    }
    return
  }

  // One customer order, one supplier order per warehouse (spec R1). A leg that parks does not
  // stop its siblings (spec R2) — `placeLeg` returns rather than throwing for every outcome the
  // planner can decide.
  for (const leg of await legsToProcess(deps, orderRow, lineItems, mappings)) {
    await placeLeg(deps, orderRow, shippingAddress, leg)
  }
}

/**
 * The legs this run must touch: the ones the CURRENT line items group into, plus any leg that
 * already has a `supplier_orders` row and did not appear in that grouping.
 *
 * The second half is a resume guarantee, not a nicety. A row that reached `created` has money
 * spent against it and MUST still be confirmed on re-entry even when the order's line items no
 * longer group to its warehouse — an order whose `raw_payload` is empty or unreadable, or a
 * mapping edited after placement. Without it such a row would sit `created`, unconfirmed and
 * unpaid, with nothing left to pick it up.
 */
async function legsToProcess(
  deps: PlaceOrderDeps,
  orderRow: OrderRow,
  lineItems: { variantGid: string; quantity: number }[],
  mappings: Map<string, MappingRow>,
): Promise<Leg[]> {
  const legs = groupLegs(lineItems, mappings)
  const grouped = new Set(legs.map((leg) => leg.origin))

  const existing = await deps.db
    .select({ warehouseCountry: supplierOrders.warehouseCountry })
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, orderRow.id), eq(supplierOrders.supplier, deps.adapter.key)))

  for (const row of existing) {
    if (grouped.has(row.warehouseCountry)) continue
    grouped.add(row.warehouseCountry)
    legs.push({ origin: row.warehouseCountry, lineItems: [], promisedMaxDays: null })
  }
  return legs
}

/**
 * The old order-scoped gather -> plan -> dispatch path, now run once per warehouse. Each leg
 * claims (or resumes) its OWN `supplier_orders` row, so a crash between legs re-enters here with
 * leg 1 already `created`/`confirmed` — never re-placed — and leg 2 still `pending`.
 */
async function placeLeg(deps: PlaceOrderDeps, orderRow: OrderRow, shippingAddress: Address, leg: Leg): Promise<void> {
  const supplierOrderRow = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key, leg.origin)

  // Resume switch: what to do depends entirely on THIS leg's current status, not on whether this
  // is the "first" attempt — pg-boss retries, a crashed worker, and a replayed webhook all funnel
  // through here identically.
  const status: SupplierOrderStatusDb = supplierOrderRow.status
  switch (status) {
    case 'pending':
      break // fall through to the full gather -> plan -> dispatch path below
    case 'created':
      await confirmOrPark(deps, orderRow, supplierOrderRow)
      return
    case 'confirmed':
      await enqueuePayOrder(deps, supplierOrderRow.id)
      return
    case 'needs_attention':
    case 'failed':
    case 'cancelled':
      // Operator owns it from here; the job must not touch it again.
      return
    case 'awaiting_funds':
    case 'paid':
    case 'shipped':
    case 'delivered':
      // Idempotent re-entry past confirm: another stage of the pipeline already owns this leg.
      return
    default: {
      const exhaustive: never = status
      throw new Error(`unhandled supplier_orders status: ${exhaustive}`)
    }
  }

  const mappings = await loadMappings(deps.db, deps.adapter.key, leg.lineItems)
  const neededBySupplierVariant = aggregateNeeded(leg.lineItems, mappings)

  const stock = new Map<string, WarehouseStock[]>()
  for (const supplierVariantId of neededBySupplierVariant.keys()) {
    stock.set(supplierVariantId, await deps.adapter.getVariantStock(supplierVariantId))
  }

  const freightItems = [...neededBySupplierVariant].map(([supplierVariantId, quantity]) => ({
    supplierVariantId,
    quantity,
  }))
  const freightOptions =
    freightItems.length === 0
      ? []
      : await deps.adapter.quoteShipping({
          // THIS leg's warehouse: stock was verified there, and a quote from any other origin
          // prices a shipment we will never make (FIX C5, as amended by the 2026-09-06 split).
          fromCountry: leg.origin,
          toCountry: shippingAddress.country,
          toZip: shippingAddress.zip,
          items: freightItems,
        })

  // Re-read per leg (spec R4): leg 1's placement has already moved this number, and leg 2 must
  // be judged against what is actually left rather than what was there before any money moved.
  const { availableCents: walletAvailableCents } = await deps.adapter.getBalance()
  const committedCents = await committedCentsForOtherLegs(deps.db, orderRow.id, supplierOrderRow.id)

  // The window THIS leg's buyer was shown. The setting is the pre-pivot fallback and nothing else
  // — a site-wide promise is exactly what the affordable-catalog pivot removed.
  const promisedMaxDays = leg.promisedMaxDays ?? (await deps.settings.get('fulfillment.promised_max_days'))

  const inputs: FulfillmentInputs = {
    order: {
      isTest: orderRow.isTest,
      totalCents: orderRow.totalCents ?? 0,
      shippingAddress,
      lineItems: leg.lineItems,
    },
    origin: leg.origin,
    committedCents,
    settings: {
      killswitch: await deps.settings.get('killswitch.global'),
      fulfillmentEnabled: await deps.settings.get('workflow.fulfillment.enabled'),
      pausedForFunds: await deps.settings.get('fulfillment.paused_for_funds'),
      spendCapPerOrderCents: await deps.settings.get('fulfillment.spend_cap_per_order_cents'),
      marginFloorBps: await deps.settings.get('fulfillment.margin_floor_bps'),
      promisedMaxDays,
    },
    mappings,
    stock,
    freightOptions,
    walletAvailableCents,
  }

  const decision = planFulfillment(inputs)
  await dispatchDecision(deps, orderRow, supplierOrderRow, decision, shippingAddress, leg.origin, promisedMaxDays)
}
