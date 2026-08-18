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
import { DELIVERY_MAX_DAYS, DELIVERY_MIN_DAYS, SAMPLE_PRODUCTS, SHIPS_FROM, type SampleProduct } from './sample-data.ts'

export interface SeedCounts {
  definitions: number
  collections: number
  products: number
}

export interface SeedResult {
  created: SeedCounts
  skipped: SeedCounts
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

/**
 * Idempotently seeds a test Shopify store with the dogebuddy metafield definitions, sample
 * collections, and sample products so the Hydrogen storefront has real data to render against.
 * Gathers current store state, diffs it against the constant sample data via `planSeed` (pure),
 * then creates only what's missing — definitions, then collections, then products — logging each
 * create/skip via `log`. Every created product is published to every publication returned by
 * `listPublications` (publication naming varies by store; broad publish is deliberate for
 * samples and guarantees the Hydrogen channel gets them).
 */
export async function runSeed(client: ShopifyAdminClient, log: (line: string) => void = () => {}): Promise<SeedResult> {
  const existingDefinitions = await listMetafieldDefinitions(client, 'dogebuddy')
  const existingCollections = await listCollections(client)
  const publications = await listPublications(client)

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

  for (const key of existingDefinitions.map((d) => d.key)) {
    log(`skipped definition (already exists): dogebuddy.${key}`)
  }
  for (const def of plan.definitions) {
    await metafieldDefinitionCreate(client, {
      name: def.name,
      namespace: def.namespace,
      key: def.key,
      type: def.type,
      ownerType: def.ownerType,
    })
    created.definitions += 1
    log(`created definition: ${def.namespace}.${def.key}`)
  }

  for (const handle of existingCollections.map((c) => c.handle)) {
    log(`skipped collection (already exists): ${handle}`)
  }
  for (const collection of plan.collections) {
    await collectionCreate(client, collection)
    created.collections += 1
    log(`created collection: ${collection.handle}`)
  }

  for (const handle of existingProductHandles) {
    log(`skipped product (already exists): ${handle}`)
  }
  for (const product of plan.products) {
    const { productId } = await productSet(client, productSetInput(product))
    created.products += 1
    log(`created product: ${product.handle} -> ${productId}`)
    for (const pub of publications) {
      await publishablePublish(client, productId, pub.id)
    }
  }

  return { created, skipped }
}
