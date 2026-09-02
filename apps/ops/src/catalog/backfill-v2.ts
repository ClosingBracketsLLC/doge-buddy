import { type createDb, products, productVariants, supplierVariantMappings } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { buildSupplierReviews } from '../proposals/supplier-reviews.ts'
import { METAFIELD_DEFINITIONS, type MetafieldDefinition } from '../seed/sample-data.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/** The four v2 (product-page-v2) definitions, filtered out of the seed script's full literal
 * rather than re-typed — a live store already carries the original three (`ships_from`,
 * `delivery_min_days`, `delivery_max_days`) from launch, so only these four are new here. */
const V2_METAFIELD_KEYS = ['highlights', 'specs', 'supplier_reviews', 'whats_in_box'] as const
const V2_METAFIELD_DEFINITIONS: MetafieldDefinition[] = METAFIELD_DEFINITIONS.filter(
  (d) => d.namespace === 'dogebuddy' && (V2_METAFIELD_KEYS as readonly string[]).includes(d.key),
)

const MEDIA_READY_ATTEMPTS = 15
const MEDIA_POLL_MS = 2000

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The Shopify ops this pass needs, already bound to a client — same injectable-ops pattern as
 * `BackfillOps` (Task 8's five operations, live-verified against the 2026-07 Admin API, plus the
 * pre-existing definitions pair).
 */
export interface BackfillV2Ops {
  productMediaState(productGid: string): Promise<{ mediaIds: string[]; variants: { id: string; sku?: string; mediaId: string | null }[] }>
  productAppendMedia(
    productGid: string,
    media: { originalSource: string; alt?: string }[],
    knownMediaIds: string[],
  ): Promise<{ id: string; status: string }[]>
  mediaImageStatus(mediaGid: string): Promise<string>
  productVariantAppendMedia(productGid: string, variantMedia: { variantId: string; mediaIds: string[] }[]): Promise<void>
  mediaDelete(mediaIds: string[]): Promise<void>
  metafieldsSet(metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[]): Promise<void>
  /** Definitions-ensure (panel 2026-09-01): the Storefront API only serves metafields that have a
   * definition with storefront exposure — without these the live page silently renders none of the
   * new sections. This is the live store's only definitions path (re-running seed-store on live
   * would also create the SAMPLE_PRODUCTS). */
  listMetafieldDefinitions(): Promise<{ namespace: string; key: string }[]>
  metafieldDefinitionCreate(def: { name: string; namespace: string; key: string; type: string; ownerType: 'PRODUCT' }): Promise<void>
}

export interface BackfillV2Deps {
  db: Db
  ops: BackfillV2Ops
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews'>
  alert: Alert
  log: (line: string) => void
  now?: () => Date
  /** Injectable for tests; default is a real `setTimeout` wait between media-ready polls. */
  sleep?: (ms: number) => Promise<void>
}

export interface BackfillV2Result {
  /** Candidate products the run considered (ACTIVE, with a Shopify gid). */
  products: number
  /** Variant⟷media links added across every product this run. */
  variantImagesAdded: number
  /** `supplier_reviews` metafields written this run. */
  reviewsWritten: number
  /** One human-readable line per contained failure — a non-empty array is the script's exit-1 signal. */
  failures: string[]
}

