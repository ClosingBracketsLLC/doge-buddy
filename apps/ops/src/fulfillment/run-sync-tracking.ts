import { auditLog, type createDb, orders, supplierOrders } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type { createAlerter } from '../alerts.ts'

type Db = ReturnType<typeof createDb>['db']
type OrderRow = typeof orders.$inferSelect
type SupplierOrderRow = typeof supplierOrders.$inferSelect

/**
 * The subset of `@doge-buddy/shopify-admin`'s fulfillment operations this executor needs, with
 * the `ShopifyAdminClient` argument already bound away — signatures otherwise match
 * `operations.ts` exactly. `index.ts` wires these as thin closures over the real functions when
 * `config.shopify` is set, or a stub that throws `'shopify not configured'` when it isn't (see
 * `queue.ts`); tests inject fakes (`vi.fn` spies) directly.
 */
export interface ShopifyFulfillmentOps {
  orderFulfillmentOrders(orderGid: string): Promise<{ id: string; status: string }[]>
  fulfillmentCreate(args: {
    fulfillmentOrderId: string
    trackingNumber?: string
    trackingCompany?: string
    notifyCustomer: boolean
  }): Promise<{ fulfillmentId: string }>
  fulfillmentTrackingInfoUpdate(gid: string, tracking: { number: string; company?: string }): Promise<void>
  /**
   * Bound form of `@doge-buddy/shopify-admin`'s `ordersUpdatedSince(client, sinceIso)` — used by
   * `run-reconcile.ts` (Task 14)'s sweep 1 to find orders Shopify says are paid that this system
   * has no record of ever placing.
   */
  ordersUpdatedSince(sinceIso: string): Promise<
    { id: string; name: string; test: boolean; displayFinancialStatus: string; email?: string; updatedAt: string }[]
  >
}

export interface SyncTrackingDeps {
  db: Db
  alert: ReturnType<typeof createAlerter>
  shopifyOps: ShopifyFulfillmentOps
}

/** A Shopify `FulfillmentOrder.status` this executor is still willing to attach a fulfillment to. */
const CREATABLE_STATUSES = new Set(['OPEN', 'IN_PROGRESS'])

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

async function auditSkip(
  db: Db,
  action: string,
  orderRow: OrderRow,
  supplierOrderRowId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({
    actor: 'system',
    action,
    entityType: 'order',
    entityId: orderRow.id,
    detail: { supplierOrderRowId, ...detail },
  })
}

/**
 * CONTROLLER RULING (Task 13 review, applied in Task 14): `shopify_fulfillment_gid` is null —
 * meaning, as far as this row is concerned, `fulfillmentCreate` has never successfully been
 * called for it — yet Shopify reports at least one of the order's fulfillment orders as `CLOSED`.
 * A crash between a real `fulfillmentCreate` call succeeding (which closes that fulfillment
 * order) and this executor persisting the returned gid is exactly the scenario that produces this
 * signature on the next run/retry. Calling `fulfillmentCreate` again in that state risks a second,
 * duplicate Shopify fulfillment for the same order, so this is treated as a hazard requiring a
 * human, not routed through the normal "pick the first open node" logic below.
 */
function hasSuspiciousClosedNode(fulfillmentOrders: { id: string; status: string }[]): boolean {
  return fulfillmentOrders.some((node) => node.status === 'CLOSED')
}

/**
 * `shopify_fulfillment_gid` is unset: this order has never had a Shopify fulfillment created for
 * it. Looks up the order's fulfillment orders and picks the first one still open for fulfillment
 * (`OPEN`/`IN_PROGRESS`); none found is a data/timing problem — not a supplier-order status
 * change — so it's audited + alerted (an operator needs to look), never routed through
 * `applyTransition`. On success, persists the new gid together with the synced tracking value and
 * timestamp in one UPDATE, so a re-run (retry, duplicate job delivery) sees
 * `shopify_fulfillment_gid` set and takes `updateFulfillment`'s no-op/update branch instead of
 * creating a second fulfillment.
 */
