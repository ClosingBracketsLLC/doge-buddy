import { auditLog, createDb, orders, supplierOrders, webhookEvents } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { upsertOrderFromPaidPayload } from '../src/fulfillment/order-upsert.ts'
import { FULFILLMENT_RETRY_OPTS } from '../src/fulfillment/run-place-order.ts'
import {
  executeReconcile,
  type ReconcileDeps,
  sweepOrphanedOrders,
  sweepOverdue,
  sweepStatusDrift,
  sweepStrandedWebhooks,
} from '../src/fulfillment/run-reconcile.ts'
import type { ShopifyFulfillmentOps } from '../src/fulfillment/run-sync-tracking.ts'
import type { SupplierOrderStatusDb } from '../src/fulfillment/transitions.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0
function nextId(): string {
  uid += 1
  return `${Date.now()}${uid}`
}
function orderGidFor(): string {
  return `gid://shopify/Order/${nextId()}`
}

// Fixed clock for the whole file — every "stale" cutoff in every test is computed relative to
// this instant, never to real wall-clock time, so a row's placement on either side of a sweep's
// cutoff is entirely up to what each test seeds, not when the test happens to run.
const NOW = new Date('2026-06-01T12:00:00.000Z')
const now = (): Date => NOW
function minutesBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 60 * 1000)
}
function daysBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
}

