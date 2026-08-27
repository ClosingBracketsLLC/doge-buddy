import { centsToUsd, NewListingPayloadSchema } from '@doge-buddy/core'
import { auditLog, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import { eq, sql } from 'drizzle-orm'
import { applyProposalTransition } from './transitions.ts'
import { proposalHandle, type ApplyProposalDeps, type ProposalRow } from './run-apply.ts'

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
 * `enqueueProposalApply`). Every DB write below is `onConflictDoNothing`, and Shopify product
 * resolution checks the local row first, then a handle-based Shopify lookup, before ever creating a
 * new product — so a resumed run never double-creates.
 */
export async function applyNewListing(deps: ApplyProposalDeps, row: ProposalRow): Promise<void> {
  const { db } = deps
  const proposalId = row.id

  const payload = NewListingPayloadSchema.parse(row.payload)
  const handle = proposalHandle(proposalId)

  // 1. Resolve the Shopify product exactly once, across crashes: local row first, then handle probe.
  const [existing] = await db.select().from(products).where(eq(products.createdFromProposalId, proposalId))
  let productGid = existing?.shopifyProductGid ?? null
  if (!productGid) {
    productGid = (await deps.shopify.findProductByHandle(handle))?.id ?? null
  }
  let variantGids: { id: string; sku?: string }[] = []
  if (!productGid) {
    // FIXTURE-ASSUMPTION (2026-07 API): ProductSetInput shape per verify-live.ts precedent —
    // verify on the first credential-gated run (Task 8).
    const created = await deps.shopify.productSet({
      title: payload.title,
      handle,
      descriptionHtml: payload.descriptionHtml,
      status: 'DRAFT',
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
        inventoryItem: { tracked: false },
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
    const gid = variantGids.find((g) => g.sku === v.sku)?.id ?? null
    await db.insert(productVariants).values({
      productId: productRow!.id, shopifyVariantGid: gid, sku: v.sku,
      priceCents: v.priceCents, compareAtCents: v.compareAtCents ?? null,
      supplierCostCents: v.supplierCostCents,
    }).onConflictDoUpdate({
      target: productVariants.sku,
      set: { shopifyVariantGid: sql`coalesce(${productVariants.shopifyVariantGid}, excluded.shopify_variant_gid)` },
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
    await db.insert(supplierVariantMappings).values({
      variantId: variantRow!.id, supplier: v.supplier,
      supplierProductId: v.supplierProductId, supplierVariantId: v.supplierVariantId,
    }).onConflictDoNothing()
  }
  // 4. ACTIVE + publish. Online Store success is required for 'applied'; others alert-and-continue.
  await deps.shopify.productSet({ id: productGid, status: 'ACTIVE' })
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
