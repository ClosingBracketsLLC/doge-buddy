import {
  auditLog,
  createDb,
  products,
  productVariants,
  proposals,
  supplierVariantMappings,
} from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNPUBLISH_PARTIAL_FAILURE_ALERT,
  WEBHOOK_UNSUBSCRIBE_FAILED_ALERT,
  applyDeprecateProduct,
} from '../src/proposals/apply-deprecate-product.ts'
import { PROPOSAL_APPLIED_ACTION, type ApplyProposalDeps, type ProposalShopifyOps } from '../src/proposals/apply-shared.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

/**
 * `ProposalShopifyOps` fake for the deprecation pipeline. Records `productSet` / `publishableUnpublish`
 * in `calls` (call order matters for the happy path), and throws loudly on any op the deprecate
 * executor must NOT touch (`findProductByHandle`/`publishablePublish`/`productVariantsByProductId`).
 * `productSet`/`publishableUnpublish` are individually overridable so a test can make one throw.
 */
function fakeShopify(
  overrides: Partial<Pick<ProposalShopifyOps, 'productSet' | 'listPublications' | 'publishableUnpublish'>> = {},
): ProposalShopifyOps & { calls: string[] } {
  const calls: string[] = []
  const mustNotTouch = (name: string) => async () => {
    throw new Error(`applyDeprecateProduct must not call ${name}`)
  }
  return {
    calls,
    findProductByHandle: mustNotTouch('findProductByHandle') as ProposalShopifyOps['findProductByHandle'],
    publishablePublish: mustNotTouch('publishablePublish') as ProposalShopifyOps['publishablePublish'],
    productVariantsByProductId:
      mustNotTouch('productVariantsByProductId') as ProposalShopifyOps['productVariantsByProductId'],
    // Task 4 added this to `ProposalShopifyOps` for the *listing* executor; the deprecation
    // pipeline has no business looking up an inventory location, so it joins the must-not-touch
    // list rather than getting a benign stub.
    primaryLocationId: mustNotTouch('primaryLocationId') as ProposalShopifyOps['primaryLocationId'],
    productSet:
      overrides.productSet ??
      (async (input) => {
        calls.push(`productSet:${String((input as { status?: string }).status)}`)
        return { productId: String((input as { id?: string }).id), variants: [] }
      }),
    listPublications:
      overrides.listPublications ??
      (async () => [
        { id: 'pub-1', name: 'Online Store' },
        { id: 'pub-2', name: 'Shop' },
      ]),
    publishableUnpublish:
      overrides.publishableUnpublish ??
      (async (_productGid, publicationId) => {
        calls.push(`unpublish:${publicationId}`)
      }),
  }
}

/** Minimal supplier-adapter fake: records every `unsubscribeProductWebhook` spid in call order.
 * The other three methods on the Pick are unused by this executor — stubbed to throw. */
function fakeAdapter(overrides: { unsubscribeProductWebhook?: (spid: string) => Promise<void> } = {}) {
  const unsubscribed: string[] = []
  return {
    unsubscribed,
    unsubscribeProductWebhook:
      overrides.unsubscribeProductWebhook ??
      (async (spid: string) => {
        unsubscribed.push(spid)
      }),
    subscribeProductWebhook: async () => {
      throw new Error('applyDeprecateProduct must not call subscribeProductWebhook')
    },
    getDisputeOptions: async () => {
      throw new Error('applyDeprecateProduct must not call getDisputeOptions')
    },
    openDispute: async () => {
      throw new Error('applyDeprecateProduct must not call openDispute')
    },
  }
}

