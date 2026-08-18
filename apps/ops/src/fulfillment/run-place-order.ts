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

export interface PlaceOrderDeps {
  db: Db
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
}

/** Send options for the fulfillment queues this executor enqueues into (design spec, exact). */
const FULFILLMENT_RETRY_OPTS: SendOpts = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }

const PLACE_ORDER_QUEUE = 'fulfillment.place-order'
const PAY_ORDER_QUEUE = 'fulfillment.pay-order'

/**
 * `supplier_orders.idempotency_key` = `db-` + digits of the Shopify order gid (Global
 * Constraints), e.g. `gid://shopify/Order/123` -> `db-123`. Deterministic, short, CJ-safe.
 */
function idempotencyKeyFor(orderGid: string): string {
  return `db-${orderGid.replace(/\D/g, '')}`
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
): Promise<SupplierOrderRow> {
  const [existing] = await db
    .select()
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, orderRow.id), eq(supplierOrders.supplier, supplier)))
  if (existing) return existing

  const [inserted] = await db
    .insert(supplierOrders)
    .values({
      orderId: orderRow.id,
      supplier,
      idempotencyKey: idempotencyKeyFor(orderRow.shopifyOrderGid),
      status: 'pending',
    })
    .onConflictDoNothing({ target: [supplierOrders.orderId, supplierOrders.supplier] })
    .returning()
  if (inserted) return inserted

  const [row] = await db
    .select()
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, orderRow.id), eq(supplierOrders.supplier, supplier)))
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
): Promise<Map<string, { supplierVariantId: string; supplierCostCents: number }>> {
  const map = new Map<string, { supplierVariantId: string; supplierCostCents: number }>()
  const gids = [...new Set(lineItems.map((item) => item.variantGid))]
  if (gids.length === 0) return map

  const rows = await db
    .select({
      shopifyVariantGid: productVariants.shopifyVariantGid,
      supplierCostCents: productVariants.supplierCostCents,
      supplierVariantId: supplierVariantMappings.supplierVariantId,
    })
    .from(supplierVariantMappings)
    .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(and(inArray(productVariants.shopifyVariantGid, gids), eq(supplierVariantMappings.supplier, supplier)))

  for (const row of rows) {
    if (row.shopifyVariantGid == null || row.supplierCostCents == null) continue
    map.set(row.shopifyVariantGid, { supplierVariantId: row.supplierVariantId, supplierCostCents: row.supplierCostCents })
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
  mappings: Map<string, { supplierVariantId: string; supplierCostCents: number }>,
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
  const totalAmountCents = supplierOrderRow.totalAmountCents ?? 0

  if (totalAmountCents > spendCapCents) {
    const detail = `actual total ${totalAmountCents}c exceeds spend cap ${spendCapCents}c`
    await applyTransition(deps.db, supplierOrderRow.id, 'created', 'needs_attention', {
      lastError: `cap_exceeded_post_create: ${detail}`,
    })
    await deps.alert('warning', 'fulfillment_needs_attention', {
      orderId: orderRow.id,
      orderGid: orderRow.shopifyOrderGid,
      supplierOrderRowId: supplierOrderRow.id,
      reason: 'cap_exceeded_post_create',
      detail,
    })
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
      await applyTransition(deps.db, supplierOrderRow.id, 'pending', 'needs_attention', {
        lastError: `${decision.reason}: ${decision.detail}`,
      })
      await deps.alert('warning', 'fulfillment_needs_attention', {
        orderId: orderRow.id,
        orderGid: orderRow.shopifyOrderGid,
        supplierOrderRowId: supplierOrderRow.id,
        reason: decision.reason,
        detail: decision.detail,
      })
      return

    case 'proceed': {
      const result = await deps.adapter.placeOrder({
        idempotencyKey: supplierOrderRow.idempotencyKey,
        shippingAddress,
        items: decision.items,
        logisticName: decision.logisticName,
        fromCountry: 'US',
      })
      await applyTransition(deps.db, supplierOrderRow.id, 'pending', 'created', {
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

  const supplierOrderRow = await loadOrCreateSupplierOrder(deps.db, orderRow, deps.adapter.key)

  // Resume switch: what to do depends entirely on the row's current status, not on whether this
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
      // Idempotent re-entry past confirm: another stage of the pipeline already owns this order.
      return
    default: {
      const exhaustive: never = status
      throw new Error(`unhandled supplier_orders status: ${exhaustive}`)
    }
  }

  const lineItems = extractLineItems(orderRow)
  const shippingAddress = orderRow.shippingAddress as Address

  const mappings = await loadMappings(deps.db, deps.adapter.key, lineItems)
  const neededBySupplierVariant = aggregateNeeded(lineItems, mappings)

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
          fromCountry: 'US',
          toCountry: shippingAddress.country,
          toZip: shippingAddress.zip,
          items: freightItems,
        })

  const { availableCents: walletAvailableCents } = await deps.adapter.getBalance()

  const inputs: FulfillmentInputs = {
    order: {
      isTest: orderRow.isTest,
      totalCents: orderRow.totalCents ?? 0,
      shippingAddress,
      lineItems,
    },
    settings: {
      killswitch: await deps.settings.get('killswitch.global'),
      fulfillmentEnabled: await deps.settings.get('workflow.fulfillment.enabled'),
      pausedForFunds: await deps.settings.get('fulfillment.paused_for_funds'),
      spendCapPerOrderCents: await deps.settings.get('fulfillment.spend_cap_per_order_cents'),
      marginFloorBps: await deps.settings.get('fulfillment.margin_floor_bps'),
      promisedMaxDays: await deps.settings.get('fulfillment.promised_max_days'),
    },
    mappings,
    stock,
    freightOptions,
    walletAvailableCents,
  }

  const decision = planFulfillment(inputs)
  await dispatchDecision(deps, orderRow, supplierOrderRow, decision, shippingAddress)
}
