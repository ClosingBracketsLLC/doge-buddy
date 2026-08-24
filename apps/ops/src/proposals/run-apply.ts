import { centsToUsd, NewListingPayloadSchema } from '@doge-buddy/core'
import { auditLog, products, productVariants, proposals, supplierVariantMappings, type createDb } from '@doge-buddy/db'
import { eq, sql } from 'drizzle-orm'
import { applyProposalTransition, StaleProposalStatusError } from './transitions.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Shopify operations `executeApplyProposal`'s `new_listing` pipeline needs — a strict, hand-picked
 * subset of `@doge-buddy/shopify-admin`'s full operation surface, same spirit as
 * `ShopifyFulfillmentOps` (`fulfillment/run-sync-tracking.ts`). Curried over the client (no
 * `client` param here) so the executor — and its tests — never depend on `ShopifyAdminClient`
 * directly.
 */
export interface ProposalShopifyOps {
  findProductByHandle(handle: string): Promise<{ id: string } | null>
  productSet(input: Record<string, unknown>): Promise<{ productId: string; variants: { id: string; sku?: string }[] }>
  listPublications(): Promise<{ id: string; name: string }[]>
  publishablePublish(productId: string, publicationId: string): Promise<void>
  /**
   * Looks up a product's current variants (id + sku) directly from Shopify. Needed on every
   * *resume* path — local row already exists, or `findProductByHandle` found it — where the
   * pipeline never called `productSet` this run and so never got a fresh `variants` array back:
   * without this, `variantGids` stays empty and every `product_variants` row lands with a
   * permanently-null `shopifyVariantGid` (permanent because the insert below is a conflict-tolerant
   * upsert matched by sku, not a hard failure) — which breaks fulfillment's `loadMappings`, which
   * filters on that column being non-null. See `executeApplyProposal`'s resume branch.
   */
  productVariantsByProductId(productGid: string): Promise<{ id: string; sku?: string }[]>
}

export interface ApplyProposalDeps {
  db: Db
  alert: Alert
  shopify: ProposalShopifyOps
}

/**
 * Deterministic Shopify handle for a proposal's product — stable across crashes/retries so
 * `findProductByHandle` can always re-find a product this pipeline created on a prior attempt.
 */
export function proposalHandle(proposalId: string): string {
  return `db-proposal-${proposalId}`
}

/**
 * `proposal.apply` executor: the sole entry point that turns an `approved` proposal into real
 * Shopify + local-DB state. Every status write goes through `applyProposalTransition` — nothing
 * here ever assigns `.status` directly (see `transitions.ts`'s own doc comment for why).
 *
 * Resumable by design: a crash between any two steps below is recovered by simply re-running this
 * function against the same `proposalId` — exactly what happens, since pg-boss retries the job on
 * a thrown error and `proposal.apply` is enqueued with `singletonKey: proposalId` (see
 * `submit.ts`'s `enqueueProposalApply`). Every DB write below is `onConflictDoNothing`, and Shopify
 * product resolution checks the local row first, then a handle-based Shopify lookup, before ever
 * creating a new product — so a resumed run never double-creates.
 */
export async function executeApplyProposal(deps: ApplyProposalDeps, proposalId: string): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
  if (!row) {
    // Missing row is a hard failure — the job retries rather than silently no-op'ing (same stance
    // `executePayOrder`/`executePlaceOrder` take for a missing row).
    throw new Error(`proposals row not found: ${proposalId}`)
  }

  if (row.status === 'approved') {
    try {
      await applyProposalTransition(db, proposalId, 'approved', 'applying')
    } catch (err) {
      if (!(err instanceof StaleProposalStatusError)) throw err
      // Another writer already moved this row off `approved` between our SELECT and the guarded
      // UPDATE — re-read to see where it landed. If it's `applying`, that writer did exactly what
      // we were about to do (or a duplicate job delivery raced us here first); safe to resume from
      // here. Anything else (already `applied`/`failed`/etc.) means someone else already finished
      // this row's next move — audit and get out, no throw (stale/duplicate delivery, not an error).
      const [after] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
      if (after?.status !== 'applying') {
        await db.insert(auditLog).values({
          actor: 'system',
          action: 'proposal.apply_skipped',
          entityType: 'proposal',
          entityId: proposalId,
          detail: { status: after?.status ?? 'unknown' },
        })
        return
      }
    }
  } else if (row.status !== 'applying') {
    // Anything else (pending/rejected/expired/applied/failed) is not ours to apply right now —
    // audit that we saw it and get out, no throw (stale/duplicate job delivery, not an error).
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'proposal.apply_skipped',
      entityType: 'proposal',
      entityId: proposalId,
      detail: { status: row.status },
    })
    return
  }

  if (row.type !== 'new_listing') {
    throw new Error(`unimplemented proposal type: ${row.type}`)
  }

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
      })
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
}

/**
 * Called by the job wrapper (`jobs/proposal-apply.ts`) only when `executeApplyProposal` threw AND
 * pg-boss's own retry-exhaustion check says this was the last attempt — same contract as
 * `deadLetterPayOrder` (`fulfillment/run-pay-order.ts`). Re-reads the row fresh since time has
 * passed since the throw; only `approved`/`applying` are ours to dead-letter (anything else means
 * someone else already moved this row's status, or it never got that far) — and the matrix allows
 * a direct transition to `failed` from either one, so this is always a single guarded UPDATE.
 */
export async function deadLetterApplyProposal(deps: ApplyProposalDeps, proposalId: string, err: unknown): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
  if (!row) return
  if (row.status !== 'approved' && row.status !== 'applying') return

  const message = err instanceof Error ? err.message : String(err)
  await applyProposalTransition(db, proposalId, row.status, 'failed', { applyError: String(message).slice(0, 500) })
  await deps.alert('critical', 'proposal_apply_failed', { proposalId, error: message })
}
