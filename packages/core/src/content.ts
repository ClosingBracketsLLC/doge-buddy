import { z } from 'zod'

/**
 * Product-page v2 structured content (spec 2026-09-01 §Data shapes): the JSON values stored in
 * `dogebuddy.*` product metafields. Shared so the ops writers (payload validation, the apply
 * worker, backfill) and the storefront reader parse the exact same shapes — a stored value that
 * fails these schemas is treated as ABSENT by the storefront (the section renders null and the
 * page equals the pre-v2 page), never a 500.
 */

export const SUPPLIER_REVIEWS_MAX = 10

export const ProductHighlightsSchema = z.array(z.string().min(3).max(120)).min(3).max(5)
export type ProductHighlights = z.infer<typeof ProductHighlightsSchema>

export const ProductSpecsSchema = z
  .array(
    z.object({
      label: z.string().min(1).max(40),
      value: z.string().min(1).max(120),
    }),
  )
  .min(1)
  .max(10)
export type ProductSpecs = z.infer<typeof ProductSpecsSchema>

export const SupplierReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1).max(500), // plain text — sanitized upstream, never HTML
  // Normalized to YYYY-MM-DD by buildSupplierReviews (panel 2026-09-01: `date` must not be the one
  // published string with no shape bound — the CJ wire shape is unverified). Display-only.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  country: z.string().length(2).optional(),
})
export type SupplierReview = z.infer<typeof SupplierReviewSchema>

export const SupplierReviewsSchema = z.object({
  average: z.number().min(1).max(5), // over ALL fetched reviews, not just the kept ones
  count: z.number().int().nonnegative(), // supplier's total where available, else fetched count
  reviews: z.array(SupplierReviewSchema).max(SUPPLIER_REVIEWS_MAX),
  fetchedAt: z.string(), // ISO — the storefront shows "as of <date>"
})
export type SupplierReviews = z.infer<typeof SupplierReviewsSchema>