describe('run-reconcile', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  // Sweeps 2-4 run deliberately unscoped queries (see run-reconcile.ts's own note on why the
  // sweep functions are exported individually) — every row a test seeds through the helpers
  // below is tracked here and deleted in `afterEach`, so a prior test run's leftovers (this DB
  // is shared and persistent, not reset between `vitest run` invocations) can never inflate a
  // later run's counts.
  let createdWebhookEventIds: string[] = []
  let createdSupplierOrderIds: string[] = []

  beforeEach(async () => {
    createdWebhookEventIds = []
    createdSupplierOrderIds = []
    // fulfillment.promised_max_days is a shared, persisted setting — reset to the code default
    // before every test so a prior test's override (sweep 4's custom-setting test) can never
    // leak into an unrelated test, in this file or (since files run non-parallel — see
    // vitest.config.ts's `fileParallelism: false`) one that runs right after it.
    await settings.set('fulfillment.promised_max_days', SETTINGS_DEFAULTS['fulfillment.promised_max_days'])
  })

  afterEach(async () => {
    if (createdWebhookEventIds.length > 0) {
      await db.delete(webhookEvents).where(inArray(webhookEvents.id, createdWebhookEventIds))
    }
    if (createdSupplierOrderIds.length > 0) {
      await db.delete(supplierOrders).where(inArray(supplierOrders.id, createdSupplierOrderIds))
    }
  })

  function makeDeps(opts: {
    adapter?: MockSupplierAdapter
    ordersUpdatedSince?: ShopifyFulfillmentOps['ordersUpdatedSince']
  } = {}): { deps: ReconcileDeps; enqueue: ReturnType<typeof vi.fn>; adapter: MockSupplierAdapter } {
    const adapter = opts.adapter ?? new MockSupplierAdapter()
    const enqueue = vi.fn(async () => {})
    const notUsed = async (): Promise<never> => {
      throw new Error('not used by these tests')
    }
    const shopifyOps: ShopifyFulfillmentOps = {
      orderFulfillmentOrders: notUsed,
      fulfillmentCreate: notUsed,
      fulfillmentTrackingInfoUpdate: notUsed,
      ordersUpdatedSince: opts.ordersUpdatedSince ?? (async () => []),
    }
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: ReconcileDeps = {
      db,
      adapter,
      settings,
      alert: createAlerter(db, mockLog),
      enqueue,
      shopifyOps,
      now,
    }
    return { deps, enqueue, adapter }
  }

  async function seedOrder(opts: { isTest?: boolean; paidAt?: Date | null } = {}): Promise<{
    orderGid: string
    orderRowId: string
  }> {
    const orderGid = orderGidFor()
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: orderGid,
        isTest: opts.isTest ?? false,
        totalCents: 5000,
        paidAt: opts.paidAt === undefined ? null : opts.paidAt,
      })
      .returning({ id: orders.id })
    return { orderGid, orderRowId: row!.id }
  }

  async function seedSupplierOrder(opts: {
    orderRowId: string
    status: SupplierOrderStatusDb
    supplierOrderId?: string | null
    trackingNumber?: string | null
    logisticName?: string | null
    updatedAt?: Date
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderRowId,
        supplier: 'mock',
        idempotencyKey: `test-${nextId()}`,
        status: opts.status,
        supplierOrderId: opts.supplierOrderId === undefined ? `sup-${nextId()}` : opts.supplierOrderId,
        trackingNumber: opts.trackingNumber ?? null,
        logisticName: opts.logisticName ?? null,
        updatedAt: opts.updatedAt ?? now(),
      })
      .returning()
    createdSupplierOrderIds.push(row!.id)
    return row!
  }

  async function seedWebhookEvent(opts: {
    source: 'shopify' | 'cj'
    topic?: string
    processedAt?: Date | null
    receivedAt?: Date
  }): Promise<typeof webhookEvents.$inferSelect> {
    const [row] = await db
      .insert(webhookEvents)
      .values({
        source: opts.source,
        externalEventId: `test-${nextId()}`,
        topic: opts.topic ?? 'orders/paid',
        payload: {},
        processedAt: opts.processedAt === undefined ? null : opts.processedAt,
        receivedAt: opts.receivedAt ?? now(),
      })
      .returning()
    createdWebhookEventIds.push(row!.id)
    return row!
  }

  async function loadSupplierOrder(id: string) {
    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    return row
  }

  async function alertRowsFor(kind: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, `alert.${kind}`)))
  }

  async function rowFailureAuditsFor(entityId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'reconcile.row_failed'), eq(auditLog.entityId, entityId)))
  }

  // ---------------------------------------------------------------------------
  // Sweep 1: orphaned orders
  // ---------------------------------------------------------------------------

  describe('sweep 1: orphaned orders', () => {
    it('calls ordersUpdatedSince with an ISO timestamp 2 hours before the injected clock', async () => {
      const ordersUpdatedSince = vi.fn(async () => [])
      const { deps } = makeDeps({ ordersUpdatedSince })

      await sweepOrphanedOrders(deps)

      expect(ordersUpdatedSince).toHaveBeenCalledWith(new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString())
    })

    it('orders row already exists (from a webhook), no supplier_orders row -> enqueues place-order, counts as orphaned', async () => {
      const { orderGid } = await seedOrder()
      const { deps, enqueue } = makeDeps({
        ordersUpdatedSince: async () => [
          { id: orderGid, name: '#1001', test: false, displayFinancialStatus: 'PAID', updatedAt: now().toISOString() },
        ],
      })

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      expect(enqueue).toHaveBeenCalledWith(
        'fulfillment.place-order',
        { orderGid },
        { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS },
      )
    })

    it('no orders row at all -> creates a minimal row, alerts reconcile_thin_order, enqueues place-order', async () => {
      const orderGid = orderGidFor()
      const { deps, enqueue } = makeDeps({
        ordersUpdatedSince: async () => [
          {
            id: orderGid,
            name: '#2002',
            test: false,
            displayFinancialStatus: 'PAID',
            email: 'thin@example.com',
            updatedAt: now().toISOString(),
          },
        ],
      })

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 1, failures: 0 })

      const [row] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
      expect(row).toBeDefined()
      expect(row?.shopifyOrderNumber).toBe('#2002')
      expect(row?.email).toBe('thin@example.com')
      expect(row?.isTest).toBe(false)
      expect(row?.paidAt).toBeNull()
      expect(row?.shippingAddress).toBeNull()

      const alerts = await alertRowsFor('reconcile_thin_order')
      const match = alerts.find((r) => (r.detail as { orderGid?: string })?.orderGid === orderGid)
      expect(match).toBeDefined()
      expect(match!.detail).toMatchObject({ severity: 'warning', orderGid, shopifyOrderNumber: '#2002' })

      expect(enqueue).toHaveBeenCalledWith(
        'fulfillment.place-order',
        { orderGid },
        { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS },
      )
    })

    it('already handled: both orders and supplier_orders rows exist -> skipped, zero enqueue calls', async () => {
      const { orderGid, orderRowId } = await seedOrder()
      await seedSupplierOrder({ orderRowId, status: 'pending' })
      const { deps, enqueue } = makeDeps({
        ordersUpdatedSince: async () => [
          { id: orderGid, name: '#3003', test: false, displayFinancialStatus: 'PAID', updatedAt: now().toISOString() },
        ],
      })

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('skips test orders (test: true never reaches the orders table or enqueue)', async () => {
      const orderGid = orderGidFor()
      const { deps, enqueue } = makeDeps({
        ordersUpdatedSince: async () => [
          { id: orderGid, name: '#4004', test: true, displayFinancialStatus: 'PAID', updatedAt: now().toISOString() },
        ],
      })

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(enqueue).not.toHaveBeenCalled()
      const [row] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
      expect(row).toBeUndefined()
    })

    it('skips entries whose displayFinancialStatus is not PAID', async () => {
      const orderGid = orderGidFor()
      const { deps, enqueue } = makeDeps({
        ordersUpdatedSince: async () => [
          { id: orderGid, name: '#5005', test: false, displayFinancialStatus: 'PENDING', updatedAt: now().toISOString() },
        ],
      })

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('FINDING 2: one item throwing during processing does not stop the rest of the batch; failure counted and audited', async () => {
      const failingGid = orderGidFor()
      const okGid = orderGidFor()

      const enqueue = vi.fn(async (_name: string, data: object) => {
        if ((data as { orderGid: string }).orderGid === failingGid) {
          throw new Error('enqueue transport down')
        }
      })
      const notUsed = async (): Promise<never> => {
        throw new Error('not used by this test')
      }
      const shopifyOps: ShopifyFulfillmentOps = {
        orderFulfillmentOrders: notUsed,
        fulfillmentCreate: notUsed,
        fulfillmentTrackingInfoUpdate: notUsed,
        ordersUpdatedSince: async () => [
          { id: failingGid, name: '#f1', test: false, displayFinancialStatus: 'PAID', updatedAt: now().toISOString() },
          { id: okGid, name: '#f2', test: false, displayFinancialStatus: 'PAID', updatedAt: now().toISOString() },
        ],
      }
      const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const deps: ReconcileDeps = {
        db,
        adapter: new MockSupplierAdapter(),
        settings,
        alert: createAlerter(db, mockLog),
        enqueue,
        shopifyOps,
        now,
      }

      const result = await sweepOrphanedOrders(deps)

      expect(result).toEqual({ count: 1, failures: 1 })

      const [okRow] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, okGid))
      expect(okRow).toBeDefined() // sibling item still processed despite the failing one

      const failureAudits = await rowFailureAuditsFor(failingGid)
      expect(failureAudits.length).toBeGreaterThan(0)
      expect(failureAudits[0]!.detail).toMatchObject({ sweep: 'orphaned_orders', message: 'enqueue transport down' })
    })
  })

  // ---------------------------------------------------------------------------
  // Sweep 2: stranded webhooks
  // ---------------------------------------------------------------------------

  describe('sweep 2: stranded webhooks', () => {
    it('unprocessed + received > 15min ago -> re-enqueues the correct process queue per source, audits, counts', async () => {
      const shopifyEvent = await seedWebhookEvent({ source: 'shopify', receivedAt: minutesBefore(20) })
      const cjEvent = await seedWebhookEvent({ source: 'cj', topic: 'logistics', receivedAt: minutesBefore(30) })

      const { deps, enqueue } = makeDeps()
      const count = await sweepStrandedWebhooks(deps)

      expect(count).toBe(2)
      expect(enqueue).toHaveBeenCalledWith('webhook.shopify.process', { webhookEventId: shopifyEvent.id })
      expect(enqueue).toHaveBeenCalledWith('webhook.cj.process', { webhookEventId: cjEvent.id })

      const audits = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.action, 'fulfillment.reconcile_stranded_webhook')),
        )
      expect(audits.some((r) => r.entityId === shopifyEvent.id)).toBe(true)
      expect(audits.some((r) => r.entityId === cjEvent.id)).toBe(true)
    })

    it('freshness boundary: received < 15min ago is left alone; already-processed rows are left alone', async () => {
      await seedWebhookEvent({ source: 'shopify', receivedAt: minutesBefore(5) })
      await seedWebhookEvent({ source: 'shopify', receivedAt: minutesBefore(30), processedAt: now() })

      const { deps, enqueue } = makeDeps()
      const count = await sweepStrandedWebhooks(deps)

      expect(count).toBe(0)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('caps at 100 rows per run and alerts when capped, without silently dropping the rest', async () => {
      const rows = Array.from({ length: 101 }, (_, i) => ({
        source: 'shopify' as const,
        externalEventId: `cap-test-${nextId()}-${i}`,
        topic: 'orders/paid',
        payload: {},
        receivedAt: minutesBefore(20),
      }))
      const inserted = await db.insert(webhookEvents).values(rows).returning({ id: webhookEvents.id })
      createdWebhookEventIds.push(...inserted.map((r) => r.id))

      const { deps, enqueue } = makeDeps()
      const count = await sweepStrandedWebhooks(deps)

      expect(count).toBe(100)
      expect(enqueue).toHaveBeenCalledTimes(100)

      const alerts = await alertRowsFor('reconcile_stranded_webhooks_capped')
      expect(alerts.length).toBeGreaterThan(0)
      expect(alerts[alerts.length - 1]!.detail).toMatchObject({ severity: 'info', cap: 100 })
    })
  })

  // ---------------------------------------------------------------------------
  // Sweep 3: status/tracking drift
  // ---------------------------------------------------------------------------

  describe('sweep 3: status/tracking drift', () => {
    it('legal forward status transition -> applies it, counts as drift fixed', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({ orderRowId, status: 'paid', updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'shipped', raw: 'shipped' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('shipped')
    })

    it('illegal (self/backwards) transition is ignored: row untouched, not counted', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({ orderRowId, status: 'shipped', updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      // 'shipped' is actionable (mapCjStatus doesn't drop it) but a row already 'shipped' has no
      // legal self-transition — `resolveCjTransition` finds no direct move AND (unlike the
      // 'cancelled' case below) no fallback applies either, since mapped isn't 'cancelled'.
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'shipped', raw: 'shipped' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('shipped')
    })

    it('CJ CANCELLED on an active row (paid, no direct path to cancelled) falls back to needs_attention: persists supplier_cancelled lastError, alerts, counts as drift fixed', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({ orderRowId, status: 'paid', updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'cancelled', raw: 'cancelled' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('needs_attention')
      expect(updated?.lastError).toBe('supplier_cancelled: CJ reports order cancelled (was paid)')

      // Matched by this test's own row id, not by total count — `alertRowsFor` is an unscoped
      // query against this shared, persistent test DB, so a prior (uncleaned) run's alert rows
      // for the same kind may still be sitting there (audit_log itself is never cleaned up by
      // this file's afterEach, unlike webhookEvents/supplierOrders).
      const alertRows = await alertRowsFor('supplier_cancelled')
      const match = alertRows.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === row.id)
      expect(match).toBeDefined()
      expect(match!.detail).toEqual({ severity: 'warning', supplierOrderRowId: row.id, priorStatus: 'paid' })
    })

    it('non-actionable CJ status (mapCjStatus -> null) is ignored: row untouched, not counted', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({ orderRowId, status: 'paid', updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'processing', raw: 'processing' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('paid')
    })

    it('new/changed tracking with no status change -> persists tracking, enqueues sync-tracking, counted', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({
        orderRowId,
        status: 'paid',
        trackingNumber: null,
        updatedAt: minutesBefore(20),
      })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'unknown', raw: 'unknown' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue({ trackingNumber: 'NEW123', carrier: 'DHL' })
      const { deps, enqueue } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('paid') // untouched
      expect(updated?.trackingNumber).toBe('NEW123')
      expect(updated?.logisticName).toBe('DHL')
      expect(enqueue).toHaveBeenCalledWith(
        'fulfillment.sync-tracking',
        { supplierOrderRowId: row.id },
        { singletonKey: row.id, ...FULFILLMENT_RETRY_OPTS },
      )
    })

    it('tracking unchanged -> no db write, no enqueue, not counted', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({
        orderRowId,
        status: 'paid',
        trackingNumber: 'SAME123',
        updatedAt: minutesBefore(20),
      })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'unknown', raw: 'unknown' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue({ trackingNumber: 'SAME123' })
      const { deps, enqueue } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(enqueue).not.toHaveBeenCalled()
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.trackingNumber).toBe('SAME123')
    })

    it('row with no supplier_order_id (never placed) is skipped entirely: zero adapter calls', async () => {
      const { orderRowId } = await seedOrder()
      await seedSupplierOrder({ orderRowId, status: 'pending', supplierOrderId: null, updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      const getOrderStatusSpy = vi.spyOn(adapter, 'getOrderStatus')
      const getTrackingSpy = vi.spyOn(adapter, 'getTracking')
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(getOrderStatusSpy).not.toHaveBeenCalled()
      expect(getTrackingSpy).not.toHaveBeenCalled()
    })

    it('freshness boundary: rows updated less than 10 minutes ago are left alone', async () => {
      const { orderRowId } = await seedOrder()
      const row = await seedSupplierOrder({ orderRowId, status: 'paid', updatedAt: minutesBefore(5) })

      const adapter = new MockSupplierAdapter()
      const getOrderStatusSpy = vi.spyOn(adapter, 'getOrderStatus')
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(getOrderStatusSpy).not.toHaveBeenCalled()
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('paid')
    })

    it('terminal statuses (e.g. delivered) are excluded from the query entirely', async () => {
      const { orderRowId } = await seedOrder()
      await seedSupplierOrder({ orderRowId, status: 'delivered', updatedAt: minutesBefore(20) })

      const adapter = new MockSupplierAdapter()
      const getOrderStatusSpy = vi.spyOn(adapter, 'getOrderStatus')
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      expect(getOrderStatusSpy).not.toHaveBeenCalled()
    })

    it('FINDING 2: getOrderStatus throwing for the first row does not stop the second row from being processed; failure counted and audited', async () => {
      const { orderRowId: firstOrderId } = await seedOrder()
      const firstRow = await seedSupplierOrder({ orderRowId: firstOrderId, status: 'paid', updatedAt: minutesBefore(20) })
      const { orderRowId: secondOrderId } = await seedOrder()
      const secondRow = await seedSupplierOrder({
        orderRowId: secondOrderId,
        status: 'paid',
        updatedAt: minutesBefore(20),
      })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockImplementation(async (supplierOrderId: string) => {
        if (supplierOrderId === firstRow.supplierOrderId) {
          throw new Error('CJ API unreachable')
        }
        return { value: 'shipped', raw: 'shipped' }
      })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)
      const { deps } = makeDeps({ adapter })

      const result = await sweepStatusDrift(deps)

      expect(result).toEqual({ count: 1, failures: 1 })

      const firstUpdated = await loadSupplierOrder(firstRow.id)
      expect(firstUpdated?.status).toBe('paid') // untouched — its own call threw before any write

      const secondUpdated = await loadSupplierOrder(secondRow.id)
      expect(secondUpdated?.status).toBe('shipped') // sibling row still processed

      const failureAudits = await rowFailureAuditsFor(firstRow.id)
      expect(failureAudits.length).toBeGreaterThan(0)
      expect(failureAudits[0]!.detail).toMatchObject({ sweep: 'status_drift', message: 'CJ API unreachable' })
    })
  })

  // ---------------------------------------------------------------------------
  // Sweep 4: overdue orders
  // ---------------------------------------------------------------------------

  describe('sweep 4: overdue orders', () => {
    it('paid more than promised_max_days (default 7) ago, not yet shipped -> parks needs_attention, alerts, counts', async () => {
      const { orderGid, orderRowId } = await seedOrder({ paidAt: daysBefore(8) })
      const row = await seedSupplierOrder({ orderRowId, status: 'confirmed' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('needs_attention')
      expect(updated?.lastError).toMatch(/^overdue:/)

      const alerts = await alertRowsFor('order_overdue')
      const match = alerts.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === row.id)
      expect(match).toBeDefined()
      expect(match!.detail).toMatchObject({ severity: 'warning', orderGid, promisedMaxDays: 7 })
    })

    it('paid within the promised window -> untouched, not counted', async () => {
      const { orderRowId } = await seedOrder({ paidAt: daysBefore(3) })
      const row = await seedSupplierOrder({ orderRowId, status: 'confirmed' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('confirmed')
    })

    it('already shipped/delivered/cancelled/failed/needs_attention -> excluded regardless of how old paid_at is', async () => {
      const { orderRowId } = await seedOrder({ paidAt: daysBefore(30) })
      const row = await seedSupplierOrder({ orderRowId, status: 'shipped' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('shipped')
    })

    it('order.paid_at is null -> excluded (never paid, so never overdue by this sweep)', async () => {
      const { orderRowId } = await seedOrder({ paidAt: null })
      const row = await seedSupplierOrder({ orderRowId, status: 'confirmed' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 0, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('confirmed')
    })

    it('respects a custom fulfillment.promised_max_days setting', async () => {
      await settings.set('fulfillment.promised_max_days', 3)
      const { orderRowId } = await seedOrder({ paidAt: daysBefore(4) })
      const row = await seedSupplierOrder({ orderRowId, status: 'confirmed' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('needs_attention')
    })

    it('FINDING 1: end-to-end from a REAL orders/paid upsert (not hand-seeded paid_at) -> the sweep now fires in the integrated path', async () => {
      const orderGid = orderGidFor()
      const processedAtIso = daysBefore(8).toISOString()
      const upserted = await upsertOrderFromPaidPayload(db, {
        admin_graphql_api_id: orderGid,
        test: false,
        total_price: '25.00',
        processed_at: processedAtIso,
      })
      const row = await seedSupplierOrder({ orderRowId: upserted.orderRowId, status: 'confirmed' })

      const { deps } = makeDeps()
      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 1, failures: 0 })
      const updated = await loadSupplierOrder(row.id)
      expect(updated?.status).toBe('needs_attention')

      const [orderRow] = await db.select().from(orders).where(eq(orders.id, upserted.orderRowId))
      expect(orderRow?.paidAt?.toISOString()).toBe(processedAtIso)
    })

    it('FINDING 2: a downstream failure (alert throwing) for one row does not stop the rest of the batch; failure counted and audited', async () => {
      const { orderRowId: firstOrderId } = await seedOrder({ paidAt: daysBefore(8) })
      const firstRow = await seedSupplierOrder({ orderRowId: firstOrderId, status: 'confirmed' })
      const { orderRowId: secondOrderId } = await seedOrder({ paidAt: daysBefore(8) })
      const secondRow = await seedSupplierOrder({ orderRowId: secondOrderId, status: 'confirmed' })

      const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const realAlert = createAlerter(db, mockLog)
      const { deps } = makeDeps()
      deps.alert = async (severity, kind, detail) => {
        if (kind === 'order_overdue' && (detail as { supplierOrderRowId?: string }).supplierOrderRowId === firstRow.id) {
          throw new Error('alert transport down')
        }
        return realAlert(severity, kind, detail)
      }

      const result = await sweepOverdue(deps)

      expect(result).toEqual({ count: 1, failures: 1 })

      // applyTransition already succeeded before the alert threw — the failure is caught after,
      // not rolled back; that's the correct/expected shape (see the sweep's doc comment).
      const firstUpdated = await loadSupplierOrder(firstRow.id)
      expect(firstUpdated?.status).toBe('needs_attention')

      const secondUpdated = await loadSupplierOrder(secondRow.id)
      expect(secondUpdated?.status).toBe('needs_attention')

      const failureAudits = await rowFailureAuditsFor(firstRow.id)
      expect(failureAudits.length).toBeGreaterThan(0)
      expect(failureAudits[0]!.detail).toMatchObject({ sweep: 'overdue', message: 'alert transport down' })
    })
  })

  // ---------------------------------------------------------------------------
  // executeReconcile: combined shape + cross-sweep failure isolation
  // ---------------------------------------------------------------------------

  describe('executeReconcile', () => {
    it('runs all four sweeps and returns their combined counts, including failures', async () => {
      // One fixture per sweep, each guaranteed to fire exactly once.
      const orphanGid = orderGidFor()
      await seedWebhookEvent({ source: 'shopify', receivedAt: minutesBefore(20) })
      const { orderRowId: driftOrderId } = await seedOrder()
      await seedSupplierOrder({ orderRowId: driftOrderId, status: 'paid', updatedAt: minutesBefore(20) })
      const { orderRowId: overdueOrderId } = await seedOrder({ paidAt: daysBefore(8) })
      await seedSupplierOrder({ orderRowId: overdueOrderId, status: 'confirmed' })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockResolvedValue({ value: 'shipped', raw: 'shipped' })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)

      const { deps } = makeDeps({
        adapter,
        ordersUpdatedSince: async () => [
          {
            id: orphanGid,
            name: '#9009',
            test: false,
            displayFinancialStatus: 'PAID',
            updatedAt: now().toISOString(),
          },
        ],
      })

      const counts = await executeReconcile(deps)

      expect(counts).toEqual({ orphaned: 1, strandedWebhooks: 1, driftFixed: 1, overdue: 1, failures: 0 })
    })

    it('FINDING 2: a sweep-3 row failure does not abort the run — sweep 4 still executes and its own count/failure is still returned', async () => {
      const { orderRowId: failingOrderId } = await seedOrder()
      const failingRow = await seedSupplierOrder({ orderRowId: failingOrderId, status: 'paid', updatedAt: minutesBefore(20) })
      const { orderRowId: okOrderId } = await seedOrder()
      const okRow = await seedSupplierOrder({ orderRowId: okOrderId, status: 'paid', updatedAt: minutesBefore(20) })
      const { orderRowId: overdueOrderId } = await seedOrder({ paidAt: daysBefore(8) })
      const overdueRow = await seedSupplierOrder({ orderRowId: overdueOrderId, status: 'confirmed' })

      const adapter = new MockSupplierAdapter()
      vi.spyOn(adapter, 'getOrderStatus').mockImplementation(async (supplierOrderId: string) => {
        if (supplierOrderId === failingRow.supplierOrderId) {
          throw new Error('CJ API unreachable')
        }
        return { value: 'shipped', raw: 'shipped' }
      })
      vi.spyOn(adapter, 'getTracking').mockResolvedValue(null)

      const { deps } = makeDeps({ adapter })

      const counts = await executeReconcile(deps)

      // Second sweep-3 row still processed despite the first one's failure.
      const okUpdated = await loadSupplierOrder(okRow.id)
      expect(okUpdated?.status).toBe('shipped')
      const failingUpdated = await loadSupplierOrder(failingRow.id)
      expect(failingUpdated?.status).toBe('paid') // untouched

      // Sweep 4 still ran (proving executeReconcile completed all four sweeps despite sweep 3's error).
      const overdueUpdated = await loadSupplierOrder(overdueRow.id)
      expect(overdueUpdated?.status).toBe('needs_attention')

      expect(counts.driftFixed).toBe(1)
      expect(counts.overdue).toBe(1)
      expect(counts.failures).toBe(1)

      const failureAudits = await rowFailureAuditsFor(failingRow.id)
      expect(failureAudits.length).toBeGreaterThan(0)
      expect(failureAudits[0]!.detail).toMatchObject({ sweep: 'status_drift', message: 'CJ API unreachable' })
    })
  })
})
