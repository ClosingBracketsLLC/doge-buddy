import { categoryByTag, categoryTagValue, slugify, type CategoryTag } from '@doge-buddy/core'
import { type createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { SendOpts } from '../fulfillment/types.ts'
import { INVENTORY_SYNC_QUEUE, inventorySyncSendOpts } from '../jobs/inventory-sync.ts'
import { readUsStock, seoDescription, seoTitle } from '../proposals/apply-new-listing.ts'
import { proposalHandle } from '../proposals/apply-shared.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * The Shopify ops the backfill needs, already bound to a client (the injectable-ops pattern used by
 * `SeedCollectionsOps` / `ProposalShopifyOps` — no `client` parameter, the caller closes over it).
 *
 * All six are LIVE-VERIFIED against the 2026-07 Admin API. `productDescriptionHtml` is a READ and
 * is here rather than derived locally for a specific reason: `seo.description` is built from the
 * product's description HTML, and for a product created under the OLD scheme that HTML exists only
 * on Shopify — the local `products` row never stored it.
 */
export interface BackfillOps {
  productUpdate(input: {
    id: string
    handle?: string
    redirectNewHandle?: boolean
    tags?: string[]
    productType?: string
    seo?: { title?: string; description?: string }
  }): Promise<void>
  productVariantsByProductId(productGid: string): Promise<{ id: string; sku?: string; inventoryItemId: string }[]>
  inventoryItemUpdate(inventoryItemId: string, input: { tracked: boolean }): Promise<void>
  primaryLocationId(): Promise<string>
  inventorySetQuantities(input: Record<string, unknown>, idempotencyKey: string): Promise<void>
  productDescriptionHtml(productGid: string): Promise<string>
}

export interface BackfillDeps {
  db: Db
  ops: BackfillOps
  /** `getVariantStock` only — the same read `readUsStock` wraps for the listing worker. */
  adapter: Pick<SupplierAdapter, 'getVariantStock'>
  alert: Alert
  /** Line printer (the script passes `console.log`) — every product's before → after handle, every
   * skip and every failure goes through it, because a human is watching this run. */
  log: (line: string) => void
  now?: () => Date
  /**
   * Optional queue producer. A fully repaired product is handed to `inventory.sync` so its
   * now-tracked inventory starts being refreshed on the 6-hourly cadence instead of waiting for the
   * next cron sweep to notice it. Optional because the dry run has nothing to enqueue and a test
   * shouldn't have to stand up pg-boss; a repair without it is still complete, just not refreshed
   * until the next cron.
   */
  enqueue?: (name: string, data: object, opts?: SendOpts) => Promise<void>
}

