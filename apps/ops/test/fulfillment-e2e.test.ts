import { createDb, orders, supplierOrders, webhookEvents } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { upsertOrderFromPaidPayload } from '../src/fulfillment/order-upsert.ts'
import { executePlaceOrder, type PlaceOrderDeps } from '../src/fulfillment/run-place-order.ts'
import type { ShopifyFulfillmentOps } from '../src/fulfillment/run-sync-tracking.ts'
import { startQueue, type Queue } from '../src/queue.ts'
import { createSettings } from '../src/settings.ts'
import {
  ADDRESS_REST,
  TEST_DB_URL,
  insertWebhookEvent,
  loadSupplierOrderByOrderGid,
  orderGidFor,
  paidPayload,
  seedMapping,
  uniqueId,
  variantGidFor,
  waitFor,
} from './helpers/fulfillment-harness.ts'

/**
 * Task 17: proves the fulfillment pipeline end-to-end through the REAL pg-boss queues wired by
 * `startQueue` — every unit of logic exercised here (planner gates, transitions, the CJ webhook
 * router, sync-tracking) already has its own dedicated unit-test file; this suite's only job is
 * wiring: does a job sent into one real queue actually reach, and correctly chain into, the next.
 *
 * Each scenario seeds its own product/variant/mapping and its own order gid (via `uniqueId`), so
 * the four `it`s below never share mutable fixture state — only the queue/adapter/shopifyOps
 * instances (started once in `beforeAll`) and the DB itself are shared, same as `queue.test.ts` /
 * `queue-fulfillment.test.ts` / `webhook-router.test.ts`'s own real-queue describe blocks.
 */
