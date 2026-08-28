import { auditLog, createDb, products, productVariants, proposals, supplierVariantMappings, supportTickets } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  deadLetterApplyProposal, executeApplyProposal, proposalHandle, type ProposalShopifyOps,
} from '../src/proposals/run-apply.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

function newListingPayload() {
  return {
    type: 'new_listing', title: 'Dog Snuff Pad', descriptionHtml: '<p>x</p>',
    categoryTag: 'toys', imageUrls: ['https://cf.cjdropshipping.com/x.png'], shipsFrom: 'US',
    deliveryMinDays: 3, deliveryMaxDays: 7,
    variants: [{ sku: `SKU-${crypto.randomUUID()}`, priceCents: 2999, supplierCostCents: 1414,
      supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjv-1' }],
  }
}

/** The one proposal type still without an apply executor — test 8's "unimplemented" fixture. */
function deprecateProductPayload() {
  return {
    type: 'deprecate_product',
    productId: crypto.randomUUID(),
    evidence: { unitsSold28d: 0, refundCount28d: 3, ticketCount28d: 4, daysLive: 45 },
  }
}

function fakeShopify(overrides: Partial<ProposalShopifyOps> = {}): ProposalShopifyOps & { calls: string[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls,
    findProductByHandle: async () => { calls.push('find'); return null },
    productSet: async (input) => {
      calls.push(`productSet:${String((input as { status?: string }).status)}`)
      n += 1
      const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
        id: `gid://shopify/ProductVariant/${n}00${i}`, sku: v.sku,
      }))
      return { productId: `gid://shopify/Product/${n}`, variants }
    },
    listPublications: async () => [{ id: 'pub-1', name: 'Online Store' }, { id: 'pub-2', name: 'Shop' }],
    publishablePublish: async (_p, pub) => { calls.push(`publish:${pub}`) },
    // Default: "Shopify has no known variants for this product" — same conservative-empty stance
    // as `findProductByHandle`'s default `null`. The resume-path tests (3, 4) and the gid-backfill
    // test below override this to return sku-matched gids, proving the executor's resume branch
    // (`ProposalShopifyOps.productVariantsByProductId`) actually populates `variantGids` instead of
    // silently leaving every resumed variant's `shopifyVariantGid` null.
    productVariantsByProductId: async () => { calls.push('variantsByProductId'); return [] },
    ...overrides,
  }
}

/** Minimal `Pick<SupplierAdapter, 'subscribeProductWebhook' | 'getDisputeOptions' | 'openDispute'>`
 * fake — same spirit as `MockSupplierAdapter.subscribeProductWebhook` (`packages/supplier`):
 * records every `supplierProductId` passed, in call order, on `subscribedProductIds`.
 * `subscribeProductWebhook` itself is overridable so a test can make it throw and assert the apply
 * still succeeds. `getDisputeOptions`/`openDispute` are unused by this file's `new_listing`-only
 * tests (Task 16's `refund` executor is what actually calls them) — stubbed here purely to satisfy
 * `ApplyProposalDeps.adapter`'s grown `Pick`. */
function fakeAdapter(overrides: { subscribeProductWebhook?: (supplierProductId: string) => Promise<void> } = {}) {
  const subscribedProductIds: string[] = []
  return {
    subscribedProductIds,
    subscribeProductWebhook: overrides.subscribeProductWebhook ?? (async (supplierProductId: string) => {
      subscribedProductIds.push(supplierProductId)
    }),
    getDisputeOptions: async () => {
      throw new Error('fakeAdapter.getDisputeOptions: not used by these tests')
    },
    openDispute: async () => {
      throw new Error('fakeAdapter.openDispute: not used by these tests')
    },
  }
}

/**
 * The Task 14 `ApplyProposalDeps` fields this file's `new_listing`-only tests don't themselves
 * exercise (`gmail`/`refundOps`/`supportAddress`), plus test-friendly defaults for `notify`/
 * `enqueue`/`adminBaseUrl` — the two new dead-letter tests below override `notify` with their own
 * spy. Keeps every other call site's deps-construction purely mechanical (Task 14 brief).
 */
