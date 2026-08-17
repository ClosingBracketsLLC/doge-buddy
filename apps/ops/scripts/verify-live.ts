import type { Pool } from 'pg'
import { createDb } from '@doge-buddy/db'
import {
  ShopifyAdminClient,
  ShopifyTokenManager,
  listPublications,
  productDelete,
  productSet,
} from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient, InMemoryCjTokenStore, type CjTokenStore } from '@doge-buddy/supplier'
import { loadConfig } from '../src/config.ts'
import { DrizzleCjTokenStore } from '../src/stores/cj-token-store.ts'
import { loadDotEnv } from './lib/load-env.ts'

/**
 * Manual, credential-gated smoke test against the real Shopify Admin API and CJ Dropshipping
 * API. Not part of the automated test suite (no mocked network) — run by hand after filling in
 * `apps/ops/.env` to confirm the live round-trip actually works. Each section is independent and
 * prints `SKIPPED (missing ...)` when its env vars aren't set; the process exits 1 only if a
 * section that *was* attempted failed.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('verify-live: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)
let failed = false
let cjPool: Pool | undefined

const MAX_ERROR_MESSAGE_LENGTH = 500

// Some underlying errors (e.g. ShopifyTokenManager's HTTP failure message) embed the raw
// response body, which can be an entire HTML error page — truncate so a misconfigured domain
// doesn't flood the terminal.
function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… (truncated)`
    : message
}

async function verifyShopify(): Promise<void> {
  if (!config.shopify) {
    console.log(
      'SHOPIFY: SKIPPED (missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_WEBHOOK_SECRET)',
    )
    return
  }

  const { shopDomain, clientId, clientSecret } = config.shopify

  try {
    const tokenManager = new ShopifyTokenManager({ shopDomain, clientId, clientSecret })
    const client = new ShopifyAdminClient({ shopDomain, tokenManager })

    // Token round-trip: force the client-credentials fetch now so an auth failure surfaces here,
    // with a clear label, rather than as an opaque error from the first real call below.
    await tokenManager.getToken()
    console.log('SHOPIFY: token round-trip OK')

    const publications = await listPublications(client)
    const names = publications.length === 0 ? '(none)' : publications.map((p) => p.name).join(', ')
    console.log(`SHOPIFY: listPublications -> ${names}`)

    const title = `DB-VERIFY ${new Date().toISOString()}`
    // FIXTURE-ASSUMPTION: ProductSetInput/ProductVariantSetInput shape per Admin API 2024-01+
    // docs (productOptions + variants[].optionValues) — verify against the live 2026-07 schema
    // on first real call, same caveat as withIdempotencyKey in @doge-buddy/shopify-admin.
    const input = {
      title,
      status: 'DRAFT',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{ price: '1.00', optionValues: [{ optionName: 'Title', name: 'Default Title' }] }],
    }
    const { productId } = await productSet(client, input)
    const numericId = productId.split('/').pop()
    const adminUrl = `https://${shopDomain}/admin/products/${numericId}`

    // Once the DRAFT product exists, cleanup must be attempted no matter what happens next in
    // this span (including a hypothetical future step throwing) — otherwise a mid-span failure
    // would leave a stray DRAFT product in the store with no error pointing at it.
    let cleanupFailed = false
    try {
      console.log(`SHOPIFY: created "${title}" -> ${productId}`)
      console.log(`SHOPIFY: admin URL -> ${adminUrl}`)
    } finally {
      try {
        await productDelete(client, productId)
        console.log('SHOPIFY: cleaned up (productDelete) — nothing left behind')
      } catch (cleanupErr) {
        cleanupFailed = true
        console.error('SHOPIFY: cleanup FAILED —', formatError(cleanupErr))
        console.error(`SHOPIFY: DRAFT product left behind at ${adminUrl}`)
      }
    }

    if (cleanupFailed) {
      failed = true
    } else {
      console.log('SHOPIFY OK')
    }
  } catch (err) {
    failed = true
    console.error('SHOPIFY: FAILED —', formatError(err))
  }
}

async function verifyCj(): Promise<void> {
  if (!config.cj) {
    console.log('CJ: SKIPPED (missing CJ_API_KEY / CJ_OPEN_ID)')
    return
  }

  try {
    // loadConfig requires DATABASE_URL, so this branch is always taken in practice today; the
    // fallback exists so this script degrades gracefully rather than crashing if that constraint
    // ever loosens (and it mirrors the CJ section's own "SKIPPED when unconfigured" spirit).
    let tokenStore: CjTokenStore
    if (process.env.DATABASE_URL) {
      const created = createDb(process.env.DATABASE_URL)
      cjPool = created.pool
      tokenStore = new DrizzleCjTokenStore(created.db)
    } else {
      tokenStore = new InMemoryCjTokenStore()
    }

    const client = new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore })
    const adapter = new CJSupplierAdapter({ client, openId: config.cj.openId })

    const balance = await adapter.getBalance()
    console.log(`CJ: getBalance -> available=${balance.availableCents}c frozen=${balance.frozenCents}c`)

    console.log('CJ OK')
  } catch (err) {
    failed = true
    console.error('CJ: FAILED —', formatError(err))
  }
}

await verifyShopify()
await verifyCj()

if (cjPool) {
  await cjPool.end()
}

process.exit(failed ? 1 : 0)
