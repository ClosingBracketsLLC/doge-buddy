import {
  auditLog,
  createDb,
  orders,
  productVariants,
  products,
  supplierOrders,
  supplierVariantMappings,
} from '@doge-buddy/db'
import { type Address, MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { executePlaceOrder, type PlaceOrderDeps } from '../src/fulfillment/run-place-order.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// Every method on SupplierAdapter (packages/supplier/src/types.ts) — used to prove the is_test
// shell guard makes literally zero adapter calls of any kind, not just zero placeOrder calls.
const ALL_ADAPTER_METHODS = [
  'searchProducts',
  'getProduct',
  'getVariantStock',
  'quoteShipping',
  'placeOrder',
  'confirmOrder',
  'payOrder',
  'getOrderStatus',
  'getTracking',
  'getBalance',
  'getDisputeOptions',
  'openDispute',
  'getDispute',
  'verifyWebhook',
  'parseWebhook',
] as const

const ADDRESS: Address = {
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
function variantGidFor(numericId: string): string {
  return `gid://shopify/ProductVariant/${numericId}`
}

describe('executePlaceOrder', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  function spyAdapter(adapter: MockSupplierAdapter) {
    const spies = {} as Record<(typeof ALL_ADAPTER_METHODS)[number], ReturnType<typeof vi.spyOn>>
    for (const method of ALL_ADAPTER_METHODS) {
      spies[method] = vi.spyOn(adapter, method as never)
    }
    return spies
  }

  async function seedOrder(opts: {
    isTest?: boolean
    totalCents: number
    lineItems: { variantId: string; quantity: number }[]
    shippingAddress?: Address
  }): Promise<{ orderGid: string; orderRowId: string }> {
    const orderGid = orderGidFor()
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: orderGid,
        isTest: opts.isTest ?? false,
        totalCents: opts.totalCents,
        shippingAddress: opts.shippingAddress ?? ADDRESS,
        rawPayload: {
          admin_graphql_api_id: orderGid,
          line_items: opts.lineItems.map((li) => ({ variant_id: li.variantId, quantity: li.quantity })),
        },
      })
      .returning({ id: orders.id })
    return { orderGid, orderRowId: row!.id }
  }

  async function seedMapping(opts: {
    variantGid: string
    supplierVariantId: string
    supplierCostCents: number
  }): Promise<void> {
    const [product] = await db.insert(products).values({ title: 'Test product', status: 'active' }).returning({ id: products.id })
    const [variant] = await db
      .insert(productVariants)
      .values({
        productId: product!.id,
        shopifyVariantGid: opts.variantGid,
        sku: `sku-${nextId()}`,
        priceCents: 1999,
        supplierCostCents: opts.supplierCostCents,
      })
      .returning({ id: productVariants.id })
    await db.insert(supplierVariantMappings).values({
      variantId: variant!.id,
      supplier: 'mock',
      supplierProductId: 'mock-p1',
      supplierVariantId: opts.supplierVariantId,
      warehouseCountry: 'US',
    })
  }

  async function loadSupplierOrder(orderRowId: string) {
    const [row] = await db
      .select()
      .from(supplierOrders)
      .where(and(eq(supplierOrders.orderId, orderRowId), eq(supplierOrders.supplier, 'mock')))
    return row
  }

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

  it('missing order row throws (job retries)', async () => {
    const { deps } = makeDeps(new MockSupplierAdapter())
    await expect(executePlaceOrder(deps, 'gid://shopify/Order/does-not-exist')).rejects.toThrow()
  })

  it('is_test order returns before ANY adapter call and audits fulfillment.skipped_test (shell-layer double guard)', async () => {
    const { orderGid, orderRowId } = await seedOrder({ isTest: true, totalCents: 10_000, lineItems: [] })
    const adapter = new MockSupplierAdapter()
    const spies = spyAdapter(adapter)
    const { deps } = makeDeps(adapter)

    await executePlaceOrder(deps, orderGid)

    for (const method of ALL_ADAPTER_METHODS) {
      expect(spies[method]).not.toHaveBeenCalled()
    }

    // No supplier_orders row should have been created for a test order.
    expect(await loadSupplierOrder(orderRowId)).toBeUndefined()

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderRowId)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('fulfillment.skipped_test')
  })

  it('happy path: proceeds to confirmed, enqueues pay-order, persists amounts', async () => {
    const variantId = nextId()
    const variantGid = variantGidFor(variantId)
    await seedMapping({ variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter()
    const spies = spyAdapter(adapter)
    const { deps, enqueue } = makeDeps(adapter)

    await executePlaceOrder(deps, orderGid)

    expect(spies.placeOrder).toHaveBeenCalledTimes(1)
    expect(spies.confirmOrder).toHaveBeenCalledTimes(1)

    const row = await loadSupplierOrder(orderRowId)
    expect(row?.status).toBe('confirmed')
    expect(row?.supplierOrderId).toBe('mock-order-1')
    expect(row?.shipmentOrderId).toBe('mock-ship-1')
    expect(row?.logisticName).toBe('Standard')
    expect(row?.productAmountCents).toBe(620)
    expect(row?.postageAmountCents).toBe(499)
    expect(row?.totalAmountCents).toBe(1119)
    expect(row?.idempotencyKey).toBe(`db-${orderGid.replace(/\D/g, '')}`)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: row!.id },
      { singletonKey: row!.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
    )

    expect(adapter.placedOrders).toHaveLength(1)
  })

  it('needs_attention decision (unmapped item): transitions, persists "reason: detail" in lastError, alerts — never calls placeOrder/confirmOrder', async () => {
    const variantId = nextId()
    // Deliberately no mapping seeded for this variant.
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter()
    const spies = spyAdapter(adapter)
    const { deps } = makeDeps(adapter)

    await executePlaceOrder(deps, orderGid)

    expect(spies.placeOrder).not.toHaveBeenCalled()
    expect(spies.confirmOrder).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(orderRowId)
    expect(row?.status).toBe('needs_attention')
    expect(row?.lastError).toMatch(/^unmapped_item: /)
    expect(row?.lastError).toContain(variantGidFor(variantId))

    const alertRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.fulfillment_needs_attention')))
    const match = alertRows.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === row!.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ severity: 'warning', reason: 'unmapped_item', orderId: orderRowId })
  })

  it('requeue decision (killswitch): re-enqueues self with startAfter=delaySeconds and audits, without touching supplier_orders status', async () => {
    const variantId = nextId()
    await seedMapping({ variantGid: variantGidFor(variantId), supplierVariantId: 'mock-v1', supplierCostCents: 620 })
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter()
    const spies = spyAdapter(adapter)
    const { deps, enqueue } = makeDeps(adapter)
    await deps.settings.set('killswitch.global', true)

    try {
      await executePlaceOrder(deps, orderGid)

      expect(spies.placeOrder).not.toHaveBeenCalled()
      const row = await loadSupplierOrder(orderRowId)
      expect(row?.status).toBe('pending')

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(
        'fulfillment.place-order',
        { orderGid },
        { startAfter: 300, singletonKey: orderGid, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
      )

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'order'), eq(auditLog.entityId, orderRowId)))
      expect(auditRows.some((r) => r.action === 'fulfillment.requeued')).toBe(true)
    } finally {
      await deps.settings.set('killswitch.global', false)
    }
  })

  it('post-create cap violation: actual result total exceeds spend cap after placeOrder → needs_attention, confirm never called', async () => {
    // Planner estimates a tiny cost (from the DB mapping) so it proceeds; the mock adapter's own
    // pricing for the same supplier variant (inflated via priceMultiplier) is what actually comes
    // back from placeOrder — simulating price drift between the mapping cache and the live quote.
    const variantId = nextId()
    await seedMapping({ variantGid: variantGidFor(variantId), supplierVariantId: 'mock-v4', supplierCostCents: 1 })
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter({ priceMultiplier: 5 })
    const spies = spyAdapter(adapter)
    const { deps } = makeDeps(adapter)

    await executePlaceOrder(deps, orderGid)

    expect(spies.placeOrder).toHaveBeenCalledTimes(1)
    expect(spies.confirmOrder).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(orderRowId)
    expect(row?.status).toBe('needs_attention')
    expect(row?.totalAmountCents).toBeGreaterThan(7500) // default spend cap
    expect(row?.lastError).toMatch(/^cap_exceeded_post_create: /)

    const alertRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.fulfillment_needs_attention')))
    const match = alertRows.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === row!.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ reason: 'cap_exceeded_post_create' })
  })

  it('resume from confirmed: re-enqueues pay-order, calls no adapter methods', async () => {
    const variantId = nextId()
    await seedMapping({ variantGid: variantGidFor(variantId), supplierVariantId: 'mock-v1', supplierCostCents: 620 })
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter()
    const { deps, enqueue } = makeDeps(adapter)
    await executePlaceOrder(deps, orderGid) // drives it to confirmed
    enqueue.mockClear()

    const spies = spyAdapter(adapter)
    await executePlaceOrder(deps, orderGid) // resume

    for (const method of ALL_ADAPTER_METHODS) {
      expect(spies[method]).not.toHaveBeenCalled()
    }
    expect(enqueue).toHaveBeenCalledTimes(1)
    const row = await loadSupplierOrder(orderRowId)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: row!.id },
      { singletonKey: row!.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
    )
  })

  it('resume from needs_attention/failed/cancelled: returns without touching the adapter or enqueueing anything (operator owns it)', async () => {
    for (const status of ['needs_attention', 'failed', 'cancelled'] as const) {
      const { orderGid, orderRowId } = await seedOrder({ totalCents: 10_000, lineItems: [] })
      await db.insert(supplierOrders).values({
        orderId: orderRowId,
        supplier: 'mock',
        idempotencyKey: `db-${orderGid.replace(/\D/g, '')}`,
        status,
      })
      const adapter = new MockSupplierAdapter()
      const spies = spyAdapter(adapter)
      const { deps, enqueue } = makeDeps(adapter)

      await executePlaceOrder(deps, orderGid)

      for (const method of ALL_ADAPTER_METHODS) {
        expect(spies[method]).not.toHaveBeenCalled()
      }
      expect(enqueue).not.toHaveBeenCalled()
      const row = await loadSupplierOrder(orderRowId)
      expect(row?.status).toBe(status)
    }
  })

  it('crash-sim: run once to created (confirmOrder throws), rerun resumes and confirms — exactly one placeOrder call and one order in the mock store', async () => {
    const variantId = nextId()
    await seedMapping({ variantGid: variantGidFor(variantId), supplierVariantId: 'mock-v1', supplierCostCents: 620 })
    const { orderGid, orderRowId } = await seedOrder({
      totalCents: 10_000,
      lineItems: [{ variantId, quantity: 1 }],
    })
    const adapter = new MockSupplierAdapter()
    const { deps, enqueue } = makeDeps(adapter)

    const placeOrderSpy = vi.spyOn(adapter, 'placeOrder')
    const confirmSpy = vi.spyOn(adapter, 'confirmOrder').mockImplementationOnce(async () => {
      throw new Error('simulated crash before confirm completes')
    })

    // Run 1: placeOrder succeeds, transitions pending -> created, then confirmOrder throws.
    await expect(executePlaceOrder(deps, orderGid)).rejects.toThrow('simulated crash')

    const afterCrash = await loadSupplierOrder(orderRowId)
    expect(afterCrash?.status).toBe('created')
    expect(afterCrash?.supplierOrderId).toBe('mock-order-1')
    expect(adapter.placedOrders).toHaveLength(1)
    expect(placeOrderSpy).toHaveBeenCalledTimes(1)

    // Run 2: resumes from 'created'. Must NOT call placeOrder again; confirmOrder now succeeds
    // (mockImplementationOnce was consumed by run 1, so this call falls through to the real impl).
    await executePlaceOrder(deps, orderGid)

    expect(placeOrderSpy).toHaveBeenCalledTimes(1) // still 1 — no second placeOrder call
    expect(confirmSpy).toHaveBeenCalledTimes(2) // 1 throwing call + 1 real call
    expect(adapter.placedOrders).toHaveLength(1) // idempotent: no duplicate order in the mock store

    const afterResume = await loadSupplierOrder(orderRowId)
    expect(afterResume?.status).toBe('confirmed')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.pay-order',
      { supplierOrderRowId: afterResume!.id },
      { singletonKey: afterResume!.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
    )
  })

  it('resuming a job already at created status calls confirm only — no second placeOrder (spy)', async () => {
    // Directly seeds a supplier_orders row already at 'created', with a supplierOrderId that
    // exists in the mock adapter's store (via a prior real placeOrder call from a throwaway
    // order), so confirmOrder(id) succeeds. Distinct from the crash-sim test above: this exercises
    // the resume switch in isolation, without needing a thrown-error setup.
    const adapter = new MockSupplierAdapter()
    const { deps, enqueue } = makeDeps(adapter)
    const placed = await adapter.placeOrder({
      idempotencyKey: `seed-${nextId()}`,
      shippingAddress: ADDRESS,
      items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      logisticName: 'Standard',
      fromCountry: 'US',
    })

    const { orderRowId, orderGid } = await seedOrder({ totalCents: 10_000, lineItems: [] })
    await db.insert(supplierOrders).values({
      orderId: orderRowId,
      supplier: 'mock',
      idempotencyKey: `db-${orderGid.replace(/\D/g, '')}`,
      status: 'created',
      supplierOrderId: placed.supplierOrderId,
      shipmentOrderId: placed.shipmentOrderId,
      productAmountCents: placed.productAmountCents,
      postageAmountCents: placed.postageAmountCents,
      totalAmountCents: placed.totalAmountCents,
      logisticName: 'Standard',
    })

    const spies = spyAdapter(adapter)

    await executePlaceOrder(deps, orderGid)

    expect(spies.placeOrder).not.toHaveBeenCalled()
    expect(spies.confirmOrder).toHaveBeenCalledTimes(1)
    expect(spies.confirmOrder).toHaveBeenCalledWith(placed.supplierOrderId)

    const row = await loadSupplierOrder(orderRowId)
    expect(row?.status).toBe('confirmed')
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
