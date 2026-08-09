import { describe, expect, it } from 'vitest'
import { ProposalPayloadSchema, NewListingPayloadSchema, RefundPayloadSchema } from '@doge-buddy/core'

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
  }
  it('accepts a refund with a CJ dispute + reason id', () => {
    expect(RefundPayloadSchema.parse(validRefund).amountCents).toBe(1999)
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
