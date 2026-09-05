import { auditLog, createDb, deprecationQueue, products, productVariants, proposals, supplierVariantMappings } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { productVariantsBulkUpdatePrice, ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient, type SupplierAdapter } from '@doge-buddy/supplier'
import { DrizzleCjTokenStore } from '../src/stores/cj-token-store.ts'
import { loadConfig } from '../src/config.ts'
import { loadDotEnv } from '../src/load-env.ts'
import { createSettings } from '../src/settings.ts'
import { createSerpApiAmazonDemand } from '../src/sourcing/demand-probe.ts'
import { createSerpApiClient } from '../src/sourcing/serpapi.ts'

/**
 * Owner ruling 2026-09-03: bring EVERY active product to a competitive price — the highest x.99
 * at or under `sourcing.max_price_to_market_bps` × the Amazon median for the product's own
 * shopper query (the same probe the sourcing gate uses), while still clearing
 * `fulfillment.margin_floor_bps` on CJ cost + freight. Never raises a price. Products that
 * CANNOT clear the floor at a competitive price are never touched — they're reported as
 * DEPRECATE candidates with a ready-to-run command, because per the owner's stroller ruling a
 * product whose supplier cost rivals its Amazon retail is not sellable at any margin.
 *
 * DRY RUN by default (prints the full plan); `--apply` executes: Shopify price (+ "was $X"
 * compare-at on every cut) + product_variants row + audit log, per variant, in lockstep.
 *
 *   pnpm --filter @doge-buddy/ops reprice-all            # plan only
 *   pnpm --filter @doge-buddy/ops reprice-all --apply    # do it
 *
 * Freight per product comes from the creating proposal's decision_context when present (post-L1
 * listings), else a live CJ quote on the first variant (10 points). Amazon lookups: one SerpApi
 * request per product.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('reprice-all: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)
console.log(`reprice-all: DATABASE → ${new URL(config.databaseUrl).hostname}`)

const apply = process.argv.includes('--apply')
console.log(`reprice-all: mode ${apply ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}`)

if (!config.serpapi) {
  console.error('reprice-all: FAILED — SERPAPI_KEY is required (Amazon medians drive the targets)')
  process.exit(1)
}
if (apply && !config.shopify) {
  console.error('reprice-all: FAILED — Shopify credentials are required for --apply')
  process.exit(1)
}

const { db, pool } = createDb(config.databaseUrl)
const settings = createSettings(db)

const amazon = createSerpApiAmazonDemand({
  client: createSerpApiClient({ apiKey: config.serpapi.apiKey, maxRequests: 200 }),
})

let adapter: SupplierAdapter | null = null
if (config.cj) {
  adapter = new CJSupplierAdapter({
    client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
    openId: config.cj.openId,
  })
}

const shopify =
  config.shopify != null
    ? new ShopifyAdminClient({
        shopDomain: config.shopify.shopDomain,
        tokenManager: new ShopifyTokenManager({
          shopDomain: config.shopify.shopDomain,
          clientId: config.shopify.clientId,
          clientSecret: config.shopify.clientSecret,
        }),
      })
    : null

/** Highest x.99 price at or under capCents, in cents (e.g. cap 1688 → 1599; cap 1699 → 1699). */
function ninetyNineUnder(capCents: number): number {
  const dollars = Math.floor((capCents + 1) / 100)
  const candidate = dollars * 100 - 1
  return candidate <= capCents ? candidate : (dollars - 1) * 100 - 1
}

function usd(cents: number | null | undefined): string {
  return cents != null ? `$${(cents / 100).toFixed(2)}` : '?'
}

interface EconomicsContext {
  freight?: { priceCents?: number }
  market?: { query?: string } | null
}

