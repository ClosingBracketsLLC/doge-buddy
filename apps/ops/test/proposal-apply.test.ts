import { categoryByTag, categoryTagValue, slugify } from '@doge-buddy/core'
import { auditLog, createDb, products, productVariants, proposals, supplierVariantMappings, supportTickets } from '@doge-buddy/db'
import type { SupplierProductReview, WarehouseStock } from '@doge-buddy/supplier'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendOpts } from '../src/fulfillment/types.ts'
import {
  executeInventorySync, INVENTORY_SYNC_QUEUE, type InventorySyncShopifyOps, usQuantity,
} from '../src/jobs/inventory-sync.ts'
import { resetLocationCache } from '../src/proposals/apply-new-listing.ts'
import {
  deadLetterApplyProposal, executeApplyProposal, proposalHandle, type ProposalShopifyOps,
} from '../src/proposals/run-apply.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

function newListingPayload() {
  return {
    type: 'new_listing', title: 'Dog Snuff Pad', descriptionHtml: '<p>x</p>',
    categoryTag: 'toys',
    imageUrls: ['https://cf.cjdropshipping.com/x.png', 'https://cdn.example.com/variant-1.jpg'],
    shipsFrom: 'US',
    deliveryMinDays: 3, deliveryMaxDays: 7,
    highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
    specs: [{ label: 'Material', value: 'Cotton' }],
    whatsInBox: '1x rope toy',
    variants: [{ sku: `SKU-${crypto.randomUUID()}`, priceCents: 2999, supplierCostCents: 1414,
      supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjv-1',
      imageUrl: 'https://cdn.example.com/variant-1.jpg' }],
  }
}

/** The one active location `primaryLocationId` resolves to for every test in this file. */
const FIXTURE_LOCATION_ID = 'gid://shopify/Location/1'

/** CJ's `getVariantStock` answer for the fixture variant: two US warehouse rows plus a CN one.
 * The listed quantity is the LARGEST SINGLE US warehouse (4), not the sum (7) and never CN's 99:
 * `fulfillment/plan.ts`'s stockout gate requires ONE warehouse entry to cover the whole order
 * (`usEntries.some((e) => e.quantity >= needed)`), so listing the sum would advertise stock that
 * gate will refuse to fulfill. CN is out regardless — it cannot serve the 3-7 day US delivery
 * promise the listing's own metafields make. */