describe('applyDeprecateProduct', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let alert: ReturnType<typeof vi.fn>
  let createdProductIds: string[] = []
  let createdProposalIds: string[] = []

  beforeEach(() => {
    alert = vi.fn(async () => {})
  })

  afterEach(async () => {
    if (createdProductIds.length > 0) {
      const variantRows = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.productId, createdProductIds))
      const variantIds = variantRows.map((v) => v.id)
      if (variantIds.length > 0) {
        await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, variantIds))
        await db.delete(productVariants).where(inArray(productVariants.id, variantIds))
      }
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
    }
    createdProductIds = []
    createdProposalIds = []
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  async function seedProduct(opts: { status?: 'active' | 'draft' | 'deprecated'; deprecatedAt?: Date | null } = {}) {
    const tag = uid()
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/deprtest-${tag}`,
        handle: `deprtest-${tag}`,
        title: 'Deprecatable Doge Toy',
        status: opts.status ?? 'active',
        categoryTag: 'toys',
        deprecatedAt: opts.deprecatedAt ?? null,
      })
      .returning()
    createdProductIds.push(row!.id)
    return row!
  }

  /** Adds a variant + its CJ mapping to a product. `supplierProductId` is what the CJ unsubscribe
   * step keys off of. */
  async function seedVariantMapping(productId: string, supplierProductId: string) {
    const tag = uid()
    const [variant] = await db
      .insert(productVariants)
      .values({ productId, sku: `SKU-${tag}`, priceCents: 2999, supplierCostCents: 1400 })
      .returning()
    await db.insert(supplierVariantMappings).values({
      variantId: variant!.id,
      supplier: 'cj',
      supplierProductId,
      supplierVariantId: `cjv-${tag}`,
    })
    return variant!
  }

  function deprecatePayload(productId: string) {
    return {
      type: 'deprecate_product',
      productId,
      evidence: { unitsSold28d: 0, refundCount28d: 3, ticketCount28d: 4, daysLive: 45 },
    }
  }

  /** Seeds an `applying` deprecate_product proposal — the state the shell hands the executor. */
  async function seedProposal(productId: string, status: 'applying' | 'approved' = 'applying') {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'deprecate_product',
        status,
        summary: 'Deprecate underperforming product',
        payload: deprecatePayload(productId),
        sourceWorkflow: 'scoring',
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  function makeDeps(overrides: Partial<ApplyProposalDeps> = {}): ApplyProposalDeps {
    return {
      db,
      alert: alert as unknown as ApplyProposalDeps['alert'],
      shopify: fakeShopify(),
      adapter: fakeAdapter() as unknown as ApplyProposalDeps['adapter'],
      gmail: null,
      refundOps: null,
      supportAddress: '',
      notify: vi.fn(async () => true) as unknown as ApplyProposalDeps['notify'],
      enqueue: vi.fn(async () => {}) as unknown as ApplyProposalDeps['enqueue'],
      adminBaseUrl: 'https://admin.test',
      ...overrides,
    }
  }

  async function loadProduct(id: string) {
    const [row] = await db.select().from(products).where(eq(products.id, id))
    return row
  }
  async function loadProposal(id: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    return row
  }
  async function auditRowsFor(id: string, action?: string) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, id))
    return action ? rows.filter((r) => r.action === action) : rows
  }

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it('1. happy path: DRAFT + unpublish-all + local deprecated + CJ unsubscribe + applied', async () => {
    const product = await seedProduct({ status: 'active' })
    await seedVariantMapping(product.id, 'cjp-dep-1')
    const proposal = await seedProposal(product.id)

    const shopify = fakeShopify()
    const adapter = fakeAdapter()
    await applyDeprecateProduct(makeDeps({ shopify, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    // Step 2 flips DRAFT, step 3 pulls from every publication.
    expect(shopify.calls).toEqual(['productSet:DRAFT', 'unpublish:pub-1', 'unpublish:pub-2'])

    // Step 4: local row deprecated + timestamp stamped.
    const after = await loadProduct(product.id)
    expect(after!.status).toBe('deprecated')
    expect(after!.deprecatedAt).toBeInstanceOf(Date)

    // Step 5: the product's sole (unshared) supplierProductId is unsubscribed.
    expect(adapter.unsubscribed).toEqual(['cjp-dep-1'])

    // Step 6: proposal applied + audit.
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applied')
    expect(afterProposal!.appliedAt).toBeInstanceOf(Date)

    const applied = await auditRowsFor(proposal.id, PROPOSAL_APPLIED_ACTION)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ actor: 'system', entityType: 'proposal', entityId: proposal.id })
    expect(applied[0]!.detail).toMatchObject({ productGid: product.shopifyProductGid, action: 'deprecated' })
  })

  // -------------------------------------------------------------------------
  // 2. Online Store unpublish throws -> alert, but deprecation STILL commits (no strand)
  // -------------------------------------------------------------------------
  it('2. Online Store publishableUnpublish throwing does not strand the deprecation', async () => {
    const product = await seedProduct({ status: 'active' })
    await seedVariantMapping(product.id, 'cjp-dep-2')
    const proposal = await seedProposal(product.id)

    const shopify = fakeShopify({
      publishableUnpublish: async (_gid, publicationId) => {
        if (publicationId === 'pub-1') throw new Error('online store unpublish failed')
        shopify.calls.push(`unpublish:${publicationId}`)
      },
    })
    const adapter = fakeAdapter()

    // Must NOT throw — a failed unpublish is alert-and-continue.
    await applyDeprecateProduct(makeDeps({ shopify, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      UNPUBLISH_PARTIAL_FAILURE_ALERT,
      expect.objectContaining({ proposalId: proposal.id, publication: 'Online Store', error: 'online store unpublish failed' }),
    )
    // The Shop publication was still processed after the Online Store failure.
    expect(shopify.calls).toContain('unpublish:pub-2')

    // The deprecation still landed and the proposal still applied.
    const after = await loadProduct(product.id)
    expect(after!.status).toBe('deprecated')
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applied')
  })

  // -------------------------------------------------------------------------
  // 3. Re-entry after step 4 already committed -> idempotent single effect
  // -------------------------------------------------------------------------
  it('3. re-entry after step 4: deprecated_at is preserved (COALESCE), applied exactly once', async () => {
    // Simulate a prior attempt that crashed AFTER step 4 (product already deprecated with a fixed
    // timestamp) but BEFORE step 6 (proposal still `applying`). The re-run must be a pure no-op on
    // local state: COALESCE keeps the original deprecated_at, not now().
    const fixedDeprecatedAt = new Date('2026-01-15T00:00:00.000Z')
    const product = await seedProduct({ status: 'deprecated', deprecatedAt: fixedDeprecatedAt })
    await seedVariantMapping(product.id, 'cjp-dep-3')
    const proposal = await seedProposal(product.id)

    const shopify = fakeShopify()
    const adapter = fakeAdapter()
    await applyDeprecateProduct(makeDeps({ shopify, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    const after = await loadProduct(product.id)
    expect(after!.status).toBe('deprecated')
    expect(after!.deprecatedAt?.toISOString()).toBe(fixedDeprecatedAt.toISOString()) // unchanged

    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applied')
    const applied = await auditRowsFor(proposal.id, PROPOSAL_APPLIED_ACTION)
    expect(applied).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // 4. Missing product -> throw, not silent-apply; proposal stays applying
  // -------------------------------------------------------------------------
  it('4. missing product throws (never silent-applies over a no-op), proposal stays applying', async () => {
    const orphanProductId = crypto.randomUUID() // no products row exists for this id
    const proposal = await seedProposal(orphanProductId)

    const shopify = fakeShopify()
    await expect(
      applyDeprecateProduct(makeDeps({ shopify }), proposal),
    ).rejects.toThrow(/products row not found/)

    // No Shopify op ran (threw at step 1), and the proposal is untouched for the job to retry.
    expect(shopify.calls).toEqual([])
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applying')
  })

  // -------------------------------------------------------------------------
  // 5. CJ unsubscribe SKIPPED when another active product shares the supplierProductId
  // -------------------------------------------------------------------------
  it('5. CJ unsubscribe is skipped for a supplierProductId still used by another active product', async () => {
    const target = await seedProduct({ status: 'active' })
    await seedVariantMapping(target.id, 'cjp-shared') // shared with the other active product below
    await seedVariantMapping(target.id, 'cjp-solo') // unique to this product

    // A DIFFERENT, still-active product that also sells the shared CJ product.
    const sibling = await seedProduct({ status: 'active' })
    await seedVariantMapping(sibling.id, 'cjp-shared')

    const proposal = await seedProposal(target.id)

    const adapter = fakeAdapter()
    await applyDeprecateProduct(makeDeps({ adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    // Only the solo supplierProductId is torn down; the shared one is kept for the sibling listing.
    expect(adapter.unsubscribed).toEqual(['cjp-solo'])

    // The deprecation itself still landed.
    const after = await loadProduct(target.id)
    expect(after!.status).toBe('deprecated')
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applied')
    // Sibling is untouched.
    const afterSibling = await loadProduct(sibling.id)
    expect(afterSibling!.status).toBe('active')
  })

  // -------------------------------------------------------------------------
  // 5b. CJ unsubscribe failure is best-effort (warning alert, apply still lands)
  // -------------------------------------------------------------------------
  it('5b. CJ unsubscribe failure alerts but never fails the already-landed deprecation', async () => {
    const product = await seedProduct({ status: 'active' })
    await seedVariantMapping(product.id, 'cjp-dep-5b')
    const proposal = await seedProposal(product.id)

    const adapter = fakeAdapter({
      unsubscribeProductWebhook: async () => {
        throw new Error('cj unsubscribe unavailable')
      },
    })
    await applyDeprecateProduct(makeDeps({ adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      WEBHOOK_UNSUBSCRIBE_FAILED_ALERT,
      expect.objectContaining({ proposalId: proposal.id, supplierProductId: 'cjp-dep-5b', error: 'cj unsubscribe unavailable' }),
    )
    const after = await loadProduct(product.id)
    expect(after!.status).toBe('deprecated')
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applied')
  })

  // -------------------------------------------------------------------------
  // 6. Never deletes: the product/variant/mapping rows all survive, only status flips
  // -------------------------------------------------------------------------
  it('6. never deletes — product, variant and mapping rows all survive as deprecated', async () => {
    const product = await seedProduct({ status: 'active' })
    const variant = await seedVariantMapping(product.id, 'cjp-dep-6')
    const proposal = await seedProposal(product.id)

    await applyDeprecateProduct(makeDeps(), proposal)

    const [productAfter] = await db.select().from(products).where(eq(products.id, product.id))
    expect(productAfter).toBeDefined()
    expect(productAfter!.status).toBe('deprecated')

    const variantsAfter = await db.select().from(productVariants).where(eq(productVariants.productId, product.id))
    expect(variantsAfter).toHaveLength(1)
    const mappingsAfter = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variant.id))
    expect(mappingsAfter).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // 7. Hard productSet failure at step 2 -> nothing committed, proposal stays applying
  // -------------------------------------------------------------------------
  it('7. hard productSet failure at step 2 commits nothing, proposal stays applying', async () => {
    const product = await seedProduct({ status: 'active' })
    await seedVariantMapping(product.id, 'cjp-dep-7')
    const proposal = await seedProposal(product.id)

    const shopify = fakeShopify({
      productSet: async () => {
        throw new Error('shopify productSet failed')
      },
    })
    const adapter = fakeAdapter()

    await expect(
      applyDeprecateProduct(makeDeps({ shopify, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal),
    ).rejects.toThrow(/productSet failed/)

    // Step 4 never ran: the product is still active, no deprecation timestamp.
    const after = await loadProduct(product.id)
    expect(after!.status).toBe('active')
    expect(after!.deprecatedAt).toBeNull()

    // Step 5/6 never ran.
    expect(adapter.unsubscribed).toEqual([])
    const afterProposal = await loadProposal(proposal.id)
    expect(afterProposal!.status).toBe('applying')
    const applied = await auditRowsFor(proposal.id, PROPOSAL_APPLIED_ACTION)
    expect(applied).toHaveLength(0)
  })
})
