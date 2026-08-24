import { auditLog, createDb, orders, supplierOrders } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { deadLetterPayOrder, executePayOrder } from '../src/fulfillment/run-pay-order.ts'
import type { PlaceOrderDeps } from '../src/fulfillment/run-place-order.ts'
import type { SupplierOrderStatusDb } from '../src/fulfillment/transitions.ts'
import { fulfillmentPayOrderHandler } from '../src/jobs/fulfillment-pay-order.ts'
import { createSettings } from '../src/settings.ts'

// `deadLetterPayOrder` (run-pay-order.ts) calls `parkNeedsAttention` (run-place-order.ts) to do
// the actual needs_attention transition + alert. One test below needs that call to fail (to prove
// the ORIGINAL payOrder error still propagates, and a `dead_letter_transition_failed` alert fires,
// per the coordinator review's Finding 1) — that requires forcing a real race/DB failure inside
// `applyTransition`'s guarded UPDATE, which isn't reliably reproducible without true concurrency.
// Instead, mock only `parkNeedsAttention` off the real module, defaulting to delegate straight
// through to the real implementation (`importOriginal`) so every OTHER test in this file — which
// never touches this mock directly — exercises the real function unchanged; only the one test that
// calls `.mockImplementationOnce(...)` on it sees different behavior, for exactly one call.
const { parkNeedsAttentionMock } = vi.hoisted(() => ({
  parkNeedsAttentionMock: vi.fn(),
}))
vi.mock('../src/fulfillment/run-place-order.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fulfillment/run-place-order.ts')>()
  parkNeedsAttentionMock.mockImplementation(actual.parkNeedsAttention)
  return { ...actual, parkNeedsAttention: parkNeedsAttentionMock }
})

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

  // Several tests below (the two `insufficient balance` scenarios) deliberately end with the row
  // parked in `awaiting_funds`, with no `total_amount_cents` ever set (this file's own
  // `seedSupplierOrder` never sets it). Left uncleaned in this shared, persistent test database,
  // that's exactly the "unknown_amounts" shape `cj-wallet-monitor.ts`'s own `executeWalletMonitor`
  // treats as a hard block on resuming ANY `awaiting_funds` row (see that function's own doc
  // comment) — `wallet-monitor.test.ts` already defends its OWN tests against this by wiping every
  // `awaiting_funds` row in its `beforeEach` (see that file's doc comment, which names this file
  // explicitly), but `fulfillment-e2e.test.ts`'s wallet-empty drill runs BEFORE both this file and
  // wallet-monitor.test.ts in file order, so it has no such defense — a dirty rerun of the ops
  // suite left it flaky, unable to tell "still short" apart from "blocked by someone else's stale
  // row". Tracking each test's own `orders.id` here and deleting its `supplier_orders`/`orders`
  // rows in `afterEach` (same pattern `fulfillment-place-order.test.ts` already uses) closes that
  // gap at the source instead of relying on a downstream file's defensive wipe.
  let createdOrderIds: string[] = []
  afterEach(async () => {
    if (createdOrderIds.length > 0) {
      await db.delete(supplierOrders).where(inArray(supplierOrders.orderId, createdOrderIds))
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
    }
    createdOrderIds = []
  })

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
    createdOrderIds.push(row!.id)
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
        // The mock adapter's own order counter restarts at 0 for every fresh instance — many
        // tests below deliberately construct their own adapter (e.g. for a distinct
        // failPayInsufficientBalance option), so `placed.supplierOrderId` is the same literal
        // ('mock-order-1') across most of them. Making the DB value unique avoids colliding with
        // the partial unique index on (supplier, supplier_order_id). Tests that exercise the
        // null-shipment_order_id fallback (where executePayOrder passes THIS column to the
        // adapter) assert against the suffixed row value and stub payOrder, so the suffix stays
        // harmless there too.
        supplierOrderId: opts.supplierOrderId == null ? null : `${opts.supplierOrderId}-${nextId()}`,
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

  it('null shipment_order_id falls back to supplier_order_id (CJ createOrderV3 never returns a shipment id)', async () => {
    // Regression: CJ's createOrderV3 response carries shipmentOrderId: null (verified live,
    // docs/cj-api-notes.md), and nothing in the pipeline backfills it — so throwing on a null
    // shipment_order_id dead-lettered every real CJ order at the payment step. The adapter
    // contract already blessed the fallback (payOrder(shipmentOrderId ?? supplierOrderId)).
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: null,
      supplierOrderId: 'SD26082400012206614001',
    })
    const adapter = new MockSupplierAdapter()
    const payOrderSpy = vi.spyOn(adapter, 'payOrder').mockResolvedValue({ paid: true })
    const { deps } = makeDeps(adapter)

    await executePayOrder(deps, supplierOrderRow.id)

    expect(payOrderSpy).toHaveBeenCalledWith(supplierOrderRow.supplierOrderId)
    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('paid')
  })

  it('missing BOTH shipment_order_id and supplier_order_id on a payable row throws', async () => {
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      status: 'confirmed',
      shipmentOrderId: null,
      supplierOrderId: null,
    })
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

  it('insufficient balance from confirmed: transitions to awaiting_funds, alerts BEFORE setting paused_for_funds (crash-safety ordering), does not throw', async () => {
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
    const alertSpy = vi.spyOn(deps, 'alert')
    const settingsSetSpy = vi.spyOn(deps.settings, 'set')

    await executePayOrder(deps, supplierOrderRow.id) // must not throw

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('awaiting_funds')

    expect(await deps.settings.get('fulfillment.paused_for_funds')).toBe(true)

    // Finding 2 (coordinator review): alert-before-flag, not flag-before-alert. A crash between
    // the two must leave the system merely un-paused-but-notified — never paused with the alert
    // permanently unreachable (the settings gate short-circuits before payOrder on every retry).
    expect(alertSpy).toHaveBeenCalledWith('critical', 'wallet_empty', { supplierOrderRowId: supplierOrderRow.id })
    expect(settingsSetSpy).toHaveBeenCalledWith('fulfillment.paused_for_funds', true)
    expect(alertSpy.mock.invocationCallOrder[0]).toBeLessThan(settingsSetSpy.mock.invocationCallOrder[0]!)

    const alerts = await alertRowsFor('wallet_empty')
    const match = alerts.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ severity: 'critical', supplierOrderRowId: supplierOrderRow.id })
  })

  it('insufficient balance from awaiting_funds (already-paused resume): no-op transition (stays awaiting_funds), still alerts before setting paused flag, does not throw', async () => {
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
    const alertSpy = vi.spyOn(deps, 'alert')
    const settingsSetSpy = vi.spyOn(deps.settings, 'set')

    await executePayOrder(deps, supplierOrderRow.id) // must not throw an IllegalTransitionError

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('awaiting_funds')
    expect(await deps.settings.get('fulfillment.paused_for_funds')).toBe(true)
    expect(alertSpy.mock.invocationCallOrder[0]).toBeLessThan(settingsSetSpy.mock.invocationCallOrder[0]!)

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
  beforeEach(() => {
    parkNeedsAttentionMock.mockClear() // clears call history only — the delegate-through default set at module load stays intact
    return resetSettings(db)
  })

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
    shipmentOrderId?: string
    supplierOrderId?: string
    status?: SupplierOrderStatusDb
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderRowId,
        supplier: 'mock',
        idempotencyKey: `test-${nextId()}`,
        status: opts.status ?? 'confirmed',
        shipmentOrderId: opts.shipmentOrderId ?? null,
        // See the sibling `seedSupplierOrder` above (executePayOrder describe) for why this needs
        // a uniqueness suffix: every test here also places its "first" order on a fresh adapter.
        supplierOrderId: opts.supplierOrderId == null ? null : `${opts.supplierOrderId}-${nextId()}`,
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

  it('final attempt whose dead-letter transition ITSELF fails: alerts dead_letter_transition_failed, still rethrows the ORIGINAL payOrder error (not the dead-letter one)', async () => {
    const adapter = failingAdapter()
    const placed = await placeMockOrder(adapter)
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({
      orderRowId,
      shipmentOrderId: placed.shipmentOrderId!,
      supplierOrderId: placed.supplierOrderId,
    })
    const { deps } = makeDeps(adapter)

    // Force the dead-letter transition itself to fail, for exactly this one call.
    parkNeedsAttentionMock.mockImplementationOnce(async () => {
      throw new Error('simulated parkNeedsAttention failure')
    })

    await expect(
      fulfillmentPayOrderHandler(deps)([
        {
          id: 'job-final-dlq-fails',
          name: 'fulfillment.pay-order',
          data: { supplierOrderRowId: supplierOrderRow.id },
          retryCount: 5,
          retryLimit: 5,
        },
      ]),
    ).rejects.toThrow(/address_rejected/) // the ORIGINAL payOrder failure, not the dead-letter one

    // The dead-letter transition never completed, so the row never reached needs_attention.
    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('confirmed')

    const alerts = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.dead_letter_transition_failed')))
    const match = alerts.find((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ severity: 'critical', supplierOrderRowId: supplierOrderRow.id })
    expect((match!.detail as { error?: string }).error).toContain('simulated parkNeedsAttention failure')
  })

  it('deadLetterPayOrder no-op guard: row already needs_attention -> does nothing (no transition attempt, no alert)', async () => {
    const { orderRowId } = await seedOrder()
    const supplierOrderRow = await seedSupplierOrder({ orderRowId, status: 'needs_attention' })
    const { deps } = makeDeps(new MockSupplierAdapter())

    await deadLetterPayOrder(deps, supplierOrderRow.id, new Error('irrelevant — row is not payable'))

    expect(parkNeedsAttentionMock).not.toHaveBeenCalled()

    const row = await loadSupplierOrder(supplierOrderRow.id)
    expect(row?.status).toBe('needs_attention') // untouched
    expect(row?.lastError).toBeNull()

    const alerts = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'alert'), eq(auditLog.action, 'alert.fulfillment_needs_attention')))
    expect(alerts.some((r) => (r.detail as { supplierOrderRowId?: string })?.supplierOrderRowId === supplierOrderRow.id)).toBe(
      false,
    )
  })
})
