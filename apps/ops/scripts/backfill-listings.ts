import { createDb } from '@doge-buddy/db'
import {
  inventoryItemUpdate,
  inventoryAvailableAt,
  inventorySetQuantities,
  listMetafieldDefinitions,
  mediaDelete,
  mediaImageStatus,
  metafieldDefinitionCreate,
  metafieldsSet,
  primaryLocationId,
  productAppendMedia,
  productDescriptionHtml,
  productMediaState,
  productUpdate,
  productVariantAppendMedia,
  productVariantsByProductId,
  ShopifyAdminClient,
  ShopifyTokenManager,
} from '@doge-buddy/shopify-admin'
import { CJSupplierAdapter, CjHttpClient, MockSupplierAdapter, type SupplierAdapter } from '@doge-buddy/supplier'
import PgBoss from 'pg-boss'
import { createAlerter } from '../src/alerts.ts'
import { backfillListings, type BackfillOps } from '../src/catalog/backfill.ts'
import { backfillProductPageV2, type BackfillV2Ops } from '../src/catalog/backfill-v2.ts'
import { loadConfig } from '../src/config.ts'
import type { SendOpts } from '../src/fulfillment/types.ts'
import { loadDotEnv } from '../src/load-env.ts'
import { DrizzleCjTokenStore } from '../src/stores/cj-token-store.ts'

/**
 * Brings products created under the OLD listing scheme up to the one Task 4 made new listings born
 * with — slugged handle, category tag, product type, SEO fields, tracked inventory seeded from CJ's
 * US stock, and the `shopify_inventory_item_gid` the sync job needs (see `src/catalog/backfill.ts`).
 *
 * Manual and credential-gated, same style as `seed-store.ts`/`seed-collections.ts` — not part of
 * the automated test suite. Run once against the real store for the two live products; the same
 * script is the repair tool if a future listing half-applies. Idempotent: safe to rerun.
 *
 * `pnpm --filter @doge-buddy/ops backfill-listings [--dry-run]`
 */

if (loadDotEnv(import.meta.url)) {
  console.log('backfill-listings: loaded apps/ops/.env (existing environment variables take precedence)')
}

const dryRun = process.argv.includes('--dry-run')

const config = loadConfig(process.env)

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN
const clientId = process.env.SHOPIFY_CLIENT_ID
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

if (!shopDomain || !clientId || !clientSecret) {
  console.error(
    'backfill-listings: missing required env vars (SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).',
  )
  console.error('See docs/OWNER-CHECKLIST.md for how to obtain Shopify Admin API credentials.')
  process.exit(1)
}

const { db, pool } = createDb(config.databaseUrl)

// Console-backed logger for createAlerter — scripts don't pull in pino (run-sourcing.ts's own
// convention).
const log = {
  info: (o: unknown, m: string) => console.log(m, o),
  warn: (o: unknown, m: string) => console.warn(m, o),
  error: (o: unknown, m: string) => console.error(m, o),
}
const alert = createAlerter(db, log)

// Same adapter selection as index.ts/run-sourcing.ts — with one extra gate. A real (non-dry) run
// pushes the adapter's stock numbers into a REAL store's inventory levels, so the in-memory mock's
// invented quantities must never reach it: better a refusal than a storefront advertising stock
// nobody has. `--dry-run` reads no stock at all and needs no adapter.
let adapter: SupplierAdapter
if (config.fulfillmentSupplier === 'cj') {
  if (!config.cj) {
    console.error('backfill-listings: FAILED — FULFILLMENT_SUPPLIER=cj but CJ_API_KEY/CJ_OPEN_ID are not set')
    await pool.end()
    process.exit(1)
  }
  adapter = new CJSupplierAdapter({
    client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
    openId: config.cj.openId,
  })
} else if (dryRun) {
  adapter = new MockSupplierAdapter()
} else {
  console.error(
    'backfill-listings: FAILED — FULFILLMENT_SUPPLIER is not cj, so only mock stock is available;' +
      ' refusing to push invented quantities to a real store. Set FULFILLMENT_SUPPLIER=cj, or rerun with --dry-run.',
  )
  await pool.end()
  process.exit(1)
}

