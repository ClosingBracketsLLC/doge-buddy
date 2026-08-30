import { ShopifyAdminClient, ShopifyTokenManager, orderRefundState } from '@doge-buddy/shopify-admin'
import { loadConfig } from '../src/config.ts'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Read-only Tier-2 helper: prints `orderRefundState` for an order straight from the live Admin API —
 * the same query the refund apply executor runs for its idempotency pre-check and accumulation
 * bound. Used to verify, after the first live refund, that the `db-proposal-<id>` note round-trips
 * verbatim (the durable half of the never-refund-twice guarantee) and that `refunds` is the full,
 * un-paginated list.
 *
 *   pnpm --filter @doge-buddy/ops read-refund-state gid://shopify/Order/<id>
 */
loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
const gid = process.argv[2]
if (!gid?.startsWith('gid://shopify/Order/')) {
  console.error('usage: read-refund-state gid://shopify/Order/<id>')
  process.exit(2)
}
if (!config.shopify) throw new Error('Shopify is not configured')
const { shopDomain, clientId, clientSecret } = config.shopify
const client = new ShopifyAdminClient({ shopDomain, tokenManager: new ShopifyTokenManager({ shopDomain, clientId, clientSecret }) })
const state = await orderRefundState(client, gid)
console.log(JSON.stringify(state, null, 2))
