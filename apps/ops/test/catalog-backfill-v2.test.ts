import { SupplierReviewsSchema } from '@doge-buddy/core'
import { createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { SupplierAdapter, SupplierProductDetail, SupplierProductReview } from '@doge-buddy/supplier'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { backfillProductPageV2, type BackfillV2Deps, type BackfillV2Ops } from '../src/catalog/backfill-v2.ts'
import { METAFIELD_DEFINITIONS } from '../src/seed/sample-data.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

/**
 * Every row this file creates carries this prefix in its natural keys (product gid, variant sku,
 * supplier ids), so a crashed run's leftovers are identifiable and the `afterEach` below deletes
 * exactly what it made — the same cleanup-by-prefix discipline `catalog-backfill.test.ts` uses.
 */
const PREFIX = 'backfill-v2-test'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${PREFIX}-${Date.now()}-${uidCounter}`
}

const NOW = new Date('2026-09-02T09:15:00.000Z')

/** All seven live `dogebuddy` metafield definitions — passed as `existingDefinitions` in every
 * test except the definitions-ensure one itself, so the definitions step is a silent no-op and
 * every other test's assertions are about the product loop, not this step. */
const ALL_DOGEBUDDY_DEFS = METAFIELD_DEFINITIONS.map((d) => ({ namespace: d.namespace, key: d.key }))
const ORIGINAL_THREE_DEFS = ALL_DOGEBUDDY_DEFS.filter((d) =>
  ['ships_from', 'delivery_min_days', 'delivery_max_days'].includes(d.key),
)

interface ScriptedProductV2 {
  mediaState: { mediaIds: string[]; variants: { id: string; sku?: string; mediaId: string | null }[] }
  /** One entry per expected `productAppendMedia` call, consumed in order. */
  appendMediaResponses?: { id: string; status: string }[][]
  variantAppendMediaError?: Error
}

/**
 * `BackfillV2Ops` over a per-product-gid script, recording every call.
 *
 * An UNSCRIPTED product gid THROWS rather than answering a default — this suite runs the real
 * whole-catalog pass against the shared dev database, which holds live rows this file did not
 * seed. A throw at the very first op/adapter call for those rows means they never reach any op
 * this file didn't explicitly script, so a test run can never touch real product data.
 */
function fakeOpsV2(opts: {
  existingDefinitions?: { namespace: string; key: string }[]
  products?: Record<string, ScriptedProductV2>
  mediaStatusQueues?: Record<string, string[]>
  mediaDeleteError?: Error
}) {
  const calls = {
    listDefinitionsCalls: 0,
    definitionCreates: [] as { name: string; namespace: string; key: string; type: string; ownerType: string }[],
    productMediaState: [] as string[],
    appendMedia: [] as { productGid: string; media: { originalSource: string; alt?: string }[]; knownMediaIds: string[] }[],
    mediaImageStatus: [] as string[],
    variantAppendMedia: [] as { productGid: string; variantMedia: { variantId: string; mediaIds: string[] }[] }[],
    mediaDelete: [] as string[][],
    metafieldsSet: [] as { ownerId: string; namespace: string; key: string; type: string; value: string }[][],
  }
  const productScript = opts.products ?? {}
  const scripted = (productGid: string): ScriptedProductV2 => {
    const entry = productScript[productGid]
    if (!entry) throw new Error(`fakeOpsV2: unscripted product ${productGid}`)
    return entry
  }
  const statusQueues = opts.mediaStatusQueues ?? {}

  const ops: BackfillV2Ops = {
    listMetafieldDefinitions: async () => {
      calls.listDefinitionsCalls += 1
      return opts.existingDefinitions ?? []
    },
    metafieldDefinitionCreate: async (def) => {
      calls.definitionCreates.push(def)
    },
    productMediaState: async (productGid) => {
      const entry = scripted(productGid)
      calls.productMediaState.push(productGid)
      return entry.mediaState
    },
    productAppendMedia: async (productGid, media, knownMediaIds) => {
      const entry = scripted(productGid)
      calls.appendMedia.push({ productGid, media, knownMediaIds: [...knownMediaIds] })
      const responses = entry.appendMediaResponses
      if (!responses || responses.length === 0) {
        throw new Error(`fakeOpsV2: product ${productGid} has no more appendMedia responses scripted`)
      }
      return responses.shift()!
    },
    mediaImageStatus: async (mediaGid) => {
      calls.mediaImageStatus.push(mediaGid)
      const queue = statusQueues[mediaGid]
      if (!queue || queue.length === 0) throw new Error(`fakeOpsV2: unscripted mediaImageStatus ${mediaGid}`)
      return queue.shift()!
    },
    productVariantAppendMedia: async (productGid, variantMedia) => {
      const entry = scripted(productGid)
      calls.variantAppendMedia.push({ productGid, variantMedia })
      if (entry.variantAppendMediaError) throw entry.variantAppendMediaError
    },
    mediaDelete: async (mediaIds) => {
      calls.mediaDelete.push(mediaIds)
      if (opts.mediaDeleteError) throw opts.mediaDeleteError
    },
    metafieldsSet: async (metafields) => {
      calls.metafieldsSet.push(metafields)
    },
  }
  return { ops, calls }
}

interface ScriptedAdapterProduct {
  detail: SupplierProductDetail
  reviews: SupplierProductReview[] | Error
  getProductError?: Error
}

/** `getProduct`/`getProductReviews` over a per-supplier-product-id script — same
 * unscripted-throws contract as `fakeOpsV2`, for the same reason. */
function fakeAdapterV2(script: Record<string, ScriptedAdapterProduct>): Pick<SupplierAdapter, 'getProduct' | 'getProductReviews'> {
  return {
    getProduct: async (pid: string) => {
      const entry = script[pid]
      if (!entry) throw new Error(`fakeAdapterV2: unscripted product ${pid}`)
      if (entry.getProductError) throw entry.getProductError
      return entry.detail
    },
    getProductReviews: async (pid: string) => {
      const entry = script[pid]
      if (!entry) throw new Error(`fakeAdapterV2: unscripted product ${pid}`)
      if (entry.reviews instanceof Error) throw entry.reviews
      return entry.reviews
    },
  }
}

function throwOnAnyCallOps(): BackfillV2Ops {
  const fail = (name: string): never => {
    throw new Error(`unexpected ops call under dry-run: ${name}`)
  }
  return {
    productMediaState: async () => fail('productMediaState'),
    productAppendMedia: async () => fail('productAppendMedia'),
    mediaImageStatus: async () => fail('mediaImageStatus'),
    productVariantAppendMedia: async () => fail('productVariantAppendMedia'),
    mediaDelete: async () => fail('mediaDelete'),
    metafieldsSet: async () => fail('metafieldsSet'),
    listMetafieldDefinitions: async () => fail('listMetafieldDefinitions'),
    metafieldDefinitionCreate: async () => fail('metafieldDefinitionCreate'),
  }
}

function throwOnAnyCallAdapter(): Pick<SupplierAdapter, 'getProduct' | 'getProductReviews'> {
  return {
    getProduct: async () => {
      throw new Error('unexpected adapter call under dry-run: getProduct')
    },
    getProductReviews: async () => {
      throw new Error('unexpected adapter call under dry-run: getProductReviews')
    },
  }
}

function detailFor(supplierProductId: string, variants: { supplierVariantId: string; imageUrl?: string }[]): SupplierProductDetail {
  return {
    supplierProductId,
    title: 'CJ Product',
    imageUrls: [],
    variants: variants.map((v) => ({ supplierVariantId: v.supplierVariantId, priceCents: 999, imageUrl: v.imageUrl })),
  }
}

function cleanReviews(n: number): SupplierProductReview[] {
  return Array.from({ length: n }, (_, i) => ({ rating: 5, content: `Great product number ${i}.`, reviewDate: '2026-08-20' }))
}

describe('backfillProductPageV2', () => {
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

  async function seedProduct(opts: { title?: string | null } = {}) {
    const productGid = `gid://shopify/Product/${uid()}`
    const title = opts.title === undefined ? 'Doge Snuffle Mat' : opts.title
    const handle = `handle-${uid()}`
    const [product] = await db
      .insert(products)
      .values({ shopifyProductGid: productGid, handle, title, status: 'active' })
      .returning({ id: products.id })
    createdProductIds.push(product!.id)
    return { productId: product!.id, productGid, title, handle }
  }

  async function addVariant(productId: string, opts: { supplierProductId: string }) {
    const sku = `${PREFIX}-sku-${uid()}`
    const variantGid = `gid://shopify/ProductVariant/${uid()}`
    const [variant] = await db
      .insert(productVariants)
      .values({ productId, shopifyVariantGid: variantGid, sku, priceCents: 1999, supplierCostCents: 620 })
      .returning({ id: productVariants.id })
    createdVariantIds.push(variant!.id)

    const supplierVariantId = `${PREFIX}-cjv-${uid()}`
    await db.insert(supplierVariantMappings).values({
      variantId: variant!.id,
      supplier: 'cj',
      supplierProductId: opts.supplierProductId,
      supplierVariantId,
    })
    return { variantId: variant!.id, variantGid, sku, supplierVariantId }
  }

  function makeDeps(ops: BackfillV2Ops, adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews'>) {
    const logs: string[] = []
    const alerts: { severity: string; kind: string; detail: Record<string, unknown> }[] = []
    const deps: BackfillV2Deps = {
      db,
      ops,
      adapter,
      alert: async (severity, kind, detail) => {
        alerts.push({ severity, kind, detail })
      },
      log: (line: string) => logs.push(line),
      now: () => NOW,
      sleep: async () => {},
    }
    return { deps, logs, alerts }
  }

  it('ensures the four v2 metafield definitions exist before touching any product', async () => {
    const { ops, calls } = fakeOpsV2({ existingDefinitions: ORIGINAL_THREE_DEFS })
    const { deps } = makeDeps(ops, fakeAdapterV2({}))

    await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.definitionCreates.map((d) => d.key).sort()).toEqual(['highlights', 'specs', 'supplier_reviews', 'whats_in_box'].sort())
    const byKey = new Map(calls.definitionCreates.map((d) => [d.key, d]))
    expect(byKey.get('highlights')!.type).toBe('json')
    expect(byKey.get('specs')!.type).toBe('json')
    expect(byKey.get('supplier_reviews')!.type).toBe('json')
    expect(byKey.get('whats_in_box')!.type).toBe('single_line_text_field')

    const { ops: ops2, calls: calls2 } = fakeOpsV2({ existingDefinitions: ALL_DOGEBUDDY_DEFS })
    const { deps: deps2 } = makeDeps(ops2, fakeAdapterV2({}))
    await backfillProductPageV2(deps2, { dryRun: false })
    expect(calls2.definitionCreates).toEqual([])
  })

  it('adds media + appends to a variant that has a CJ image and no Shopify media', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId, status: 'UPLOADED' }]],
        },
      },
      mediaStatusQueues: { [mediaId]: ['READY'] },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: [],
      },
    })
    const { deps } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.appendMedia).toHaveLength(1)
    expect(calls.appendMedia[0]!.media).toEqual([{ originalSource: 'https://cj/x.jpg', alt: seeded.title }])
    expect(calls.variantAppendMedia).toContainEqual({
      productGid: seeded.productGid,
      variantMedia: [{ variantId: variant.variantGid, mediaIds: [mediaId] }],
    })
    expect(result.variantImagesAdded).toBe(1)
  })

  it('variants sharing one CJ image URL get ONE created media, appended to all of them', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const v1 = await addVariant(seeded.productId, { supplierProductId })
    const v2 = await addVariant(seeded.productId, { supplierProductId })
    const v3 = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`
    const sharedUrl = 'https://cj/shared.jpg'

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: {
            mediaIds: [],
            variants: [
              { id: v1.variantGid, mediaId: null },
              { id: v2.variantGid, mediaId: null },
              { id: v3.variantGid, mediaId: null },
            ],
          },
          appendMediaResponses: [[{ id: mediaId, status: 'READY' }]],
        },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [
          { supplierVariantId: v1.supplierVariantId, imageUrl: sharedUrl },
          { supplierVariantId: v2.supplierVariantId, imageUrl: sharedUrl },
          { supplierVariantId: v3.supplierVariantId, imageUrl: sharedUrl },
        ]),
        reviews: [],
      },
    })
    const { deps } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.appendMedia).toHaveLength(1)
    expect(calls.variantAppendMedia).toHaveLength(1)
    const variantMedia = calls.variantAppendMedia[0]!.variantMedia
    expect(variantMedia.map((vm) => vm.variantId).sort()).toEqual([v1.variantGid, v2.variantGid, v3.variantGid].sort())
    for (const vm of variantMedia) expect(vm.mediaIds).toEqual([mediaId])
    expect(result.variantImagesAdded).toBe(3)
  })

  it('SKIPS a variant that already has Shopify media (idempotency)', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const existingMediaId = `gid://shopify/MediaImage/${uid()}`

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [existingMediaId], variants: [{ id: variant.variantGid, mediaId: existingMediaId }] },
        },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: [],
      },
    })
    const { deps } = makeDeps(ops, adapter)

    const result1 = await backfillProductPageV2(deps, { dryRun: false })
    expect(calls.appendMedia).toEqual([])
    expect(result1.variantImagesAdded).toBe(0)

    // Rerunning is a no-op: same script, still zero append calls.
    const result2 = await backfillProductPageV2(deps, { dryRun: false })
    expect(calls.appendMedia).toEqual([])
    expect(result2.variantImagesAdded).toBe(0)
  })

  it('skips a variant CJ shows no image for', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: { mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] } },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId }]), // no imageUrl
        reviews: [],
      },
    })
    const { deps } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.appendMedia).toEqual([])
    expect(result.variantImagesAdded).toBe(0)
  })

  it('polls until READY and gives up on FAILED: created media DELETED, warning alert, no append', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId, status: 'UPLOADED' }]],
        },
      },
      mediaStatusQueues: { [mediaId]: ['PROCESSING', 'FAILED'] },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: [],
      },
    })
    const { deps, alerts } = makeDeps(ops, adapter)

    await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.mediaDelete).toContainEqual([mediaId])
    expect(alerts.some((a) => a.severity === 'warning' && a.kind === 'backfill_media_not_ready')).toBe(true)
    expect(calls.variantAppendMedia).toEqual([])
  })

  it('append throws after a successful create: created media deleted, failure recorded, a rerun creates exactly one', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: [],
      },
    })

    const { ops: ops1, calls: calls1 } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId, status: 'READY' }]],
          variantAppendMediaError: new Error('Shopify 500'),
        },
      },
    })
    const { deps: deps1 } = makeDeps(ops1, adapter)

    const result1 = await backfillProductPageV2(deps1, { dryRun: false })
    expect(calls1.mediaDelete).toContainEqual([mediaId])
    expect(result1.failures.some((f) => f.includes(seeded.productId))).toBe(true)

    // Fresh scripted ops for the rerun — the variant is still without media (nothing was ever
    // appended), so exactly one new create+append happens.
    const mediaId2 = `gid://shopify/MediaImage/${uid()}`
    const { ops: ops2, calls: calls2 } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId2, status: 'READY' }]],
        },
      },
    })
    const { deps: deps2 } = makeDeps(ops2, adapter)

    const result2 = await backfillProductPageV2(deps2, { dryRun: false })
    expect(calls2.appendMedia).toHaveLength(1)
    expect(calls2.variantAppendMedia).toHaveLength(1)
    expect(result2.variantImagesAdded).toBe(1)
  })

  it('deletes cascading: when the delete itself fails, alerts backfill_media_orphaned too', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId, status: 'UPLOADED' }]],
        },
      },
      mediaStatusQueues: { [mediaId]: ['FAILED'] },
      mediaDeleteError: new Error('delete also failed'),
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: [],
      },
    })
    const { deps, alerts } = makeDeps(ops, adapter)

    await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.mediaDelete).toContainEqual([mediaId])
    expect(alerts.some((a) => a.severity === 'warning' && a.kind === 'backfill_media_orphaned')).toBe(true)
    expect(alerts.some((a) => a.severity === 'warning' && a.kind === 'backfill_media_not_ready')).toBe(true)
  })

  it('writes the supplier_reviews metafield from a fresh fetch', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: { mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] } },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: { detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId }]), reviews: cleanReviews(2) },
    })
    const { deps } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(calls.metafieldsSet).toHaveLength(1)
    const [written] = calls.metafieldsSet[0]!
    expect(written!.ownerId).toBe(seeded.productGid)
    expect(written!.key).toBe('supplier_reviews')
    expect(written!.type).toBe('json')
    expect(() => SupplierReviewsSchema.parse(JSON.parse(written!.value))).not.toThrow()
    expect(result.reviewsWritten).toBe(1)
  })

  it('zero usable reviews -> info alert listing_reviews_unavailable, no metafieldsSet', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: { mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] } },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: { detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId }]), reviews: [] },
    })
    const { deps, alerts } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(alerts.some((a) => a.severity === 'info' && a.kind === 'listing_reviews_unavailable')).toBe(true)
    expect(calls.metafieldsSet).toEqual([])
    expect(result.reviewsWritten).toBe(0)
  })

  it('does NOT touch highlights/specs metafields (no agent ran for live products — spec §A5)', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    const variant = await addVariant(seeded.productId, { supplierProductId })
    const mediaId = `gid://shopify/MediaImage/${uid()}`

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [seeded.productGid]: {
          mediaState: { mediaIds: [], variants: [{ id: variant.variantGid, mediaId: null }] },
          appendMediaResponses: [[{ id: mediaId, status: 'READY' }]],
        },
      },
    })
    const adapter = fakeAdapterV2({
      [supplierProductId]: {
        detail: detailFor(supplierProductId, [{ supplierVariantId: variant.supplierVariantId, imageUrl: 'https://cj/x.jpg' }]),
        reviews: cleanReviews(2),
      },
    })
    const { deps } = makeDeps(ops, adapter)

    await backfillProductPageV2(deps, { dryRun: false })

    const keys = new Set(calls.metafieldsSet.flat().map((m) => m.key))
    expect(keys).toEqual(new Set(['supplier_reviews']))
  })

  it('dry-run: reports the plan from LOCAL DB state only — zero ops calls AND zero adapter calls', async () => {
    const seeded = await seedProduct()
    const supplierProductId = `${PREFIX}-cjp-${uid()}`
    await addVariant(seeded.productId, { supplierProductId })

    const { deps, logs } = makeDeps(throwOnAnyCallOps(), throwOnAnyCallAdapter())

    const result = await backfillProductPageV2(deps, { dryRun: true })

    expect(result.products).toBeGreaterThanOrEqual(1)
    expect(logs.some((l) => l.includes(seeded.handle) && l.includes('1 mapped variant'))).toBe(true)
  })

  it('failure containment: a product whose CJ detail read throws lands in failures, the next product still processes', async () => {
    const bad = await seedProduct({ title: 'Broken Product' })
    const badPid = `${PREFIX}-cjp-${uid()}`
    await addVariant(bad.productId, { supplierProductId: badPid })

    const good = await seedProduct({ title: 'Good Product' })
    const goodPid = `${PREFIX}-cjp-${uid()}`
    const goodVariant = await addVariant(good.productId, { supplierProductId: goodPid })

    const { ops, calls } = fakeOpsV2({
      existingDefinitions: ALL_DOGEBUDDY_DEFS,
      products: {
        [good.productGid]: { mediaState: { mediaIds: [], variants: [{ id: goodVariant.variantGid, mediaId: null }] } },
      },
    })
    const adapter = fakeAdapterV2({
      [goodPid]: { detail: detailFor(goodPid, [{ supplierVariantId: goodVariant.supplierVariantId }]), reviews: cleanReviews(1) },
    })
    const { deps } = makeDeps(ops, adapter)

    const result = await backfillProductPageV2(deps, { dryRun: false })

    expect(result.failures.some((f) => f.includes(bad.productId))).toBe(true)
    expect(calls.metafieldsSet.some((m) => m.some((mf) => mf.ownerId === good.productGid))).toBe(true)
  })
})
