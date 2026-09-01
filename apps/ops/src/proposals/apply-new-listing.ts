import { categoryByTag, categoryTagValue, centsToUsd, NewListingPayloadSchema } from '@doge-buddy/core'
import { auditLog, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import { eq, sql } from 'drizzle-orm'
import { INVENTORY_SYNC_QUEUE, inventorySyncSendOpts, usQuantity } from '../jobs/inventory-sync.ts'
import { applyProposalTransition } from './transitions.ts'
import { proposalHandle, type ApplyProposalDeps, type ProposalRow, type ProposalShopifyOps } from './apply-shared.ts'

/** Shopify truncates a longer `seo.title` in the SERP anyway; cut it ourselves so what we store is
 * what shows. Same reasoning for the 155-char meta description. */
const SEO_TITLE_MAX = 70
const SEO_DESCRIPTION_MAX = 155

/**
 * Process-lifetime memo for the store's one active location id.
 *
 * The store is single-location by design, so this is a constant, not per-listing state — but it
 * costs a Shopify round-trip to learn, and every variant of every listing needs it. Cached at
 * module level rather than on `deps` because `ApplyProposalDeps` is rebuilt per job by the queue
 * wiring, which would defeat any cache living there. Deliberately caches the *resolved value* and
 * not the in-flight promise: a failed lookup must be retried by the next apply, not memoized as a
 * permanent failure.
 */
let cachedLocationId: string | null = null

/** Test seam: clears the memo above so a test can prove the lookup happens exactly once. */
export function resetLocationCache(): void {
  cachedLocationId = null
}

async function getLocationId(shopify: ProposalShopifyOps): Promise<string> {
  cachedLocationId ??= await shopify.primaryLocationId()
  return cachedLocationId
}

/**
 * `seo.description` from the listing's own description HTML: tags out, whitespace collapsed,
 * capped. Entities are left exactly as they are — `&amp;` in a meta description renders as `&`,
 * and a half-hearted decode is how you get `&lt;script` back out the other side.
 */
function seoDescription(descriptionHtml: string): string {
  return descriptionHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEO_DESCRIPTION_MAX)
}

/**
 * `usQuantity` (the LARGEST SINGLE US warehouse, floored at 0 — see its doc comment in
 * `jobs/inventory-sync.ts`, which now owns it) over a live CJ read, or `null` when the read itself
 * failed.
 *
 * `null` is NOT the same as 0 and the two must not be conflated. Shopify's brand-new listing still
 * gets 0 for a failed read (safe: it under-sells, and the sync job corrects it on its next pass) —
 * but the local `last_known_stock` cache must keep whatever reading it last actually took, because
 * "CJ was unreachable for 30 seconds" is not an observation that the warehouse is empty. Writing a
 * confident 0 there would silently destroy a good value on every retry of a listing whose apply
 * happened to coincide with a supplier hiccup.
 */
