import { createDb, orders, supplierOrders, webhookEvents } from '@doge-buddy/db'
import { type MockAdapterOptions, MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { upsertOrderFromPaidPayload } from '../src/fulfillment/order-upsert.ts'
import { executePayOrder } from '../src/fulfillment/run-pay-order.ts'
import { executePlaceOrder, FULFILLMENT_RETRY_OPTS, type PlaceOrderDeps } from '../src/fulfillment/run-place-order.ts'
import { executeReconcile, type ReconcileDeps } from '../src/fulfillment/run-reconcile.ts'
import type { ShopifyFulfillmentOps } from '../src/fulfillment/run-sync-tracking.ts'
import { executeWalletMonitor, type WalletMonitorDeps } from '../src/jobs/cj-wallet-monitor.ts'
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
      // adapter's own id (its in-memory counter restarts at 0 every test run, and while
      // `MockSupplierAdapter`'s per-instance nonce now keeps that id from colliding with another
      // instance's rows, it's still a 'mock'-supplier id, not a 'cj' one).
      // `findCjSupplierOrder`'s lookup is an unordered, unlimited SELECT scoped to supplier='cj'
      // — against this suite's persistent, never-reset shared test DB, a colliding id can match a
      // DIFFERENT (older, already-synced) row instead of this one, which is exactly what happened
      // the first time this test was written without this fix: the webhook silently updated a
      // stale row and this row's own gid stayed null. A fresh `uniqueId()`-based id makes the
      // lookup key unambiguous.
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

      // This test's own `adapter.placeOrder` call lands on a real 'mock'-supplier
      // `supplier_order_id` (never relabeled to 'cj' the way the happy-path test above does), so
      // — same reasoning as the kill-switch drill's own `finally` below — the row must not outlive
      // this test in this shared, persistent, never-reset test database.
      try {
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
      } finally {
        const leftoverRow = await loadSupplierOrderByOrderGid(db, orderGid)
        if (leftoverRow) await db.delete(supplierOrders).where(eq(supplierOrders.id, leftoverRow.id))
      }
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
        // `localAdapter` is a fresh MockSupplierAdapter — its per-instance nonce (see
        // mock-adapter.ts) keeps its first real `placeOrder` id from colliding with any other
        // instance's rows under the partial unique index on (supplier, supplier_order_id) that
        // T18 adds (guards `findCjSupplierOrder`'s unordered lookup), but this row must still not
        // outlive this test — cheap defense-in-depth, and keeps this shared, persistent,
        // never-reset test database tidy.
        const leftoverRow = await loadSupplierOrderByOrderGid(db, orderGid)
        if (leftoverRow) await db.delete(supplierOrders).where(eq(supplierOrders.id, leftoverRow.id))
      }
    },
    15_000,
  )
})

/**
 * Task 18: "Drills B" — the failure classes T17's own drills didn't cover: a crash mid-create, a
 * wallet running dry then getting topped up, and reconcile recovering an order that never got a
 * webhook at all. All three below use DIRECT executor calls, not the real queue — same
 * established convention as the kill-switch drill above (see its own doc comment): none of these
 * scenarios need pg-boss's actual timing (a crash retry, a wallet-monitor tick, and an hourly
 * reconcile sweep are all just "call the executor again" from the caller's perspective), so
 * driving them directly keeps the tests fast and deterministic while still exercising the real
 * production executors end to end.
 */