/**
 * `backfill-listings` v2 pass (spec 2026-09-01 §A5): repair variant gallery images and refresh
 * `supplier_reviews` on the two live products, without re-running the sourcing agent against them.
 * Content metafields (`highlights`/`specs`/`whats_in_box`) are NEVER synthesized here — no agent
 * ran for these products, and inventing that content client-side would be worse than the section
 * simply not rendering.
 *
 * **Per product** (ACTIVE local rows carrying a Shopify gid, oldest first):
 * 1. Local variant rows + first mapping per variant (same dedupe as `backfill.ts`). A product with
 *    no CJ-mapped variant at all has nothing this pass can do and is skipped entirely.
 * 2. `--dry-run` early-continue, BEFORE any external call — the adapter may even be the mock under
 *    `--dry-run`, so a "plan" computed from adapter reads would be invented data. The plan is
 *    reported from local DB state alone (mapped-variant count); it honestly cannot know which
 *    variants Shopify already covers.
 * 3. One CJ detail read for the product's supplier product id, feeding a
 *    `supplierVariantId → http(s) imageUrl` map (a non-http(s) or missing url is never usable).
 * 4. One `productMediaState` read: per-variant first media id (idempotency: a variant that already
 *    shows media is SKIPPED) plus the product's full media id list, which seeds `knownMediaIds` for
 *    every `productAppendMedia` call below.
 * 5. Pending media work is GROUPED by unique image URL — CJ commonly shares one variant image
 *    across size variants, and creating one per variant would stack identical gallery images. One
 *    `productAppendMedia` per unique url, then a poll for `READY` before the variant append (media
 *    processing is async). Any give-up (no media returned, `FAILED`, poll exhaustion, or the
 *    append itself throwing) best-effort deletes the created media — a created-but-never-appended
 *    `MediaImage` is already attached to the product, and leaving it stacks a duplicate on every
 *    rerun — then records a warning and moves to the next url; reviews still run for the product.
 * 6. Reviews: `buildSupplierReviews` (Task 6) over a fresh fetch (a failed fetch degrades to `[]`,
 *    never a thrown error). Zero usable reviews fires an info alert and writes nothing; otherwise
 *    exactly one `metafieldsSet` for `dogebuddy.supplier_reviews`.
 *
 * **Definitions-ensure** runs ONCE before the product loop (panel 2026-09-01): the Storefront API
 * serves NO value for a metafield lacking a definition with storefront exposure, so without this
 * step every new section silently renders nothing on the live store. `--dry-run` makes NO calls
 * here either — even the list read stays live-only, matching the zero-ops dry-run contract.
 *
 * **Failure containment** mirrors `backfillListings`: a product whose CJ detail read (or anything
 * else uncaught) throws is recorded in `failures` and the loop moves to the next product. A
 * per-url media give-up is ALSO recorded in `failures` (so an operator sees it needs a rerun) but
 * does not abort the product — reviews still run.
 */
