import { createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import PgBoss from 'pg-boss'
import type { createAlerter } from './alerts.ts'
import type { PlaceOrderDeps } from './fulfillment/run-place-order.ts'
import { type ShopifyFulfillmentOps, type SyncTrackingDeps } from './fulfillment/run-sync-tracking.ts'
import type { SendOpts } from './fulfillment/types.ts'
import { demoPingHandler } from './jobs/demo-ping.ts'
import { fulfillmentPayOrderHandler } from './jobs/fulfillment-pay-order.ts'
import { fulfillmentPlaceOrderHandler } from './jobs/fulfillment-place-order.ts'
import { fulfillmentSyncTrackingHandler } from './jobs/fulfillment-sync-tracking.ts'
import { webhookProcessHandler } from './jobs/webhook-process.ts'
import type { createSettings } from './settings.ts'

export interface FulfillmentQueueDeps {
  adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  /**
   * Shopify fulfillment operations backing `fulfillment.sync-tracking` (Task 13) and, later,
   * `fulfillment.reconcile` (Task 14). Optional here purely so tests that never touch either of
   * those queues (e.g. `queue-fulfillment.test.ts`'s place-order wiring checks) don't need to
   * supply one — when omitted, `startQueue` below wires a stub that throws
   * `'shopify not configured'` on any call, same as `index.ts` does when `config.shopify` is
   * unset (see that file's own stub for the production-path reasoning).
   */
  shopify?: ShopifyFulfillmentOps
}

export interface Queue {
  boss: PgBoss
  ready: () => boolean
  stop: () => Promise<void>
}

const PLACE_ORDER_QUEUE = 'fulfillment.place-order'
const PAY_ORDER_QUEUE = 'fulfillment.pay-order'
const SYNC_TRACKING_QUEUE = 'fulfillment.sync-tracking'
const RECONCILE_QUEUE = 'fulfillment.reconcile'
const WALLET_MONITOR_QUEUE = 'cj.wallet-monitor'

/**
 * `boss.createQueue` for a brand-new queue name runs DDL (creates the queue's partition table +
 * indexes) after an `INSERT ... ON CONFLICT DO NOTHING`. If two processes race to create the
 * *same never-before-seen* queue at the same time — multiple ops instances cold-booting against
 * a fresh database, or (as observed) parallel test files each calling `startQueue` — Postgres can
 * raise a deadlock (40P01) or serialization failure (40001) on that DDL. Once the queue exists,
 * every future call is a fast no-op, so this only ever matters on first boot; retrying a few
 * times with a short backoff is safe and sufficient.
 */
async function createQueueRetrying(boss: PgBoss, name: string, options?: PgBoss.Queue): Promise<void> {
  const RETRYABLE_CODES = new Set(['40P01', '40001'])
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; ; attempt++) {
    try {
      await boss.createQueue(name, options)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

export async function startQueue(connectionString: string, deps: FulfillmentQueueDeps): Promise<Queue> {
  const boss = new PgBoss(connectionString)
  const { db, pool } = createDb(connectionString)
  let running = false

  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  running = true

  // pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
  // this only forwards `opts` when the caller actually passed one.
  const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
    if (opts) {
      await boss.send(name, data, opts)
    } else {
      await boss.send(name, data)
    }
  }

  const placeOrderDeps: PlaceOrderDeps = {
    db,
    adapter: deps.adapter,
    settings: deps.settings,
    alert: deps.alert,
    enqueue,
  }

  // No-config fallback: mirrors `index.ts`'s own `config.shopify`-gated stub so a caller that
  // doesn't wire `deps.shopify` (unconfigured Shopify creds, or a test that never exercises this
  // queue) still gets a `FulfillmentQueueDeps.shopify`-shaped object — one that fails loudly (job
  // retries, then dead-letters) instead of throwing a `TypeError` on a missing method.
  const shopifyNotConfigured = (): Promise<never> => Promise.reject(new Error('shopify not configured'))
  const syncTrackingDeps: SyncTrackingDeps = {
    db,
    alert: deps.alert,
    shopifyOps: deps.shopify ?? {
      orderFulfillmentOrders: shopifyNotConfigured,
      fulfillmentCreate: shopifyNotConfigured,
      fulfillmentTrackingInfoUpdate: shopifyNotConfigured,
    },
  }

  await createQueueRetrying(boss, 'demo.ping')
  await boss.work('demo.ping', demoPingHandler(db))

  await createQueueRetrying(boss, 'webhook.shopify.process')
  await boss.work('webhook.shopify.process', webhookProcessHandler({ db, enqueue }, 'shopify'))

  await createQueueRetrying(boss, 'webhook.cj.process')
  await boss.work('webhook.cj.process', webhookProcessHandler({ db, enqueue }, 'cj'))

  // The three fulfillment queues below use `policy: 'singleton'` because every producer that
  // enqueues into them sets a `singletonKey` (order gid / supplier_orders row id) expecting
  // pg-boss to keep at most one ACTIVE job per key at a time — enforced by a unique index scoped
  // to `policy = 'singleton'` (pg-boss's default 'standard' policy applies no such constraint at
  // all). `createQueue` is idempotent (first call wins the policy for a given queue name for
  // good), so getting this right here matters. Note this dedupes concurrent *execution*, not the
  // `send()` itself: a second send with the same key while the first is active still succeeds
  // and queues normally — it just won't be picked up until the active one leaves that state.
  await createQueueRetrying(boss, PLACE_ORDER_QUEUE, { name: PLACE_ORDER_QUEUE, policy: 'singleton' })
  await boss.work(PLACE_ORDER_QUEUE, fulfillmentPlaceOrderHandler(placeOrderDeps))

  // `{ includeMetadata: true }` is required here (unlike the place-order worker above): the
  // pay-order handler's retry-exhaustion dead-letter hook needs `job.retryCount`/`retryLimit`,
  // which only `JobWithMetadata` (not the plain `Job` the 1-arg `work()` overload hands back)
  // carries — see the handler's own doc comment in jobs/fulfillment-pay-order.ts.
  await createQueueRetrying(boss, PAY_ORDER_QUEUE, { name: PAY_ORDER_QUEUE, policy: 'singleton' })
  await boss.work(PAY_ORDER_QUEUE, { includeMetadata: true }, fulfillmentPayOrderHandler(placeOrderDeps))

  await createQueueRetrying(boss, SYNC_TRACKING_QUEUE, { name: SYNC_TRACKING_QUEUE, policy: 'singleton' })
  await boss.work(SYNC_TRACKING_QUEUE, fulfillmentSyncTrackingHandler(syncTrackingDeps))

  // No singletonKey producer for these two (both are cron-driven sweeps, not per-entity jobs),
  // so the default 'standard' policy is correct — left unspecified deliberately.
  await createQueueRetrying(boss, RECONCILE_QUEUE)
  await boss.work(RECONCILE_QUEUE, async () => {
    // executeReconcile lands in Task 14 (run-reconcile.ts). Cron registration (hourly) also
    // lands in Task 14 — this task only creates the queue and its worker slot.
    throw new Error('fulfillment.reconcile lands in Task 14')
  })

  await createQueueRetrying(boss, WALLET_MONITOR_QUEUE)
  await boss.work(WALLET_MONITOR_QUEUE, async () => {
    // executeWalletMonitor lands in Task 15 (cj-wallet-monitor.ts). Cron registration (every 4h)
    // also lands in Task 15 — this task only creates the queue and its worker slot.
    throw new Error('cj.wallet-monitor lands in Task 15')
  })

  return {
    boss,
    ready: () => running,
    stop: async () => {
      running = false
      await boss.stop({ graceful: true, wait: true })
      await pool.end()
    },
  }
}

/**
 * Creates a queue (if needed), registers its worker, and schedules it on a cron. Used for
 * recurring jobs like `shopify.webhook-audit` that aren't triggered by application events.
 */
export async function registerCron<ReqData extends object = object>(
  boss: PgBoss,
  name: string,
  cron: string,
  handler: PgBoss.WorkHandler<ReqData>,
): Promise<void> {
  await createQueueRetrying(boss, name)
  await boss.work(name, handler)
  await boss.schedule(name, cron)
}
