import { describe, expect, it } from 'vitest'
import { planSeed } from '../src/seed/plan.ts'
import { METAFIELD_DEFINITIONS, COLLECTIONS, SAMPLE_PRODUCTS } from '../src/seed/sample-data.ts'

describe('planSeed', () => {
  it('plans everything on an empty store', () => {
    const plan = planSeed({ definitionKeys: [], collectionHandles: [], productHandles: [] })
    expect(plan.definitions).toHaveLength(7)
    expect(plan.collections).toHaveLength(4)
    expect(plan.products).toHaveLength(10)
  })

  it('plans nothing when everything exists (idempotent rerun)', () => {
    const plan = planSeed({
      definitionKeys: METAFIELD_DEFINITIONS.map((d) => d.key),
      collectionHandles: COLLECTIONS.map((c) => c.handle),
      productHandles: SAMPLE_PRODUCTS.map((p) => p.handle),
    })
    expect(plan).toEqual({ definitions: [], collections: [], products: [] })
  })

  it('plans only the missing subset', () => {
    const plan = planSeed({
      definitionKeys: ['ships_from'],
      collectionHandles: ['toys-play'],
      productHandles: SAMPLE_PRODUCTS.slice(1).map((p) => p.handle),
    })
    expect(plan.definitions.map((d) => d.key).sort()).toEqual([
      'delivery_max_days', 'delivery_min_days', 'highlights', 'specs', 'supplier_reviews', 'whats_in_box',
    ])
    expect(plan.collections).toHaveLength(3)
    expect(plan.products.map((p) => p.handle)).toEqual([SAMPLE_PRODUCTS[0]!.handle])
  })
})
