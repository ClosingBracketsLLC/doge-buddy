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
    imageUrls: z
      .array(
        z
          .url()
          .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'imageUrls must be http(s)'),
      )
      .min(1),
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

/**
 * The thread snapshot the drafting run actually saw — the ticket's `last_inbound_at` as read under
 * the run's CAS claim (6B §1 `threadSnapshotAt`), ISO-8601. REQUIRED on both support payloads:
 * the apply executors compare it against the ticket's current `last_inbound_at` to detect a reply
 * drafted against a thread the customer has since added to (a stale draft must not send), and a
 * proposal that carried no snapshot could not be checked at all. It lives INSIDE the payload
 * because `proposals` has no column for it and these schemas are strict.
 */
const threadSnapshotAt = z.iso.datetime()

export const SupportReplyPayloadSchema = z.object({
  type: z.literal('support_reply'),
  ticketId: z.string().uuid(),
  body: z.string().min(1),
  threadSnapshotAt,
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
    threadSnapshotAt,
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
