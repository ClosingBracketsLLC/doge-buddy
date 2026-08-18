import { auditLog, createDb, orders, supplierOrders } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { executePayOrder } from '../src/fulfillment/run-pay-order.ts'
import type { PlaceOrderDeps } from '../src/fulfillment/run-place-order.ts'
import type { SupplierOrderStatusDb } from '../src/fulfillment/transitions.ts'
import { fulfillmentPayOrderHandler } from '../src/jobs/fulfillment-pay-order.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const ADDRESS = {
  name: 'Ada Lovelace',
  line1: '123 Analytical Engine Way',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
}

let uid = 0
function nextId(): string {
  uid += 1
  return `${Date.now()}${uid}`
}
function orderGidFor(): string {
  return `gid://shopify/Order/${nextId()}`
}

/**
 * `settings` is one shared row per key across the whole (persistent, shared-across-test-runs)
 * test database — not scoped per test — so a test that sets `fulfillment.paused_for_funds` (the
 * insufficient-balance tests do) or any other gate setting leaks it into every test that runs
 * after it unless reset first. Called from `beforeEach` in both describe blocks below.
 */
async function resetSettings(db: ReturnType<typeof createDb>['db']): Promise<void> {
  const settings = createSettings(db)
  await settings.set('killswitch.global', false)
  await settings.set('workflow.fulfillment.enabled', true)
  await settings.set('fulfillment.paused_for_funds', false)
}