function baseDeps(overrides: { notify?: ReturnType<typeof vi.fn> } = {}) {
  return {
    gmail: null,
    refundOps: null,
    supportAddress: '',
    notify: overrides.notify ?? vi.fn(async () => true),
    enqueue: vi.fn(async () => {}),
    adminBaseUrl: 'https://admin.example.com',
  }
}

// `fakeShopify`'s `productSet` mints deterministic gids from a per-instance counter that always
// starts at 0 — every test's *own* fresh `fakeShopify()` therefore produces the exact same literal
// first-call gids (`gid://shopify/Product/1`, `gid://shopify/ProductVariant/1000`), and test 4
// pins a second literal (`gid://shopify/Product/9`) via its `findProductByHandle` override. Normal
// intra-run hygiene is `afterEach` below (tracks and deletes exactly what each test created) — but
// this shared, persistent test database can also carry a row left behind by a run that crashed or
// was killed mid-file (before its own `afterEach` fired) on a PRIOR invocation. Because the
// products-row insert is `onConflictDoNothing` (by design — it's the crash-resume idempotency this
// suite exists to test), a stale row squatting one of these exact literal gids doesn't fail loudly
// on the next run: the insert silently no-ops and the subsequent SELECT quietly reads back
// whatever unrelated row already owns that gid, corrupting every test's assertions in a confusing
// way (same class of bug `fulfillment-pay-order.test.ts` and friends already guard against — see
// this repo's "test: fix dirty-DB rerun contamination" fix). Purge every row pinned to these known
// literals once, up front, so a dirty rerun can't silently contaminate this file's very first test.
const FIXTURE_PRODUCT_GIDS = ['gid://shopify/Product/1', 'gid://shopify/Product/9']
const FIXTURE_VARIANT_GIDS = ['gid://shopify/ProductVariant/1000']

