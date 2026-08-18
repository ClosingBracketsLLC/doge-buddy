import { createDb } from '@doge-buddy/db'
import {
  fulfillmentCreate,
  fulfillmentTrackingInfoUpdate,
  orderFulfillmentOrders,
  ShopifyAdminClient,
  ShopifyTokenManager,
} from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient, MockSupplierAdapter, type SupplierAdapter } from '@doge-buddy/supplier'
import { createAlerter } from './alerts.ts'
import { loadConfig } from './config.ts'
import type { ShopifyFulfillmentOps } from './fulfillment/run-sync-tracking.ts'
import type { WebhookDeps } from './http/webhooks.ts'
import { shopifyWebhookAudit } from './jobs/shopify-webhook-audit.ts'
import { registerCron, startQueue, type Queue } from './queue.ts'
import { buildServer } from './server.ts'
import { createSettings } from './settings.ts'
import { DrizzleCjTokenStore } from './stores/cj-token-store.ts'

const config = loadConfig(process.env)
const { db, pool } = createDb(config.databaseUrl, { connectionTimeoutMillis: 5000 })
const settings = createSettings(db)

const cjAdapter = config.cj
  ? new CJSupplierAdapter({
      client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
      openId: config.cj.openId,
    })
  : undefined

// FULFILLMENT_SUPPLIER picks which SupplierAdapter backs the fulfillment queues. loadConfig's
// zod schema already guarantees `config.cj` is set whenever fulfillmentSupplier is 'cj' — this
// check is a second, defense-in-depth guard in case that invariant is ever broken by a future
// change to config.ts, rather than a path expected to actually trigger today.
let supplierAdapter: SupplierAdapter
if (config.fulfillmentSupplier === 'cj') {
  if (!cjAdapter) {
    throw new Error('FULFILLMENT_SUPPLIER=cj but no CJ adapter was constructed (config.cj is missing)')
  }
  supplierAdapter = cjAdapter
} else {
  supplierAdapter = new MockSupplierAdapter()
}

// `queue` is assigned only after `app` (below) exists — `startQueue` needs `app.log` (via the
// alerter) as one of its own dependencies, so building the server has to come first. The
// webhook route's `enqueue` closes over this `let` binding rather than an already-assigned
// value; that's safe because webhook routes only ever run at request time, which is after
// `app.listen()`, which is itself after `queue` is assigned below.
let queue: Queue

// pg-boss's 3-arg `send` overload requires a real SendOptions object (not `undefined`), so
// this only forwards `opts` when the caller actually passed one.
const enqueue: WebhookDeps['enqueue'] = async (name, data, opts) => {
  if (opts) {
    await queue.boss.send(name, data, opts)
  } else {
    await queue.boss.send(name, data)
  }
}

const webhookDeps: WebhookDeps = {
  db,
  enqueue,
  ...(config.shopify ? { shopifyWebhookSecret: config.shopify.webhookSecret } : {}),
  ...(cjAdapter
    ? {
        cjVerify: (rawBody: Buffer, headers: Record<string, string | string[] | undefined>) =>
          cjAdapter.verifyWebhook(rawBody, headers),
        cjParse: (rawBody: Buffer) => cjAdapter.parseWebhook(rawBody),
      }
    : {}),
}

const app = buildServer({ pool, isQueueReady: () => queue.ready(), webhooks: webhookDeps })

const alert = createAlerter(db, app.log)

// Built here — before `startQueue` — because the `fulfillment.sync-tracking` queue it wires needs
// a `shopifyOps` dep at registration time, not just at cron time (unlike the webhook-audit cron
// below, which only needs the client once `adminBaseUrl` is also known). `shopifyClient` is
// `undefined` whenever `config.shopify` is unset (dev without Shopify creds) — `shopifyOps` falls
// back to a stub that throws `'shopify not configured'` on any call in that case, so a
// `fulfillment.sync-tracking` job simply fails/retries (and eventually needs an operator) rather
// than crashing on a missing method.
const shopifyClient = config.shopify
  ? new ShopifyAdminClient({
      shopDomain: config.shopify.shopDomain,
      tokenManager: new ShopifyTokenManager({
        shopDomain: config.shopify.shopDomain,
        clientId: config.shopify.clientId,
        clientSecret: config.shopify.clientSecret,
      }),
    })
  : undefined

const shopifyNotConfigured = (): Promise<never> => Promise.reject(new Error('shopify not configured'))
const shopifyOps: ShopifyFulfillmentOps = shopifyClient
  ? {
      orderFulfillmentOrders: (orderGid) => orderFulfillmentOrders(shopifyClient, orderGid),
      fulfillmentCreate: (args) => fulfillmentCreate(shopifyClient, args),
      fulfillmentTrackingInfoUpdate: (gid, tracking) => fulfillmentTrackingInfoUpdate(shopifyClient, gid, tracking),
    }
  : {
      orderFulfillmentOrders: shopifyNotConfigured,
      fulfillmentCreate: shopifyNotConfigured,
      fulfillmentTrackingInfoUpdate: shopifyNotConfigured,
    }

queue = await startQueue(config.databaseUrl, { adapter: supplierAdapter, settings, alert, shopify: shopifyOps })

if (config.shopify && config.adminBaseUrl && shopifyClient) {
  const { adminBaseUrl } = config
  await registerCron(queue.boss, 'shopify.webhook-audit', '0 6 * * *', async () => {
    await shopifyWebhookAudit({ client: shopifyClient, adminBaseUrl })
  })
} else if (config.shopify) {
  // Shopify creds are configured but ADMIN_BASE_URL isn't, so the daily webhook-audit cron
  // (self-healing for dropped/misdirected subscriptions) never gets registered — a production
  // deploy could silently lose this safety net, so make it loud instead of silent.
  app.log.warn('shopify webhook-audit cron disabled: ADMIN_BASE_URL not set')
}

await app.listen({ port: config.port, host: config.host })
app.log.info(`ops listening on :${config.port}`)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info(`${signal} received, shutting down`)

  let ok = true

  try {
    await app.close()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error closing server during shutdown')
  }

  try {
    await queue.stop()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error stopping queue during shutdown')
  }

  try {
    await pool.end()
  } catch (err) {
    ok = false
    app.log.error({ err }, 'error closing db pool during shutdown')
  }

  process.exit(ok ? 0 : 1)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
