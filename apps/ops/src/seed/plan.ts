import { COLLECTIONS, METAFIELD_DEFINITIONS, SAMPLE_PRODUCTS, type SampleProduct } from './sample-data.ts'

export interface SeedState {
  definitionKeys: string[]
  collectionHandles: string[]
  productHandles: string[]
}

export interface SeedPlan {
  definitions: typeof METAFIELD_DEFINITIONS
  collections: typeof COLLECTIONS
  products: SampleProduct[]
}

/**
 * Pure diff between the constant sample data and what a live store already has, so `run.ts` only
 * creates what's missing (idempotent reruns). Takes no client — all I/O (gathering `state` via
 * `listMetafieldDefinitions` / `listCollections` / `findProductByHandle`) is the caller's job.
 */
export function planSeed(state: SeedState): SeedPlan {
  const definitionKeys = new Set(state.definitionKeys)
  const collectionHandles = new Set(state.collectionHandles)
  const productHandles = new Set(state.productHandles)

  return {
    definitions: METAFIELD_DEFINITIONS.filter((d) => !definitionKeys.has(d.key)),
    collections: COLLECTIONS.filter((c) => !collectionHandles.has(c.handle)),
    products: SAMPLE_PRODUCTS.filter((p) => !productHandles.has(p.handle)),
  }
}