try {
  const marginFloorBps = await settings.get('fulfillment.margin_floor_bps')
  const ratioBps = await settings.get('sourcing.max_price_to_market_bps')
  console.log(`reprice-all: floor ${marginFloorBps}bps, ceiling ${ratioBps / 10_000}× Amazon median\n`)

  const rows = await db
    .select({
      productId: products.id,
      title: products.title,
      handle: products.handle,
      productGid: products.shopifyProductGid,
      proposalId: products.createdFromProposalId,
      variantId: productVariants.id,
      variantGid: productVariants.shopifyVariantGid,
      sku: productVariants.sku,
      priceCents: productVariants.priceCents,
      supplierCostCents: productVariants.supplierCostCents,
      supplierVariantId: supplierVariantMappings.supplierVariantId,
    })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(supplierVariantMappings, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(eq(products.status, 'active'))

  const byProduct = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byProduct.get(r.productId) ?? []
    list.push(r)
    byProduct.set(r.productId, list)
  }
  console.log(`reprice-all: ${byProduct.size} active product(s), ${rows.length} variant(s)\n`)

  let repriced = 0
  let unchanged = 0
  const deprecateCommands: string[] = []
  const reviewNotes: string[] = []

  for (const [productId, variants] of byProduct) {
    const first = variants[0]!
    const title = (first.title ?? first.handle ?? productId).slice(0, 56)

    // decision_context (post-L1 listings) carries the shopper query + freight; older listings fall
    // back to the title's lead segment and a live CJ freight quote.
    let economics: EconomicsContext | null = null
    if (first.proposalId) {
      const [prop] = await db
        .select({ decisionContext: proposals.decisionContext })
        .from(proposals)
        .where(eq(proposals.id, first.proposalId))
        .limit(1)
      economics = ((prop?.decisionContext as { economics?: EconomicsContext } | null)?.economics ?? null)
    }

    const query = economics?.market?.query ?? (first.title ?? '').split(' - ')[0]!.toLowerCase()
    const snap = await amazon.probe(query)
    if (snap?.medianPriceCents == null) {
      reviewNotes.push(`REVIEW  ${title} — no conclusive Amazon median for "${query}"; untouched`)
      continue
    }

    let freightCents: number | null = economics?.freight?.priceCents ?? null
    if (freightCents == null && adapter && first.supplierVariantId) {
      try {
        const options = await adapter.quoteShipping({
          fromCountry: 'US',
          toCountry: 'US',
          items: [{ supplierVariantId: first.supplierVariantId, quantity: 1 }],
        })
        const eligible = options.filter((o) => o.maxDays <= 8)
        freightCents = (eligible.length > 0 ? eligible : options).reduce((a, b) => (b.priceCents < a.priceCents ? b : a)).priceCents
      } catch {
        freightCents = null
      }
    }
    if (freightCents == null) {
      reviewNotes.push(`REVIEW  ${title} — no freight figure (no decision_context, CJ quote failed); untouched`)
      continue
    }

    const capCents = Math.floor((snap.medianPriceCents * ratioBps) / 10_000)
    const target99 = ninetyNineUnder(capCents)

    // Viability: every variant must clear the floor at its (possibly capped) target.
    let viable = true
    const plan: Array<{ sku: string; from: number; to: number; variantId: string; variantGid: string | null; marginBps: number }> = []
    for (const v of variants) {
      const to = Math.min(v.priceCents, target99)
      if (v.supplierCostCents == null) {
        viable = false
        reviewNotes.push(`REVIEW  ${title} [${v.sku}] — no supplier cost on record; product untouched`)
        break
      }
      const marginBps = Math.floor(((to - v.supplierCostCents - freightCents) * 10_000) / to)
      if (marginBps < marginFloorBps) {
        viable = false
        deprecateCommands.push(
          `# ${title} [${v.sku}]: amazon ${usd(snap.medianPriceCents)} → cap ${usd(capCents)}; cost ${usd(v.supplierCostCents)} + freight ${usd(freightCents)} → ${marginBps}bps < ${marginFloorBps}bps floor\n` +
            `pnpm --filter @doge-buddy/ops deprecate-product --product ${productId} --reason not-competitive-vs-amazon`,
        )
        if (apply) {
          // Owner ask 2026-09-03: non-competitive products drip out via the nightly
          // catalog.deprecation-drip cron rather than a big-bang purge. Idempotent — a product
          // already queued (or once processed) is left alone.
          await db
            .insert(deprecationQueue)
            .values({ productId, reason: 'not-competitive-vs-amazon' })
            .onConflictDoNothing()
        }
        break
      }
      plan.push({ sku: v.sku, from: v.priceCents, to, variantId: v.variantId, variantGid: v.variantGid, marginBps })
    }
    if (!viable) continue

    const changes = plan.filter((p) => p.to < p.from)
    if (changes.length === 0) {
      unchanged += 1
      console.log(`OK      ${title} — already ≤ cap ${usd(capCents)} (amazon ${usd(snap.medianPriceCents)})`)
      continue
    }
    const collapsed = new Set(plan.map((p) => p.to)).size < new Set(plan.map((p) => p.from)).size ? '  [variant ladder collapsed to the cap]' : ''

    for (const change of changes) {
      console.log(
        `${apply ? 'APPLY ' : 'PLAN  '} ${title} [${change.sku}] ${usd(change.from)} → ${usd(change.to)} (amazon ${usd(snap.medianPriceCents)}, cap ${usd(capCents)}, margin ${change.marginBps}bps)${collapsed}`,
      )
      if (apply) {
        if (!change.variantGid || !first.productGid || !shopify) {
          reviewNotes.push(`REVIEW  ${title} [${change.sku}] — missing Shopify GID; skipped`)
          continue
        }
        await productVariantsBulkUpdatePrice(shopify, first.productGid, {
          id: change.variantGid,
          price: (change.to / 100).toFixed(2),
          compareAtPrice: (change.from / 100).toFixed(2),
        })
        await db
          .update(productVariants)
          .set({ priceCents: change.to, compareAtCents: change.from })
          .where(eq(productVariants.id, change.variantId))
        await db.insert(auditLog).values({
          actor: 'owner',
          action: 'pricing.manual_reprice',
          entityType: 'product_variant',
          entityId: change.variantId,
          detail: { sku: change.sku, fromCents: change.from, toCents: change.to, compareAtCents: change.from, amazonMedianCents: snap.medianPriceCents, via: 'reprice-all' },
        })
        repriced += 1
      }
    }
  }

  console.log(`\nreprice-all: ${apply ? `${repriced} variant(s) repriced` : 'dry run complete'}, ${unchanged} product(s) already competitive`)
  if (deprecateCommands.length > 0) {
    console.log(`\n=== DEPRECATE candidates (cannot clear the floor at a competitive price — commands ready, NOT run) ===`)
    for (const cmd of deprecateCommands) console.log(`\n${cmd}`)
  }
  if (reviewNotes.length > 0) {
    console.log(`\n=== Needs a human look ===`)
    for (const note of reviewNotes) console.log(note)
  }
} catch (err) {
  console.error('reprice-all: FAILED —', err instanceof Error ? err.message.slice(0, 400) : String(err))
  process.exitCode = 1
} finally {
  await pool.end()
}
