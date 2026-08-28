import { z } from 'zod'

/**
 * The `refund` shape is its own schema (rather than inlined) so the
 * openCjDispute-requires-cjDisputeReasonId cross-field rule can be attached with `.refine()`.
 * This is UNTRUSTED — the plain-code validator (`support/validator.ts`) re-derives the order
 * total, re-sums prior applied refunds, and re-checks sender authentication before anything is
 * submitted; this schema only bounds shape and the one rule JSON Schema can't express on its own.
 */
const SupportRefundSchema = z
  .object({
    amountCents: z.number().int().positive(),
    reason: z.string().min(1).max(500),
    openCjDispute: z.boolean(),
    cjDisputeReasonId: z.string().min(1).optional(),
  })
  .refine((r) => !r.openCjDispute || !!r.cjDisputeReasonId, {
    message: 'cjDisputeReasonId is required when openCjDispute is true',
    path: ['cjDisputeReasonId'],
  })

/**
 * The support agent's structured output: propose a reply (optionally bundled with a refund),
 * escalate to a human, or take no action. `refund` only exists inside the `propose` branch, which
 * REQUIRES `reply` — a model that tries to propose a refund without a customer-facing reply body
 * fails this schema, not just the validator.
 */
export const SupportOutputSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('propose'),
    reply: z.object({ body: z.string().min(1).max(4000) }),
    refund: SupportRefundSchema.optional(),
    rationale: z.string().min(1).max(2000),
  }),
  z.object({
    outcome: z.literal('escalate'),
    escalationReason: z.string().min(1).max(500),
    rationale: z.string().min(1).max(2000),
  }),
  z.object({
    outcome: z.literal('no_action'),
    rationale: z.string().min(1).max(2000),
  }),
])
export type SupportOutput = z.infer<typeof SupportOutputSchema>

/**
 * JSON Schema handed to the SDK as `outputFormat.schema`. Bridged from the zod schema via
 * `z.toJSONSchema` (zod v4) so the model's structured-output contract stays in lockstep with the
 * zod schema the runner parses the result against.
 *
 * `target: 'draft-7'` is load-bearing: zod v4 defaults to draft-2020-12, and the Agent SDK's
 * subprocess validator (ajv) ships draft-07 as its built-in meta-schema but NOT 2020-12, so a
 * default-target schema is rejected at runtime with "no schema with key or ref
 * https://json-schema.org/draft/2020-12/schema" (see `agents/output-schema.ts`'s doc comment —
 * found in the first live Tier-2 run there). draft-7 output is fully inlined here (no $ref/$defs),
 * and the `.refine` on `SupportRefundSchema` (openCjDispute ⇒ cjDisputeReasonId) drops out of the
 * generated JSON Schema — harmless, since `support/validator.ts` re-checks that exact rule (as
 * `refund_dispute_reason_required`) against the DB-backed refund object before anything is
 * submitted, same as every other rule in this file.
 */
export const SUPPORT_OUTPUT_JSON_SCHEMA = z.toJSONSchema(SupportOutputSchema, { target: 'draft-7' })