export async function backfillProductPageV2(deps: BackfillV2Deps, opts: { dryRun: boolean }): Promise<BackfillV2Result> {
  const { db, ops, log } = deps
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const dry = opts.dryRun ? '[dry-run] ' : ''
  const result: BackfillV2Result = { products: 0, variantImagesAdded: 0, reviewsWritten: 0, failures: [] }

  const candidates = await db
    .select()
    .from(products)
    .where(and(eq(products.status, 'active'), isNotNull(products.shopifyProductGid)))
    .orderBy(asc(products.createdAt), asc(products.id))

  // Definitions-ensure, once, before touching any product.
  if (opts.dryRun) {
    log(`${dry}would ensure the four v2 metafield definitions exist`)
  } else {
    const existing = await ops.listMetafieldDefinitions()
    for (const def of V2_METAFIELD_DEFINITIONS) {
      const has = existing.some((e) => e.namespace === def.namespace && e.key === def.key)
      if (!has) {
        await ops.metafieldDefinitionCreate({ name: def.name, namespace: def.namespace, key: def.key, type: def.type, ownerType: def.ownerType })
      }
    }
  }

  for (const product of candidates) {
    result.products += 1
    const productGid = product.shopifyProductGid!
    const label = product.handle ?? product.id
    try {
      // 1. Local variant rows + first mapping per variant, same dedupe as backfill.ts:206-222.
      const variantRows = await db
        .select({
          id: productVariants.id,
          shopifyVariantGid: productVariants.shopifyVariantGid,
          supplierProductId: supplierVariantMappings.supplierProductId,
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
      const mapped = locals.filter(
        (l): l is typeof l & { shopifyVariantGid: string; supplierProductId: string; supplierVariantId: string } =>
          !!l.shopifyVariantGid && !!l.supplierProductId && !!l.supplierVariantId,
      )

      if (mapped.length === 0) {
        log(`${dry}SKIP product ${product.id} (${label}): no CJ-mapped variant`)
        continue
      }

      // 2. DRY-RUN EARLY-CONTINUE — before any external call. Honest limitation stated in the log
      // line: this cannot know which variants Shopify already covers.
      if (opts.dryRun) {
        log(`${dry}${label}: would fetch CJ detail + reviews for ${mapped.length} mapped variant(s) and repair missing variant media`)
        continue
      }

      // 3. One CJ detail read, feeding a supplierVariantId -> http(s)-only imageUrl map.
      const pid = mapped[0]!.supplierProductId
      const detail = await deps.adapter.getProduct(pid)
      const cjImageByVid = new Map<string, string>()
      for (const v of detail.variants) {
        if (v.imageUrl && /^https?:\/\//i.test(v.imageUrl)) cjImageByVid.set(v.supplierVariantId, v.imageUrl)
      }

      // 4. Shopify media state: per-variant first media id, plus the product's known media ids.
      const state = await ops.productMediaState(productGid)
      const stateByGid = new Map(state.variants.map((v) => [v.id, v]))
      const knownMediaIds = [...state.mediaIds]

      // 5. Group pending work by unique image URL.
      const pending = new Map<string, string[]>()
      for (const local of mapped) {
        const imageUrl = cjImageByVid.get(local.supplierVariantId)
        if (!imageUrl) continue // CJ shows no usable image for this variant
        const existingMediaId = stateByGid.get(local.shopifyVariantGid)?.mediaId ?? null
        if (existingMediaId !== null) continue // already has Shopify media — idempotent skip
        if (!pending.has(imageUrl)) pending.set(imageUrl, [])
        pending.get(imageUrl)!.push(local.shopifyVariantGid)
      }

      const productFailures: string[] = []
      for (const [url, variantGids] of pending) {
        const [media] = await ops.productAppendMedia(productGid, [{ originalSource: url, alt: product.title ?? undefined }], knownMediaIds)
        if (!media) {
          await deps.alert('warning', 'backfill_media_not_ready', { productGid, url, error: 'no media returned' }).catch(() => {})
          productFailures.push(`product ${product.id}: media ${url}: no media returned`)
          continue
        }
        knownMediaIds.push(media.id)
        try {
          let status = media.status
          let attempts = 1
          while (status !== 'READY') {
            if (status === 'FAILED' || attempts >= MEDIA_READY_ATTEMPTS) throw new Error('media not ready')
            await sleep(MEDIA_POLL_MS)
            status = await ops.mediaImageStatus(media.id)
            attempts += 1
          }
          await ops.productVariantAppendMedia(
            productGid,
            variantGids.map((variantId) => ({ variantId, mediaIds: [media.id] })),
          )
          result.variantImagesAdded += variantGids.length
        } catch (mediaErr) {
          await ops.mediaDelete([media.id]).catch(async () => {
            await deps.alert('warning', 'backfill_media_orphaned', { productGid, mediaId: media.id }).catch(() => {})
          })
          await deps
            .alert('warning', 'backfill_media_not_ready', { productGid, url, error: errMessage(mediaErr) })
            .catch(() => {})
          productFailures.push(`product ${product.id}: media ${url}: ${errMessage(mediaErr)}`)
        }
      }
      result.failures.push(...productFailures)

      // 6. Reviews — writes ONLY supplier_reviews (spec §A5): no agent ran for these products, so
      // highlights/specs/whats_in_box are never synthesized here.
      let fetched: Awaited<ReturnType<typeof deps.adapter.getProductReviews>> = []
      let reviewFetchError: string | undefined
      try {
        fetched = await deps.adapter.getProductReviews(pid)
      } catch (err) {
        reviewFetchError = errMessage(err)
        fetched = []
      }
      const reviews = buildSupplierReviews(fetched, now())
      if (reviews === null) {
        await deps
          .alert('info', 'listing_reviews_unavailable', {
            source: 'backfill',
            productId: product.id,
            supplierProductId: pid,
            ...(reviewFetchError ? { error: reviewFetchError } : {}),
          })
          .catch(() => {})
      } else {
        await ops.metafieldsSet([
          { ownerId: productGid, namespace: 'dogebuddy', key: 'supplier_reviews', type: 'json', value: JSON.stringify(reviews) },
        ])
        result.reviewsWritten += 1
      }
    } catch (err) {
      result.failures.push(`${product.id}: ${errMessage(err)}`)
    }
  }

  return result
}
