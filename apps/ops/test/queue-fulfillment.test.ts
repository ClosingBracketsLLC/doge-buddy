import { createDb } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { startQueue, type Queue } from '../src/queue.ts'
import { createSettings } from '../src/settings.ts'

// `fulfillmentPlaceOrderHandler` (jobs/fulfillment-place-order.ts) calls the real
// `executePlaceOrder` directly — mocked here so this test proves queue *wiring* (a sent job
// reaches the handler with the right payload; singletonKey dedupe works through the real boss)
// without needing a fully-seeded order/mapping fixture, which `fulfillment-place-order.test.ts`
// already covers for the executor's own logic.
const { executePlaceOrderSpy } = vi.hoisted(() => ({
  executePlaceOrderSpy: vi.fn(async (_deps: unknown, _orderGid: string) => {}),
}))
vi.mock('../src/fulfillment/run-place-order.ts', () => ({
  executePlaceOrder: executePlaceOrderSpy,
}))

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('queue: fulfillment wiring', () => {
  let q: Queue
  const { db, pool } = createDb(url)
  const mockLog = { info: () => {}, warn: () => {}, error: () => {} }

  beforeAll(async () => {
    q = await startQueue(url, {
      adapter: new MockSupplierAdapter(),
      settings: createSettings(db),
      alert: createAlerter(db, mockLog),
    })
  })

  afterAll(async () => {
    await q.stop()
    await pool.end()
  })

  beforeEach(() => {
    executePlaceOrderSpy.mockClear()
  })

  it(
    'a sent fulfillment.place-order job reaches the executor through the real boss',
    async () => {
      const orderGid = `gid://shopify/Order/wire-${Date.now()}`
      await q.boss.send('fulfillment.place-order', { orderGid })

      await waitUntil(() => executePlaceOrderSpy.mock.calls.length > 0)

      expect(executePlaceOrderSpy).toHaveBeenCalledTimes(1)
      const [, receivedOrderGid] = executePlaceOrderSpy.mock.calls[0]!
      expect(receivedOrderGid).toBe(orderGid)
    },
    15_000,
  )

  it(
    'singletonKey dedupe: two sends with the same key while the first is active yield only one execution',
    async () => {
      let releaseFirst!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      executePlaceOrderSpy.mockImplementationOnce(async () => {
        await gate
      })

      const orderGid = `gid://shopify/Order/dedupe-${Date.now()}`
      const opts = { singletonKey: orderGid }

      // try/finally: if an assertion below throws, `releaseFirst()` still runs — leaving the
      // gated handler call permanently unresolved would strand that job in 'active' state in the
      // (persistent, shared-across-test-runs) test database, which — under `policy: 'singleton'`
      // — would then permanently block every future job sharing this queue's oldest-first fetch
      // order until pg-boss's 15-minute default job expiry catches up. Hit this exact hang during
      // development; this is the fix, not speculative hardening.
      try {
        const firstId = await q.boss.send('fulfillment.place-order', { orderGid }, opts)
        expect(firstId).not.toBeNull()

        // Wait for the worker to actually pick up and start the first job (state -> active)
        // before sending the second. pg-boss's `policy: 'singleton'` dedupes *concurrent
        // execution*, not the send itself: a second send with the same key while the first is
        // active still returns a real job id and gets queued — it's just held back from becoming
        // active (and therefore from running) until the first job leaves the active state.
        // Verified directly against a real pg-boss instance before writing this assertion.
        await waitUntil(() => executePlaceOrderSpy.mock.calls.length > 0)

        const secondId = await q.boss.send('fulfillment.place-order', { orderGid }, opts)
        expect(secondId).not.toBeNull()

        // While the first job is still active (gated on `gate`), the second must not also start
        // — that's the actual dedupe guarantee: never two concurrent executions for the same key.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(executePlaceOrderSpy).toHaveBeenCalledTimes(1)
      } finally {
        releaseFirst()
      }

      // Releasing the first lets the second (previously held-back) job take its turn — it was
      // queued, not dropped.
      await waitUntil(() => executePlaceOrderSpy.mock.calls.length > 1)
      expect(executePlaceOrderSpy).toHaveBeenCalledTimes(2)
    },
    15_000,
  )
})
