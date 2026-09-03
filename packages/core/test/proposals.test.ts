import { describe, expect, it } from 'vitest'
import {
  ProposalPayloadSchema, NewListingPayloadSchema, RefundPayloadSchema, SupportReplyPayloadSchema,
  ListingDecisionContextSchema,
} from '@doge-buddy/core'

const validListing = {
  type: 'new_listing',
  title: 'Tug-O-War Rope Toy',
  descriptionHtml: '<p>Durable rope toy for medium dogs.</p>',
  categoryTag: 'toys',
  imageUrls: ['https://cdn.example.com/rope.jpg'],
  shipsFrom: 'US',
  deliveryMinDays: 3,
  deliveryMaxDays: 7,
  variants: [
    {
      sku: 'DB-ROPE-01',
      priceCents: 1999,
      compareAtCents: 2499,
      supplierCostCents: 620,
      supplier: 'cj',
      supplierProductId: 'pid123',
      supplierVariantId: 'vid456',
    },
  ],
} as const

describe('NewListingPayloadSchema', () => {
  it('accepts a complete listing draft', () => {
    expect(NewListingPayloadSchema.parse(validListing)).toMatchObject({ title: 'Tug-O-War Rope Toy' })
  })
  it('rejects empty variants, bad category, non-integer cents, min>max delivery', () => {
    expect(NewListingPayloadSchema.safeParse({ ...validListing, variants: [] }).success).toBe(false)
    expect(NewListingPayloadSchema.safeParse({ ...validListing, categoryTag: 'cats' }).success).toBe(false)
    expect(
      NewListingPayloadSchema.safeParse({
        ...validListing,
        variants: [{ ...validListing.variants[0], priceCents: 19.99 }],
      }).success,
    ).toBe(false)
    expect(
      NewListingPayloadSchema.safeParse({ ...validListing, deliveryMinDays: 9, deliveryMaxDays: 7 }).success,
    ).toBe(false)
  })

  it('rejects imageUrls that are not http(s) (javascript:/data: schemes)', () => {
    expect(
      NewListingPayloadSchema.safeParse({ ...validListing, imageUrls: ['javascript:alert(1)'] }).success,
    ).toBe(false)
    expect(
      NewListingPayloadSchema.safeParse({ ...validListing, imageUrls: ['data:text/html;x'] }).success,
    ).toBe(false)
  })

  it('accepts an https imageUrls entry', () => {
    expect(
      NewListingPayloadSchema.safeParse({
        ...validListing,
        imageUrls: ['https://cf.cjdropshipping.com/x.png'],
      }).success,
    ).toBe(true)
  })
})

describe('SupportReplyPayloadSchema', () => {
  const validReply = {
    type: 'support_reply',
    ticketId: '4b4e6ac8-3e37-4f6e-9e0a-0a4bbf9a4a11',
    body: 'Thanks for writing in.',
    threadSnapshotAt: '2026-08-27T12:00:00.000Z',
  }
  it('accepts a reply carrying its thread snapshot', () => {
    expect(SupportReplyPayloadSchema.parse(validReply).threadSnapshotAt).toBe('2026-08-27T12:00:00.000Z')
  })
  it('requires threadSnapshotAt as an ISO datetime — the apply staleness guard has nothing to compare without it', () => {
    expect(SupportReplyPayloadSchema.safeParse({ ...validReply, threadSnapshotAt: undefined }).success).toBe(false)
    expect(SupportReplyPayloadSchema.safeParse({ ...validReply, threadSnapshotAt: '2026-08-27' }).success).toBe(false)
  })
})

describe('RefundPayloadSchema', () => {
  const validRefund = {
    type: 'refund',
    orderId: '4b4e6ac8-3e37-4f6e-9e0a-0a4bbf9a4a11',
    shopifyOrderGid: 'gid://shopify/Order/123',
    amountCents: 1999,
    reason: 'Item arrived damaged',
    openCjDispute: true,
    cjDisputeReasonId: 'r42',
    threadSnapshotAt: '2026-08-27T12:00:00.000Z',
  }
  it('accepts a refund with a CJ dispute + reason id', () => {
    expect(RefundPayloadSchema.parse(validRefund).amountCents).toBe(1999)
  })
  it('requires threadSnapshotAt as an ISO datetime', () => {
    expect(RefundPayloadSchema.safeParse({ ...validRefund, threadSnapshotAt: undefined }).success).toBe(false)
    expect(RefundPayloadSchema.safeParse({ ...validRefund, threadSnapshotAt: 'yesterday' }).success).toBe(false)
  })
  it('requires cjDisputeReasonId when openCjDispute is true', () => {
    expect(RefundPayloadSchema.safeParse({ ...validRefund, cjDisputeReasonId: undefined }).success).toBe(false)
    expect(
      RefundPayloadSchema.safeParse({ ...validRefund, openCjDispute: false, cjDisputeReasonId: undefined }).success,
    ).toBe(true)
  })
})

