import { auditLog, createDb, orders, supplierOrders } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { executeSyncTracking, type ShopifyFulfillmentOps, type SyncTrackingDeps } from '../src/fulfillment/run-sync-tracking.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0
function nextId(): string {
  uid += 1
  return `${Date.now()}${uid}`
}
function orderGidFor(): string {
  return `gid://shopify/Order/${nextId()}`
}

describe('executeSyncTracking', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  function makeDeps(overrides: Partial<ShopifyFulfillmentOps> = {}): {
    deps: SyncTrackingDeps
    orderFulfillmentOrders: ReturnType<typeof vi.fn>
    fulfillmentCreate: ReturnType<typeof vi.fn>
    fulfillmentTrackingInfoUpdate: ReturnType<typeof vi.fn>
  } {
    const orderFulfillmentOrders = vi.fn(
      overrides.orderFulfillmentOrders ??
        (async () => [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN' }]),
    )
    const fulfillmentCreate = vi.fn(
      overrides.fulfillmentCreate ?? (async () => ({ fulfillmentId: 'gid://shopify/Fulfillment/1' })),
    )
    const fulfillmentTrackingInfoUpdate = vi.fn(overrides.fulfillmentTrackingInfoUpdate ?? (async () => {}))
    // Not exercised by this file's tests (that's `fulfillment-reconcile.test.ts`'s job) — present
    // only so this object literal satisfies `ShopifyFulfillmentOps` in full.
    const ordersUpdatedSince = vi.fn(overrides.ordersUpdatedSince ?? (async () => []))
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: SyncTrackingDeps = {
      db,
      alert: createAlerter(db, mockLog),
      shopifyOps: { orderFulfillmentOrders, fulfillmentCreate, fulfillmentTrackingInfoUpdate, ordersUpdatedSince },
    }
    return { deps, orderFulfillmentOrders, fulfillmentCreate, fulfillmentTrackingInfoUpdate }
  }

  async function seedOrder(opts: { isTest?: boolean } = {}): Promise<{ orderGid: string; orderRowId: string }> {
    const orderGid = orderGidFor()
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: orderGid, isTest: opts.isTest ?? false, totalCents: 10_000 })
      .returning({ id: orders.id })
    return { orderGid, orderRowId: row!.id }
  }

  async function seedSupplierOrder(opts: {
    orderRowId: string
    trackingNumber?: string | null
    logisticName?: string | null
    shopifyFulfillmentGid?: string | null
    trackingSyncedValue?: string | null
    trackingSyncedToShopifyAt?: Date | null
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderRowId,
        supplier: 'cj',
        idempotencyKey: `test-${nextId()}`,
        status: 'paid',
        trackingNumber: opts.trackingNumber === undefined ? null : opts.trackingNumber,
        logisticName: opts.logisticName === undefined ? null : opts.logisticName,
        shopifyFulfillmentGid: opts.shopifyFulfillmentGid === undefined ? null : opts.shopifyFulfillmentGid,
        trackingSyncedValue: opts.trackingSyncedValue === undefined ? null : opts.trackingSyncedValue,
        trackingSyncedToShopifyAt:
          opts.trackingSyncedToShopifyAt === undefined ? null : opts.trackingSyncedToShopifyAt,
      })
      .returning()
    return row!
  }

  async function loadSupplierOrder(id: string) {
    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    return row
  }

  async function auditRowsFor(orderRowId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderRowId)))
  }

  async function alertRowsFor(kind: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, `alert.${kind}`)))
  }

  it('missing supplier_orders row throws (job retries)', async () => {
    const { deps } = makeDeps()
    await expect(executeSyncTracking(deps, '00000000-0000-0000-0000-000000000000')).rejects.toThrow()
  })

  it('is_test order: audits fulfillment.sync_skipped_test, zero Shopify calls', async () => {
    const { orderRowId } = await seedOrder({ isTest: true })
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: 'TRACK1' })
    const { deps, orderFulfillmentOrders, fulfillmentCreate, fulfillmentTrackingInfoUpdate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(orderFulfillmentOrders).not.toHaveBeenCalled()
    expect(fulfillmentCreate).not.toHaveBeenCalled()
    expect(fulfillmentTrackingInfoUpdate).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.shopifyFulfillmentGid).toBeNull()

    const rows = await auditRowsFor(orderRowId)
    expect(rows.some((r) => r.action === 'fulfillment.sync_skipped_test')).toBe(true)
  })

  it('no tracking_number: audits fulfillment.sync_skipped_no_tracking, zero Shopify calls', async () => {
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: null })
    const { deps, orderFulfillmentOrders, fulfillmentCreate, fulfillmentTrackingInfoUpdate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(orderFulfillmentOrders).not.toHaveBeenCalled()
    expect(fulfillmentCreate).not.toHaveBeenCalled()
    expect(fulfillmentTrackingInfoUpdate).not.toHaveBeenCalled()

    const rows = await auditRowsFor(orderRowId)
    expect(rows.some((r) => r.action === 'fulfillment.sync_skipped_no_tracking')).toBe(true)
  })

  it('create path: no shopify_fulfillment_gid — creates fulfillment, persists gid + synced value + timestamp', async () => {
    const { orderGid, orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      trackingNumber: 'TRACK123',
      logisticName: 'CJPacket Ordinary',
    })
    const { deps, orderFulfillmentOrders, fulfillmentCreate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(orderFulfillmentOrders).toHaveBeenCalledWith(orderGid)
    expect(fulfillmentCreate).toHaveBeenCalledWith({
      fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1',
      trackingNumber: 'TRACK123',
      trackingCompany: 'CJPacket Ordinary',
      notifyCustomer: true,
    })

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.shopifyFulfillmentGid).toBe('gid://shopify/Fulfillment/1')
    expect(row?.trackingSyncedValue).toBe('TRACK123')
    expect(row?.trackingSyncedToShopifyAt).toBeInstanceOf(Date)
    expect(row?.status).toBe('paid') // never touched — tracking sync is never a status change
  })

  it('create path: null logisticName -> trackingCompany passed as undefined', async () => {
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: 'TRACK9', logisticName: null })
    const { deps, fulfillmentCreate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(fulfillmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ trackingCompany: undefined, trackingNumber: 'TRACK9' }),
    )
  })

  it('create path: picks the first creatable (OPEN/IN_PROGRESS) node when multiple are returned', async () => {
    // No CLOSED entry here (deliberately, unlike before Task 14's controller ruling): a CLOSED
    // node anywhere in the list — even alongside an open one — now trips the suspected-duplicate
    // guard below instead of being quietly skipped in favor of the first open node. This test's
    // job is narrowed to just "multiple creatable nodes -> first one wins", which the ruling
    // doesn't touch.
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: 'TRACK-PICK' })
    const { deps, fulfillmentCreate } = makeDeps({
      orderFulfillmentOrders: async () => [
        { id: 'fo-in-progress', status: 'IN_PROGRESS' },
        { id: 'fo-open-too', status: 'OPEN' },
      ],
    })

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(fulfillmentCreate).toHaveBeenCalledWith(expect.objectContaining({ fulfillmentOrderId: 'fo-in-progress' }))
  })

  it('create path: no OPEN/IN_PROGRESS/CLOSED fulfillment order at all — audits + alerts (warning), no status change, never calls fulfillmentCreate', async () => {
    // Changed from a single CLOSED-only fixture (Task 13) to CANCELLED (Task 14): a CLOSED node
    // now routes through the suspected-duplicate guard below, not this "nothing to fulfill" path
    // — see the dedicated suspected-duplicate test for that case.
    const { orderGid, orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: 'TRACK-NONE' })
    const { deps, fulfillmentCreate } = makeDeps({
      orderFulfillmentOrders: async () => [{ id: 'fo-cancelled', status: 'CANCELLED' }],
    })

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(fulfillmentCreate).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid') // untouched — not a supplier-order status change
    expect(row?.shopifyFulfillmentGid).toBeNull()

    const rows = await auditRowsFor(orderRowId)
    const match = rows.find((r) => r.action === 'fulfillment.sync_no_fulfillment_order')
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ supplierOrderRowId: supplierOrderRow.id, orderGid })

    const alerts = await alertRowsFor('fulfillment_sync_no_fulfillment_order')
    const alertMatch = alerts.find(
      (r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id,
    )
    expect(alertMatch).toBeDefined()
    expect(alertMatch!.detail).toMatchObject({ severity: 'warning', orderGid })
  })

  it('CONTROLLER RULING: create path, gid null, a CLOSED node present alongside an OPEN one — suspected duplicate, zero create calls, audits + alerts', async () => {
    const { orderGid, orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, trackingNumber: 'TRACK-DUP' })
    const { deps, fulfillmentCreate } = makeDeps({
      orderFulfillmentOrders: async () => [
        { id: 'fo-closed', status: 'CLOSED' },
        { id: 'fo-open', status: 'OPEN' },
      ],
    })

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(fulfillmentCreate).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid') // untouched — not a supplier-order status change
    expect(row?.shopifyFulfillmentGid).toBeNull()

    const rows = await auditRowsFor(orderRowId)
    const match = rows.find((r) => r.action === 'fulfillment.sync_suspected_duplicate')
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ supplierOrderRowId: supplierOrderRow.id, orderGid })

    const alerts = await alertRowsFor('sync_suspected_duplicate')
    const alertMatch = alerts.find(
      (r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id,
    )
    expect(alertMatch).toBeDefined()
    expect(alertMatch!.detail).toMatchObject({ severity: 'warning' })
  })

  it('duplicate run: gid present, tracking unchanged since last sync — no-op, zero Shopify calls', async () => {
    const syncedAt = new Date('2026-01-01T00:00:00Z')
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      trackingNumber: 'TRACK-SAME',
      shopifyFulfillmentGid: 'gid://shopify/Fulfillment/existing',
      trackingSyncedValue: 'TRACK-SAME',
      trackingSyncedToShopifyAt: syncedAt,
    })
    const { deps, orderFulfillmentOrders, fulfillmentCreate, fulfillmentTrackingInfoUpdate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(orderFulfillmentOrders).not.toHaveBeenCalled()
    expect(fulfillmentCreate).not.toHaveBeenCalled()
    expect(fulfillmentTrackingInfoUpdate).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.shopifyFulfillmentGid).toBe('gid://shopify/Fulfillment/existing')
    expect(row?.trackingSyncedValue).toBe('TRACK-SAME')
    expect(row?.trackingSyncedToShopifyAt?.toISOString()).toBe(syncedAt.toISOString()) // untouched
  })

  it('gid present, tracking changed: calls fulfillmentTrackingInfoUpdate (not fulfillmentCreate), persists new synced value + timestamp', async () => {
    const oldSyncedAt = new Date('2026-01-01T00:00:00Z')
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      trackingNumber: 'TRACK-NEW',
      logisticName: 'DHL',
      shopifyFulfillmentGid: 'gid://shopify/Fulfillment/existing',
      trackingSyncedValue: 'TRACK-OLD',
      trackingSyncedToShopifyAt: oldSyncedAt,
    })
    const { deps, fulfillmentCreate, fulfillmentTrackingInfoUpdate } = makeDeps()

    await executeSyncTracking(deps, supplierOrderRow.id)

    expect(fulfillmentCreate).not.toHaveBeenCalled()
    expect(fulfillmentTrackingInfoUpdate).toHaveBeenCalledWith('gid://shopify/Fulfillment/existing', {
      number: 'TRACK-NEW',
      company: 'DHL',
    })

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.trackingSyncedValue).toBe('TRACK-NEW')
    expect(row?.shopifyFulfillmentGid).toBe('gid://shopify/Fulfillment/existing') // unchanged
    expect(row?.trackingSyncedToShopifyAt?.getTime()).toBeGreaterThan(oldSyncedAt.getTime())
    expect(row?.status).toBe('paid') // never touched
  })
})
