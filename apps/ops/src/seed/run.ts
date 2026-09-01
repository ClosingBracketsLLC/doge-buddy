import {
  collectionCreate,
  findProductByHandle,
  listCollections,
  listMetafieldDefinitions,
  listPublications,
  metafieldDefinitionCreate,
  productSet,
  publishablePublish,
  type ShopifyAdminClient,
} from '@doge-buddy/shopify-admin'
import { planSeed } from './plan.ts'
import {
  COLLECTIONS,
  DELIVERY_MAX_DAYS,
  DELIVERY_MIN_DAYS,
  METAFIELD_DEFINITIONS,
  SAMPLE_PRODUCTS,
  SHIPS_FROM,
  type SampleProduct,
} from './sample-data.ts'

export interface SeedCounts {
  definitions: number
  collections: number
  products: number
}

export interface SeedResult {
  created: SeedCounts
  skipped: SeedCounts
  failures: string[]
}

function productSetInput(product: SampleProduct): Record<string, unknown> {
  return {
    title: product.title,
    handle: product.handle,
    status: 'ACTIVE',
    tags: [`category:${product.categoryTag}`, 'sample'],
    metafields: [
      { namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', value: SHIPS_FROM },
      { namespace: 'dogebuddy', key: 'delivery_min_days', type: 'number_integer', value: DELIVERY_MIN_DAYS },
      { namespace: 'dogebuddy', key: 'delivery_max_days', type: 'number_integer', value: DELIVERY_MAX_DAYS },
    ],
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [
      {
        price: product.price,
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        inventoryItem: { tracked: false },
      },
    ],
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Idempotently seeds a test Shopify store with the dogebuddy metafield definitions, sample
 * collections, and sample products so the Hydrogen storefront has real data to render against.
 * Gathers current store state, diffs it against the constant sample data via `planSeed` (pure),
 * then creates only what's missing — definitions, then collections, then products — logging each
 * create/skip via `log`. Every collection in `COLLECTIONS` (existing or newly created) is
 * published to every publication returned by `listPublications`, every run; every NEWLY CREATED
 * product is too (publication naming varies by store; broad publish is deliberate for samples and
 * guarantees the Hydrogen channel gets them). Collections and products are deliberately treated
 * differently here — see the collection-publish loop's own comment below.
 *
 * Every create/publish call is individually contained: a failure is logged, recorded in
 * `failures`, and the run continues with the next item/publication rather than aborting. This
 * matters most for publish: `productSet` and `publishablePublish` are separate calls, so a
 * product that was created but only partially published would otherwise have no self-heal path
 * on rerun (`findProductByHandle` finds it, `planSeed` skips it, its remaining publications are
 * never retried). Attempting every publication regardless of earlier failures, and surfacing
 * `failures` in the returned summary, keeps that state visible and retryable by hand.
 */
export async function runSeed(client: ShopifyAdminClient, log: (line: string) => void = () => {}): Promise<SeedResult> {
  const seedDefinitionKeys = new Set(METAFIELD_DEFINITIONS.map((d) => d.key))
  const seedCollectionHandles = new Set(COLLECTIONS.map((c) => c.handle))

  const allDefinitions = await listMetafieldDefinitions(client, 'dogebuddy')
  const allCollections = await listCollections(client)
  const publications = await listPublications(client)

  // Scoped to the seed's own definitions/collections — listCollections in particular returns
  // every collection in the store, and a store can have unrelated pre-existing collections
  // (e.g. "featured-products") that must not be counted or logged as seed skips.
  const existingDefinitions = allDefinitions.filter((d) => seedDefinitionKeys.has(d.key))
  const existingCollections = allCollections.filter((c) => seedCollectionHandles.has(c.handle))

  // 10 sequential lookups — one product each, no batch-by-handle query exists — fine per brief.
  const existingProductHandles: string[] = []
  for (const product of SAMPLE_PRODUCTS) {
    const found = await findProductByHandle(client, product.handle)
    if (found) existingProductHandles.push(product.handle)
  }

  const plan = planSeed({
    definitionKeys: existingDefinitions.map((d) => d.key),
    collectionHandles: existingCollections.map((c) => c.handle),
    productHandles: existingProductHandles,
  })

  const created: SeedCounts = { definitions: 0, collections: 0, products: 0 }
  const skipped: SeedCounts = {
    definitions: existingDefinitions.length,
    collections: existingCollections.length,
    products: existingProductHandles.length,
  }
  const failures: string[] = []

  for (const key of existingDefinitions.map((d) => d.key)) {
    log(`skipped definition (already exists): dogebuddy.${key}`)
  }
  for (const def of plan.definitions) {
    try {
      await metafieldDefinitionCreate(client, {
        name: def.name,
        namespace: def.namespace,
        key: def.key,
        type: def.type,
        ownerType: def.ownerType,
      })
      created.definitions += 1
      log(`created definition: ${def.namespace}.${def.key}`)
    } catch (err) {
      const message = `definition ${def.namespace}.${def.key}: ${formatError(err)}`
      failures.push(message)
      log(`FAILED definition: ${message}`)
    }
  }

  for (const handle of existingCollections.map((c) => c.handle)) {
    log(`skipped collection (already exists): ${handle}`)
  }
  // handle -> collection id, so the publish loop below can publish both collections that already
  // existed and ones just created this run.
  const collectionIds = new Map(existingCollections.map((c) => [c.handle, c.id]))
  for (const collection of plan.collections) {
    try {
      const result = await collectionCreate(client, collection)
      collectionIds.set(collection.handle, result.id)
      created.collections += 1
      log(`created collection: ${collection.handle}`)
    } catch (err) {
      const message = `collection ${collection.handle}: ${formatError(err)}`
      failures.push(message)
      log(`FAILED collection: ${message}`)
    }
  }

  // Every collection in COLLECTIONS is published to every publication, EVERY run — unlike
  // products below, this is unconditional (existing collections republish too), so a collection
  // published before a new sales channel/publication existed, or one that was only
  // partially published, self-heals on the very next seed run rather than needing a separate
  // recovery path. See `seedCollections`'s docstring (`src/seed/collections.ts`) for the same
  // rationale — this loop mirrors that function's publish step.
  //
  // FIXTURE-ASSUMPTION (2026-07 API): publishablePublish on a Collection id — verify on the
  // first live seed-collections run.
  for (const collection of COLLECTIONS) {
    const collectionId = collectionIds.get(collection.handle)
    // No id means collectionCreate failed above for this collection — already recorded as a
    // failure; there is nothing to publish.
    if (!collectionId) continue
    for (const pub of publications) {
      try {
        await publishablePublish(client, collectionId, pub.id)
      } catch (err) {
        const message = `collection ${collection.handle}: publish to "${pub.name}" failed: ${formatError(err)}`
        failures.push(message)
        log(`FAILED publish: ${message}`)
      }
    }
  }

  for (const handle of existingProductHandles) {
    log(`skipped product (already exists): ${handle}`)
  }
  for (const product of plan.products) {
    let productId: string
    try {
      const result = await productSet(client, productSetInput(product))
      productId = result.productId
      created.products += 1
      log(`created product: ${product.handle} -> ${productId}`)
    } catch (err) {
      const message = `product ${product.handle}: create failed: ${formatError(err)}`
      failures.push(message)
      log(`FAILED product: ${message}`)
      continue
    }

    for (const pub of publications) {
      try {
        await publishablePublish(client, productId, pub.id)
      } catch (err) {
        const message = `product ${product.handle}: publish to "${pub.name}" failed: ${formatError(err)}`
        failures.push(message)
        log(`FAILED publish: ${message}`)
      }
    }
  }

  return { created, skipped, failures }
}