const FIXTURE_US_STOCK = 4
function fixtureStock(): WarehouseStock[] {
  return [
    { countryCode: 'US', quantity: 4, verified: true },
    { countryCode: 'US', quantity: 3, verified: true },
    { countryCode: 'CN', quantity: 99, verified: true },
  ]
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
        inventoryItemId: `gid://shopify/InventoryItem/${n}00${i}`,
      }))
      return { productId: `gid://shopify/Product/${n}`, variants }
    },
    listPublications: async () => [{ id: 'pub-1', name: 'Online Store' }, { id: 'pub-2', name: 'Shop' }],
    // Deliberately NOT recorded in `calls`: the worker memoizes this at module level, so whether a
    // given apply actually issues the call depends on which test ran first — recording it would
    // make every exact-`calls` assertion in this file order-dependent. The memo test below counts
    // it with its own `vi.spyOn` after `resetLocationCache()` instead.
    primaryLocationId: async () => FIXTURE_LOCATION_ID,
    publishablePublish: async (_p, pub) => { calls.push(`publish:${pub}`) },
    // `deprecate_product`'s apply (Task 10) is the only executor that calls this; `new_listing`'s
    // tests never reach it, so recording here leaves their `calls` assertions unchanged.
    publishableUnpublish: async (_p, pub) => { calls.push(`unpublish:${pub}`) },
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
function fakeAdapter(
  overrides: {
    subscribeProductWebhook?: (supplierProductId: string) => Promise<void>
    getVariantStock?: (supplierVariantId: string) => Promise<WarehouseStock[]>
    getProductReviews?: (supplierProductId: string) => Promise<SupplierProductReview[]>
  } = {},
) {
  const subscribedProductIds: string[] = []
  const stockReads: string[] = []
  const reviewReads: string[] = []
  return {
    subscribedProductIds,
    // Task 4: the listing worker reads CJ's per-warehouse stock for every payload variant, on the
    // create AND the resume path (the mapping's `last_known_stock` has to land either way).
    // Overridable so a test can make the read throw and assert the listing still ships at 0.
    stockReads,
    getVariantStock: async (supplierVariantId: string) => {
      stockReads.push(supplierVariantId)
      return overrides.getVariantStock ? await overrides.getVariantStock(supplierVariantId) : fixtureStock()
    },
    // v2 (Task 7): the listing worker fetches the supplier's marketplace reviews at apply time, on
    // the CREATE path only. Default: two clean, rated reviews (average 4.5) so most tests exercise
    // the happy path for free; overridable so a test can make the fetch throw.
    reviewReads,
    getProductReviews: async (supplierProductId: string) => {
      reviewReads.push(supplierProductId)
      return overrides.getProductReviews
        ? await overrides.getProductReviews(supplierProductId)
        : [
          { rating: 5, content: 'Great toy, my dog loves it', reviewDate: '2026-06-01', countryCode: 'US' },
          { rating: 4, content: 'Sturdy and washable' },
        ]
    },
    subscribeProductWebhook: overrides.subscribeProductWebhook ?? (async (supplierProductId: string) => {
      subscribedProductIds.push(supplierProductId)
    }),
    // Grown for Task 10's `ApplyProposalDeps.adapter` Pick — `deprecate_product`'s executor is what
    // actually exercises it (see apply-deprecate-product.test.ts). Unused by this file's tests, so
    // stubbed to throw like the two dispute methods below.
    unsubscribeProductWebhook: async () => {
      throw new Error('fakeAdapter.unsubscribeProductWebhook: not used by these tests')
    },
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
function baseDeps(
  overrides: {
    notify?: ReturnType<typeof vi.fn>
    enqueue?: (name: string, data: object, opts?: SendOpts) => Promise<void>
  } = {},
) {
  return {
    gmail: null,
    refundOps: null,
    supportAddress: '',
    notify: overrides.notify ?? vi.fn(async () => true),
    enqueue: overrides.enqueue ?? vi.fn(async () => {}),
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

  // The worker memoizes the primary location id at module level (one Shopify round-trip per
  // process, not per listing). That cache outlives a single test, so clear it between tests —
  // otherwise whichever test ran first silently satisfies every later test's location lookup.
  beforeEach(() => resetLocationCache())

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
    expect(productRow!.handle).toBe(proposalHandle(row.id, payload.title))

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
    expect(draftInput.handle).toBe(proposalHandle(row.id, payload.title))
    expect(draftInput.metafields).toEqual(
      expect.arrayContaining([expect.objectContaining({ namespace: 'dogebuddy', key: 'ships_from' })]),
    )
    const draftVariants = draftInput.variants as { inventoryItem?: unknown }[]
    expect(draftVariants.length).toBeGreaterThan(0)
    for (const v of draftVariants) {
      // Task 4 flipped this from `{ tracked: false }`: every variant is now inventory-tracked so
      // the sync job (Task 5) has something to write CJ's stock into. Test 14 pins the quantities.
      expect(v.inventoryItem).toEqual({ tracked: true })
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
        handle: proposalHandle(row.id, 'Dog Snuff Pad'),
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
        { id: 'gid://shopify/ProductVariant/resume-3', sku: payload.variants[0]!.sku, inventoryItemId: 'gid://shopify/InventoryItem/resume-3' },
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
    // Same argument, same column family: the inventory-item gid the sync job (Task 5) needs is
    // read off `productVariantsByProductId` on the resume path, not just off `productSet`.
    expect(variantRows[0]!.shopifyInventoryItemGid).toBe('gid://shopify/InventoryItem/resume-3')
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
      { id: 'gid://shopify/ProductVariant/resume-4', sku: payload.variants[0]!.sku, inventoryItemId: 'gid://shopify/InventoryItem/resume-4' },
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
    expect(variantRows[0]!.shopifyInventoryItemGid).toBe('gid://shopify/InventoryItem/resume-4')
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
  // 8. Defensive dispatch backstop: an unmapped proposal type throws
  // ---------------------------------------------------------------------------
  it('8. unmapped proposal type throws (defensive dispatch backstop)', async () => {
    // Every real `proposal_type` enum value now has an executor (Task 10 gave `deprecate_product`
    // its own, `applyDeprecateProduct`), so the `unimplemented proposal type` guard is no longer
    // reachable through a valid seeded row — Postgres rejects any other value at the enum itself.
    // Force a SYNTHETIC unmapped type past the type system to keep the guard covered: a fake db
    // returns exactly one 'applying' row whose `type` is bogus. The shell skips both
    // status-transition branches for an already-'applying' row and dispatches straight into the
    // guard, which throws before any executor (or Shopify op) runs. Dead-lettering from that thrown
    // state to `failed`+critical-alert is exercised separately by test 9.
    const syntheticRow = { id: crypto.randomUUID(), type: 'nonsense', status: 'applying' }
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([syntheticRow]) }) }),
    }
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})

    await expect(
      executeApplyProposal(
        { db: fakeDb as unknown as typeof db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() },
        syntheticRow.id,
      ),
    ).rejects.toThrow(/unimplemented proposal type: nonsense/)

    // The guard fires before dispatch reaches any executor — no Shopify op ran.
    expect(shopify.calls).toEqual([])
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

  it('9b. deadLetterApplyProposal surfaces GraphQL errors[] in apply_error and the alert (not just the generic message)', async () => {
    const row = await seedProposal({ status: 'applying' })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    // Shaped like @doge-buddy/shopify-admin's ShopifyGraphqlError: generic message + `errors`.
    const err = Object.assign(new Error('Shopify GraphQL request returned errors'), {
      errors: [{ message: "'@idempotent' can't be applied to mutations (allowed: fields)" }],
    })

    await deadLetterApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id, err)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('failed')
    expect(after!.applyError).toMatch(/returned errors: \[\{"message":"'@idempotent' can't be applied/)
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'proposal_apply_failed',
      expect.objectContaining({ proposalId: row.id, graphqlErrors: [{ message: expect.stringContaining('@idempotent') }] }),
    )
  })

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
        handle: proposalHandle(row.id, 'Dog Snuff Pad'), title: 'Dog Snuff Pad', status: 'active',
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
      productVariantsByProductId: async () => [{ id: 'gid://shopify/ProductVariant/backfill', sku, inventoryItemId: 'gid://shopify/InventoryItem/backfill' }],
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

  // ---------------------------------------------------------------------------
  // 14. Catalog fields (Task 4): the DRAFT `productSet` input a listing is BORN with — slug handle,
  // category tag + productType, SEO pair, and inventory tracked at CJ's US stock.
  // ---------------------------------------------------------------------------
  it('14. productSet DRAFT input: slug handle, category tag/type, SEO, tracked inventory at US stock', async () => {
    const payload = newListingPayload()
    payload.title = 'Dog Snuffle Mat — Slow Feeder'
    payload.descriptionHtml = `<p>A <b>calming</b> mat.</p>\n<p>${'x'.repeat(300)}</p>`
    const row = await seedProposal({ status: 'approved', payload })
    const shopify = fakeShopify()
    const productSetSpy = vi.spyOn(shopify, 'productSet')
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    const draftCall = productSetSpy.mock.calls.find(([input]) => (input as { status?: string }).status === 'DRAFT')
    const draftInput = draftCall![0] as Record<string, unknown>

    // (a) Handle: a human-readable slug of the title, disambiguated by the proposal id's first 8
    // hex chars — still deterministic from (proposalId, title) alone, which is what keeps the
    // crash-resume `findProductByHandle` probe able to re-find its own product.
    const handle = proposalHandle(row.id, payload.title)
    expect(handle).toBe(`${slugify(payload.title)}-${row.id.slice(0, 8)}`)
    expect(handle).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(draftInput.handle).toBe(handle)
    expect(productRow!.handle).toBe(handle)

    // (b) Tag + type come from the single category source (`@doge-buddy/core`'s CATEGORIES), which
    // is also what the automated collections key on.
    expect(draftInput.tags).toEqual([categoryTagValue('toys')])
    expect(draftInput.productType).toBe(categoryByTag('toys').productType)

    // (c) SEO: title verbatim (well under 70), description = the description HTML as plain text,
    // whitespace-collapsed and capped at 155 chars.
    const seo = draftInput.seo as { title: string; description: string }
    expect(seo.title).toBe(payload.title)
    expect(seo.title.length).toBeLessThanOrEqual(70)
    expect(seo.description).toBe(`A calming mat. ${'x'.repeat(140)}`)
    expect(seo.description).toHaveLength(155)

    // (d) Tracked inventory, seeded with the summed US stock (4 + 3, CN's 99 ignored).
    const draftVariants = draftInput.variants as { inventoryItem?: unknown; inventoryQuantities?: unknown }[]
    expect(draftVariants).toHaveLength(1)
    expect(draftVariants[0]!.inventoryItem).toEqual({ tracked: true })
    expect(draftVariants[0]!.inventoryQuantities).toEqual([
      { locationId: FIXTURE_LOCATION_ID, name: 'available', quantity: FIXTURE_US_STOCK },
    ])
    expect(adapter.stockReads).toEqual([payload.variants[0]!.supplierVariantId])

    // (e) The inventory-item gid `productSet` handed back is persisted — Task 5's sync job addresses
    // Shopify inventory by that gid, and re-deriving it later would cost a round-trip per variant.
    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, payload.variants[0]!.sku))
    expect(variantRow!.shopifyInventoryItemGid).toBe('gid://shopify/InventoryItem/1000')

    // (f) The mapping records what CJ said and when, so the sync job can reason about staleness.
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow!.id))
    expect(mapping!.lastKnownStock).toBe(FIXTURE_US_STOCK)
    expect(mapping!.stockCheckedAt).toBeInstanceOf(Date)
  })

  // ---------------------------------------------------------------------------
  // 15. A CJ stock read that throws must not cost us the listing: quantity 0 (safe: nothing
  // oversells), the product still ships, and the owner gets a warning.
  // ---------------------------------------------------------------------------
  it('15. stock read failure: quantity 0, listing still applied, listing_stock_read_failed warning', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const productSetSpy = vi.spyOn(shopify, 'productSet')
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter({
      getVariantStock: async () => {
        throw new Error('cj stock unavailable')
      },
    })

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')
    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    const draftCall = productSetSpy.mock.calls.find(([input]) => (input as { status?: string }).status === 'DRAFT')
    const draftVariants = (draftCall![0] as Record<string, unknown>).variants as {
      inventoryQuantities: { quantity: number }[]
    }[]
    expect(draftVariants[0]!.inventoryQuantities[0]!.quantity).toBe(0)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      'listing_stock_read_failed',
      expect.objectContaining({
        supplierVariantId: payload.variants[0]!.supplierVariantId,
        error: 'cj stock unavailable',
      }),
    )

    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, payload.variants[0]!.sku))
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow!.id))
    // Shopify gets a 0 (safe under-sell); the local cache records NO observation rather than a
    // confident zero — there is nothing to know yet, and test 21 covers why that distinction pays.
    expect(mapping!.lastKnownStock).toBeNull()
    expect(mapping!.stockCheckedAt).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // 16. Post-listing inventory sync enqueue (Task 4 -> Task 5's job).
  // ---------------------------------------------------------------------------
  it('16. inventory sync is enqueued once, keyed on the local product id', async () => {
    const row = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const enqueue = vi.fn(async (_name: string, _data: object, _opts?: SendOpts) => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps({ enqueue }) }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    const syncSends = enqueue.mock.calls.filter(([name]) => name === INVENTORY_SYNC_QUEUE)
    expect(syncSends).toHaveLength(1)
    expect(syncSends[0]![1]).toEqual({ productId: productRow!.id })
    expect(syncSends[0]![2]).toEqual(expect.objectContaining({ singletonKey: productRow!.id }))
  })

  // ---------------------------------------------------------------------------
  // 17. ...and a listing NEVER fails because that enqueue couldn't be placed. The product is live
  // on the storefront by then; a missing sync job is a warning, not a rollback.
  // ---------------------------------------------------------------------------
  it('17. inventory-sync enqueue failure leaves the listing applied, fires listing_sync_enqueue_failed', async () => {
    const row = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})
    const enqueue = vi.fn(async (name: string, _data: object, _opts?: SendOpts) => {
      if (name === INVENTORY_SYNC_QUEUE) throw new Error('boss is down')
    })

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps({ enqueue }) }, row.id)

    const after = await loadProposal(row.id)
    expect(after!.status).toBe('applied')
    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    expect(alert).toHaveBeenCalledWith(
      'warning',
      'listing_sync_enqueue_failed',
      expect.objectContaining({ proposalId: row.id, productId: productRow!.id, error: 'boss is down' }),
    )
  })

  // ---------------------------------------------------------------------------
  // 18. The primary location is a per-process constant, not a per-listing lookup.
  // ---------------------------------------------------------------------------
  it('18. primaryLocationId is fetched once and memoized across applies', async () => {
    const rowA = await seedProposal({ status: 'approved' })
    const rowB = await seedProposal({ status: 'approved' })
    const shopify = fakeShopify()
    const locationSpy = vi.spyOn(shopify, 'primaryLocationId')
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, rowA.id)
    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, rowB.id)

    const productA = await loadProduct(rowA.id)
    const productB = await loadProduct(rowB.id)
    createdProductIds.push(productA!.id, productB!.id)

    expect((await loadProposal(rowA.id))!.status).toBe('applied')
    expect((await loadProposal(rowB.id))!.status).toBe('applied')
    expect(locationSpy).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // 19. The listable quantity is the largest SINGLE US warehouse, never the sum — review round 1.
  // `fulfillment/plan.ts`'s Gate 4 needs one warehouse to cover the whole order, so a summed
  // quantity is stock the fulfillment pipeline will refuse to ship.
  // ---------------------------------------------------------------------------
  it('19. usQuantity takes the largest single US warehouse, ignores non-US, floors at 0', () => {
    expect(usQuantity(fixtureStock())).toBe(4)
    expect(usQuantity([])).toBe(0)
    expect(usQuantity([{ countryCode: 'CN', quantity: 99, verified: true }])).toBe(0)
    expect(usQuantity([{ countryCode: 'US', quantity: -5, verified: true }])).toBe(0)
    expect(usQuantity([
      { countryCode: 'US', quantity: 2, verified: true },
      { countryCode: 'US', quantity: 11, verified: false },
    ])).toBe(11)
  })

  // ---------------------------------------------------------------------------
  // 20. The ACTIVE flip is a second `productSet` on the same product. Whether Shopify preserves
  // fields an input omits is not live-verified, so the catalog scalars ride along on that call
  // too — variants/files deliberately do NOT (re-sending those would rewrite inventory and
  // re-upload media).
  // ---------------------------------------------------------------------------
  it('20. the ACTIVE productSet call re-sends tags/productType/seo, and never variants or files', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const productSetSpy = vi.spyOn(shopify, 'productSet')
    const alert = vi.fn(async () => {})

    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)

    const activeCall = productSetSpy.mock.calls.find(([input]) => (input as { status?: string }).status === 'ACTIVE')
    expect(activeCall).toBeDefined()
    const activeInput = activeCall![0] as Record<string, unknown>
    expect(activeInput.id).toBe(productRow!.shopifyProductGid)
    expect(activeInput.tags).toEqual([categoryTagValue('toys')])
    expect(activeInput.productType).toBe(categoryByTag('toys').productType)
    expect(activeInput.seo).toEqual({ title: payload.title, description: 'x' })
    expect(activeInput.variants).toBeUndefined()
    expect(activeInput.files).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // 21. A failed stock read must not overwrite a good `last_known_stock` with a confident 0.
  // Shopify still gets 0 for a fresh listing (safe: under-sell), but the local cache keeps the
  // last reading it actually took, timestamp and all.
  // ---------------------------------------------------------------------------
  it('21. a failed stock read leaves an existing last_known_stock/stock_checked_at untouched', async () => {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const shopify = fakeShopify()
    const alert = vi.fn(async () => {})

    // First apply: a healthy read lands the mapping row.
    await executeApplyProposal({ db, alert, shopify, adapter: fakeAdapter(), ...baseDeps() }, row.id)
    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, payload.variants[0]!.sku))

    // Pin a known-good prior observation, then re-enter the apply (the crash-retry path) with CJ down.
    const priorCheckedAt = new Date('2026-08-01T00:00:00.000Z')
    await db
      .update(supplierVariantMappings)
      .set({ lastKnownStock: 7, stockCheckedAt: priorCheckedAt })
      .where(eq(supplierVariantMappings.variantId, variantRow!.id))
    await db.update(proposals).set({ status: 'applying' }).where(eq(proposals.id, row.id))

    await executeApplyProposal(
      {
        db,
        alert,
        shopify,
        adapter: fakeAdapter({
          getVariantStock: async () => {
            throw new Error('cj stock unavailable')
          },
        }),
        ...baseDeps(),
      },
      row.id,
    )

    expect((await loadProposal(row.id))!.status).toBe('applied')
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow!.id))
    expect(mapping!.lastKnownStock).toBe(7)
    expect(mapping!.stockCheckedAt).toEqual(priorCheckedAt)
  })
  // ---------------------------------------------------------------------------
  // 22./23. C1 (whole-branch review): the RESUME path must not refresh the stock cache.
  //
  // Only the CREATE branch's `productSet` ever writes a Shopify quantity. A reading taken on a
  // resumed apply therefore cannot reach Shopify — but it WOULD land in `last_known_stock`, which
  // is precisely what `inventory.sync` compares its own fresh reading against. Attempt 1 fails its
  // read and ships Shopify a 0; attempt 2 reads 7 and caches 7; the next sync sees 7 == 7, calls it
  // "unchanged", pushes nothing — and the product is Sold out forever (or, for 7 -> 5, oversells
  // forever) with no alert anywhere. So: no read, no cache write, and the enqueued `inventory.sync`
  // is left as the single writer of that product's Shopify inventory.
  // ---------------------------------------------------------------------------

  /** Attempt 1 with CJ down (product created, Shopify quantity 0, nothing cached), then the
   * crash-retry re-entry with CJ healthy again. Returns what both tests below assert on. */
  async function crashedThenResumed() {
    const row = await seedProposal({ status: 'approved' })
    const payload = row.payload as ReturnType<typeof newListingPayload>
    const alert = vi.fn(async () => {})

    const first = fakeShopify()
    await executeApplyProposal(
      {
        db, alert, shopify: first,
        adapter: fakeAdapter({
          getVariantStock: async () => {
            throw new Error('cj stock unavailable')
          },
        }),
        ...baseDeps(),
      },
      row.id,
    )
    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, payload.variants[0]!.sku))

    await db.update(proposals).set({ status: 'applying' }).where(eq(proposals.id, row.id))
    const second = fakeShopify({
      productVariantsByProductId: async () => [
        {
          id: variantRow!.shopifyVariantGid!,
          sku: payload.variants[0]!.sku,
          inventoryItemId: variantRow!.shopifyInventoryItemGid!,
        },
      ],
    })
    const productSetSpy = vi.spyOn(second, 'productSet')
    const adapter = fakeAdapter()
    await executeApplyProposal({ db, alert, shopify: second, adapter, ...baseDeps() }, row.id)

    return { row, payload, productRow: productRow!, variantRow: variantRow!, second, productSetSpy, adapter, alert }
  }

  it('22. re-entry after a failed-read create neither re-reads CJ nor caches a quantity Shopify never got', async () => {
    const { row, variantRow, second, productSetSpy, adapter } = await crashedThenResumed()

    expect((await loadProposal(row.id))!.status).toBe('applied')
    // No CJ read at all on the resume path — the reading would have nowhere to go.
    expect(adapter.stockReads).toEqual([])
    // And no second inventory push: the only `productSet` is the ACTIVE flip, which carries
    // neither `variants` nor the `inventoryQuantities` that live on them.
    expect(second.calls.filter((c) => c.startsWith('productSet:'))).toEqual(['productSet:ACTIVE'])
    for (const [input] of productSetSpy.mock.calls) {
      expect((input as Record<string, unknown>).variants).toBeUndefined()
    }
    // The cache stays empty, so the enqueued sync below is guaranteed to see a difference and push.
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow.id))
    expect(mapping!.lastKnownStock).toBeNull()
    expect(mapping!.stockCheckedAt).toBeNull()
  })

  it('23. the inventory.sync enqueued by that re-entry is what pushes the fresh quantity to Shopify', async () => {
    const { productRow, variantRow } = await crashedThenResumed()

    const pushes: { input: Record<string, unknown>; key: string }[] = []
    const syncShopify: InventorySyncShopifyOps = {
      inventorySetQuantities: async (input, key) => {
        pushes.push({ input, key })
      },
      // What Shopify currently holds for the item: the listing seeded 0 (the failed CJ read),
      // so the CAS value the sync must send is 0 — read from Shopify, not from the (null) cache.
      inventoryAvailableAt: async () => 0,
      primaryLocationId: async () => FIXTURE_LOCATION_ID,
    }

    const result = await executeInventorySync(
      { db, adapter: fakeAdapter(), shopify: syncShopify, alert: vi.fn(async () => {}) },
      { productId: productRow.id },
    )

    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0, skipped: 0 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.input).toEqual({
      name: 'available',
      reason: 'correction',
      // `changeFromQuantity` is Shopify's CURRENT `available` (0 — what the listing seeded on
      // its failed read), never the cache (null here): the 2026-07 API requires the CAS field
      // on every entry, and it compares against Shopify's number, not ours.
      quantities: [
        { inventoryItemId: variantRow.shopifyInventoryItemGid, locationId: FIXTURE_LOCATION_ID, quantity: FIXTURE_US_STOCK, changeFromQuantity: 0 },
      ],
    })
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, variantRow.id))
    expect(mapping!.lastKnownStock).toBe(FIXTURE_US_STOCK)
    expect(mapping!.stockCheckedAt).not.toBeNull()

    await db.delete(auditLog).where(eq(auditLog.entityId, productRow.id))
  })

  // ---------------------------------------------------------------------------
  // 24.-28. Task 7: variant files, v2 content metafields, and the apply-time supplier-review
  // fetch — CREATE-only (the ACTIVE flip stays byte-identical to today, see comment at
  // apply-new-listing.ts's flip call).
  // ---------------------------------------------------------------------------
  it('24. CREATE productSet carries per-variant file, the v2 metafields, and product files exclude variant images', async () => {
    const row = await seedProposal({ status: 'approved' })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        return {
          productId: 'gid://shopify/Product/901',
          variants: [{
            id: 'gid://shopify/ProductVariant/9001',
            sku: (input as { variants?: { sku?: string }[] }).variants?.[0]?.sku,
            inventoryItemId: 'gid://shopify/InventoryItem/9001',
          }],
        }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const create = inputs[0] as any
    expect(create.variants[0].file).toEqual({ originalSource: 'https://cdn.example.com/variant-1.jpg', contentType: 'IMAGE' })
    const keys = (create.metafields as { key: string; value: string }[]).map((m) => m.key)
    expect(keys).toEqual(expect.arrayContaining(['highlights', 'specs', 'whats_in_box', 'supplier_reviews', 'ships_from']))
    const reviews = JSON.parse((create.metafields as any[]).find((m) => m.key === 'supplier_reviews').value)
    expect(reviews).toMatchObject({ average: 4.5, count: 2 })
    expect(reviews.reviews).toHaveLength(2)
    // the variant's image URL must not double as a product-level file
    expect(create.files.map((f: { originalSource: string }) => f.originalSource)).not.toContain('https://cdn.example.com/variant-1.jpg')

    const flip = inputs[1] as any
    expect(flip.status).toBe('ACTIVE')
    // Metafields ride the CREATE call ONLY — see apply-new-listing.ts's comment above the flip.
    expect(flip.metafields).toBeUndefined()
    expect(flip.variants).toBeUndefined()
    expect(flip.files).toBeUndefined()
  })

  it('25. review fetch failure: listing proceeds, info alert listing_reviews_unavailable, no supplier_reviews metafield', async () => {
    const row = await seedProposal({ status: 'approved' })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/rev-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/rev-${i}`,
        }))
        return { productId: 'gid://shopify/Product/902', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter({
      getProductReviews: async () => {
        throw new Error('cj 500')
      },
    })

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    expect(alert).toHaveBeenCalledWith('info', 'listing_reviews_unavailable', expect.objectContaining({ error: 'cj 500' }))
    const keys = (inputs[0] as any).metafields.map((m: { key: string }) => m.key)
    expect(keys).not.toContain('supplier_reviews')
  })

  it('26. claims backstop: a stored payload with a claim in a highlight applies WITHOUT content metafields + warning alert', async () => {
    const payload = newListingPayload()
    payload.highlights = ['Durable rope core', 'clinically proven comfort', 'Non-slip grip']
    const row = await seedProposal({ status: 'approved', payload })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/claim-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/claim-${i}`,
        }))
        return { productId: 'gid://shopify/Product/903', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const keys = (inputs[0] as any).metafields.map((m: { key: string }) => m.key)
    expect(keys).not.toContain('highlights')
    expect(keys).not.toContain('specs')
    expect(keys).not.toContain('whats_in_box')
    expect(alert).toHaveBeenCalledWith(
      'warning', 'listing_content_claims_blocked', expect.objectContaining({ terms: ['clinically proven'] }),
    )
  })

  it('26b. claims backstop: a stored whatsInBox ENDING in a bare CLAIM_TERM word (no trailing space) is still caught — the trailing-space evasion (whole-branch review)', async () => {
    // whatsInBox rides last in findClaimViolations' arg list here too (see apply-new-listing.ts's
    // contentClaimHits call) — this is the same evasion closed in guards.ts, exercised through the
    // apply-worker backstop rather than Stage 6.
    const payload = newListingPayload()
    payload.whatsInBox = 'the ultimate boredom cure'
    const row = await seedProposal({ status: 'approved', payload })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/cure-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/cure-${i}`,
        }))
        return { productId: 'gid://shopify/Product/906', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const keys = (inputs[0] as any).metafields.map((m: { key: string }) => m.key)
    expect(keys).not.toContain('highlights')
    expect(keys).not.toContain('specs')
    expect(keys).not.toContain('whats_in_box')
    expect(alert).toHaveBeenCalledWith(
      'warning', 'listing_content_claims_blocked', expect.objectContaining({ terms: ['cure '] }),
    )
  })

  it('27. whatsInBox with an embedded newline is normalized to one line (single_line_text_field must not fail the create)', async () => {
    const payload = newListingPayload()
    payload.whatsInBox = '1x rope toy\n1x care card'
    const row = await seedProposal({ status: 'approved', payload })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/nl-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/nl-${i}`,
        }))
        return { productId: 'gid://shopify/Product/904', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const whatsInBox = (inputs[0] as any).metafields.find((m: { key: string }) => m.key === 'whats_in_box')
    expect(whatsInBox.value).toBe('1x rope toy 1x care card')
  })

  it('27b. whitespace-only whatsInBox degrades (no whats_in_box metafield) instead of dead-lettering the create with a blank single_line_text_field', async () => {
    const payload = newListingPayload()
    payload.whatsInBox = '   '
    const row = await seedProposal({ status: 'approved', payload })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/blank-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/blank-${i}`,
        }))
        return { productId: 'gid://shopify/Product/907', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const keys = (inputs[0] as any).metafields.map((m: { key: string }) => m.key)
    expect(keys).not.toContain('whats_in_box')
    // sibling v2 metafields are unaffected — only whats_in_box degrades
    expect(keys).toEqual(expect.arrayContaining(['highlights', 'specs']))
  })

  it('28. legacy payload (no v2 fields): applies clean with only the original three metafields', async () => {
    const payload = newListingPayload() as Record<string, unknown>
    delete payload.highlights
    delete payload.specs
    delete payload.whatsInBox
    delete (payload.variants as Record<string, unknown>[])[0]!.imageUrl
    const row = await seedProposal({ status: 'approved', payload })
    const inputs: Record<string, unknown>[] = []
    const shopify = fakeShopify({
      productSet: async (input) => {
        inputs.push(input as Record<string, unknown>)
        const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
          id: `gid://shopify/ProductVariant/legacy-${i}`, sku: v.sku, inventoryItemId: `gid://shopify/InventoryItem/legacy-${i}`,
        }))
        return { productId: 'gid://shopify/Product/905', variants }
      },
    })
    const alert = vi.fn(async () => {})
    const adapter = fakeAdapter()

    await executeApplyProposal({ db, alert, shopify, adapter, ...baseDeps() }, row.id)

    const productRow = await loadProduct(row.id)
    createdProductIds.push(productRow!.id)
    expect((await loadProposal(row.id))!.status).toBe('applied')

    const create = inputs[0] as any
    const keys = create.metafields.map((m: { key: string }) => m.key)
    expect(keys).not.toContain('highlights')
    expect(keys).not.toContain('specs')
    expect(keys).not.toContain('whats_in_box')
    expect(create.variants[0].file).toBeUndefined()
  })
})
