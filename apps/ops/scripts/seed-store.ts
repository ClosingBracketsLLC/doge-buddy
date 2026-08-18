import { ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { runSeed } from '../src/seed/run.ts'
import { loadDotEnv } from './lib/load-env.ts'

/**
 * Idempotently seeds Robert's test Shopify store with the dogebuddy metafield definitions,
 * sample collections, and sample products (see `src/seed/`). Manual, credential-gated — like
 * `verify-live.ts`, not part of the automated test suite. Safe to rerun: `runSeed` only creates
 * what's missing.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('seed-store: loaded apps/ops/.env (existing environment variables take precedence)')
}

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN
const clientId = process.env.SHOPIFY_CLIENT_ID
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

if (!shopDomain || !clientId || !clientSecret) {
  console.error(
    'seed-store: missing required env vars (SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).',
  )
  console.error('See docs/OWNER-CHECKLIST.md for how to obtain Shopify Admin API credentials.')
  process.exit(1)
}

try {
  const tokenManager = new ShopifyTokenManager({ shopDomain, clientId, clientSecret })
  const client = new ShopifyAdminClient({ shopDomain, tokenManager })

  const result = await runSeed(client, console.log)

  console.log(
    `seed-store: created — definitions=${result.created.definitions} collections=${result.created.collections} products=${result.created.products}`,
  )
  console.log(
    `seed-store: skipped (already existed) — definitions=${result.skipped.definitions} collections=${result.skipped.collections} products=${result.skipped.products}`,
  )
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error('seed-store: FAILED —', message)
  process.exit(1)
}
