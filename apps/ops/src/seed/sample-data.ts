import { CATEGORIES, categoryTagValue, type CategoryTag } from '@doge-buddy/core'

/**
 * Static sample data for `seed-store`: metafield definitions, collections, and sample products
 * used to populate a fresh test Shopify store so the Hydrogen storefront has something real to
 * render. All values here are constants — the planner (`plan.ts`) diffs them against live store
 * state to decide what's missing; `run.ts` does the actual creation.
 */

export interface MetafieldDefinition {
  name: string
  namespace: string
  key: string
  type: string
  ownerType: 'PRODUCT'
}

export const METAFIELD_DEFINITIONS: MetafieldDefinition[] = [
  { name: 'Ships from', namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', ownerType: 'PRODUCT' },
  { name: 'Delivery min days', namespace: 'dogebuddy', key: 'delivery_min_days', type: 'number_integer', ownerType: 'PRODUCT' },
  { name: 'Delivery max days', namespace: 'dogebuddy', key: 'delivery_max_days', type: 'number_integer', ownerType: 'PRODUCT' },
  { name: 'Highlights', namespace: 'dogebuddy', key: 'highlights', type: 'json', ownerType: 'PRODUCT' },
  { name: 'Specs', namespace: 'dogebuddy', key: 'specs', type: 'json', ownerType: 'PRODUCT' },
  { name: 'Supplier reviews', namespace: 'dogebuddy', key: 'supplier_reviews', type: 'json', ownerType: 'PRODUCT' },
  { name: "What's in the box", namespace: 'dogebuddy', key: 'whats_in_box', type: 'single_line_text_field', ownerType: 'PRODUCT' },
]

export interface SeedCollection {
  title: string
  handle: string
  tagValue: string
  descriptionHtml?: string
}

// Derived from `@doge-buddy/core`'s `CATEGORIES` — the single category source of truth (spec
// 2026-08-31 catalog-p0 §1) — rather than hardcoded, so a category added/changed in
// `packages/core/src/catalog.ts` propagates here for free instead of drifting silently.
export const COLLECTIONS: SeedCollection[] = CATEGORIES.map((c) => ({
  title: c.title,
  handle: c.handle,
  tagValue: categoryTagValue(c.tag),
  descriptionHtml: c.blurb,
}))

export interface SampleProduct {
  title: string
  handle: string
  categoryTag: CategoryTag
  price: string
}

// dogebuddy metafield values are the same for every sample product — a real supplier feed would
// vary these per-product, but for seed samples a single US-warehouse / 3-7 day story is enough.
export const SHIPS_FROM = 'US warehouse'
export const DELIVERY_MIN_DAYS = '3'
export const DELIVERY_MAX_DAYS = '7'

export const SAMPLE_PRODUCTS: SampleProduct[] = [
  { title: 'Sample — Tug-of-War Rope Toy', handle: 'sample-tug-of-war-rope-toy', categoryTag: 'toys', price: '12.99' },
  { title: 'Sample — Squeaky Plush Fox', handle: 'sample-squeaky-plush-fox', categoryTag: 'toys', price: '14.99' },
  { title: 'Sample — Treat Puzzle Ball', handle: 'sample-treat-puzzle-ball', categoryTag: 'toys', price: '16.99' },
  { title: 'Sample — No-Pull Harness', handle: 'sample-no-pull-harness', categoryTag: 'walks', price: '24.99' },
  { title: 'Sample — Reflective Leash', handle: 'sample-reflective-leash', categoryTag: 'walks', price: '18.99' },
  { title: 'Sample — Collapsible Travel Bowl', handle: 'sample-collapsible-travel-bowl', categoryTag: 'walks', price: '9.99' },
  { title: 'Sample — Donut Calming Bed', handle: 'sample-donut-calming-bed', categoryTag: 'beds', price: '39.99' },
  { title: 'Sample — Cozy Fleece Blanket', handle: 'sample-cozy-fleece-blanket', categoryTag: 'beds', price: '19.99' },
  { title: 'Sample — Self-Cleaning Slicker Brush', handle: 'sample-self-cleaning-slicker-brush', categoryTag: 'grooming', price: '15.99' },
  { title: 'Sample — Nail Grinder Kit', handle: 'sample-nail-grinder-kit', categoryTag: 'grooming', price: '22.99' },
]