let failed = false

/**
 * Short-lived PgBoss so a repaired product can be handed to `inventory.sync`, mirroring
 * run-sourcing.ts's `send` + `stop` idiom. Only for a real run: a dry run enqueues nothing, and
 * starting pg-boss (which migrates its own schema on boot) to do nothing would be worse than
 * pointless.
 */
const boss = dryRun ? null : new PgBoss(config.databaseUrl)
if (boss) {
  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
}

try {
  const tokenManager = new ShopifyTokenManager({ shopDomain, clientId, clientSecret })
  const client = new ShopifyAdminClient({ shopDomain, tokenManager })

  const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
    if (opts) {
      await boss!.send(name, data, opts)
    } else {
      await boss!.send(name, data)
    }
  }

  const ops: BackfillOps = {
    productUpdate: (input) => productUpdate(client, input),
    productVariantsByProductId: (productGid) => productVariantsByProductId(client, productGid),
    inventoryItemUpdate: (inventoryItemId, input) => inventoryItemUpdate(client, inventoryItemId, input),
    primaryLocationId: () => primaryLocationId(client),
    inventoryAvailableAt: (inventoryItemId, locationId) => inventoryAvailableAt(client, inventoryItemId, locationId),
    inventorySetQuantities: (input, key) => inventorySetQuantities(client, input, key),
    productDescriptionHtml: (productGid) => productDescriptionHtml(client, productGid),
  }

  console.log(`backfill-listings: starting${dryRun ? ' (--dry-run: no Shopify calls, no writes)' : ''}...`)
  const result = await backfillListings(
    { db, ops, adapter, alert, log: console.log, ...(boss ? { enqueue } : {}) },
    { dryRun },
  )

  console.log(
    `backfill-listings: products=${result.products} ${dryRun ? 'would-update' : 'updated'}=${result.updated}` +
      ` partial=${result.partial} skipped=${result.skipped} failures=${result.failures.length}`,
  )

  if (result.failures.length > 0) {
    failed = true
    console.error(`backfill-listings: ${result.failures.length} failure(s) — rerun to retry (idempotent):`)
    for (const failure of result.failures) {
      console.error(`  - ${failure}`)
    }
  }

  const v2Ops: BackfillV2Ops = {
    productMediaState: (gid: string) => productMediaState(client, gid),
    productAppendMedia: (gid: string, media: { originalSource: string; alt?: string }[], known: string[]) =>
      productAppendMedia(client, gid, media, known),
    mediaImageStatus: (gid: string) => mediaImageStatus(client, gid),
    productVariantAppendMedia: (gid: string, vm: { variantId: string; mediaIds: string[] }[]) => productVariantAppendMedia(client, gid, vm),
    mediaDelete: (ids: string[]) => mediaDelete(client, ids),
    metafieldsSet: (m: Parameters<typeof metafieldsSet>[1]) => metafieldsSet(client, m),
    listMetafieldDefinitions: async () => {
      const defs = await listMetafieldDefinitions(client, 'dogebuddy')
      return defs.map((d) => ({ namespace: 'dogebuddy', key: d.key }))
    },
    metafieldDefinitionCreate: async (def) => {
      await metafieldDefinitionCreate(client, def)
    },
  }
  const v2 = await backfillProductPageV2({ db, ops: v2Ops, adapter, alert, log: console.log }, { dryRun })
  console.log(
    `v2 pass: ${v2.products} product(s), ${v2.variantImagesAdded} variant image(s), ${v2.reviewsWritten} review metafield(s), ${v2.failures.length} failure(s)`,
  )
  if (v2.failures.length > 0) {
    failed = true
    console.error(`backfill-listings v2: ${v2.failures.length} failure(s) — rerun to retry (idempotent):`)
    for (const failure of v2.failures) {
      console.error(`  - ${failure}`)
    }
  }
} catch (err) {
  failed = true
  console.error('backfill-listings: FAILED —', err instanceof Error ? err.message : String(err))
} finally {
  await boss?.stop()
  await pool.end()
}

process.exit(failed ? 1 : 0)
