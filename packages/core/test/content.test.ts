import { describe, expect, it } from 'vitest'
import {
  ProductHighlightsSchema,
  ProductSpecsSchema,
  SupplierReviewsSchema,
  SUPPLIER_REVIEWS_MAX,
} from '../src/content.ts'

describe('ProductHighlightsSchema', () => {
  it('accepts 3-5 bullets of 3-120 chars', () => {
    expect(ProductHighlightsSchema.safeParse(['Durable rope core', 'Machine washable', 'Non-slip grip']).success).toBe(true)
  })
  it.each([
    [['one', 'two'], 'fewer than 3'],
    [['a1', 'b2', 'c3'], 'bullets under 3 chars'],
    [['ok bullet', 'ok bullet 2', 'ok bullet 3', 'ok 4', 'ok 5', 'ok 6'], 'more than 5'],
  ])('rejects %j (%s)', (input) => {
    expect(ProductHighlightsSchema.safeParse(input).success).toBe(false)
  })
})

describe('ProductSpecsSchema', () => {
  it('accepts 1-10 label/value rows', () => {
    expect(ProductSpecsSchema.safeParse([{ label: 'Material', value: 'Cotton rope' }]).success).toBe(true)
  })
  it('rejects a label over 40 chars', () => {
    expect(ProductSpecsSchema.safeParse([{ label: 'x'.repeat(41), value: 'v' }]).success).toBe(false)
  })
  it('rejects an empty array', () => {
    expect(ProductSpecsSchema.safeParse([]).success).toBe(false)
  })
})

describe('SupplierReviewsSchema', () => {
  const review = { rating: 5, text: 'Great toy, my dog loves it' }
  it('accepts a full valid value', () => {
    const parsed = SupplierReviewsSchema.safeParse({
      average: 4.6,
      count: 1238,
      reviews: [{ ...review, date: '2026-05-01', country: 'US' }],
      fetchedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })
  it.each([
    [{ rating: 0, text: 'ok' }, 'rating 0'],
    [{ rating: 6, text: 'ok' }, 'rating 6'],
    [{ rating: 4.5, text: 'ok' }, 'non-integer rating'],
    [{ rating: 5, text: '' }, 'empty text'],
    [{ rating: 5, text: 'ok', country: 'USA' }, '3-letter country'],
    [{ rating: 5, text: 'ok', date: 'June 1st' }, 'non-ISO date'],
  ])('rejects a review %j (%s)', (bad, _desc) => {
    expect(
      SupplierReviewsSchema.safeParse({ average: 4, count: 1, reviews: [bad], fetchedAt: '2026-09-01T00:00:00.000Z' }).success,
    ).toBe(false)
  })
  it(`caps reviews at ${SUPPLIER_REVIEWS_MAX}`, () => {
    const reviews = Array.from({ length: SUPPLIER_REVIEWS_MAX + 1 }, () => review)
    expect(SupplierReviewsSchema.safeParse({ average: 5, count: 11, reviews, fetchedAt: 'x' }).success).toBe(false)
  })
})