async function readUsStock(deps: ApplyProposalDeps, supplierVariantId: string): Promise<number | null> {
  try {
    return usQuantity(await deps.adapter.getVariantStock(supplierVariantId))
  } catch (err) {
    await deps
      .alert('warning', 'listing_stock_read_failed', {
        supplierVariantId,
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {})
    return null
  }
}

/**
 * `new_listing` proposal executor (Task 14): turns an `approved`/`applying` new_listing proposal
 * into real Shopify + local-DB state. Extracted byte-identical from `run-apply.ts`'s former inline
 * pipeline behind that file's type-keyed `executors` dispatch — every comment and code path below
 * is unchanged from the original, only the function wrapper (and `proposalId` now coming off
 * `row.id` instead of a separate parameter) is new.
 *
 * Resumable by design: a crash between any two steps below is recovered by simply re-running this
 * function against the same proposal — exactly what happens, since pg-boss retries the job on a
 * thrown error and `proposal.apply` is enqueued with `singletonKey: proposalId` (see `submit.ts`'s
 * `enqueueProposalApply`). Every DB write below is conflict-tolerant — `onConflictDoNothing`, or an
 * upsert that only ever backfills a null identity column (the two gids) or refreshes a timestamped
 * observation (the mapping's stock pair) — and Shopify product resolution checks the local row
 * first, then a handle-based Shopify lookup, before ever creating a new product, so a resumed run
 * never double-creates.
 */
export async function applyNewListing(deps: ApplyProposalDeps, row: ProposalRow): Promise<void> {
  const { db } = deps
  const proposalId = row.id

  const payload = NewListingPayloadSchema.parse(row.payload)
  const handle = proposalHandle(proposalId, payload.title)
  const category = categoryByTag(payload.categoryTag)
  /**
   * The merchandising scalars, hoisted because BOTH `productSet` calls below send them.
   *
   * The second call (the DRAFT -> ACTIVE flip) is a full `productSet` on the same product, and
   * whether Shopify preserves fields an input omits is not something this repo has verified live.
   * Re-sending these three costs nothing and removes the question entirely. What must NEVER ride
   * along on that call is `variants` or `files` — those would rewrite inventory quantities the
   * store may have moved on from and re-upload the media.
   */
  const catalogFields = {
    // The tag the automated collections key on, and the storefront's own category vocabulary —
    // both derived from `@doge-buddy/core`'s CATEGORIES so a product cannot be born into a
    // category the store doesn't render.
    tags: [categoryTagValue(payload.categoryTag)],
    productType: category.productType,
    seo: {
      title: payload.title.slice(0, SEO_TITLE_MAX),
      description: seoDescription(payload.descriptionHtml),
    },
  }

  // 0. CJ's US stock per payload variant, read BEFORE the product is resolved so both paths below
  // get it: the create path seeds Shopify's inventory levels with it, and every path — create or
  // resume — records it on the mapping row. Doing this only inside the create branch would leave
  // a resumed listing's `last_known_stock` permanently null, which is exactly the class of
  // resume-path hole the variant-gid backfill in step 3 below already had to be fixed for.
  const stockCheckedAt = new Date()
  // `null` = the read failed (see `readUsStock`); 0 = CJ genuinely has none.
  const stockBySku = new Map<string, number | null>()
  for (const v of payload.variants) {
    stockBySku.set(v.sku, await readUsStock(deps, v.supplierVariantId))
  }

  // 1. Resolve the Shopify product exactly once, across crashes: local row first, then handle probe.
  const [existing] = await db.select().from(products).where(eq(products.createdFromProposalId, proposalId))
  let productGid = existing?.shopifyProductGid ?? null
  if (!productGid) {
    productGid = (await deps.shopify.findProductByHandle(handle))?.id ?? null
  }
  let variantGids: { id: string; sku?: string; inventoryItemId: string }[] = []
  if (!productGid) {
    // The location every `inventoryQuantities` entry below is addressed to. Resolved lazily, and
    // only on this branch: a resumed apply that finds its product already created never touches
    // Shopify inventory, so it must not pay (or fail on) a location lookup it has no use for.
    const locationId = await getLocationId(deps.shopify)
    // The `ProductSetInput` fields below (`handle`, `tags`, `productType`, `seo`, and the variants'
    // `inventoryItem`/`inventoryQuantities`) were LIVE-VERIFIED against the 2026-07 Admin API —
    // this is no longer a fixture guess. See the catalog-p0 ledger.
    const created = await deps.shopify.productSet({
      title: payload.title,
      handle,
      descriptionHtml: payload.descriptionHtml,
      status: 'DRAFT',
      ...catalogFields,
      productOptions: [{
        name: 'Title',
        values: payload.variants.map((v, i, all) => ({ name: all.length === 1 ? 'Default Title' : v.sku })),
      }],
      files: payload.imageUrls.map((url) => ({ originalSource: url, contentType: 'IMAGE' })),
      metafields: [
        { namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', value: payload.shipsFrom },
        { namespace: 'dogebuddy', key: 'delivery_min_days', type: 'number_integer', value: String(payload.deliveryMinDays) },
        { namespace: 'dogebuddy', key: 'delivery_max_days', type: 'number_integer', value: String(payload.deliveryMaxDays) },
      ],
      variants: payload.variants.map((v, i, all) => ({
        sku: v.sku,
        price: centsToUsd(v.priceCents),
        ...(v.compareAtCents ? { compareAtPrice: centsToUsd(v.compareAtCents) } : {}),
        // Tracked from birth, seeded with what CJ has in the US right now. Untracked (the old
        // behaviour) means Shopify will happily sell a variant CJ cannot ship; tracked-but-unseeded
        // means the storefront shows every brand-new product as sold out until the sync job's first
        // pass. Both are wrong on day one, which is why the quantity ships with the create call.
        inventoryItem: { tracked: true },
        inventoryQuantities: [
          { locationId, name: 'available', quantity: stockBySku.get(v.sku) ?? 0 },
        ],
        optionValues: [{ optionName: 'Title', name: all.length === 1 ? 'Default Title' : v.sku }],
      })),
    })
    productGid = created.productId
    variantGids = created.variants
  } else {
    // Resume path: the product already existed (local row, or the handle probe found it), so
    // `productSet` was never called this run and there's no fresh `variants` array to read gids
    // from. Fetch them directly so the insert loop below still populates `shopifyVariantGid`
    // instead of leaving it permanently null — see `ProposalShopifyOps.productVariantsByProductId`'s
    // own doc comment for why "permanently" is the actual failure mode without this.
    variantGids = await deps.shopify.productVariantsByProductId(productGid)
  }
  // 2. Local products row — gid lands before anything else can crash.
  await db.insert(products).values({
    shopifyProductGid: productGid, handle, title: payload.title, status: 'active',
    categoryTag: payload.categoryTag, createdFromProposalId: proposalId,
  }).onConflictDoNothing({ target: products.shopifyProductGid })
  const [productRow] = await db.select().from(products).where(eq(products.shopifyProductGid, productGid))
  // 3. product_variants + supplier_variant_mappings (idempotent; matched by sku). The gid column
  // is a coalesce-backfill on conflict — not a plain onConflictDoNothing — specifically so a row
  // that landed with a null `shopifyVariantGid` on an earlier run (the exact resume scenario this
  // just guarded against getting introduced going forward) can still self-heal on a later re-apply
  // that DOES have the real gid, rather than that null being permanent. Every other column keeps
  // first-write-wins semantics (price/cost are never overwritten on conflict).
  for (const v of payload.variants) {
    const shopifyVariant = variantGids.find((g) => g.sku === v.sku)
    const gid = shopifyVariant?.id ?? null
    // The inventory-item gid is how Task 5's sync job addresses this variant's stock; it arrives on
    // the same two paths the variant gid does (`productSet`'s return, or `productVariantsByProductId`
    // on a resume) and gets the same coalesce-backfill treatment on conflict, for the same reason:
    // a row that landed null on an earlier partial run must be able to self-heal.
    const inventoryItemGid = shopifyVariant?.inventoryItemId ?? null
    await db.insert(productVariants).values({
      productId: productRow!.id, shopifyVariantGid: gid, shopifyInventoryItemGid: inventoryItemGid, sku: v.sku,
      priceCents: v.priceCents, compareAtCents: v.compareAtCents ?? null,
      supplierCostCents: v.supplierCostCents,
    }).onConflictDoUpdate({
      target: productVariants.sku,
      set: {
        shopifyVariantGid: sql`coalesce(${productVariants.shopifyVariantGid}, excluded.shopify_variant_gid)`,
        shopifyInventoryItemGid: sql`coalesce(${productVariants.shopifyInventoryItemGid}, excluded.shopify_inventory_item_gid)`,
      },
    })
    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, v.sku))
    // Sku-keyed re-select above can cross-wire onto a DIFFERENT product's variant row if the same
    // sku appears in two different proposals' payloads — the coalesce-upsert just above is
    // matched by sku alone, so a duplicate sku silently attaches this proposal's mapping to some
    // other product's variant instead of failing loudly. Guard it: the re-selected row must
    // belong to THIS pipeline's product, or this is a real data problem that must not proceed
    // silently — throw so the job retries and dead-letters into failed+alert via the existing
    // `deadLetterApplyProposal` hook (loud failure, not a silent cross-wire).
    if (variantRow!.productId !== productRow!.id) {
      throw new Error(`sku collision: ${v.sku} already belongs to another product`)
    }
    // Unlike the identity columns above, the stock pair is NOT first-write-wins: it is a
    // timestamped observation, and a re-applied listing that took a FRESH one should overwrite —
    // a stale `last_known_stock` is worse than the new reading. But only a real reading counts:
    // when the read failed (`null`), both columns go in null and the `coalesce(excluded, existing)`
    // on conflict keeps whatever was already there, so a supplier hiccup during a retry can never
    // regress a good value to 0. The pair moves together — a quantity without its timestamp, or a
    // timestamp implying a reading that never happened, is worse than either alone.
    const observed = stockBySku.get(v.sku) ?? null
    await db.insert(supplierVariantMappings).values({
      variantId: variantRow!.id, supplier: v.supplier,
      supplierProductId: v.supplierProductId, supplierVariantId: v.supplierVariantId,
      lastKnownStock: observed, stockCheckedAt: observed === null ? null : stockCheckedAt,
    }).onConflictDoUpdate({
      target: [supplierVariantMappings.variantId, supplierVariantMappings.supplier],
      set: {
        lastKnownStock: sql`coalesce(excluded.last_known_stock, ${supplierVariantMappings.lastKnownStock})`,
        stockCheckedAt: sql`coalesce(excluded.stock_checked_at, ${supplierVariantMappings.stockCheckedAt})`,
      },
    })
  }

  // 3b. Hand the product to the inventory sync job (Task 5). Strictly after the local rows exist —
  // the job resolves the product by its local id. The product is still DRAFT at this point (step 4
  // flips it), which changes nothing about the argument: the sync job is a *refresher* of an
  // inventory the create call already seeded correctly, so a queue that is momentarily unreachable
  // costs a refresh, never the listing — hence best-effort, alert, and carry on. The queue's
  // `singletonKey` is the product id, so the retry a thrown apply triggers cannot pile up
  // duplicate syncs either.
  try {
    await deps.enqueue(INVENTORY_SYNC_QUEUE, { productId: productRow!.id }, inventorySyncSendOpts(productRow!.id))
  } catch (err) {
    await deps.alert('warning', 'listing_sync_enqueue_failed', {
      proposalId,
      productId: productRow!.id,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
  }
  // 4. ACTIVE + publish. Online Store success is required for 'applied'; others alert-and-continue.
  await deps.shopify.productSet({ id: productGid, status: 'ACTIVE', ...catalogFields })
  const publications = await deps.shopify.listPublications()
  for (const pub of publications) {
    try {
      await deps.shopify.publishablePublish(productGid, pub.id)
    } catch (err) {
      if (pub.name === 'Online Store') throw err
      await deps.alert('warning', 'publish_partial_failure', {
        proposalId, publication: pub.name,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {})
    }
  }
  await applyProposalTransition(db, proposalId, 'applying', 'applied', { appliedAt: new Date() })
  await db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.applied',
    entityType: 'proposal',
    entityId: proposalId,
    detail: { productGid },
  })

  // 5. Apply-time CJ product-webhook subscribe (Task 16). Strictly AFTER the applied transition
  // committed above — never before, and never allowed to affect the apply's own success: a
  // subscribe failure here must not roll back or retry the apply that already landed, so each
  // call is wrapped in its own best-effort catch (alert, never throw). A resumed/retried apply
  // that finds the row already 'applied' returns from the `row.status === 'approved'` /
  // `!== 'applying'` dispatch above long before reaching this point, so a re-run never
  // double-subscribes.
  const supplierProductIds = [...new Set(payload.variants.map((v) => v.supplierProductId))]
  for (const supplierProductId of supplierProductIds) {
    await deps.adapter.subscribeProductWebhook(supplierProductId).catch((err) =>
      deps.alert('warning', 'product_webhook_subscribe_failed', {
        proposalId,
        supplierProductId,
        error: String(err instanceof Error ? err.message : err),
      }).catch(() => {}),
    )
  }
}