describe('executeApplyProposal / deadLetterApplyProposal', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  beforeAll(async () => {
    const staleVariants = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(inArray(productVariants.shopifyVariantGid, FIXTURE_VARIANT_GIDS))
    const staleProducts = await db
      .select({ id: products.id })
      .from(products)
      .where(inArray(products.shopifyProductGid, FIXTURE_PRODUCT_GIDS))
    const productIds = staleProducts.map((p) => p.id)
    const moreVariants = productIds.length
      ? await db.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.productId, productIds))
      : []
    const variantIds = [...new Set([...staleVariants, ...moreVariants].map((v) => v.id))]
    if (variantIds.length > 0) {
      await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, variantIds))
      await db.delete(productVariants).where(inArray(productVariants.id, variantIds))
    }
    if (productIds.length > 0) {
      await db.delete(products).where(inArray(products.id, productIds))
    }
  })

  let createdProposalIds: string[] = []
  let createdProductIds: string[] = []
  let createdTicketIds: string[] = []

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
    if (createdTicketIds.length > 0) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
    }
    createdProductIds = []
    createdProposalIds = []
    createdTicketIds = []
  })

  async function seedProposal(opts: {
    status: 'approved' | 'applying' | 'applied' | 'rejected'
    type?: 'new_listing' | 'refund' | 'support_reply' | 'deprecate_product'
    payload?: unknown
    ticketId?: string
  }) {
    const [row] = await db
      .insert(proposals)
      .values({
        type: opts.type ?? 'new_listing',
        status: opts.status,
        summary: 'test summary',
        payload: (opts.payload ?? newListingPayload()) as object,
        sourceWorkflow: 'test',
        ticketId: opts.ticketId,
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  /** Seeds a support_tickets row in `awaiting_approval` — the status a proposal-bearing ticket
   * sits in while its approved support_reply/refund waits to be applied. */
  async function seedAwaitingApprovalTicket() {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `test-thread-${crypto.randomUUID()}`,
        status: 'awaiting_approval',
      })
      .returning()
    createdTicketIds.push(row!.id)
    return row!
  }

  async function loadProposal(id: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    return row
  }

  async function auditRowsFor(id: string, action?: string) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, id))
    return action ? rows.filter((r) => r.action === action) : rows
  }

  async function loadProduct(proposalId: string) {
    const [row] = await db.select().from(products).where(eq(products.createdFromProposalId, proposalId))
    return row
  }

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------
  it('1. happy path: new_listing goes live and fulfillable', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const productSetSpy = vi.spyOn(shopify, 'productSet')
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')
    expect(after!.appliedAt).toBeInstanceOf(Date)

    // Apply-time CJ product-webhook subscribe (Task 16): fired strictly after the applied
    // transition, best-effort, once per unique supplierProductId in the payload.
    expect(adapter.subscribedProductIds).toEqual([payload.variants[0]!.supplierProductId])

    const productRow = await loadProduct(row.id)
    expect(productRow).toBeDefined()
    createdProductIds.push(productRow!.id)
    expect(productRow!.shopifyProductGid).toBe('gid://shopify/Product/1')
    expect(productRow!.handle).toBe(proposalHandle(row.id))

    const variantRows = await db.select().from(productVariants).where(eq(productVariants.productId, productRow!.id))
    expect(variantRows).toHaveLength(1)
    const variantRow = variantRows[0]!
    expect(variantRow.sku).toBe(payload.variants[0]!.sku)
    expect(variantRow.priceCents).toBe(payload.variants[0]!.priceCents)
    expect(variantRow.supplierCostCents).toBe(payload.variants[0]!.supplierCostCents)
    expect(variantRow.shopifyVariantGid).not.toBeNull()

    const mappingRows = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow.id))
    expect(mappingRows).toHaveLength(1)
    expect(mappingRows[0]!.supplier).toBe('cj')
    expect(mappingRows[0]!.supplierProductId).toBe(payload.variants[0]!.supplierProductId)
    expect(mappingRows[0]!.supplierVariantId).toBe(payload.variants[0]!.supplierVariantId)

    expect(shopify.calls).toEqual([
      'find', 'productSet:DRAFT', 'productSet:ACTIVE', 'publish:pub-1', 'publish:pub-2',
    ])

    const draftCall = productSetSpy.mock.calls.find(([input]) => (input as { status?: string }).status === 'DRAFT')
    expect(draftCall).toBeDefined()
    const draftInput = draftCall![0] as Record<string, unknown>
    expect(draftInput.handle).toBe(proposalHandle(row.id))
    expect(draftInput.metafields).toEqual(
      expect.arrayContaining([expect.objectContaining({ namespace: 'dogebuddy', key: 'ships_from' })]),
    )
    const draftVariants = draftInput.variants as { inventoryItem?: unknown }[]
    expect(draftVariants.length).toBeGreaterThan(0)
    for (const v of draftVariants) {
      expect(v.inventoryItem).toEqual({ tracked: false })
    }

    const applied = await auditRowsFor(row.id, 'proposal.applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ actor: 'system', entityType: 'proposal', entityId: row.id })
  })

  // ---------------------------------------------------------------------------
  // 1b. Apply-time subscribe is best-effort: a throw must not fail the apply
  // ---------------------------------------------------------------------------
  it('1b. product-webhook subscribe throw: apply still succeeds, warning alert fired', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter({
      subscribeProductWebhook: async () => {
        throw new Error('cj subscribe unavailable')
      },
    })

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      'product_webhook_subscribe_failed',
      expect.objectContaining({
        proposalId: row.id,
        supplierProductId: payload.variants[0]!.supplierProductId,
        error: 'cj subscribe unavailable',
      }),
    )
  })

  // ---------------------------------------------------------------------------
  // 1c. Re-run of an already-applied proposal: no second subscribe
  // ---------------------------------------------------------------------------
  it('1c. re-run of an already-applied proposal returns before subscribing again', async () => {
    const row = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)
    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    expect(adapter.subscribedProductIds).toHaveLength(1)

    // Re-run against the same (now 'applied') row — the existing dispatch-no-op branch (test 5)
    // returns before reaching the resolve-payload/subscribe step, so no second subscribe call.
    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)
    expect(adapter.subscribedProductIds).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // 2. Fulfillability proof
  // ---------------------------------------------------------------------------
  it('2. fulfillability proof: the mapping row joins back to a variant with cost + gid set', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    const [joined] = await db
      .select({
        supplierCostCents: productVariants.supplierCostCents,
        shopifyVariantGid: productVariants.shopifyVariantGid,
      })
      .from(supplierVariantMappings)
      .innerJoin(productVariants, eq(supplierVariantMappings.variantId, productVariants.id))
      .where(eq(productVariants.sku, payload.variants[0]!.sku))

    expect(joined).toBeDefined()
    expect(joined!.supplierCostCents).not.toBeNull()
    expect(joined!.shopifyVariantGid).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 3. Resume idempotency (crash after create)
  // ---------------------------------------------------------------------------
  it('3. resume after crash-after-create: local products row already has the gid, no re-create', async () => {
    const row = await seedProposal({ status: 'applying' })
    const [preInserted] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/pre-${row.id}`,
        handle: proposalHandle(row.id),
        title: 'Dog Snuff Pad',
        status: 'active',
        categoryTag: 'toys',
        createdFromProposalId: row.id,
      })
      .returning()
    createdProductIds.push(preInserted!.id)

    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify({
      findProductByHandle: async () => ({ id: preInserted!.shopifyProductGid! }),
      productVariantsByProductId: async () => [
        { id: 'gid://shopify/ProductVariant/resume-3', sku: payload.variants[0]!.sku },
      ],
    })
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    expect(shopify.calls).not.toContain('productSet:DRAFT')
    expect(shopify.calls).toContain('productSet:ACTIVE')

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')

    const productRow = await loadProduct(row.id)
    expect(productRow!.id).toBe(preInserted!.id)

    const variantRows = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, payload.variants[0]!.sku))
    expect(variantRows).toHaveLength(1)
    // The Critical fix: resume paths must recover the real gid via `productVariantsByProductId`
    // instead of leaving it permanently null (fulfillment's `loadMappings` filters on this column).
    expect(variantRows[0]!.shopifyVariantGid).toBe('gid://shopify/ProductVariant/resume-3')
    const mappingRows = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRows[0]!.id))
    expect(mappingRows).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // 4. Resume without local row
  // ---------------------------------------------------------------------------
  it('4. resume without a local row: finds by handle, backfills the local row, no re-create', async () => {
    const row = await seedProposal({ status: 'applying' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    shopify.findProductByHandle = async () => {
      shopify.calls.push('find')
      return { id: 'gid://shopify/Product/9' }
    }
    shopify.productVariantsByProductId = async () => [
      { id: 'gid://shopify/ProductVariant/resume-4', sku: payload.variants[0]!.sku },
    ]
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    expect(shopify.calls).toContain('find')
    expect(shopify.calls).not.toContain('productSet:DRAFT')
    expect(shopify.calls).toContain('productSet:ACTIVE')

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')

    const productRow = await loadProduct(row.id)
    expect(productRow).toBeDefined()
    createdProductIds.push(productRow!.id)
    expect(productRow!.shopifyProductGid).toBe('gid://shopify/Product/9')

    const variantRows = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.sku, payload.variants[0]!.sku))
    expect(variantRows).toHaveLength(1)
    expect(variantRows[0]!.shopifyVariantGid).toBe('gid://shopify/ProductVariant/resume-4')
  })

  // ---------------------------------------------------------------------------
  // 5. Dispatch no-ops
  // ---------------------------------------------------------------------------
  it.each(['applied', 'rejected'] as const)(
    '5. dispatch no-op from %s: no ops calls, audits proposal.apply_skipped',
    async (status) => {
      const row = await seedProposal({ status })
      const shopify = fakeShopify()
      const alert = vi.fn(async () => {})

      await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

      expect(shopify.calls).toEqual([])
      const after = await loadProposal(row.id)
      expect(after!.status).toBe(status)

      const skipped = await auditRowsFor(row.id, 'proposal.apply_skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ actor: 'system', entityType: 'proposal', entityId: row.id })
    },
  )

  // ---------------------------------------------------------------------------
  // 6. Online Store publish failure throws
  // ---------------------------------------------------------------------------
  it('6. Online Store publish failure throws, row stays applying', async () => {
    const row = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const originalPublish = shopify.publishablePublish
    shopify.publishablePublish = async (productId, pub) => {
      if (pub === 'pub-1') throw new Error('online store publish failed')
      return originalPublish(productId, pub)
    }
    const alert = vi.fn(async () => {})

    await expect(executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)).rejects.toThrow(/online store publish failed/)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applying')

    // The throw happens mid-pipeline, AFTER the product/variant/mapping rows are already
    // committed (step 4's publish loop runs after step 3's inserts) — track the leftover product
    // row so `afterEach` cleans it up, same as every other test that reaches that far.
    const productRow = await loadProduct(row.id)
    if (productRow) createdProductIds.push(productRow.id)
  })

  // ---------------------------------------------------------------------------
  // 7. Non-essential publish failure -> applied, alert fired
  // ---------------------------------------------------------------------------
  it('7. non-essential (Shop) publish failure still lands applied, fires publish_partial_failure', async () => {
    const row = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const originalPublish = shopify.publishablePublish
    shopify.publishablePublish = async (productId, pub) => {
      if (pub === 'pub-2') throw new Error('shop publish failed')
      return originalPublish(productId, pub)
    }
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      'publish_partial_failure',
      expect.objectContaining({ proposalId: row.id, publication: 'Shop' }),
    )
  })

  // ---------------------------------------------------------------------------
  // 8. Unimplemented type -> throws, dead-letters to failed
  // ---------------------------------------------------------------------------
  it('8. unimplemented proposal type throws, then dead-letters to failed', async () => {
    // `deprecate_product` is the only type left with no executor — `refund` used to stand in here
    // until Task 16 gave it one.
    const row = await seedProposal({ status: 'approved', type: 'deprecate_product', payload: deprecateProductPayload() })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})

    await expect(executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)).rejects.toThrow(/unimplemented/)

    const midway = await loadProposal(row.id)
    expect(midway!.status).toBe('applying')

    const err = new Error('unimplemented proposal type: deprecate_product')
    await deadLetterApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id, err)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('failed')
    expect(after!.applyError).toMatch(/^unimplemented/)

    expect(alert).toHaveBeenCalledWith(
      'critical',
      'proposal_apply_failed',
      expect.objectContaining({ proposalId: row.id }),
    )
  })

  // ---------------------------------------------------------------------------
  // 9. deadLetter from applying / approved both work (single-step matrix transitions)
  // ---------------------------------------------------------------------------
  it.each(['approved', 'applying'] as const)(
    '9. deadLetterApplyProposal from %s transitions straight to failed',
    async (status) => {
      const row = await seedProposal({ status })
      const shopify = fakeShopify()
      const alert = vi.fn(async () => {})

      await deadLetterApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id, new Error('boom'))

      const after = await loadProposal(row.id)
      expect(after!.status).toBe('failed')
      expect(after!.applyError).toMatch(/^boom/)
    },
  )

  // ---------------------------------------------------------------------------
  // Critical fix regression: a pre-existing null-gid variant row (left over from an earlier
  // partial apply, before this fix existed) self-heals on a later resumed run — but ONLY the gid
  // column backfills; every other column (price, cost, ...) keeps first-write-wins semantics.
  // ---------------------------------------------------------------------------
  it('backfill: a pre-existing null-gid variant row for the payload sku is backfilled by a resumed run, without overwriting priceCents', async () => {
    const sku = `SKU-${crypto.randomUUID()}`
    const payload = newListingPayload()
    payload.variants[0]!.sku = sku
    payload.variants[0]!.priceCents = 2999
    const row = await seedProposal({ status: 'applying', payload })

    // Pre-existing product + variant row simulating an earlier partial apply (pre-fix): null gid,
    // and a DIFFERENT priceCents (500) than the payload's (2999) — proves the upsert backfills
    // only the gid, not price/cost/productId.
    const [preProduct] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/pre-${row.id}`,
        handle: proposalHandle(row.id), title: 'Dog Snuff Pad', status: 'active',
        categoryTag: 'toys', createdFromProposalId: row.id,
      })
      .returning()
    createdProductIds.push(preProduct!.id)
    await db.insert(productVariants).values({
      productId: preProduct!.id, shopifyVariantGid: null, sku,
      priceCents: 500, supplierCostCents: 200,
    })

    const shopify = fakeShopify({
      findProductByHandle: async () => ({ id: preProduct!.shopifyProductGid! }),
      productVariantsByProductId: async () => [{ id: 'gid://shopify/ProductVariant/backfill', sku }],
    })
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, sku))
    expect(variantRow).toBeDefined()
    expect(variantRow!.shopifyVariantGid).toBe('gid://shopify/ProductVariant/backfill')
    expect(variantRow!.priceCents).toBe(500) // untouched — NOT overwritten to the payload's 2999
  })

  // ---------------------------------------------------------------------------
  // 11. Sku collision guard: a duplicate sku across two DIFFERENT proposals must not silently
  // cross-wire the second proposal's mapping onto the first proposal's variant. The coalesce-
  // upsert in the variant loop is matched by sku alone (a global unique constraint), so applying
  // proposal B with a sku that proposal A already owns re-selects A's variant row — the guard
  // must detect that mismatch and throw loudly rather than let B's mapping attach to A's variant.
  // ---------------------------------------------------------------------------
  it('11. sku collision: duplicate sku across two proposals rejects the second, first product untouched', async () => {
    const sharedSku = `SKU-${crypto.randomUUID()}`

    const payloadA = newListingPayload()
    payloadA.variants[0]!.sku = sharedSku
    payloadA.variants[0]!.supplierProductId = 'cjp-a'
    payloadA.variants[0]!.supplierVariantId = 'cjv-a'
    const rowA = await seedProposal({ status: 'approved', payload: payloadA })

    const payloadB = newListingPayload()
    payloadB.variants[0]!.sku = sharedSku
    payloadB.variants[0]!.supplierProductId = 'cjp-b'
    payloadB.variants[0]!.supplierVariantId = 'cjv-b'
    const rowB = await seedProposal({ status: 'approved', payload: payloadB })

    // A applies clean first.
    const shopifyA = fakeShopify()
    const alertA = vi.fn(async () => {})
    await executeApplyProposal({ db, alert: alertA, shopify: shopifyA, adapter: fakeAdapter(), ...baseDeps() }, rowA.id)

    const afterA = await loadProposal(rowA.id)
    expect(afterA!.status).toBe('applied')

    const productA = await loadProduct(rowA.id)
    createdProductIds.push(productA!.id)

    const [variantA] = await db.select().from(productVariants).where(eq(productVariants.sku, sharedSku))
    expect(variantA).toBeDefined()
    expect(variantA!.productId).toBe(productA!.id)

    const mappingsBefore = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantA!.id))
    expect(mappingsBefore).toHaveLength(1)
    expect(mappingsBefore[0]!.supplierProductId).toBe('cjp-a')
    expect(mappingsBefore[0]!.supplierVariantId).toBe('cjv-a')

    // B's apply hits the shared sku and must reject loudly instead of cross-wiring onto A's variant.
    // `fakeShopify()`'s per-instance gid counter always starts at 0 (see the file-level doc comment
    // above `FIXTURE_PRODUCT_GIDS`), so a fresh instance for B would mint the exact same literal
    // product/variant gids as A's did — colliding on `products.shopifyProductGid`'s own uniqueness
    // and masking the sku collision this test exists to exercise. Suffix every id `productSet`
    // returns so B's product/variant gids are guaranteed distinct from A's.
    const shopifyB = fakeShopify()
    const originalProductSetB = shopifyB.productSet
    shopifyB.productSet = async (input) => {
      const result = await originalProductSetB(input)
      const suffix = `b-${crypto.randomUUID()}`
      return {
        productId: `${result.productId}-${suffix}`,
        variants: result.variants.map((v) => ({ ...v, id: `${v.id}-${suffix}` })),
      }
    }
    const alertB = vi.fn(async () => {})
    await expect(
      executeApplyProposal({ db, alert: alertB, shopify: shopifyB, adapter: fakeAdapter(), ...baseDeps() }, rowB.id),
    ).rejects.toThrow(/sku collision/)

    // B's own product row was already created (step 2, before the variant loop's guard fires) —
    // track it for cleanup, same as test 6's mid-pipeline-throw case.
    const productB = await loadProduct(rowB.id)
    if (productB) createdProductIds.push(productB.id)

    const midwayB = await loadProposal(rowB.id)
    expect(midwayB!.status).toBe('applying')

    // Dead-letter B: the job wrapper's retry-exhaustion path, same as test 8.
    const err = new Error(`sku collision: ${sharedSku} already belongs to another product`)
    await deadLetterApplyProposal({ db, alert: alertB, shopify: shopifyB, adapter: fakeAdapter(), ...baseDeps() }, rowB.id, err)

    const afterB = await loadProposal(rowB.id)
    expect(afterB!.status).toBe('failed')
    expect(afterB!.applyError).toMatch(/^sku collision/)
    expect(alertB).toHaveBeenCalledWith(
      'critical',
      'proposal_apply_failed',
      expect.objectContaining({ proposalId: rowB.id }),
    )

    // CRITICAL: A's variant row and mapping are completely untouched by B's rejected attempt.
    const [variantAAfter] = await db.select().from(productVariants).where(eq(productVariants.sku, sharedSku))
    expect(variantAAfter!.id).toBe(variantA!.id)
    expect(variantAAfter!.productId).toBe(productA!.id)

    const mappingsAfter = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantA!.id))
    expect(mappingsAfter).toHaveLength(1)
    expect(mappingsAfter[0]!.supplierProductId).toBe('cjp-a')
    expect(mappingsAfter[0]!.supplierVariantId).toBe('cjv-a')
  })

  // ---------------------------------------------------------------------------
  // 12. Dead-letter growth (Task 14): support_reply escalates its ticket and pages the owner.
  // ---------------------------------------------------------------------------
  it('12. support_reply dead-letter: ticket escalated + notify called with the proposal link', async () => {
    const ticket = await seedAwaitingApprovalTicket()
    const row = await seedProposal({
      status: 'approved', type: 'support_reply', payload: { type: 'support_reply' }, ticketId: ticket.id,
    })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const notify = vi.fn(async () => true)

    await deadLetterApplyProposal(
      { db, alert, shopify, adapter: fakeAdapter(), ...baseDeps({ notify }) },
      row.id,
      new Error('gmail send failed'),
    )

    const afterProposal = await loadProposal(row.id)
    expect(afterProposal!.status).toBe('failed')

    const [afterTicket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(afterTicket!.status).toBe('escalated')
    expect(afterTicket!.escalationReason).toBe('apply_failed')
    expect(afterTicket!.escalationNotifiedAt).toBeNull()

    expect(notify).toHaveBeenCalledWith({
      title: 'Approved support_reply FAILED to apply',
      body: row.summary,
      actions: [{ label: 'View', url: `https://admin.example.com/admin/proposals/${row.id}` }],
    })
  })

  // ---------------------------------------------------------------------------
  // 13. Dead-letter growth (Task 14): new_listing touches neither the ticket nor notify, even
  // when a ticketId happens to be present on the row (it normally isn't for this type).
  // ---------------------------------------------------------------------------
  it('13. new_listing dead-letter: ticket untouched, notify not called', async () => {
    const ticket = await seedAwaitingApprovalTicket()
    const row = await seedProposal({ status: 'approved', type: 'new_listing', ticketId: ticket.id })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const notify = vi.fn(async () => true)

    await deadLetterApplyProposal(
      { db, alert, shopify, adapter: fakeAdapter(), ...baseDeps({ notify }) },
      row.id,
      new Error('shopify publish failed'),
    )

    const afterProposal = await loadProposal(row.id)
    expect(afterProposal!.status).toBe('failed')

    const [afterTicket] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(afterTicket!.status).toBe('awaiting_approval')
    expect(afterTicket!.escalationReason).toBeNull()

    expect(notify).not.toHaveBeenCalled()
  })
})
