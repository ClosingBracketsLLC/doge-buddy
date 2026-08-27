import { describe, expect, it } from 'vitest'
import {
  ProposalPayloadSchema, NewListingPayloadSchema, RefundPayloadSchema, SupportReplyPayloadSchema,
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
