import { auditLog, createDb, products, productVariants } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { productVariantsBulkUpdatePrice, ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { loadConfig } from '../src/config.ts'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Manual, credential-gated reprice of ONE variant (owner ruling 2026-09-03: the catalog reprice
 * after the Amazon-ceiling audit). Updates Shopify AND the local product_variants row in one go —
 * hand-editing prices in the Shopify admin desyncs the DB the margin/refund gates read, which is
 * exactly why this script exists. When LOWERING a price, the previous price becomes compareAtPrice
 * ("was $X") automatically; raising clears it.
 *
 * Run where the live DB + Shopify creds are configured (Railway shell, or locally with the
 * DATABASE_URL override — the printed "DATABASE →" banner tells you which):
 *
 *   pnpm --filter @doge-buddy/ops reprice --sku <SKU> --price <USD, e.g. 16.99>
 */

if (loadDotEnv(import.meta.url)) {
  console.log('reprice: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)
console.log(`reprice: DATABASE → ${new URL(config.databaseUrl).hostname}`)

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sku = argValue('--sku')
const priceRaw = argValue('--price')
const priceUsd = priceRaw ? Number(priceRaw) : NaN
if (!sku || !Number.isFinite(priceUsd) || priceUsd <= 0) {
  console.error('usage: reprice --sku <SKU> --price <USD, e.g. 16.99>')
  process.exit(2)
}
const newPriceCents = Math.round(priceUsd * 100)

if (!config.shopify) {
  console.error('reprice: FAILED — Shopify credentials are not configured')
  process.exit(1)
}

const { db, pool } = createDb(config.databaseUrl)

try {
  const [row] = await db
    .select({
      variantId: productVariants.id,
      variantGid: productVariants.shopifyVariantGid,
      priceCents: productVariants.priceCents,
      compareAtCents: productVariants.compareAtCents,
      supplierCostCents: productVariants.supplierCostCents,
      productGid: products.shopifyProductGid,
      title: products.title,
      status: products.status,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.sku, sku))
    .limit(1)

  if (!row) {
    console.error(`reprice: FAILED — no variant with sku ${sku}`)
    process.exit(1)
  }
  if (!row.variantGid || !row.productGid) {
    console.error(`reprice: FAILED — ${sku} has no Shopify GIDs (never applied?)`)
    process.exit(1)
  }
  if (newPriceCents === row.priceCents) {
    console.log(`reprice: ${sku} already at $${(newPriceCents / 100).toFixed(2)} — nothing to do`)
    process.exit(0)
  }

  const lowering = newPriceCents < row.priceCents
  const compareAtCents = lowering ? row.priceCents : null

  const tokenManager = new ShopifyTokenManager({
    shopDomain: config.shopify.shopDomain,
    clientId: config.shopify.clientId,
    clientSecret: config.shopify.clientSecret,
  })
  const client = new ShopifyAdminClient({ shopDomain: config.shopify.shopDomain, tokenManager })

  await productVariantsBulkUpdatePrice(client, row.productGid, {
    id: row.variantGid,
    price: (newPriceCents / 100).toFixed(2),
    compareAtPrice: compareAtCents != null ? (compareAtCents / 100).toFixed(2) : null,
  })

  await db
    .update(productVariants)
    .set({ priceCents: newPriceCents, compareAtCents })
    .where(eq(productVariants.id, row.variantId))

  await db.insert(auditLog).values({
    actor: 'owner',
    action: 'pricing.manual_reprice',
    entityType: 'product_variant',
    entityId: row.variantId,
    detail: { sku, fromCents: row.priceCents, toCents: newPriceCents, compareAtCents, title: row.title },
  })

  const margin =
    row.supplierCostCents != null ? ` (supplier cost $${(row.supplierCostCents / 100).toFixed(2)})` : ''
  console.log(
    `reprice: ${row.title} [${sku}] $${(row.priceCents / 100).toFixed(2)} → $${(newPriceCents / 100).toFixed(2)}${
      compareAtCents != null ? ` (compare-at "was" $${(compareAtCents / 100).toFixed(2)})` : ''
    }${margin} — Shopify + DB + audit updated`,
  )
} catch (err) {
  console.error('reprice: FAILED —', err instanceof Error ? err.message.slice(0, 400) : String(err))
  process.exit(1)
} finally {
  await pool.end()
}
