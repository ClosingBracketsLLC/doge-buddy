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
]

export interface SeedCollection {
  title: string
  handle: string
  tagCondition: string
}

export const COLLECTIONS: SeedCollection[] = [
  { title: 'Toys & Play', handle: 'toys-play', tagCondition: 'category:toys-play' },
  { title: 'Walks & Travel', handle: 'walks-travel', tagCondition: 'category:walks-travel' },
  { title: 'Beds & Comfort', handle: 'beds-comfort', tagCondition: 'category:beds-comfort' },
  { title: 'Grooming & Care', handle: 'grooming-care', tagCondition: 'category:grooming-care' },
]

export interface SampleProduct {
  title: string
  handle: string
  categoryTag: string
  price: string
}

// dogebuddy metafield values are the same for every sample product — a real supplier feed would
// vary these per-product, but for seed samples a single US-warehouse / 3-7 day story is enough.
export const SHIPS_FROM = 'US warehouse'
export const DELIVERY_MIN_DAYS = '3'
export const DELIVERY_MAX_DAYS = '7'

export const SAMPLE_PRODUCTS: SampleProduct[] = [
  { title: 'Sample — Tug-of-War Rope Toy', handle: 'sample-tug-of-war-rope-toy', categoryTag: 'toys-play', price: '12.99' },
  { title: 'Sample — Squeaky Plush Fox', handle: 'sample-squeaky-plush-fox', categoryTag: 'toys-play', price: '14.99' },
  { title: 'Sample — Treat Puzzle Ball', handle: 'sample-treat-puzzle-ball', categoryTag: 'toys-play', price: '16.99' },
  { title: 'Sample — No-Pull Harness', handle: 'sample-no-pull-harness', categoryTag: 'walks-travel', price: '24.99' },
  { title: 'Sample — Reflective Leash', handle: 'sample-reflective-leash', categoryTag: 'walks-travel', price: '18.99' },
  { title: 'Sample — Collapsible Travel Bowl', handle: 'sample-collapsible-travel-bowl', categoryTag: 'walks-travel', price: '9.99' },
  { title: 'Sample — Donut Calming Bed', handle: 'sample-donut-calming-bed', categoryTag: 'beds-comfort', price: '39.99' },
  { title: 'Sample — Cozy Fleece Blanket', handle: 'sample-cozy-fleece-blanket', categoryTag: 'beds-comfort', price: '19.99' },
  { title: 'Sample — Self-Cleaning Slicker Brush', handle: 'sample-self-cleaning-slicker-brush', categoryTag: 'grooming-care', price: '15.99' },
  { title: 'Sample — Nail Grinder Kit', handle: 'sample-nail-grinder-kit', categoryTag: 'grooming-care', price: '22.99' },
]