describe('executePayOrder', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  beforeEach(() => resetSettings(db))

  function makeDeps(adapter: MockSupplierAdapter): { deps: PlaceOrderDeps; enqueue: ReturnType<typeof vi.fn> } {
    const enqueue = vi.fn(async () => {})
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: PlaceOrderDeps = {
      db,
      adapter,
      settings: createSettings(db),
      alert: createAlerter(db, mockLog),
      enqueue,
    }
    return { deps, enqueue }
  }

  async function seedOrder(): Promise<{ orderGid: string; orderRowId: string }> {
    const orderGid = orderGidFor()
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: orderGid, isTest: false, totalCents: 10_000 })
      .returning({ id: orders.id })
    return { orderGid, orderRowId: row!.id }
  }

  /** Places a real order in the mock adapter's own store, so `payOrder` can find it by shipmentOrderId. */
  async function placeMockOrder(adapter: MockSupplierAdapter) {
    return adapter.placeOrder({
      idempotencyKey: `seed-${nextId()}`,
      shippingAddress: ADDRESS,
      items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      logisticName: 'Standard',
      fromCountry: 'US',
    })
  }

  async function seedSupplierOrder(opts: {
    orderRowId: string
    status: SupplierOrderStatusDb
    shipmentOrderId?: string | null
    supplierOrderId?: string | null
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderRowId,
        supplier: 'mock',
        idempotencyKey: `test-${nextId()}`,
        status: opts.status,
        shipmentOrderId: opts.shipmentOrderId === undefined ? null : opts.shipmentOrderId,
        supplierOrderId: opts.supplierOrderId === undefined ? null : opts.supplierOrderId,
      })
      .returning()
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

  it('missing supplier_orders row throws (job retries)', async () => {
    const { deps } = makeDeps(new MockSupplierAdapter())
    await expect(executePayOrder(deps, '00000000-0000-0000-0000-000000000000')).rejects.toThrow()
  })

  it.each(['pending', 'created', 'paid', 'needs_attention', 'cancelled', 'failed'] as const)(
    'wrong status (%s): audits fulfillment.pay_order_skipped and returns — zero adapter calls',
    async (status) => {
      const { orderRowId } = await seedOrder()
      const supplierOrderRow = await seedSupplierOrder({ orderRowId, status })
      const adapter = new MockSupplierAdapter()
      const payOrderSpy = vi.spyOn(adapter, 'payOrder')
      const { deps } = makeDeps(adapter)

      await executePayOrder(deps, supplierOrderRow.id)

      expect(payOrderSpy).not.toHaveBeenCalled()
      const row = await loadSupplierOrder(supplierOrderRow.id)
      expect(row?.status).toBe(status) // untouched

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderRowId)))
      expect(rows.some((r) => r.action === 'fulfillment.pay_order_skipped')).toBe(true)
    },
  )

  it('missing shipment_order_id on an otherwise-payable row throws', async () => {
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, status: 'confirmed', shipmentOrderId: null })
    const { deps } = makeDeps(new MockSupplierAdapter())

    await expect(executePayOrder(deps, supplierOrderRow.id)).rejects.toThrow(/shipment_order_id/)
  })

  it('happy path from confirmed: paid true -> transitions to paid, sets paidAt', async () => {
    const adapter = new MockSupplierAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const payOrderSpy = vi.spyOn(adapter, 'payOrder')
    const { deps } = makeDeps(adapter)

    await executePayOrder(deps, supplierOrderRow.id)

    expect(payOrderSpy).toHaveBeenCalledWith(placed.shipmentOrderId)
    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid')
    expect(row?.paidAt).toBeInstanceOf(Date)
  })

  it('happy path from awaiting_funds (resumed after a wallet top-up): paid true -> transitions to paid', async () => {
    const adapter = new MockSupplierAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'awaiting_funds',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await executePayOrder(deps, supplierOrderRow.id)

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid')
    expect(row?.paidAt).toBeInstanceOf(Date)
  })

  it('insufficient balance from confirmed: transitions to awaiting_funds, sets paused_for_funds, fires critical wallet_empty alert, does not throw', async () => {
    const adapter = new MockSupplierAdapter({ failPayInsufficientBalance: true })
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await executePayOrder(deps, supplierOrderRow.id) // must not throw

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('awaiting_funds')

    expect(await deps.settings.get('fulfillment.paused_for_funds')).toBe(true)

    const alerts = await alertRowsFor('wallet_empty')
    const match = alerts.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ severity: 'critical', supplierOrderRowId: supplierOrderRow.id })
  })

  it('insufficient balance from awaiting_funds (already-paused resume): no-op transition (stays awaiting_funds), still sets paused flag + alerts, does not throw', async () => {
    const adapter = new MockSupplierAdapter({ failPayInsufficientBalance: true })
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'awaiting_funds',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await executePayOrder(deps, supplierOrderRow.id) // must not throw an IllegalTransitionError

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('awaiting_funds')
    expect(await deps.settings.get('fulfillment.paused_for_funds')).toBe(true)

    const alerts = await alertRowsFor('wallet_empty')
    expect(alerts.some((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)).toBe(
      true,
    )
  })

  it('non-balance payOrder failure throws (bounded pg-boss retries), leaves status untouched', async () => {
    const adapter = new MockSupplierAdapter()
    const placed = await placeMockOrder(adapter)
    vi.spyOn(adapter, 'payOrder').mockResolvedValueOnce({ paid: false, failureReason: 'address_rejected' })
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await expect(executePayOrder(deps, supplierOrderRow.id)).rejects.toThrow(/address_rejected/)

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('confirmed')
  })

  it.each([
    ['killswitch.global', true, 'killswitch'],
    ['workflow.fulfillment.enabled', false, 'fulfillment_disabled'],
    ['fulfillment.paused_for_funds', true, 'paused_for_funds'],
  ] as const)('settings gate (%s=%s): re-enqueues self with startAfter=300, never calls payOrder', async (key, value, reason) => {
    const adapter = new MockSupplierAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: placed.shipmentOrderId,
      supplierOrderId: placed.supplierOrderId,
    })
    const payOrderSpy = vi.spyOn(adapter, 'payOrder')
    const { deps, enqueue } = makeDeps(adapter)
    // beforeEach above already reset every gate setting to its default; this flips only the one
    // under test, so the other two stay at their (non-blocking) defaults.
    await deps.settings.set(key, value)

    await executePayOrder(deps, supplierOrderRow.id)

    expect(payOrderSpy).not.toHaveBeenCalled()
    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('confirmed') // untouched

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: supplierOrderRow.id },
      { startAfter: 300, singletonKey: supplierOrderRow.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
    )

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderRowId)))
    const match = rows.find((r) => r.action === 'fulfillment.requeued')
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ stage: 'pay_order', reason })
  })
})