describe('ProposalPayloadSchema union', () => {
  it('discriminates on type', () => {
    const parsed = ProposalPayloadSchema.parse(validListing)
    expect(parsed.type).toBe('new_listing')
    expect(ProposalPayloadSchema.safeParse({ type: 'bogus' }).success).toBe(false)
  })
})

describe('NewListingPayloadSchema v2 fields', () => {
  const base = {
    type: 'new_listing' as const,
    title: 'Rope Toy',
    descriptionHtml: '<p>A rope toy.</p>',
    categoryTag: 'toys' as const,
    imageUrls: ['https://cdn.example.com/a.jpg'],
    shipsFrom: 'US' as const,
    deliveryMinDays: 3,
    deliveryMaxDays: 7,
    variants: [
      {
        sku: 'ROPE-1',
        priceCents: 1999,
        supplierCostCents: 500,
        supplier: 'cj' as const,
        supplierProductId: 'pid-1',
        supplierVariantId: 'vid-1',
      },
    ],
  }

  it('still parses a legacy payload without any v2 field (stored pre-v2 proposals must keep applying)', () => {
    expect(NewListingPayloadSchema.safeParse(base).success).toBe(true)
  })

  it('parses a full v2 payload', () => {
    const parsed = NewListingPayloadSchema.safeParse({
      ...base,
      highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
      specs: [{ label: 'Material', value: 'Cotton' }],
      whatsInBox: '1x rope toy',
      variants: [{ ...base.variants[0], imageUrl: 'https://cdn.example.com/v1.jpg' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a non-http(s) variant imageUrl', () => {
    const parsed = NewListingPayloadSchema.safeParse({
      ...base,
      variants: [{ ...base.variants[0], imageUrl: 'ftp://cdn.example.com/v1.jpg' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects whatsInBox over 200 chars', () => {
    expect(NewListingPayloadSchema.safeParse({ ...base, whatsInBox: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('ListingDecisionContextSchema', () => {
  const validContext = {
    version: 1,
    economics: {
      freight: { priceCents: 649, name: 'USPS Ground', minDays: 3, maxDays: 7 },
      variants: [{ sku: 'DB-1', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: 4743 }],
      market: { query: 'dog water bottle', offerCount: 12, medianCents: 2199, typicalCents: 2399, ceilingCents: 2858, maxPriceToMarketBps: 13000 },
      usStockUnits: 214,
    },
    demand: {
      cjListedCount: 1200,
      cjReviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
      marketOfferCount: 12,
      trends: { keyword: 'dog leash', score: 62.1, momentum: 8 },
      amazon: { query: 'dog water bottle', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000, },
    },
  }

  it('accepts a fully populated context', () => {
    expect(ListingDecisionContextSchema.safeParse(validContext).success).toBe(true)
  })
  it('accepts every nullable source as null (market-gate-skipped run)', () => {
    const degraded = {
      ...validContext,
      economics: { ...validContext.economics, market: null, usStockUnits: null },
      demand: { cjListedCount: null, cjReviews: null, marketOfferCount: null, trends: null, amazon: null },
    }
    expect(ListingDecisionContextSchema.safeParse(degraded).success).toBe(true)
  })
  it('rejects version 2 and missing economics', () => {
    expect(ListingDecisionContextSchema.safeParse({ ...validContext, version: 2 }).success).toBe(false)
    expect(ListingDecisionContextSchema.safeParse({ version: 1, demand: validContext.demand }).success).toBe(false)
  })
  it('rejects non-integer cents', () => {
    const bad = structuredClone(validContext)
    bad.economics.variants[0]!.priceCents = 23.99
    expect(ListingDecisionContextSchema.safeParse(bad).success).toBe(false)
  })
})
