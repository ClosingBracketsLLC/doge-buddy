import { categoryTagValue, slugify } from '@doge-buddy/core'
import { createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { WarehouseStock } from '@doge-buddy/supplier'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { backfillListings, type BackfillOps } from '../src/catalog/backfill.ts'
import { proposalHandle } from '../src/proposals/apply-shared.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

/**
 * Every row this file creates carries this prefix in its natural keys (product gid, variant sku,
 * supplier ids), so a crashed run's leftovers are identifiable and the `afterEach` below deletes
 * exactly what it made — the cleanup-by-prefix discipline the other DB-backed job tests use.
 */
const PREFIX = 'backfill-test'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${PREFIX}-${Date.now()}-${uidCounter}`
}

const LOCATION_ID = 'gid://shopify/Location/backfill-test'
const NOW = new Date('2026-09-02T09:15:00.000Z')
const NOW_EPOCH_SECONDS = Math.floor(NOW.getTime() / 1000)

/** Two US warehouses plus a CN one — the LARGEST SINGLE US entry is the sellable quantity, never
 * the sum and never CN's. Same fixture shape as the listing/sync tests. */
function stock(quantity: number): WarehouseStock[] {
  return [
    { countryCode: 'US', quantity, verified: true },
    { countryCode: 'US', quantity: Math.max(0, quantity - 1), verified: true },
    { countryCode: 'CN', quantity: 99, verified: true },
  ]
}

interface ScriptedProduct {
  descriptionHtml: string
  variants: { id: string; sku?: string; inventoryItemId: string }[]
  /** When set, `productUpdate` rejects with it — the (d) failure-containment case. */
  productUpdateError?: Error
}

/**
 * `BackfillOps` over a per-product-gid script, recording every call.
 *
 * An UNSCRIPTED product gid THROWS rather than answering a default. This suite runs the real
 * whole-catalog backfill against the shared dev database, which holds rows this file did not seed
 * (the live `Dog Snuff Pad` among them) — a throw on the very first op means that product's local
 * rows are never written, so a test run can never rewrite a real product's handle.
 */
function fakeOps(script: Record<string, ScriptedProduct>) {
  const calls = {
    descriptionHtml: [] as string[],
    productUpdate: [] as Parameters<BackfillOps['productUpdate']>[0][],
    variantsFor: [] as string[],
    inventoryItemUpdate: [] as { inventoryItemId: string; input: { tracked: boolean } }[],
    setQuantities: [] as { input: Record<string, unknown>; key: string }[],
    locationCalls: 0,
  }
  const scripted = (productGid: string): ScriptedProduct => {
    const entry = script[productGid]
    if (!entry) throw new Error(`fakeOps: unscripted product ${productGid}`)
    return entry
  }
  const ops: BackfillOps = {
    productDescriptionHtml: async (productGid) => {
      const entry = scripted(productGid)
      calls.descriptionHtml.push(productGid)
      return entry.descriptionHtml
    },
    productUpdate: async (input) => {
      const entry = scripted(input.id)
      if (entry.productUpdateError) throw entry.productUpdateError
      calls.productUpdate.push(input)
    },
    productVariantsByProductId: async (productGid) => {
      const entry = scripted(productGid)
      calls.variantsFor.push(productGid)
      return entry.variants
    },
    inventoryItemUpdate: async (inventoryItemId, input) => {
      calls.inventoryItemUpdate.push({ inventoryItemId, input })
    },
    primaryLocationId: async () => {
      calls.locationCalls += 1
      return LOCATION_ID
    },
    inventorySetQuantities: async (input, key) => {
      calls.setQuantities.push({ input, key })
    },
  }
  return { ops, calls }
}

/** `getVariantStock` over a per-supplier-variant-id script: a number answers with that US
 * quantity, an Error rejects with it, an unscripted id throws (see `fakeOps`'s reasoning). */
function fakeAdapter(script: Record<string, number | Error>) {
  const reads: string[] = []
  return {
    reads,
    getVariantStock: async (supplierVariantId: string): Promise<WarehouseStock[]> => {
      reads.push(supplierVariantId)
      const answer = script[supplierVariantId]
      if (answer === undefined) throw new Error(`fakeAdapter: unscripted supplier variant ${supplierVariantId}`)
      if (answer instanceof Error) throw answer
      return stock(answer)
    },
  }
}

describe('backfillListings', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProductIds: string[] = []
  let createdVariantIds: string[] = []

  afterEach(async () => {
    if (createdVariantIds.length > 0) {
      await db.delete(supplierVariantMappings).where(inArray(supplierVariantMappings.variantId, createdVariantIds))
      await db.delete(productVariants).where(inArray(productVariants.id, createdVariantIds))
    }
    if (createdProductIds.length > 0) {
      await db.delete(products).where(inArray(products.id, createdProductIds))
    }
    createdVariantIds = []
    createdProductIds = []
  })

  interface SeedOpts {
    categoryTag?: string | null
    createdFromProposalId?: string | null
    title?: string | null
    /** Seeded local variant state — both gids null is the old-scheme shape the backfill repairs. */
    variantGid?: string | null
    inventoryItemGid?: string | null
    withMapping?: boolean
    lastKnownStock?: number | null
    stockCheckedAt?: Date | null
  }

  /** One OLD-SCHEME product: `db-proposal-<uuid>` handle, no tags/type/seo on Shopify, an untracked
   * variant carrying neither gid locally — exactly what the two live products look like. */
  async function seedProduct(opts: SeedOpts = {}) {
    const productGid = `gid://shopify/Product/${uid()}`
    const proposalId = opts.createdFromProposalId === undefined ? crypto.randomUUID() : opts.createdFromProposalId
    const title = opts.title === undefined ? 'Doge Snuffle Mat' : opts.title
    const [product] = await db
      .insert(products)
      .values({
        shopifyProductGid: productGid,
        handle: `db-proposal-${proposalId ?? crypto.randomUUID()}`,
        title,
        status: 'active',
        categoryTag: opts.categoryTag === undefined ? 'toys' : opts.categoryTag,
        createdFromProposalId: proposalId,
      })
      .returning({ id: products.id, handle: products.handle })
    createdProductIds.push(product!.id)

    const sku = `${PREFIX}-sku-${uid()}`
    const [variant] = await db
      .insert(productVariants)
      .values({
        productId: product!.id,
        shopifyVariantGid: opts.variantGid === undefined ? null : opts.variantGid,
        shopifyInventoryItemGid: opts.inventoryItemGid === undefined ? null : opts.inventoryItemGid,
        sku,
        priceCents: 1999,
        supplierCostCents: 620,
      })
      .returning({ id: productVariants.id })
    createdVariantIds.push(variant!.id)

    const supplierVariantId = `${PREFIX}-cjv-${uid()}`
    if (opts.withMapping !== false) {
      await db.insert(supplierVariantMappings).values({
        variantId: variant!.id,
        supplier: 'cj',
        supplierProductId: `${PREFIX}-cjp`,
        supplierVariantId,
        lastKnownStock: opts.lastKnownStock ?? null,
        stockCheckedAt: opts.stockCheckedAt ?? null,
      })
    }
    return {
      productId: product!.id,
      productGid,
      proposalId,
      title,
      oldHandle: product!.handle!,
      variantId: variant!.id,
      sku,
      supplierVariantId,
    }
  }

  function deps(ops: BackfillOps, adapter: { getVariantStock: (id: string) => Promise<WarehouseStock[]> }) {
    const logs: string[] = []
    const alerts: { severity: string; kind: string; detail: Record<string, unknown> }[] = []
    return {
      logs,
      alerts,
      deps: {
        db,
        ops,
        adapter,
        alert: async (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => {
          alerts.push({ severity, kind, detail })
        },
        log: (line: string) => logs.push(line),
        now: () => NOW,
      },
    }
  }

  it('(a) sends one productUpdate with the new handle/tags/productType/seo and rewrites the local handle', async () => {
    const seeded = await seedProduct()
    const { ops, calls } = fakeOps({
      [seeded.productGid]: {
        descriptionHtml: '<p>A <b>snuffle</b> mat  for   slow feeding.</p>',
        variants: [{ id: 'gid://shopify/ProductVariant/1', sku: seeded.sku, inventoryItemId: 'gid://shopify/InventoryItem/1' }],
      },
    })
    const adapter = fakeAdapter({ [seeded.supplierVariantId]: 4 })
    const { deps: d, logs } = deps(ops, adapter)

    const result = await backfillListings(d, { dryRun: false })

    const expectedHandle = proposalHandle(seeded.proposalId!, seeded.title!)
    expect(calls.productUpdate).toEqual([
      {
        id: seeded.productGid,
        handle: expectedHandle,
        tags: [categoryTagValue('toys')],
        productType: 'Dog Toys',
        seo: { title: seeded.title, description: 'A snuffle mat for slow feeding.' },
      },
    ])
    const [row] = await db.select().from(products).where(eq(products.id, seeded.productId))
    expect(row!.handle).toBe(expectedHandle)
    expect(result.updated).toBeGreaterThanOrEqual(1)
    expect(result.failures.filter((f) => f.includes(seeded.productId))).toEqual([])
    expect(logs.some((l) => l.includes(`${seeded.oldHandle} → ${expectedHandle}`))).toBe(true)
  })

  it('(a) falls back to slugify(title)-<8 of the product id> when createdFromProposalId is null', async () => {
    const seeded = await seedProduct({ createdFromProposalId: null, title: 'Calming Donut Bed' })
    const { ops, calls } = fakeOps({
      [seeded.productGid]: { descriptionHtml: '<p>Bed.</p>', variants: [] },
    })
    const { deps: d } = deps(ops, fakeAdapter({}))

    await backfillListings(d, { dryRun: false })

    const expectedHandle = `${slugify('Calming Donut Bed')}-${seeded.productId.slice(0, 8)}`
    expect(calls.productUpdate.find((c) => c.id === seeded.productGid)?.handle).toBe(expectedHandle)
    const [row] = await db.select().from(products).where(eq(products.id, seeded.productId))
    expect(row!.handle).toBe(expectedHandle)
  })

  it('(b) persists both variant gids, tracks the inventory item and pushes the US quantity', async () => {
    const seeded = await seedProduct()
    const { ops, calls } = fakeOps({
      [seeded.productGid]: {
        descriptionHtml: '<p>Mat.</p>',
        variants: [{ id: 'gid://shopify/ProductVariant/77', sku: seeded.sku, inventoryItemId: 'gid://shopify/InventoryItem/77' }],
      },
    })
    const adapter = fakeAdapter({ [seeded.supplierVariantId]: 4 })
    const { deps: d } = deps(ops, adapter)

    await backfillListings(d, { dryRun: false })

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, seeded.variantId))
    expect(variant!.shopifyVariantGid).toBe('gid://shopify/ProductVariant/77')
    expect(variant!.shopifyInventoryItemGid).toBe('gid://shopify/InventoryItem/77')

    expect(calls.inventoryItemUpdate).toContainEqual({
      inventoryItemId: 'gid://shopify/InventoryItem/77',
      input: { tracked: true },
    })
    expect(adapter.reads).toContain(seeded.supplierVariantId)
    const push = calls.setQuantities.find((c) => c.key.includes(seeded.variantId))
    expect(push).toBeDefined()
    expect(push!.input).toEqual({
      name: 'available',
      reason: 'correction',
      quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/77', locationId: LOCATION_ID, quantity: 4 }],
    })
    expect(push!.key).toBe(`bf-${seeded.variantId}-4-${NOW_EPOCH_SECONDS}`)

    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, seeded.variantId))
    expect(mapping!.lastKnownStock).toBe(4)
    expect(mapping!.stockCheckedAt).toEqual(NOW)
  })

  it('(b) pushes 0 but keeps the cached stock when the CJ read fails', async () => {
    const checkedAt = new Date('2026-08-20T00:00:00.000Z')
    const seeded = await seedProduct({ lastKnownStock: 7, stockCheckedAt: checkedAt })
    const { ops, calls } = fakeOps({
      [seeded.productGid]: {
        descriptionHtml: '<p>Mat.</p>',
        variants: [{ id: 'gid://shopify/ProductVariant/78', sku: seeded.sku, inventoryItemId: 'gid://shopify/InventoryItem/78' }],
      },
    })
    const adapter = fakeAdapter({ [seeded.supplierVariantId]: new Error('CJ 503') })
    const { deps: d, alerts } = deps(ops, adapter)

    await backfillListings(d, { dryRun: false })

    const push = calls.setQuantities.find((c) => c.key.includes(seeded.variantId))
    expect((push!.input.quantities as { quantity: number }[])[0]!.quantity).toBe(0)
    const [mapping] = await db
      .select()
      .from(supplierVariantMappings)
      .where(eq(supplierVariantMappings.variantId, seeded.variantId))
    expect(mapping!.lastKnownStock).toBe(7)
    expect(mapping!.stockCheckedAt).toEqual(checkedAt)
    expect(alerts.some((a) => a.kind === 'listing_stock_read_failed')).toBe(true)
  })

  it('(c) --dry-run makes no ops calls, writes nothing, and prints the plan', async () => {
    const seeded = await seedProduct()
    const { ops, calls } = fakeOps({})
    const adapter = fakeAdapter({})
    const { deps: d, logs } = deps(ops, adapter)

    const result = await backfillListings(d, { dryRun: true })

    expect(calls.productUpdate).toEqual([])
    expect(calls.descriptionHtml).toEqual([])
    expect(calls.variantsFor).toEqual([])
    expect(calls.inventoryItemUpdate).toEqual([])
    expect(calls.setQuantities).toEqual([])
    expect(calls.locationCalls).toBe(0)
    expect(adapter.reads).toEqual([])
    expect(result.failures).toEqual([])

    const [row] = await db.select().from(products).where(eq(products.id, seeded.productId))
    expect(row!.handle).toBe(seeded.oldHandle)
    const expectedHandle = proposalHandle(seeded.proposalId!, seeded.title!)
    expect(logs.some((l) => l.includes(`${seeded.oldHandle} → ${expectedHandle}`))).toBe(true)
  })

  it('(d) records a failing product and carries on with the next one', async () => {
    const bad = await seedProduct({ title: 'Broken Product' })
    const good = await seedProduct({ title: 'Good Product' })
    const { ops, calls } = fakeOps({
      [bad.productGid]: { descriptionHtml: '<p>x</p>', variants: [], productUpdateError: new Error('Handle already in use') },
      [good.productGid]: {
        descriptionHtml: '<p>y</p>',
        variants: [{ id: 'gid://shopify/ProductVariant/9', sku: good.sku, inventoryItemId: 'gid://shopify/InventoryItem/9' }],
      },
    })
    const { deps: d } = deps(ops, fakeAdapter({ [good.supplierVariantId]: 2 }))

    const result = await backfillListings(d, { dryRun: false })

    expect(result.failures.some((f) => f.includes(bad.productId) && f.includes('Handle already in use'))).toBe(true)
    const [badRow] = await db.select().from(products).where(eq(products.id, bad.productId))
    expect(badRow!.handle).toBe(bad.oldHandle)
    expect(calls.productUpdate.some((c) => c.id === good.productGid)).toBe(true)
    const [goodRow] = await db.select().from(products).where(eq(products.id, good.productId))
    expect(goodRow!.handle).toBe(proposalHandle(good.proposalId!, 'Good Product'))
  })

  it('(b) leaves an already-populated variant gid alone (coalesce-backfill, not overwrite)', async () => {
    const seeded = await seedProduct({
      variantGid: 'gid://shopify/ProductVariant/old',
      inventoryItemGid: 'gid://shopify/InventoryItem/old',
    })
    const { ops, calls } = fakeOps({
      [seeded.productGid]: {
        descriptionHtml: '<p>Mat.</p>',
        variants: [{ id: 'gid://shopify/ProductVariant/new', sku: seeded.sku, inventoryItemId: 'gid://shopify/InventoryItem/new' }],
      },
    })
    const { deps: d } = deps(ops, fakeAdapter({ [seeded.supplierVariantId]: 1 }))

    await backfillListings(d, { dryRun: false })

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, seeded.variantId))
    expect(variant!.shopifyVariantGid).toBe('gid://shopify/ProductVariant/old')
    expect(variant!.shopifyInventoryItemGid).toBe('gid://shopify/InventoryItem/old')
    // The PUSH still addresses what Shopify says the inventory item is today.
    const push = calls.setQuantities.find((c) => c.key.includes(seeded.variantId))
    expect((push!.input.quantities as { inventoryItemId: string }[])[0]!.inventoryItemId).toBe('gid://shopify/InventoryItem/new')
  })

  it('skips a product with no title — a handle and an SEO title cannot be derived from nothing', async () => {
    const seeded = await seedProduct({ title: null })
    const { ops, calls } = fakeOps({})
    const { deps: d, logs } = deps(ops, fakeAdapter({}))

    const result = await backfillListings(d, { dryRun: false })

    expect(calls.productUpdate.some((c) => c.id === seeded.productGid)).toBe(false)
    expect(result.skipped).toBeGreaterThanOrEqual(1)
    expect(logs.some((l) => l.includes(seeded.productId) && l.includes('no title'))).toBe(true)
    const [row] = await db.select().from(products).where(eq(products.id, seeded.productId))
    expect(row!.handle).toBe(seeded.oldHandle)
  })

  it('skips a product with no category tag — logged, counted, never sent to Shopify', async () => {
    const seeded = await seedProduct({ categoryTag: null })
    const { ops, calls } = fakeOps({})
    const { deps: d, logs } = deps(ops, fakeAdapter({}))

    const result = await backfillListings(d, { dryRun: false })

    expect(calls.productUpdate.some((c) => c.id === seeded.productGid)).toBe(false)
    expect(result.skipped).toBeGreaterThanOrEqual(1)
    expect(logs.some((l) => l.includes(seeded.productId) && l.includes('no category tag'))).toBe(true)
    const [row] = await db.select().from(products).where(eq(products.id, seeded.productId))
    expect(row!.handle).toBe(seeded.oldHandle)
  })
})
