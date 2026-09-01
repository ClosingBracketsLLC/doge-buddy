import { CATEGORY_TAGS, type CategoryTag } from './proposals.ts'

export interface CategoryDef {
  tag: CategoryTag
  /** Storefront collection handle — also the header nav route `/collections/<handle>`. */
  handle: string
  title: string
  /** Shopify `productType` stamped on every product listed in this category. */
  productType: string
  /** One-line collection description. */
  blurb: string
}

/**
 * The single source of truth for the store's categories (spec 2026-08-31 catalog-p0 §1). The
 * proposal schema's `CATEGORY_TAGS` enum fixes WHICH categories exist; this table fixes what each
 * one looks like on the store. The `satisfies` + the consistency test keep the two aligned.
 */
export const CATEGORIES = [
  { tag: 'toys', handle: 'toys-play', title: 'Toys & Play', productType: 'Dog Toys', blurb: 'Tug, chew, fetch, puzzle — gear that keeps the tail going.' },
  { tag: 'walks', handle: 'walks-travel', title: 'Walks & Travel', productType: 'Dog Walking', blurb: 'Leashes, harnesses, bowls and carriers for the road.' },
  { tag: 'beds', handle: 'beds-comfort', title: 'Beds & Comfort', productType: 'Dog Beds', blurb: 'Beds, blankets and calming spots for the off hours.' },
  { tag: 'grooming', handle: 'grooming-care', title: 'Grooming & Care', productType: 'Dog Grooming', blurb: 'Brushes, clippers and care tools for at-home upkeep.' },
] as const satisfies readonly CategoryDef[]

export function categoryByTag(tag: CategoryTag): CategoryDef {
  const found = CATEGORIES.find((c) => c.tag === tag)
  if (!found) throw new Error(`unknown category tag ${tag}`)
  return found
}

/** The Shopify product tag the automated collections key on. */
export function categoryTagValue(tag: CategoryTag): string {
  return `category:${tag}`
}

const SLUG_MAX = 60

/** URL slug: ASCII, lower-case, `-` separated, ≤ 60 chars, never empty (`product`). */
export function slugify(input: string): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const capped = ascii.slice(0, SLUG_MAX).replace(/^-+|-+$/g, '')
  return capped.length > 0 ? capped : 'product'
}

export { CATEGORY_TAGS }
