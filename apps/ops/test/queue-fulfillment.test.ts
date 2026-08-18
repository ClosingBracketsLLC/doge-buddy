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
    'singletonKey dedupe: while the first job is active, pg-boss refuses to promote a second job with the same key to active',
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
        await waitUntil(() => executePlaceOrderSpy.mock.calls.length > 0)

        const secondId = await q.boss.send('fulfillment.place-order', { orderGid }, opts)
        expect(secondId).not.toBeNull()

        // NOTE on what this test does NOT prove by itself: `queue.ts` registers exactly one
        // `boss.work()` worker per queue, and that worker's fetch loop (pg-boss's `Worker.start`)
        // is a plain `while` loop that `await`s the handler before fetching again — so while job
        // 1's handler is gated here, that single worker structurally cannot attempt a second
        // fetch at all, regardless of queue policy. Asserting `executePlaceOrderSpy` was "called
        // once" at this point would therefore pass even against a `policy: 'standard'` queue with
        // zero real dedupe — a false positive an earlier version of this test shipped with (see
        // Task 10 fix report). To actually exercise the DB-level guarantee, call `boss.fetch()`
        // directly here — independent of the registered worker's loop — and assert it refuses to
        // return job 2. Verified this discriminates correctly with a throwaway script before
        // writing this: against an identical scenario on a `policy: 'standard'` queue, the same
        // direct fetch call *does* return job 2 (no dedupe); against `policy: 'singleton'` (what
        // this queue actually uses), it returns nothing for job 2, because the UPDATE that would
        // promote it collides with the unique index backing this policy (job_i2 in pg-boss's
        // schema: unique on (name, singleton_key) WHERE state='active' AND policy='singleton').
        const fetched = await q.boss.fetch('fulfillment.place-order', { batchSize: 10 })
        expect(fetched.some((job) => job.id === secondId)).toBe(false)

        // Reinforces (does not by itself prove — see note above) that no second execution
        // started while the first was active.
        expect(executePlaceOrderSpy).toHaveBeenCalledTimes(1)
      } finally {
        releaseFirst()
      }

      // Releasing the first lets the second (still 'created' — our direct fetch above never
      // consumed it) take its turn via the queue's own registered worker on its next poll,
      // proving it was queued, not dropped.
      await waitUntil(() => executePlaceOrderSpy.mock.calls.length > 1)
      expect(executePlaceOrderSpy).toHaveBeenCalledTimes(2)
    },
    15_000,
  )
})
