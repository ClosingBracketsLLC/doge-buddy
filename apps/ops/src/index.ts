import { createDb } from '@doge-buddy/db'
import { ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient } from '@doge-buddy/supplier'
import { loadConfig } from './config.ts'
import type { WebhookDeps } from './http/webhooks.ts'
import { shopifyWebhookAudit } from './jobs/shopify-webhook-audit.ts'
import { registerCron, startQueue } from './queue.ts'
import { buildServer } from './server.ts'
import { DrizzleCjTokenStore } from './stores/cj-token-store.ts'

const config = loadConfig(process.env)
const { db, pool } = createDb(config.databaseUrl, { connectionTimeoutMillis: 5000 })
const queue = await startQueue(config.databaseUrl)

if (config.shopify && config.adminBaseUrl) {
  const { shopify, adminBaseUrl } = config
  const tokenManager = new ShopifyTokenManager({
    shopDomain: shopify.shopDomain,
    clientId: shopify.clientId,
    clientSecret: shopify.clientSecret,
  })
  const shopifyClient = new ShopifyAdminClient({ shopDomain: shopify.shopDomain, tokenManager })

  await registerCron(queue.boss, 'shopify.webhook-audit', '0 6 * * *', async () => {
    await shopifyWebhookAudit({ client: shopifyClient, adminBaseUrl })
  })
}

const enqueue: WebhookDeps['enqueue'] = async (name, data) => {
  await queue.boss.send(name, data)
}

const cjAdapter = config.cj
  ? new CJSupplierAdapter({
      client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
      openId: config.cj.openId,
    })
  : undefined

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

const app = buildServer({ pool, isQueueReady: queue.ready, webhooks: webhookDeps })

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
