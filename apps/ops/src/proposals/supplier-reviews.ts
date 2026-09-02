import { SUPPLIER_REVIEWS_MAX, SupplierReviewsSchema, type SupplierReviews } from '@doge-buddy/core'
import type { SupplierProductReview } from '@doge-buddy/supplier'
import { findClaimViolations, htmlToText } from '../sourcing/guards.ts'

const REVIEW_TEXT_MAX = 500

const clampRating = (rating: number): number => Math.min(5, Math.max(1, Math.round(rating)))

/**
 * Turns a raw supplier review fetch into the `dogebuddy.supplier_reviews` metafield value, or
 * `null` when nothing publishable survives — an empty reviews section is worse than none (spec
 * 2026-09-01 §Error handling). Shared by the apply worker (§A4.3) and backfill's v2 pass (§A5).
 *
 * Fail-safe stance (panel 2026-09-01): the `product/productComments` wire shape is UNVERIFIED
 * (cj-api-notes "Still unverified"), so a review without a parsable rating is never published
 * and never counted — a wrong score-field name degrades to "no reviews section", never to
 * invented stars. Pipeline per spec §A4.3: sanitize to plain text; scrub the FULL sanitized
 * text (with a trailing-space sentinel so end-of-string 'cure'/'treats' match CLAIM_TERMS'
 * trailing-space forms, and BEFORE the display cap so a claim past char 500 still drops the
 * review) — reject, never rewrite; drop empties; sort rating-desc then date-desc; keep 10.
 * `average`/`count` are over ALL rated reviews, dropped ones included — the kept subset must
 * not launder into a better score. Dates keep only an ISO YYYY-MM-DD prefix (display + sort).
 */
export function buildSupplierReviews(fetched: SupplierProductReview[], now: Date): SupplierReviews | null {
  const rated = fetched.filter(
    (r): r is SupplierProductReview & { rating: number } => typeof r.rating === 'number' && Number.isFinite(r.rating),
  )
  if (rated.length === 0) return null

  const kept = rated
    .map((r) => {
      const full = htmlToText(r.content)
      return {
        full,
        review: {
          rating: clampRating(r.rating),
          text: full.slice(0, REVIEW_TEXT_MAX).trim(),
          ...(r.reviewDate && /^\d{4}-\d{2}-\d{2}/.test(r.reviewDate) ? { date: r.reviewDate.slice(0, 10) } : {}),
          ...(r.countryCode && /^[A-Za-z]{2}$/.test(r.countryCode)
            ? { country: r.countryCode.toUpperCase() }
            : {}),
        },
      }
    })
    .filter(({ review }) => review.text.length > 0)
    .filter(({ full }) => findClaimViolations(`${full} `).length === 0)
    .map(({ review }) => review)
    .sort((a, b) => b.rating - a.rating || (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, SUPPLIER_REVIEWS_MAX)

  if (kept.length === 0) return null

  const average = rated.reduce((sum, r) => sum + clampRating(r.rating), 0) / rated.length

  return SupplierReviewsSchema.parse({
    average: Math.round(average * 10) / 10,
    count: rated.length,
    reviews: kept,
    fetchedAt: now.toISOString(),
  })
}
