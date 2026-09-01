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

/** The cap the sourcing agent has always run with — the `sourcing.max_winners` setting default and
 * what every caller that does not resolve knobs still gets. */
export const DEFAULT_MAX_WINNERS = 3

/**
 * The agent's structured output: ≤ `maxWinners` winners plus optional free-text notes. A factory
 * (spec 2026-08-31 catalog-p0 §5) because a catalog-build run raises the cap for that run only —
 * the shape is identical at every cap, only `.max()` moves.
 */
export function sourcingOutputSchema(maxWinners: number) {
  return z.object({
    winners: z.array(SourcingWinnerSchema).max(maxWinners),
    notes: z.string().max(2000).optional(),
  })
}

/** The default-cap schema. Kept as a named export so untouched callers/tests keep compiling. */
export const SourcingOutputSchema = sourcingOutputSchema(DEFAULT_MAX_WINNERS)
export type SourcingOutput = z.infer<ReturnType<typeof sourcingOutputSchema>>

/**
 * JSON Schema handed to the SDK as `outputFormat.schema`. Bridged from the zod schema via
 * `z.toJSONSchema` (zod v4) so the model's structured-output contract stays in lockstep with the
 * zod schema the runner parses the result against.
 *
 * `target: 'draft-7'` is load-bearing: zod v4 defaults to draft-2020-12, and the Agent SDK's
 * subprocess validator (ajv) ships draft-07 as its built-in meta-schema but NOT 2020-12, so a
 * default-target schema is rejected at runtime with "no schema with key or ref
 * https://json-schema.org/draft/2020-12/schema" (found in the first live Tier-2 run — the mocked
 * SDK in the unit tests never exercises this). draft-7 output is fully inlined here (no $ref/$defs),
 * and the zod `.refine`s that JSON Schema can't express drop out — harmless, since Stage 4
 * re-validates every winner against the full zod schema before anything is submitted.
 */
export function sourcingOutputJsonSchema(maxWinners: number): Record<string, unknown> {
  return z.toJSONSchema(sourcingOutputSchema(maxWinners), { target: 'draft-7' })
}

/** The default-cap JSON Schema. Kept as a named export for untouched callers/tests. */
export const SOURCING_OUTPUT_JSON_SCHEMA = sourcingOutputJsonSchema(DEFAULT_MAX_WINNERS)