describe('fulfillment E2E: failure drills B (crash mid-create, wallet pause/resume, webhook outage)', () => {
  const { db, pool } = createDb(TEST_DB_URL)
  const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
  const settingsApi = createSettings(db)

  afterAll(() => pool.end())

  /**
   * Every test below places a "first" real order through its own fresh, single-use
   * MockSupplierAdapter — the mock adapter's own counter restarts at 0 per instance, and its
   * per-instance nonce (see mock-adapter.ts) keeps that id from colliding with any other
   * instance's rows under the T18 partial unique index on (supplier, supplier_order_id). The row
   * still must not outlive its own test, though — this shared, persistent test database never
   * resets between tests, files, or runs, and leftover rows are cheap to avoid. Called from a
   * `finally` in every test that places a real order.
   */
  async function cleanupMockOrder(orderGid: string): Promise<void> {
    const row = await loadSupplierOrderByOrderGid(db, orderGid)
    if (row) await db.delete(supplierOrders).where(eq(supplierOrders.id, row.id))
  }

  it(
    'crash mid-create: confirmOrder throws once -> row parked at created; rerun resumes without a second placeOrder call, reaches confirmed',
    async () => {
      const localAdapter = new MockSupplierAdapter()
      const enqueue = vi.fn(async () => {})
      const deps: PlaceOrderDeps = { db, adapter: localAdapter, settings: settingsApi, alert: createAlerter(db, mockLog), enqueue }

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
      const orderGid = orderGidFor()
      await upsertOrderFromPaidPayload(db, paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] }))

      const confirmSpy = vi.spyOn(localAdapter, 'confirmOrder').mockImplementationOnce(async () => {
        throw new Error('simulated crash before confirm completes')
      })

      try {
        // Run 1 ("the worker crashes mid-create"): placeOrder succeeds (row -> created,
        // supplierOrderId persisted), then confirmOrder throws — the exception propagates out of
        // executePlaceOrder uncaught, exactly what a killed worker or a failed job attempt looks
        // like from the caller's perspective (pg-boss would retry the job; not exercised here —
        // see the drill-3 429-storm test below for real pg-boss retry mechanics).
        await expect(executePlaceOrder(deps, orderGid)).rejects.toThrow('simulated crash before confirm completes')

        const parkedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(parkedRow?.status).toBe('created')
        expect(parkedRow?.supplierOrderId).toBeTruthy()
        expect(localAdapter.placedOrders).toHaveLength(1) // exactly one placeOrder call ever succeeded
        expect(confirmSpy).toHaveBeenCalledTimes(1)

        // Run 2 ("rerun" — a retried job, or a fresh worker picking the same order back up):
        // resumes from 'created' via confirmOrPark directly — must NOT call placeOrder again.
        await executePlaceOrder(deps, orderGid)

        const confirmedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(confirmedRow?.status).toBe('confirmed')
        expect(localAdapter.placedOrders).toHaveLength(1) // still exactly one — resume never re-placed
        expect(confirmSpy).toHaveBeenCalledTimes(2) // 1 throwing call + 1 real call
        expect(enqueue).toHaveBeenCalledWith(
          'fulfillment.pay-order',
          { supplierOrderRowId: confirmedRow!.id },
          { singletonKey: confirmedRow!.id, ...FULFILLMENT_RETRY_OPTS },
        )
      } finally {
        await cleanupMockOrder(orderGid)
      }
    },
    15_000,
  )

  it(
    'wallet-empty pause/resume: insufficient balance parks awaiting_funds + pauses; restored balance + wallet monitor resumes to paid',
    async () => {
      // `opts` is passed BY REFERENCE into the adapter's constructor (MockSupplierAdapter stores
      // it as-is, not a copy) — mutating it after construction changes what `getBalance`/`payOrder`
      // return on every SUBSEQUENT call, without needing a second adapter instance. That's what
      // "flip the mock balance" below actually does.
      const opts: MockAdapterOptions = { failPayInsufficientBalance: true, balanceCents: 100_000 }
      const localAdapter = new MockSupplierAdapter(opts)

      // executePlaceOrder's own enqueue forwards straight into the real executePayOrder — safe
      // here because at THIS point (first pay attempt) `fulfillment.paused_for_funds` is still
      // false, so executePayOrder's own settings gate lets it through cleanly.
      const forwardToPayOrder = vi.fn(async (name: string, data: object) => {
        if (name === 'fulfillment.pay-order') {
          await executePayOrder(deps, (data as { supplierOrderRowId: string }).supplierOrderRowId)
        }
      })
      const deps: PlaceOrderDeps = {
        db,
        adapter: localAdapter,
        settings: settingsApi,
        alert: createAlerter(db, mockLog),
        enqueue: forwardToPayOrder,
      }

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
      const orderGid = orderGidFor()
      await upsertOrderFromPaidPayload(db, paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] }))

      try {
        // place -> confirm -> (via forwardToPayOrder) pay: payOrder fails on insufficient balance,
        // parking the row at awaiting_funds and setting the global pause flag — all within this
        // one await, since forwardToPayOrder is awaited synchronously inside executePlaceOrder's
        // own enqueuePayOrder call.
        await executePlaceOrder(deps, orderGid)

        const pausedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(pausedRow?.status).toBe('awaiting_funds')
        expect(await settingsApi.get('fulfillment.paused_for_funds')).toBe(true)

        opts.failPayInsufficientBalance = false // "top up the wallet"

        // executeWalletMonitor's OWN enqueue must NOT forward synchronously into executePayOrder
        // the way executePlaceOrder's does above: wallet-monitor only clears
        // `fulfillment.paused_for_funds` AFTER its enqueue loop finishes (see that function's own
        // ordering rationale), so an executePayOrder call nested INSIDE that loop would still see
        // the flag as true, hit its own settings gate, and re-enqueue itself — forever (verified
        // this exact infinite loop with a throwaway repro before writing it this way). Recording
        // the enqueue instead and driving executePayOrder AFTER executeWalletMonitor returns
        // mirrors the real system's actual timing: a queued job only ever runs once some LATER
        // worker tick picks it up, by which point the flag has already been cleared.
        const recordedPayOrderRowIds: string[] = []
        const recordEnqueue = vi.fn(async (name: string, data: object) => {
          if (name === 'fulfillment.pay-order') {
            recordedPayOrderRowIds.push((data as { supplierOrderRowId: string }).supplierOrderRowId)
          }
        })
        const walletDeps: WalletMonitorDeps = {
          db,
          adapter: localAdapter,
          settings: settingsApi,
          alert: createAlerter(db, mockLog),
          enqueue: recordEnqueue,
        }
        await executeWalletMonitor(walletDeps)

        expect(await settingsApi.get('fulfillment.paused_for_funds')).toBe(false)
        expect(recordedPayOrderRowIds).toEqual([pausedRow!.id])

        // "the worker that would eventually pick up the job wallet-monitor just enqueued" — same
        // direct-executor convention as everywhere else in this describe.
        await executePayOrder(deps, pausedRow!.id)

        const resumedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(resumedRow?.status).toBe('paid')
      } finally {
        await settingsApi.set('fulfillment.paused_for_funds', false) // SETTINGS_DEFAULTS
        await cleanupMockOrder(orderGid)
      }
    },
    15_000,
  )

  it(
    'webhook outage: no orders/paid webhook ever arrives; reconcile discovers the paid order via ordersUpdatedSince and places it',
    async () => {
      const localAdapter = new MockSupplierAdapter()
      const forwardEnqueue = vi.fn(async (name: string, data: object) => {
        if (name === 'fulfillment.place-order') {
          await executePlaceOrder(placeDeps, (data as { orderGid: string }).orderGid)
        }
      })
      const placeDeps: PlaceOrderDeps = {
        db,
        adapter: localAdapter,
        settings: settingsApi,
        alert: createAlerter(db, mockLog),
        enqueue: forwardEnqueue,
      }

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
      const orderGid = orderGidFor()
      // No webhook at all — simulates the `orders` row existing (e.g. from a Shopify data sync
      // outside this system's own webhook path) with NOTHING ever having enqueued
      // fulfillment.place-order for it. Matches sweepOrphanedOrders's first sub-case ("an orders
      // row already exists ... just enqueue place-order") — the harder "no orders row at all" thin
      // sub-case is already covered directly in fulfillment-reconcile.test.ts.
      await upsertOrderFromPaidPayload(db, paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] }))

      const notUsed = async (): Promise<never> => {
        throw new Error('not used by this drill')
      }
      const reconcileDeps: ReconcileDeps = {
        db,
        adapter: localAdapter,
        settings: settingsApi,
        alert: createAlerter(db, mockLog),
        enqueue: forwardEnqueue,
        shopifyOps: {
          orderFulfillmentOrders: notUsed,
          fulfillmentCreate: notUsed,
          fulfillmentTrackingInfoUpdate: notUsed,
          ordersUpdatedSince: async () => [
            { id: orderGid, name: '#4242', test: false, displayFinancialStatus: 'PAID', updatedAt: new Date().toISOString() },
          ],
        },
        // Fixed, deliberately-ancient clock: every OTHER sweep (2 stranded webhooks, 3 status
        // drift, 4 overdue) runs unscoped queries against this same shared, persistent test
        // database — a real "now" would make sweep 3 try to poll leftover rows from unrelated
        // tests through THIS test's adapter (which has no idea about their supplierOrderIds) and
        // fail per-row. Pinning "now" decades in the past puts every real row's timestamp AFTER
        // every sweep's staleness cutoff, so sweeps 2-4 deterministically find nothing — isolating
        // this test to exactly what sweep 1 (orphaned orders) does with the one item this test's
        // own `ordersUpdatedSince` stub returns.
        now: () => new Date('2020-01-01T00:00:00.000Z'),
      }

      try {
        const result = await executeReconcile(reconcileDeps)

        expect(result.orphaned).toBe(1)
        expect(result.failures).toBe(0)
        expect(forwardEnqueue).toHaveBeenCalledWith(
          'fulfillment.place-order',
          { orderGid },
          { singletonKey: orderGid, ...FULFILLMENT_RETRY_OPTS },
        )

        const placedRow = await loadSupplierOrderByOrderGid(db, orderGid)
        expect(placedRow?.status).toBe('confirmed')
        expect(placedRow?.supplierOrderId).toBeTruthy()
        expect(localAdapter.placedOrders).toHaveLength(1)
      } finally {
        await cleanupMockOrder(orderGid)
      }
    },
    15_000,
  )
})

