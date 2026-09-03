import { describe, expect, it } from 'vitest'
import { ListingDecisionContextSchema } from '@doge-buddy/core'
import { buildListingDecisionContext, computeTrendMomentum, ReviewsSeen } from '../src/sourcing/decision-context.ts'

describe('ReviewsSeen', () => {
  it('summarizes rated reviews only; avg over rated; never fabricates a rating', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ rating: 5, content: 'a' }, { rating: 4, content: 'b' }, { content: 'unrated' }])
    expect(seen.get('pid1')).toEqual({ page1Count: 3, ratedCount: 2, avgRating: 4.5 })
  })
  it('avgRating null when nothing rated', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ content: 'x' }])
    expect(seen.get('pid1')).toEqual({ page1Count: 1, ratedCount: 0, avgRating: null })
  })
  it('first recording per pid wins', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ rating: 5, content: 'a' }])
    seen.record('pid1', [{ content: 'b' }, { content: 'c' }])
    expect(seen.get('pid1')!.page1Count).toBe(1)
  })
})

describe('computeTrendMomentum', () => {
  it('mean(last third) - mean(first third), rounded', () => {
    const points = [10, 10, 10, 50, 50, 50, 90, 90, 90].map((value) => ({ value }))
    expect(computeTrendMomentum(points)).toBe(80)
  })
  it('null under 3 points', () => {
    expect(computeTrendMomentum([{ value: 1 }, { value: 2 }])).toBeNull()
    expect(computeTrendMomentum([])).toBeNull()
  })
  it('negative momentum survives', () => {
    const points = [90, 90, 90, 50, 50, 50, 10, 10, 10].map((value) => ({ value }))
    expect(computeTrendMomentum(points)).toBe(-80)
  })
})

describe('buildListingDecisionContext', () => {
  const payload = {
    type: 'new_listing', title: 'T', descriptionHtml: '<p>d</p>', categoryTag: 'walks',
    imageUrls: ['https://x/a.jpg'], shipsFrom: 'US', deliveryMinDays: 2, deliveryMaxDays: 7,
    variants: [
      { sku: 'A', supplierProductId: 'p1', supplierVariantId: 'v1', priceCents: 2399, supplierCostCents: 612 },
      { sku: 'B', supplierProductId: 'p1', supplierVariantId: 'v2', priceCents: 2899, supplierCostCents: 750 },
    ],
  } as never // shape per NewListingPayload; cast keeps the test focused (builder reads, never validates)
  const base = {
    payload,
    freightCents: 649,
    freightOption: { name: 'USPS', priceCents: 649, minDays: 3, maxDays: 7 },
    lookup: { lookupId: 'mkt_1', supplierProductId: 'p1', query: 'dog thing', offerCount: 12, medianCents: 2199, p25Cents: 1800, p75Cents: 2600, offers: [], snapshot: {} },
    maxPriceToMarketBps: 13000,
    stockRows: [
      { countryCode: 'US', quantity: 200, verified: true },
      { countryCode: 'US', quantity: 14, verified: true },
      { countryCode: 'CN', quantity: 999, verified: true },
    ],
    candidate: { supplierProductId: 'p1', title: 't', categoryName: null, sellPriceCents: null, listedNum: 1200, imageUrl: null, keyword: 'dog leash' },
    trendSignal: { keyword: 'dog leash', score: 62.1, snapshot: { timelineData: [10, 10, 10, 50, 50, 50, 90, 90, 90].map((value) => ({ value })) } },
    reviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
    amazon: { query: 'dog thing', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000 },
  }

  it('assembles a schema-valid context with correct arithmetic', () => {
    const ctx = buildListingDecisionContext(base as never)
    expect(ListingDecisionContextSchema.safeParse(ctx).success).toBe(true)
    expect(ctx.economics.variants[0]).toEqual({ sku: 'A', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: Math.floor(((2399 - 612 - 649) * 10_000) / 2399) })
    expect(ctx.economics.market).toMatchObject({ medianCents: 2199, typicalCents: 2899, ceilingCents: Math.floor((2199 * 13000) / 10_000), offerCount: 12 })
    expect(ctx.economics.usStockUnits).toBe(214)
    expect(ctx.demand.trends).toEqual({ keyword: 'dog leash', score: 62.1, momentum: 80 })
    expect(ctx.demand.cjListedCount).toBe(1200)
  })

  it('degrades every missing source to null and stays schema-valid', () => {
    const ctx = buildListingDecisionContext({ ...base, lookup: null, candidate: undefined, trendSignal: undefined, reviews: undefined, amazon: null, stockRows: [{ countryCode: 'CN', quantity: 5, verified: true }] } as never)
    expect(ctx.economics.market).toBeNull()
    expect(ctx.economics.usStockUnits).toBeNull()
    expect(ctx.demand).toEqual({ cjListedCount: null, cjReviews: null, marketOfferCount: null, trends: null, amazon: null })
    expect(ListingDecisionContextSchema.safeParse(ctx).success).toBe(true)
  })

  it('candidate with null listedNum yields cjListedCount null (never 0-for-unknown)', () => {
    const ctx = buildListingDecisionContext({ ...base, candidate: { ...base.candidate, listedNum: null } } as never)
    expect(ctx.demand.cjListedCount).toBeNull()
  })
})