describe('fulfillment E2E: happy path + gate drills', () => {
  const { db, pool } = createDb(TEST_DB_URL)
  const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
  const settingsApi = createSettings(db)

  let q: Queue
  let adapter: MockSupplierAdapter
  let shopifyOps: {
    orderFulfillmentOrders: ReturnType<typeof vi.fn>
    fulfillmentCreate: ReturnType<typeof vi.fn>
    fulfillmentTrackingInfoUpdate: ReturnType<typeof vi.fn>
    ordersUpdatedSince: ReturnType<typeof vi.fn>
  }

  beforeAll(async () => {
    adapter = new MockSupplierAdapter()
    shopifyOps = {
      orderFulfillmentOrders: vi.fn(async () => [{ id: 'gid://shopify/FulfillmentOrder/e2e-1', status: 'OPEN' }]),
      fulfillmentCreate: vi.fn(async () => ({ fulfillmentId: 'gid://shopify/Fulfillment/e2e-1' })),
      fulfillmentTrackingInfoUpdate: vi.fn(async () => {}),
      ordersUpdatedSince: vi.fn(async () => []),
    }
    q = await startQueue(TEST_DB_URL, {
      adapter,
      settings: settingsApi,
      alert: createAlerter(db, mockLog),
      shopify: shopifyOps as unknown as ShopifyFulfillmentOps,
    })
  })

  afterAll(async () => {
    await q.stop()
    await pool.end()
  })

  it(
    'happy path: orders/paid -> real queue -> supplier order reaches paid -> CJ LOGISTICS webhook replay -> sync-tracking -> fulfillmentCreate called once, gid persisted',
    async () => {
      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })

      const orderGid = orderGidFor()
      const payload = paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] })
      const webhookEventId = await insertWebhookEvent(db, 'shopify', 'orders/paid', payload)

      // Real queue, start to finish: webhook.shopify.process -> upsertOrderFromPaidPayload +
      // enqueue fulfillment.place-order -> executePlaceOrder (plan -> proceed -> confirm) ->
      // enqueue fulfillment.pay-order -> executePayOrder -> paid.
      await q.boss.send('webhook.shopify.process', { webhookEventId })

      const paidRow = await waitFor(async () => {
        const row = await loadSupplierOrderByOrderGid(db, orderGid)
        return row?.status === 'paid' ? row : undefined
      }, 25_000)

      expect(paidRow.supplierOrderId).toBeTruthy()
      expect(adapter.placedOrders.some((o) => o.supplierOrderId === paidRow.supplierOrderId)).toBe(true)

      // CJ webhook routing (`findCjSupplierOrder` in src/jobs/webhook-process.ts) is intentionally
      // scoped to `supplier_orders.supplier = 'cj'` — CJ is the only real (non-mock) supplier this
      // system integrates with. This suite runs the pipeline against MockSupplierAdapter (key:
      // 'mock', see packages/supplier) to avoid any network calls, so the row the real pipeline
      // just produced is tagged 'mock'. Relabel it to 'cj' — nothing else about the row changes —
      // purely so a real CJ LOGISTICS webhook has a matching row to find; this is the same "seed a
      // supplier='cj' row directly" pattern webhook-router.test.ts's own CJ routing tests use, just
      // applied post-hoc to a row this test built through the real place/pay pipeline instead of a
      // hand-seeded one.
      //
      // Also overwrite supplier_order_id with a fresh unique value rather than reusing the mock
      // adapter's own 'mock-order-1' (its in-memory counter restarts at 0 every test run, so that
      // exact id is deterministically reused run after run). `findCjSupplierOrder`'s lookup is an
      // unordered, unlimited SELECT — against this suite's persistent, never-reset shared test DB,
      // a colliding id can match a DIFFERENT (older, already-synced) row instead of this one,
      // which is exactly what happened the first time this test was written without this fix: the
      // webhook silently updated a stale row and this row's own gid stayed null. A fresh
      // `uniqueId()`-based id makes the lookup key unambiguous.
      const cjOrderId = uniqueId('cj-order-')
      await db
        .update(supplierOrders)
        .set({ supplier: 'cj', supplierOrderId: cjOrderId })
        .where(eq(supplierOrders.id, paidRow.id))

      const trackNumber = uniqueId('TRACK-')
      const logisticsPayload = {
        type: 'LOGISTICS',
        messageId: uniqueId('cj-msg-'),
        orderId: cjOrderId,
        trackNumber,
        logisticName: 'CJPacket Ordinary',
      }
      const logisticsEventId = await insertWebhookEvent(db, 'cj', 'logistics', logisticsPayload)

      // Real queue again: webhook.cj.process -> routeCjLogistics (persists tracking fields, enqueues
      // fulfillment.sync-tracking) -> executeSyncTracking -> fake fulfillmentCreate.
      await q.boss.send('webhook.cj.process', { webhookEventId: logisticsEventId })

      await waitFor(async () => (shopifyOps.fulfillmentCreate.mock.calls.length > 0 ? true : undefined), 15_000)

      expect(shopifyOps.fulfillmentCreate).toHaveBeenCalledTimes(1)
      expect(shopifyOps.fulfillmentCreate).toHaveBeenCalledWith({
        fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/e2e-1',
        trackingNumber: trackNumber,
        trackingCompany: 'CJPacket Ordinary',
        notifyCustomer: true,
      })

      const [finalRow] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, paidRow.id))
      expect(finalRow!.shopifyFulfillmentGid).toBe('gid://shopify/Fulfillment/e2e-1')
      expect(finalRow!.trackingNumber).toBe(trackNumber)
      expect(finalRow!.trackingSyncedValue).toBe(trackNumber)
      expect(finalRow!.trackingSyncedToShopifyAt).toBeInstanceOf(Date)
      expect(finalRow!.status).toBe('paid') // sync-tracking never writes supplier_orders.status
    },
    30_000,
  )

  it(
    'duplicate orders/paid (NEW webhook event id, same order): still exactly one supplier_orders row and one mock order placed',
    async () => {
      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })

      const orderGid = orderGidFor()
      const buildPayload = () => paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] })

      const firstEventId = await insertWebhookEvent(db, 'shopify', 'orders/paid', buildPayload())
      await q.boss.send('webhook.shopify.process', { webhookEventId: firstEventId })

      // Wait for the FIRST delivery to fully settle (through place-order AND pay-order) before the
      // duplicate arrives — this is what makes the invariant below unambiguous: by the time the
      // second delivery's place-order job could possibly run, the row is already 'paid', so
      // `executePlaceOrder`'s resume switch takes its idempotent no-op branch, guaranteed.
      const paidRow = await waitFor(async () => {
        const row = await loadSupplierOrderByOrderGid(db, orderGid)
        return row?.status === 'paid' ? row : undefined
      }, 25_000)

      const secondEventId = await insertWebhookEvent(db, 'shopify', 'orders/paid', buildPayload())
      await q.boss.send('webhook.shopify.process', { webhookEventId: secondEventId })

      // Proves the router itself handled the replay cleanly (upsert, not insert) — the row-count
      // invariants below already hold at this point regardless of whether/when a resulting
      // fulfillment.place-order job for the second delivery gets a turn on the singleton queue.
      await waitFor(async () => {
        const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, secondEventId))
        return row?.processedAt ? true : undefined
      }, 15_000)

      const orderRows = await db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
      expect(orderRows).toHaveLength(1)

      const supplierOrderRows = await db
        .select()
        .from(supplierOrders)
        .where(and(eq(supplierOrders.orderId, orderRows[0]!.id), eq(supplierOrders.supplier, 'mock')))
      expect(supplierOrderRows).toHaveLength(1)
      expect(supplierOrderRows[0]!.id).toBe(paidRow.id)

      const placedForThisOrder = adapter.placedOrders.filter((o) => o.supplierOrderId === paidRow.supplierOrderId)
      expect(placedForThisOrder).toHaveLength(1)
    },
    30_000,
  )

  it(
    'cap exceeded (spend cap 100c): needs_attention, placeOrder never called, zero spend',
    async () => {
      const placeOrderSpy = vi.spyOn(adapter, 'placeOrder')

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      // Product cost alone (620c) plus standard freight (499c) is already 1119c — comfortably
      // over the 100c cap this test sets, so gate 6's PRE-`placeOrder` cap check (plan.ts) is what
      // fires, not the post-create re-check `run-place-order.ts` does after a real placeOrder call.
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })

      const orderGid = orderGidFor()
      const payload = paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] })
      const webhookEventId = await insertWebhookEvent(db, 'shopify', 'orders/paid', payload)

      await settingsApi.set('fulfillment.spend_cap_per_order_cents', 100)
      try {
        await q.boss.send('webhook.shopify.process', { webhookEventId })

        const parkedRow = await waitFor(async () => {
          const row = await loadSupplierOrderByOrderGid(db, orderGid)
          return row?.status === 'needs_attention' ? row : undefined
        }, 20_000)

        expect(parkedRow.lastError).toMatch(/^cap_exceeded: /)
        expect(placeOrderSpy).not.toHaveBeenCalled()
        expect(parkedRow.supplierOrderId).toBeNull()
        expect(parkedRow.totalAmountCents).toBeNull() // zero spend: nothing was ever placed
      } finally {
        await settingsApi.set('fulfillment.spend_cap_per_order_cents', 7500) // SETTINGS_DEFAULTS
        placeOrderSpy.mockRestore()
      }
    },
    25_000,
  )

  it(
    'kill-switch mid-flight: parks while on (status stays pending, zero adapter calls), resumes to confirmed + pay enqueued once off',
    async () => {
      // Direct executePlaceOrder calls, not the real queue — see brief: the real requeue path
      // (`dispatchDecision`'s 'requeue' case) uses a fixed 300s `startAfter`
      // (plan.ts's REQUEUE_DELAY_SECONDS / run-place-order.ts's FULFILLMENT_RETRY_OPTS), so waiting
      // for pg-boss to actually resurface the requeued job would make this test five minutes of
      // dead time for no extra wiring coverage: `executePlaceOrder` here is the exact same real
      // executor `fulfillmentPlaceOrderHandler` hands each queued job to (jobs/fulfillment-place-
      // order.ts is a one-line pass-through), and queue-fulfillment.test.ts already proves a sent
      // job reaches that same executor through the real boss. What's novel here — settings flip
      // between two runs actually parking then resuming the row via the real planner + applyTransition
      // — is exactly what this test proves.
      const localAdapter = new MockSupplierAdapter()
      const enqueue = vi.fn(async () => {})
      const deps: PlaceOrderDeps = {
        db,
        adapter: localAdapter,
        settings: settingsApi,
        alert: createAlerter(db, mockLog),
        enqueue,
      }

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
      const orderGid = orderGidFor()
      await upsertOrderFromPaidPayload(db, paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] }))

      try {
        await settingsApi.set('killswitch.global', true)
        await executePlaceOrder(deps, orderGid)

        const parkedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(parkedRow?.status).toBe('pending')
        expect(localAdapter.placedOrders).toHaveLength(0)
        expect(enqueue).toHaveBeenCalledWith(
          'fulfillment.place-order',
          { orderGid },
          { startAfter: 300, singletonKey: orderGid, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
        )

        enqueue.mockClear()
        await settingsApi.set('killswitch.global', false)

        // "next run": the worker that would eventually pick up the self-requeued job calls
        // executePlaceOrder again for the same orderGid — simulated directly here.
        await executePlaceOrder(deps, orderGid)

        const confirmedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(confirmedRow?.status).toBe('confirmed')
        expect(localAdapter.placedOrders).toHaveLength(1)
        expect(enqueue).toHaveBeenCalledTimes(1)
        expect(enqueue).toHaveBeenCalledWith(
          'fulfillment.pay-order',
          { supplierOrderRowId: confirmedRow!.id },
          { singletonKey: confirmedRow!.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
        )
      } finally {
        await settingsApi.set('killswitch.global', false)
        // `localAdapter` is a fresh MockSupplierAdapter, so its first (and only) real `placeOrder`
        // call above always lands on the same literal id ('mock-order-1') every run — harmless on
        // its own, but the partial unique index on (supplier, supplier_order_id) that T18 adds
        // (guards `findCjSupplierOrder`'s unordered lookup) means this row must not outlive this
        // test, or the next fresh-adapter test anywhere in the suite that also places a "first"
        // mock order would collide with it in this shared, persistent, never-reset test database.
        const leftoverRow = await loadSupplierOrderByOrderGid(db, orderGid)
        if (leftoverRow) await db.delete(supplierOrders).where(eq(supplierOrders.id, leftoverRow.id))
      }
    },
    15_000,
  )
})