describe('fulfillmentPayOrderHandler (retry-exhaustion dead-letter)', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  beforeEach(() => resetSettings(db))

  function makeDeps(adapter: MockSupplierAdapter): { deps: PlaceOrderDeps; enqueue: ReturnType<typeof vi.fn> } {
    const enqueue = vi.fn(async () => {})
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: PlaceOrderDeps = {
      db,
      adapter,
      settings: createSettings(db),
      alert: createAlerter(db, mockLog),
      enqueue,
    }
    return { deps, enqueue }
  }

  async function seedOrder(): Promise<{ orderGid: string; orderRowId: string }> {
    const orderGid = orderGidFor()
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: orderGid, isTest: false, totalCents: 10_000 })
      .returning({ id: orders.id })
    return { orderGid, orderRowId: row!.id }
  }

  async function placeMockOrder(adapter: MockSupplierAdapter) {
    return adapter.placeOrder({
      idempotencyKey: `seed-${nextId()}`,
      shippingAddress: ADDRESS,
      items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      logisticName: 'Standard',
      fromCountry: 'US',
    })
  }

  async function seedSupplierOrder(opts: {
    orderRowId: string
    shipmentOrderId: string
    supplierOrderId: string
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderRowId,
        supplier: 'mock',
        idempotencyKey: `test-${nextId()}`,
        status: 'confirmed',
        shipmentOrderId: opts.shipmentOrderId,
        supplierOrderId: opts.supplierOrderId,
      })
      .returning()
    return row!
  }

  async function loadSupplierOrder(id: string) {
    const [row] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, id))
    return row
  }

  function failingAdapter(): MockSupplierAdapter {
    const adapter = new MockSupplierAdapter()
    vi.spyOn(adapter, 'payOrder').mockResolvedValue({ paid: false, failureReason: 'address_rejected' })
    return adapter
  }

  it('final attempt (retryCount >= retryLimit): dead-letters to needs_attention, alerts, then still rethrows', async () => {
    const adapter = failingAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      shipmentOrderId: placed.shipmentOrderId!,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await expect(
      fulfillmentPayOrderHandler(deps)([
        {
          id: 'job-final',
          name: 'fulfillment.pay-order',
          data: { supplierOrderRowId: supplierOrderRow.id },
          retryCount: 5,
          retryLimit: 5,
        },
      ]),
    ).rejects.toThrow(/address_rejected/)

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('needs_attention')
    expect(row?.lastError).toMatch(/^pay_order_failed: /)
    expect(row?.lastError).toContain('address_rejected')

    const alerts = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.fulfillment_needs_attention')))
    const match = alerts.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ severity: 'warning', reason: 'pay_order_failed', orderId: orderRowId })
  })

  it('non-final attempt (retryCount < retryLimit): rethrows without dead-lettering — row stays confirmed', async () => {
    const adapter = failingAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      shipmentOrderId: placed.shipmentOrderId!,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await expect(
      fulfillmentPayOrderHandler(deps)([
        {
          id: 'job-mid-retry',
          name: 'fulfillment.pay-order',
          data: { supplierOrderRowId: supplierOrderRow.id },
          retryCount: 2,
          retryLimit: 5,
        },
      ]),
    ).rejects.toThrow(/address_rejected/)

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('confirmed') // untouched — still has retries left
    expect(row?.lastError).toBeNull()
  })

  it('success: forwards to executePayOrder and does not throw', async () => {
    const adapter = new MockSupplierAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      shipmentOrderId: placed.shipmentOrderId!,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    await fulfillmentPayOrderHandler(deps)([
      {
        id: 'job-ok',
        name: 'fulfillment.pay-order',
        data: { supplierOrderRowId: supplierOrderRow.id },
        retryCount: 0,
        retryLimit: 5,
      },
    ])

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid')
  })
})
