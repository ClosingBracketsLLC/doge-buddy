import { NewListingPayloadSchema } from '@doge-buddy/core'
import { z } from 'zod'

/**
 * One agent-proposed winner: a complete `new_listing` payload draft plus the agent's supporting
 * numbers. Everything here is UNTRUSTED — Stage 4 (plain code) re-validates the payload, re-derives
 * the margin, re-quotes freight, and re-verifies against CJ before anything is submitted. These
 * fields exist so the transcript/admin page can show the agent's reasoning, not because the pipeline
 * trusts them.
 */
export const SourcingWinnerSchema = z.object({
  payload: NewListingPayloadSchema, // from @doge-buddy/core
  rationale: z.string().min(1).max(2000),
  marginPct: z.number(),
  freightEstimateCents: z.number().int().nonnegative(),
})
export type SourcingWinner = z.infer<typeof SourcingWinnerSchema>

/** The agent's structured output: ≤3 winners plus optional free-text notes. */
export const SourcingOutputSchema = z.object({
  winners: z.array(SourcingWinnerSchema).max(3),
  notes: z.string().max(2000).optional(),
})
export type SourcingOutput = z.infer<typeof SourcingOutputSchema>

/**
 * JSON Schema handed to the SDK as `outputFormat.schema`. Bridged from the zod schema via
 * `z.toJSONSchema` (zod v4) so the model's structured-output contract stays in lockstep with the
 * zod schema the runner parses the result against.
 */
export const SOURCING_OUTPUT_JSON_SCHEMA = z.toJSONSchema(SourcingOutputSchema)
