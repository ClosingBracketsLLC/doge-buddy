import { DeprecateProductPayloadSchema } from '@doge-buddy/core'
import { auditLog, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import { and, eq, ne, sql } from 'drizzle-orm'
import { PROPOSAL_APPLIED_ACTION, type ApplyProposalDeps, type ProposalRow } from './apply-shared.ts'
import { applyProposalTransition } from './transitions.ts'

/** Warning alert kind for a single publication that could not be unpublished. The product is
 * already `DRAFT` by the time these fire — a failed unpublish must NOT strand the deprecation. */
export const UNPUBLISH_PARTIAL_FAILURE_ALERT = 'unpublish_partial_failure'
/** Warning alert kind for a CJ product-webhook unsubscribe that failed. Best-effort recovery of a
 * supplier resource — the deprecation has already landed by the time this fires, and Task 3's
 * adapter already treats a not-found subscription as success, so this never fails the proposal. */
export const WEBHOOK_UNSUBSCRIBE_FAILED_ALERT = 'product_webhook_unsubscribe_failed'

/**
 * `deprecate_product` proposal executor (Task 10, spec §5): turns an owner-approved deprecation
 * into real Shopify + local-DB state — the product is flipped to `DRAFT`, pulled from every
 * publication, and its local row marked `deprecated`; then, safely, its CJ product-webhook
 * subscriptions are torn down. Called with the row already in `applying` — the shell
 * (`executeApplyProposal`) commits `approved -> applying` BEFORE dispatching here, and that
 * `applying`/`applied` guard is the idempotency boundary that makes a crash mid-deprecation
 * recoverable at all.
 *
 * Two guarantees are the whole point of the step order below:
 *   - **No half-apply, never delete.** The product row is only ever UPDATEd (`status='deprecated'`),
 *     never removed — every downstream join (orders, fulfillment, scoring history) keeps working.
 *   - **Resume-safe / idempotent.** Every step is a no-op on a second run: `productSet DRAFT` and
 *     `publishableUnpublish` are idempotent at Shopify; the local UPDATE is unconditional on `id`
 *     with `deprecated_at` pinned by `COALESCE` (first-write-wins, so the timestamp never moves on
 *     a re-run); the CJ unsubscribe is best-effort with not-found-as-success. A re-entered apply
 *     therefore reaches the exact same final state and transitions `applying -> applied` exactly
 *     once (the shell returns early for any already-`applied` row before ever calling this).
 */
export async function applyDeprecateProduct(deps: ApplyProposalDeps, row: ProposalRow): Promise<void> {
  const { db } = deps
  const proposalId = row.id

  // 1. Parse the payload and load the target product. A missing product is a hard failure — throw
  // so the job retries and eventually dead-letters, rather than silently marking a phantom product
  // deprecated. (The re-read guard in step 4 is the second, defensive half of the same stance.)
  const payload = DeprecateProductPayloadSchema.parse(row.payload)
  const [productRow] = await db.select().from(products).where(eq(products.id, payload.productId))
  if (!productRow) {
    throw new Error(`deprecate_product: products row not found: ${payload.productId}`)
  }
  const productGid = productRow.shopifyProductGid

  // 2. Flip the Shopify product to DRAFT. Idempotent (setting DRAFT on an already-DRAFT product is
  // a no-op at Shopify), and on its own enough to hide the product from every sales channel — the
  // unpublish loop below is belt-and-suspenders on top of it. A hard failure here throws BEFORE any
  // local state changes, so the product is never left `active`-but-hidden inconsistently: nothing
  // committed, proposal stays `applying` for retry.
  await deps.shopify.productSet({ id: productGid, status: 'DRAFT' })

  // 3. Pull the product from every publication. Mirror of `apply-new-listing`'s publish loop but
  // WITHOUT the Online-Store-throws rule: DRAFT (step 2) already hid it everywhere, so a single
  // failed unpublish must NOT strand the local `deprecated` write in step 4. Each call is its own
  // try/catch → warning alert; none is required and none may throw.
  const publications = await deps.shopify.listPublications()
  for (const pub of publications) {
    try {
      await deps.shopify.publishableUnpublish(productGid!, pub.id)
    } catch (err) {
      await deps
        .alert('warning', UNPUBLISH_PARTIAL_FAILURE_ALERT, {
          proposalId,
          publication: pub.name,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {})
    }
  }

  // 4. Mark the local row deprecated. Unconditional on `id` (so it's idempotent) and `deprecated_at`
  // is pinned by COALESCE — first-write-wins, so a re-run never moves the original timestamp. Then
  // re-read and assert: if the row is not `deprecated`, the write did not land (0 rows / a concurrent
  // writer), so throw rather than silent-apply over a no-op.
  await db
    .update(products)
    .set({ status: 'deprecated', deprecatedAt: sql`coalesce(${products.deprecatedAt}, now())` })
    .where(eq(products.id, payload.productId))
  const [afterUpdate] = await db.select().from(products).where(eq(products.id, payload.productId))
  if (afterUpdate?.status !== 'deprecated') {
    throw new Error(`deprecate_product: local status did not commit for product ${payload.productId}`)
  }

  // 5. Tear down CJ product-webhook subscriptions SAFELY. For each DISTINCT supplierProductId this
  // product maps to, unsubscribe ONLY when no OTHER `active` product still shares that
  // supplierProductId — a shared CJ product must keep its stock/price webhook alive for the sibling
  // listing that still sells it. Best-effort: the deprecation has already landed above, so a failed
  // (or skipped) unsubscribe never un-applies, retries, or fails the proposal.
  const spidRows = await db
    .selectDistinct({ supplierProductId: supplierVariantMappings.supplierProductId })
    .from(supplierVariantMappings)
    .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
    .where(eq(productVariants.productId, payload.productId))
  for (const { supplierProductId } of spidRows) {
    const [shared] = await db
      .select({ id: products.id })
      .from(products)
      .innerJoin(productVariants, eq(productVariants.productId, products.id))
      .innerJoin(supplierVariantMappings, eq(supplierVariantMappings.variantId, productVariants.id))
      .where(
        and(
          eq(products.status, 'active'),
          ne(products.id, payload.productId),
          eq(supplierVariantMappings.supplierProductId, supplierProductId),
        ),
      )
      .limit(1)
    if (shared) continue // another active product still sells this CJ product — keep its webhook.
    await deps.adapter.unsubscribeProductWebhook(supplierProductId).catch((err) =>
      deps
        .alert('warning', WEBHOOK_UNSUBSCRIBE_FAILED_ALERT, {
          proposalId,
          supplierProductId,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {}),
    )
  }

  // 6. Commit the terminal transition and record the audit. Guarded `applying -> applied` (the shell
  // put us in `applying`); a re-entered apply that already reached `applied` never gets here because
  // the shell returns early for any non-`applying` row.
  await applyProposalTransition(db, proposalId, 'applying', 'applied', { appliedAt: new Date() })
  await db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLIED_ACTION,
    entityType: 'proposal',
    entityId: proposalId,
    detail: { productGid, action: 'deprecated' },
  })
}