/**
 * Task 18 drill: 429 storm. Unlike the direct-executor drills above, this one specifically needs
 * REAL pg-boss retries — the point is proving the production retry wiring (FULFILLMENT_RETRY_OPTS
 * on the fulfillment.place-order queue) actually recovers from a transient supplier failure, not
 * just that `executePlaceOrder` behaves correctly when called twice. Runs in its own describe (own
 * queue, own adapter) rather than sharing the top describe's `q`/`adapter` — those are already
 * mid-lifecycle across 4 tests by the time this file gets here, and this drill needs a supplier
 * adapter configured with `failPlaceOrderTimes` from the start.
 */
describe('fulfillment E2E: 429 storm (real queue + pg-boss retries)', () => {
  const { db, pool } = createDb(TEST_DB_URL)
  const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
  const settingsApi = createSettings(db)

  let q: Queue
  let adapter: MockSupplierAdapter

  beforeAll(async () => {
    adapter = new MockSupplierAdapter({ failPlaceOrderTimes: 3 })
    q = await startQueue(TEST_DB_URL, { adapter, settings: settingsApi, alert: createAlerter(db, mockLog) })
  })

  afterAll(async () => {
    await q.stop()
    await pool.end()
  })

  it(
    'failPlaceOrderTimes: 3 -> pg-boss retries recover automatically -> exactly one mock order placed, >=3 attempts recorded, eventually confirmed',
    async () => {
      const placeOrderSpy = vi.spyOn(adapter, 'placeOrder')

      const variantId = uniqueId('v-')
      const variantGid = variantGidFor(variantId)
      await seedMapping(db, { variantGid, supplierVariantId: 'mock-v1', supplierCostCents: 620 })
      const orderGid = orderGidFor()
      await upsertOrderFromPaidPayload(db, paidPayload(orderGid, { line_items: [{ variant_id: variantId, quantity: 1 }] }))

      try {
        // A small, fixed retry delay (not FULFILLMENT_RETRY_OPTS's production 30s/backoff shape)
        // purely to keep this test's wall-clock time reasonable — what's under test is pg-boss's
        // own automatic per-job retry MECHANISM on a thrown handler error, not the specific
        // production backoff schedule (already a separately-documented literal in
        // run-place-order.ts, unrelated to this drill). retryLimit: 5 leaves headroom above the 3
        // injected failures.
        await q.boss.send('fulfillment.place-order', { orderGid }, { retryLimit: 5, retryBackoff: false, retryDelay: 1 })

        // Polls for 'confirmed' OR anything past it ('paid') — once the 4th attempt's placeOrder
        // succeeds, confirmOrPark chains straight into enqueuing fulfillment.pay-order on the same
        // real queue, which can race ahead to 'paid' before this poll's next tick.
        const row = await waitFor(async () => {
          const r = await loadSupplierOrderByOrderGid(db, orderGid)
          return r && (r.status === 'confirmed' || r.status === 'paid') ? r : undefined
        }, 35_000)

        expect(placeOrderSpy.mock.calls.length).toBeGreaterThanOrEqual(3) // >= 3 attempts, per the brief
        expect(row.supplierOrderId).toBeTruthy()
        const placedForThisOrder = adapter.placedOrders.filter((o) => o.supplierOrderId === row.supplierOrderId)
        expect(placedForThisOrder).toHaveLength(1) // exactly one mock order, despite the retried attempts
      } finally {
        const finalRow = await loadSupplierOrderByOrderGid(db, orderGid)
        if (finalRow) await db.delete(supplierOrders).where(eq(supplierOrders.id, finalRow.id))
      }
    },
    45_000,
  )
})
