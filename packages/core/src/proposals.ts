import { z } from 'zod'
import { ProductHighlightsSchema, ProductSpecsSchema } from './content.ts'

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
  // v2 (spec 2026-09-01 Decision 1): the variant's own image. The agent proposes it from CJ's
  // `variantImage`; Stage 6 OVERWRITES it with the live CJ value during re-verification — same
  // trust pattern as supplierCostCents. Absent = the variant has no dedicated image.
  imageUrl: z
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'imageUrl must be http(s)')
    .optional(),
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
    // v2 structured content (spec 2026-09-01 §A1). Optional at the SCHEMA level so stored pre-v2
    // proposals and support-side payloads still parse and apply (rendering the pre-v2 page); the
    // sourcing prompt REQUIRES highlights+specs, and Stage 6 drops `sourcing.weekly` winners
    // without them (`sourcing_winner_missing_content`).
    highlights: ProductHighlightsSchema.optional(),
    specs: ProductSpecsSchema.optional(),
    whatsInBox: z.string().max(200).optional(),
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

/**
 * L1 decision-support context (spec 2026-09-03): the code-computed numbers Robert decides a
 * new_listing on — economics per variant plus demand ESTIMATES. Produced ONLY by Stage 6
 * (plain code) and stored on `proposals.decision_context`; display-only, never read by apply.
 * `profitCents` may be any integer in principle, but every producer runs AFTER the margin-floor
 * gate. `demand.*` are estimates — every renderer labels them so.
 */
export const ListingDecisionContextSchema = z.object({
  version: z.literal(1),
  economics: z.object({
    freight: z.object({
      priceCents: cents.nonnegative(),
      name: z.string(),
      minDays: z.number().int().nonnegative(),
      maxDays: z.number().int().nonnegative(),
    }),
    variants: z
      .array(
        z.object({
          sku: z.string(),
          priceCents: cents.positive(),
          supplierCostCents: cents.nonnegative(),
          landedCents: cents.nonnegative(),
          profitCents: z.number().int(),
          marginBps: z.number().int(),
        }),
      )
      .min(1),
    market: z
      .object({
        query: z.string(),
        offerCount: z.number().int().nonnegative(),
        medianCents: cents.positive(),
        typicalCents: cents.positive(),
        ceilingCents: cents.nonnegative(),
        maxPriceToMarketBps: z.number().int(),
      })
      .nullable(),
    usStockUnits: z.number().int().nonnegative().nullable(),
  }),
  demand: z.object({
    cjListedCount: z.number().int().nonnegative().nullable(),
    cjReviews: z
      .object({
        page1Count: z.number().int().nonnegative(),
        ratedCount: z.number().int().nonnegative(),
        avgRating: z.number().min(1).max(5).nullable(),
      })
      .nullable(),
    marketOfferCount: z.number().int().nonnegative().nullable(),
    trends: z.object({ keyword: z.string(), score: z.number().nullable(), momentum: z.number().nullable() }).nullable(),
    amazon: z
      .object({
        query: z.string(),
        resultsSampled: z.number().int().nonnegative(),
        medianPriceCents: cents.positive().nullable(),
        medianReviews: z.number().int().nonnegative().nullable(),
        totalReviews: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
})
export type ListingDecisionContext = z.infer<typeof ListingDecisionContextSchema>

// NOTE: z.discriminatedUnion cannot contain .refine()-wrapped members in zod v4 —
// use a plain union; the `type` literals still discriminate correctly on parse.
export const ProposalPayloadSchema = z.union([
  NewListingPayloadSchema,
  SupportReplyPayloadSchema,
  RefundPayloadSchema,
  DeprecateProductPayloadSchema,
])
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>
