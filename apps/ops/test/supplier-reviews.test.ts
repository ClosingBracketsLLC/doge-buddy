import { describe, expect, it } from 'vitest'
import type { SupplierProductReview } from '@doge-buddy/supplier'
import { buildSupplierReviews } from '../src/proposals/supplier-reviews.ts'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const review = (over: Partial<SupplierProductReview> = {}): SupplierProductReview => ({
  rating: 5,
  content: 'Great toy, my dog loves it',
  ...over,
})

describe('buildSupplierReviews', () => {
  it('returns null for an empty fetch', () => {
    expect(buildSupplierReviews([], NOW)).toBeNull()
  })

  it('a review with no parsable score is never published and never counted (fail-safe on the unverified wire)', () => {
    const out = buildSupplierReviews([review(), review({ rating: undefined })], NOW)!
    expect(out.reviews).toHaveLength(1)
    expect(out.count).toBe(1)
    expect(out.average).toBe(5)
    expect(buildSupplierReviews([review({ rating: undefined })], NOW)).toBeNull()
  })

  it('sanitizes HTML to plain text and caps at 500 chars', () => {
    const out = buildSupplierReviews([review({ content: `<b>Nice</b> &amp; sturdy ${'x'.repeat(600)}` })], NOW)
    expect(out!.reviews[0]!.text.startsWith('Nice & sturdy')).toBe(true)
    expect(out!.reviews[0]!.text.length).toBeLessThanOrEqual(500)
    expect(out!.reviews[0]!.text).not.toContain('<b>')
  })

  it('DROPS (never rewrites) a review whose text hits the claims list', () => {
    const out = buildSupplierReviews([review({ content: 'this vet approved toy is great' }), review()], NOW)
    expect(out!.reviews).toHaveLength(1)
    expect(out!.reviews[0]!.text).toBe('Great toy, my dog loves it')
  })

  it('scrubs the FULL text: end-of-string bare "cure" and a claim term past the 500-char cap both drop', () => {
    expect(buildSupplierReviews([review({ content: 'I hoped for a cure' })], NOW)).toBeNull()
    expect(buildSupplierReviews([review({ content: `${'x'.repeat(600)} clinically proven` })], NOW)).toBeNull()
  })

  it('returns null when every review is scrubbed away (empty section is worse than none)', () => {
    expect(buildSupplierReviews([review({ content: 'pain relief at last' })], NOW)).toBeNull()
    expect(buildSupplierReviews([review({ content: '<p></p>' })], NOW)).toBeNull()
  })

  it('sorts rating-desc then date-desc and keeps 10', () => {
    const fetched = [
      review({ rating: 4, reviewDate: '2026-01-01' }),
      review({ rating: 5, reviewDate: '2026-01-01' }),
      review({ rating: 5, reviewDate: '2026-06-01' }),
      ...Array.from({ length: 12 }, (_, i) => review({ rating: 3, reviewDate: `2026-02-${String(i + 1).padStart(2, '0')}` })),
    ]
    const out = buildSupplierReviews(fetched, NOW)!
    expect(out.reviews).toHaveLength(10)
    expect(out.reviews[0]).toMatchObject({ rating: 5, date: '2026-06-01' })
    expect(out.reviews[1]).toMatchObject({ rating: 5, date: '2026-01-01' })
    expect(out.reviews[2]).toMatchObject({ rating: 4 })
  })

  it('averages over all RATED reviews (claim-dropped ones included) and counts the rated length', () => {
    const out = buildSupplierReviews([review({ rating: 5 }), review({ rating: 1, content: 'vet approved junk' })], NOW)!
    expect(out.average).toBe(3)
    expect(out.count).toBe(2)
    expect(out.reviews).toHaveLength(1)
  })

  it('normalizes country to 2-letter uppercase and drops junk country codes', () => {
    const out = buildSupplierReviews([review({ countryCode: 'us' }), review({ countryCode: 'USA' })], NOW)!
    expect(out.reviews.map((r) => r.country)).toEqual(['US', undefined])
  })

  it('keeps only ISO-shaped dates, normalized to YYYY-MM-DD; junk dates are omitted', () => {
    const out = buildSupplierReviews(
      [review({ reviewDate: '2026-06-01T09:00:00Z' }), review({ reviewDate: 'June 1st, cure guaranteed' })],
      NOW,
    )!
    expect(out.reviews.map((r) => r.date)).toEqual(['2026-06-01', undefined])
  })

  it('stamps fetchedAt from the injected clock', () => {
    expect(buildSupplierReviews([review()], NOW)!.fetchedAt).toBe('2026-09-01T12:00:00.000Z')
  })
})