export interface BackfillResult {
  /** Candidate products the run considered (ACTIVE, with a Shopify gid). */
  products: number
  /** Products fully repaired this run — every variant included. */
  updated: number
  /** Products whose Shopify catalog fields landed but at least one of whose variants failed. Their
   * local handle is still rewritten (the Shopify update DID happen, and a local row disagreeing
   * with the live handle is worse than none), but they are NOT counted as repaired and are NOT
   * handed to the sync job. Every one of them has a line in `failures`. */
  partial: number
  /** Products deliberately left alone: no local category tag, or no local title — neither can be
   * invented, and both are inputs the repair cannot proceed without. */
  skipped: number
  /** One human-readable line per contained failure; a non-empty array makes the script exit 1. */
  failures: string[]
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The idempotency key for one backfill push: `bf-<variantRowId>-<quantity>-<unix seconds>`.
 *
 * Same construction (and the same reasoning) as `inventory-sync.ts`'s `inv-` key — the QUANTITY is
 * in the key so a real change can never be swallowed as a replay, and only an identical push
 * repeated inside the same second dedupes. The `bf-` prefix keeps a backfill push and a sync push
 * for the same variant/quantity/second from colliding: they are different intents, and a replayed
 * "nothing happened" on either would be invisible. Length: 3 + 36 + 2 + quantity + 10 ≈ 57, inside
 * Shopify's 64-char `[A-Za-z0-9_-]` limit.
 */
function idempotencyKey(variantId: string, quantity: number, at: Date): string {
  return `bf-${variantId}-${quantity}-${Math.floor(at.getTime() / 1000)}`
}

/**
 * `backfill-listings` (spec §3 "Backfill"): bring products created under the OLD listing scheme up
 * to the one Task 4 made new listings born with.
 *
 * The two live products were created before slugged handles, category tags, product types, SEO
 * fields and tracked inventory existed — they carry `db-proposal-<uuid>` handles, no tags/type/seo,
 * untracked inventory items and no `shopify_inventory_item_gid` locally (which is precisely why
 * `inventory.sync` counts them `skipped` and can never keep them honest). This function is the
 * one-shot repair for those two AND the permanent repair tool for any future listing that
 * half-applies.
 *
 * **Per product** (ACTIVE local rows carrying a Shopify gid, oldest first):
 * 1. `handle` — `proposalHandle(createdFromProposalId, title)` when the product came from a
 *    proposal (identical to what a re-listing would compute, so the repair is a no-op for anything
 *    already on the new scheme), else `slugify(title)-<8 of the local product id>` for a product
 *    with no proposal behind it.
 * 2. ONE `productUpdate` carrying handle + tags + productType + seo, with `redirectNewHandle: true`
 *    so Shopify leaves a redirect from the old handle and no existing storefront link dies.
 *    NOTE — `tags` and `seo` are REPLACED WHOLESALE, not merged: any tag added by hand in the
 *    Shopify admin, and any hand-curated meta title/description, is discarded in favour of the
 *    values derived from the local category and description. That is the intended behaviour for a
 *    tool whose job is to make a product match the scheme, but it is destructive, and it is the
 *    reason `--dry-run` exists.
 * 3. `productVariantsByProductId` → persist `shopify_inventory_item_gid` (and
 *    `shopify_variant_gid` when it's null) onto the local variant rows, matched by sku.
 * 4. Per variant that has a supplier mapping: read CJ's US stock FIRST, then — only on a real
 *    reading — one `inventorySetQuantities` with it and, ONLY IF THAT LANDED,
 *    `inventoryItemUpdate(tracked: true)`. A failed read leaves the variant untouched and
 *    untracked (see the inline note: tracking a live product at a fabricated 0 would strand it at
 *    Sold out, because the unchanged local cache would make every later sync cycle call it
 *    "unchanged"), and a failed quantity set does the same for the same reason — tracking is what
 *    makes a quantity enforced, so it must never be switched on ahead of a real number.
 * 5. The local `products.handle`, written LAST — so a crash anywhere above leaves the row still
 *    claiming the old handle and a rerun repeats the whole product rather than believing it done.
 * 6. Only if EVERY variant came through: the product is counted `updated` and handed to
 *    `inventory.sync`. A product with any failed variant is counted `partial` instead and left for
 *    a rerun (its handle is still written — see `BackfillResult.partial`).
 *
 * **Idempotent by construction.** Every step is a full overwrite with a value derived from
 * immutable local state, so a product already on the new scheme simply gets the same tags/type/seo
 * re-sent — cheap, and harmless. That is deliberate: the alternative (skip anything whose handle
 * already matches) would silently refuse to repair a product whose handle landed but whose
 * inventory tracking didn't, which is the exact half-applied state this tool exists for.
 *
 * **Failure containment** mirrors `runSeed`/`seedCollections`: a product that throws is recorded in
 * `failures` and the loop moves to the next one. One product whose handle collides must not cost
 * the other its repair.
 *
 * **`dryRun`** makes NO ops calls whatsoever — not even the description read — and writes nothing.
 * It prints the plan from local state alone, so it is safe to run against production credentials.
 */
export async function backfillListings(deps: BackfillDeps, opts: { dryRun: boolean }): Promise<BackfillResult> {
  const { db, ops, log } = deps
  const clock = (): Date => deps.now?.() ?? new Date()
  const dry = opts.dryRun ? '[dry-run] ' : ''

  const candidates = await db
    .select()
    .from(products)
    .where(and(eq(products.status, 'active'), isNotNull(products.shopifyProductGid)))
    .orderBy(asc(products.createdAt), asc(products.id))

  const failures: string[] = []
  let updated = 0
  let partial = 0
  let skipped = 0

  /**
   * The store's one active location, resolved at most once per run and only when a variant
   * actually needs a push — a run with nothing to push must not pay for (or fail on) a lookup it
   * has no use for. Caches the resolved VALUE only, never a failed attempt, exactly like the
   * listing worker's and the sync job's own memos.
   */
  let locationId: string | null = null
  const getLocationId = async (): Promise<string> => (locationId ??= await ops.primaryLocationId())

  log(`${dry}backfill: ${candidates.length} active product(s) with a Shopify gid`)

  for (const product of candidates) {
    const productGid = product.shopifyProductGid!
    const title = product.title ?? ''
    // A product with no local category tag cannot be categorized without a human decision — there
    // is no tag to derive `tags`/`productType` from, and guessing one would put it in the wrong
    // storefront collection. Skipped loudly, never silently: the log line plus the `skipped` count
    // is how an operator learns the row needs a category before the tool can help it.
    if (!product.categoryTag) {
      skipped += 1
      log(`${dry}SKIP product ${product.id} (${title || 'untitled'}): no category tag locally`)
      continue
    }
    // Same reasoning one step further: `handle` and `seo.title` are both DERIVED from the title,
    // and a titleless row would have this tool write `product-<8 hex>` and an empty meta title to a
    // real storefront. `products.title` is nullable, so this is reachable; a decision (what is this
    // product called?) has to come from a human, not from a slug of nothing.
    if (!title) {
      skipped += 1
      log(`${dry}SKIP product ${product.id}: no title locally — cannot derive a handle or an SEO title`)
      continue
    }

    try {
      const category = categoryByTag(product.categoryTag as CategoryTag)
      const handle = product.createdFromProposalId
        ? proposalHandle(product.createdFromProposalId, title)
        : `${slugify(title)}-${product.id.slice(0, 8)}`
      log(`${dry}product ${product.id} (${title}): ${product.handle ?? '(none)'} → ${handle}`)

      // Local variant rows for this product, with their mapping when they have one. A variant
      // could in principle carry mappings for two suppliers (the unique index is on
      // (variant, supplier)); take the first deterministically rather than pushing the same
      // inventory item twice under two keys — same guard `inventory-sync.ts` makes.
      const variantRows = await db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          inventoryItemGid: productVariants.shopifyInventoryItemGid,
          mappingId: supplierVariantMappings.id,
          supplierVariantId: supplierVariantMappings.supplierVariantId,
        })
        .from(productVariants)
        .leftJoin(supplierVariantMappings, eq(supplierVariantMappings.variantId, productVariants.id))
        .where(eq(productVariants.productId, product.id))
        .orderBy(asc(productVariants.createdAt), asc(productVariants.id))
      const byVariant = new Map<string, (typeof variantRows)[number]>()
      for (const row of variantRows) {
        if (!byVariant.has(row.id)) byVariant.set(row.id, row)
      }
      const locals = [...byVariant.values()]

      if (opts.dryRun) {
        log(`${dry}  tags=${categoryTagValue(product.categoryTag as CategoryTag)} productType=${category.productType} seo.title=${seoTitle(title)}`)
        for (const local of locals) {
          log(
            `${dry}  variant ${local.sku}: inventoryItemGid=${local.inventoryItemGid ?? '(missing — will fetch)'}` +
              ` mapping=${local.mappingId ? 'yes → track + push CJ US stock' : 'none → inventory left alone'}`,
          )
        }
        updated += 1
        continue
      }

      // ONE productUpdate carrying every catalog field. The description read feeding `seo` comes
      // from Shopify because the local row never stored it (see `BackfillOps`).
      const descriptionHtml = await ops.productDescriptionHtml(productGid)
      await ops.productUpdate({
        id: productGid,
        handle,
        // Shopify does NOT redirect a renamed handle unless asked. Without this, repairing the two
        // live products would 404 every link that already points at their `db-proposal-…` URLs.
        redirectNewHandle: true,
        tags: [categoryTagValue(product.categoryTag as CategoryTag)],
        productType: category.productType,
        seo: { title: seoTitle(title), description: seoDescription(descriptionHtml) },
      })

      const shopifyVariants = await ops.productVariantsByProductId(productGid)
      // Positional fallback for the one unambiguous case: exactly one variant on each side. A
      // single-variant product created by hand (or by an older `productSet`) can carry a NULL sku
      // on Shopify, which no sku match can ever satisfy — leaving `shopify_inventory_item_gid`
      // permanently null and the product permanently unsyncable. With one variant each there is
      // only one possible pairing, so this is a deduction rather than a guess; with more on either
      // side it IS a guess, and a wrong pairing would push one variant's stock onto another, so
      // the match is left to fail loudly instead.
      const positional = locals.length === 1 && shopifyVariants.length === 1
      let variantFailures = 0
      for (const local of locals) {
        const match = shopifyVariants.find((v) => v.sku === local.sku) ?? (positional ? shopifyVariants[0] : undefined)
        if (!match) {
          // The local row claims a sku Shopify doesn't have on this product. Not fatal to the rest
          // of the product (the catalog fields above already landed), but it IS a real data
          // problem — recorded so the run exits non-zero and a human looks at it.
          variantFailures += 1
          const message = `product ${product.id}: local variant ${local.sku} has no Shopify variant with that sku`
          failures.push(message)
          log(`FAILED ${message}`)
          continue
        }
        // Coalesce-backfill, the same contract `applyNewListing` writes these two columns under:
        // a null column self-heals, an existing value is left exactly as it is. Done in SQL rather
        // than read-then-write so the null test and the write are one statement.
        await db
          .update(productVariants)
          .set({
            shopifyVariantGid: sql`coalesce(${productVariants.shopifyVariantGid}, ${match.id})`,
            shopifyInventoryItemGid: sql`coalesce(${productVariants.shopifyInventoryItemGid}, ${match.inventoryItemId})`,
          })
          .where(eq(productVariants.id, local.id))

        // No mapping means no supplier variant to read stock from — nothing to track or push, and
        // an untracked inventory item is strictly better than one tracked at a made-up quantity.
        if (!local.mappingId || !local.supplierVariantId) continue

        // STOCK FIRST, before anything is changed on Shopify. `null` = the CJ read itself failed
        // (see `readUsStock`); 0 = CJ genuinely has none.
        const observed = await readUsStock({ adapter: deps.adapter, alert: deps.alert }, local.supplierVariantId)
        if (observed === null) {
          // Leave this variant EXACTLY as it is: untracked and still selling. The tempting
          // alternative — track it at 0 like a brand-new listing does — is safe there and actively
          // harmful here, because the local cache keeps its old value: the next sync cycle reads
          // CJ (say 7), compares it to the unchanged cache (7), calls it "unchanged" and pushes
          // nothing, so a LIVE product would sit at Sold out indefinitely with no alert. A
          // recorded failure and a rerun is the only correct outcome.
          variantFailures += 1
          const message = `product ${product.id} ${local.sku}: stock read failed — inventory left untouched`
          failures.push(message)
          log(`FAILED ${message}`)
          continue
        }
        // QUANTITY FIRST, TRACKING SECOND — the order matters and it is not the obvious one
        // (whole-branch review, I4). A quantity can be set on an UNTRACKED inventory item;
        // `tracked` only decides whether Shopify ENFORCES it at checkout. Switching tracking on
        // first therefore publishes an enforced quantity of whatever Shopify happened to hold for
        // an item nobody was tracking — 0 — so a failed or slow `inventorySetQuantities` leaves a
        // LIVE product reading Sold out: for the length of one round-trip if the set lands, and
        // permanently if it throws. Quantity first inverts that: the worst case is an item that is
        // correct but unenforced, which is exactly the state the product is in right now.
        //
        // Shopify's own answer addresses both calls, not the (possibly stale) local column: the
        // gid that came back from `productVariantsByProductId` is what this inventory item is
        // TODAY.
        try {
          await ops.inventorySetQuantities(
            {
              name: 'available',
              reason: 'correction',
              quantities: [{ inventoryItemId: match.inventoryItemId, locationId: await getLocationId(), quantity: observed }],
            },
            idempotencyKey(local.id, observed, clock()),
          )
          await ops.inventoryItemUpdate(match.inventoryItemId, { tracked: true })
        } catch (err) {
          // Contained per VARIANT, not per product: the catalog fields already landed and the
          // sibling variants still deserve their repair. The item is left untracked and selling —
          // its current live state — and the recorded failure is what makes the run exit 1 and a
          // human rerun it.
          variantFailures += 1
          const message = `product ${product.id} ${local.sku}: inventory repair failed — ${formatError(err)}`
          failures.push(message)
          log(`FAILED ${message}`)
          continue
        }
        // Strictly after the push: a crash between the two re-pushes the same value on a rerun
        // (harmless), whereas caching first would record a push that never happened.
        await db
          .update(supplierVariantMappings)
          .set({ lastKnownStock: observed, stockCheckedAt: clock() })
          .where(eq(supplierVariantMappings.id, local.mappingId))
      }

      // The handle write happens either way — the Shopify update above DID land, and a local row
      // still claiming the old handle would desync from the live store. What a variant failure
      // costs the product is the `updated` count and the sync enqueue below, not this.
      await db.update(products).set({ handle }).where(eq(products.id, product.id))
      if (variantFailures > 0) {
        partial += 1
        log(`PARTIAL product ${product.id}: catalog fields updated, ${variantFailures} variant(s) failed — rerun`)
        continue
      }
      updated += 1

      // Hand the repaired product to the sync job so its now-tracked inventory is refreshed on the
      // 6-hourly cadence from here on. Best-effort, exactly as `applyNewListing` treats the same
      // enqueue: the repair itself already landed, so a momentarily unreachable queue costs a
      // refresh, never the repair — and the queue's `singletonKey` is the product id, so a rerun
      // cannot pile up duplicates.
      if (deps.enqueue) {
        try {
          await deps.enqueue(INVENTORY_SYNC_QUEUE, { productId: product.id }, inventorySyncSendOpts(product.id))
        } catch (err) {
          log(`WARN product ${product.id}: inventory.sync enqueue failed: ${formatError(err)}`)
          await deps
            .alert('warning', 'backfill_sync_enqueue_failed', { productId: product.id, error: formatError(err) })
            .catch(() => {})
        }
      }
    } catch (err) {
      const message = `product ${product.id}: ${formatError(err)}`
      failures.push(message)
      log(`FAILED ${message}`)
    }
  }

  return { products: candidates.length, updated, partial, skipped, failures }
}