async function createFulfillment(
  deps: SyncTrackingDeps,
  orderRow: OrderRow,
  supplierOrderRow: SupplierOrderRow,
): Promise<void> {
  const fulfillmentOrders = await deps.shopifyOps.orderFulfillmentOrders(orderRow.shopifyOrderGid)

  if (hasSuspiciousClosedNode(fulfillmentOrders)) {
    await auditSkip(deps.db, 'fulfillment.sync_suspected_duplicate', orderRow, supplierOrderRow.id, {
      orderGid: orderRow.shopifyOrderGid,
    })
    await deps.alert('warning', 'sync_suspected_duplicate', {
      supplierOrderRowId: supplierOrderRow.id,
    })
    return
  }

  const target = fulfillmentOrders.find((node) => CREATABLE_STATUSES.has(node.status))

  if (!target) {
    await auditSkip(deps.db, 'fulfillment.sync_no_fulfillment_order', orderRow, supplierOrderRow.id, {
      orderGid: orderRow.shopifyOrderGid,
    })
    await deps.alert('warning', 'fulfillment_sync_no_fulfillment_order', {
      orderId: orderRow.id,
      orderGid: orderRow.shopifyOrderGid,
      supplierOrderRowId: supplierOrderRow.id,
    })
    return
  }

  const result = await deps.shopifyOps.fulfillmentCreate({
    fulfillmentOrderId: target.id,
    trackingNumber: supplierOrderRow.trackingNumber!,
    trackingCompany: supplierOrderRow.logisticName ?? undefined,
    notifyCustomer: true,
  })

  await deps.db
    .update(supplierOrders)
    .set({
      shopifyFulfillmentGid: result.fulfillmentId,
      trackingSyncedValue: supplierOrderRow.trackingNumber,
      trackingSyncedToShopifyAt: new Date(),
    })
    .where(eq(supplierOrders.id, supplierOrderRow.id))
}

/**
 * `shopify_fulfillment_gid` is already set: either no-op (the tracking number hasn't changed
 * since the last successful sync) or push the update via `fulfillmentTrackingInfoUpdate`.
 * Comparing the current `tracking_number` against the persisted `tracking_synced_value` — rather
 * than re-querying Shopify — is what makes a duplicate job delivery (retry, replayed CJ webhook)
 * a zero-Shopify-call no-op.
 */
async function updateFulfillment(deps: SyncTrackingDeps, supplierOrderRow: SupplierOrderRow): Promise<void> {
  if (supplierOrderRow.trackingNumber === supplierOrderRow.trackingSyncedValue) {
    return
  }

  await deps.shopifyOps.fulfillmentTrackingInfoUpdate(supplierOrderRow.shopifyFulfillmentGid!, {
    number: supplierOrderRow.trackingNumber!,
    company: supplierOrderRow.logisticName ?? undefined,
  })

  await deps.db
    .update(supplierOrders)
    .set({
      trackingSyncedValue: supplierOrderRow.trackingNumber,
      trackingSyncedToShopifyAt: new Date(),
    })
    .where(eq(supplierOrders.id, supplierOrderRow.id))
}

/**
 * Tracking-sync executor: the sole entry point that pushes CJ's tracking number/carrier onto the
 * matching Shopify fulfillment. Customer notification is Shopify's job (`notifyCustomer: true` on
 * create, and Shopify notifies again on a tracking update) — this function only ever moves
 * tracking metadata, it never writes `supplier_orders.status`.
 *
 * Safe to call repeatedly for the same row — job retries, crash recovery, and duplicate CJ
 * LOGISTICS webhook deliveries all resume from whatever `shopify_fulfillment_gid` /
 * `tracking_synced_value` currently hold instead of redoing completed work.
 */
export async function executeSyncTracking(deps: SyncTrackingDeps, supplierOrderRowId: string): Promise<void> {
  const rows = await loadRows(deps.db, supplierOrderRowId)
  if (!rows) {
    // Missing row is a hard failure — the job retries rather than silently no-op'ing (same
    // stance `executePlaceOrder`/`executePayOrder` take for a missing row).
    throw new Error(`supplier_orders row not found: ${supplierOrderRowId}`)
  }
  const { orderRow, supplierOrderRow } = rows

  if (orderRow.isTest) {
    await auditSkip(deps.db, 'fulfillment.sync_skipped_test', orderRow, supplierOrderRowId, {
      orderGid: orderRow.shopifyOrderGid,
    })
    return
  }

  if (!supplierOrderRow.trackingNumber) {
    await auditSkip(deps.db, 'fulfillment.sync_skipped_no_tracking', orderRow, supplierOrderRowId)
    return
  }

  if (!supplierOrderRow.shopifyFulfillmentGid) {
    await createFulfillment(deps, orderRow, supplierOrderRow)
    return
  }

  await updateFulfillment(deps, supplierOrderRow)
}
