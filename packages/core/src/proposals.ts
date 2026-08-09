import { z } from 'zod'

export const PROPOSAL_TYPES = ['new_listing', 'support_reply', 'refund', 'deprecate_product'] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

export const CATEGORY_TAGS = ['toys', 'walks', 'beds', 'grooming'] as const
export type CategoryTag = (typeof CATEGORY_TAGS)[number]

export const SUPPLIER_KEYS = ['cj', 'mock'] as const
export type SupplierKey = (typeof SUPPLIER_KEYS)[number]

const cents = z.number().int('must be integer cents')

const listingVariant = z.object({
  sku: z.string().min(1),
  priceCents: cents.positive(),
  compareAtCents: cents.positive().optional(),
  supplierCostCents: cents.positive(),
  supplier: z.enum(SUPPLIER_KEYS),
  supplierProductId: z.string().min(1),
  supplierVariantId: z.string().min(1),
})

export const NewListingPayloadSchema = z
  .object({
    type: z.literal('new_listing'),
    title: z.string().min(1).max(255),
    descriptionHtml: z.string().min(1),
    categoryTag: z.enum(CATEGORY_TAGS),
    imageUrls: z.array(z.string().url()).min(1),
    shipsFrom: z.literal('US'),
    deliveryMinDays: z.number().int().min(1),
    deliveryMaxDays: z.number().int().min(1),
    variants: z.array(listingVariant).min(1),
  })
  .refine((p) => p.deliveryMinDays <= p.deliveryMaxDays, {
    message: 'deliveryMinDays must be <= deliveryMaxDays',
    path: ['deliveryMinDays'],
  })
export type NewListingPayload = z.infer<typeof NewListingPayloadSchema>

export const SupportReplyPayloadSchema = z.object({
  type: z.literal('support_reply'),
  ticketId: z.string().uuid(),
  body: z.string().min(1),
})
export type SupportReplyPayload = z.infer<typeof SupportReplyPayloadSchema>

export const RefundPayloadSchema = z
  .object({
    type: z.literal('refund'),
    orderId: z.string().uuid(),
    shopifyOrderGid: z.string().startsWith('gid://shopify/Order/'),
    amountCents: cents.positive(),
    reason: z.string().min(1),
    openCjDispute: z.boolean(),
    cjDisputeReasonId: z.string().min(1).optional(),
  })
  .refine((p) => !p.openCjDispute || p.cjDisputeReasonId !== undefined, {
    message: 'cjDisputeReasonId is required when openCjDispute is true',
    path: ['cjDisputeReasonId'],
  })
export type RefundPayload = z.infer<typeof RefundPayloadSchema>

export const DeprecateProductPayloadSchema = z.object({
  type: z.literal('deprecate_product'),
  productId: z.string().uuid(),
  evidence: z.object({
    unitsSold28d: z.number().int().min(0),
    refundCount28d: z.number().int().min(0),
    ticketCount28d: z.number().int().min(0),
    daysLive: z.number().int().min(0),
    reasoning: z.string().optional(),
  }),
})
export type DeprecateProductPayload = z.infer<typeof DeprecateProductPayloadSchema>

// NOTE: z.discriminatedUnion cannot contain .refine()-wrapped members in zod v4 —
// use a plain union; the `type` literals still discriminate correctly on parse.
export const ProposalPayloadSchema = z.union([
  NewListingPayloadSchema,
  SupportReplyPayloadSchema,
  RefundPayloadSchema,
  DeprecateProductPayloadSchema,
])
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>
