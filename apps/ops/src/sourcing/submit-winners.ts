import { NewListingPayloadSchema, type NewListingPayload } from '@doge-buddy/core'
import type { createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import type { SourcingWinner } from '../agents/output-schema.ts'
import type { PointsAllowance } from '../agents/points.ts'
import { submitProposal, type SubmitProposalDeps } from '../proposals/submit.ts'
import type { Settings } from '../settings.ts'
import { findClaimViolations, htmlToText, matchExcludedCategory, validateDescriptionHtml } from './guards.ts'
import type { HarvestCandidate } from './harvest.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/** How far a live CJ variant cost may drift from what the agent claimed and still pass
 * re-verification (spec §Stage 4.6) — beyond this the winner is dropped as unverifiable rather
 * than trusted; the live figure (not the agent's guess) is what fulfillment will actually pay. */
export const COST_TOLERANCE_BPS = 500

export interface SubmitWinnersDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getVariantStock' | 'quoteShipping'>
  allowance: PointsAllowance
  /** Injection seam; production passes the real submitProposal. */
  submit: typeof submitProposal
  submitDeps: SubmitProposalDeps
  settings: Settings
  alert: Alert
}

export interface WinnerOutcome {
  supplierProductId: string
  outcome: 'submitted' | 'dropped'
  reason?: string
}

export interface ValidateAndSubmitWinnersInput {
  runId: string
  candidateIds: Set<string>
  candidatesByPid: Map<string, HarvestCandidate>
  winners: SourcingWinner[]
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Stage 4 (spec §Stage 4): the plain-code gate between the sourcing agent's proposed winners and
 * a real proposal. Nothing the agent wrote is trusted — not its arithmetic, not its supplier
 * data, not its HTML, not even its choice of product. Steps run in order per winner; the first
 * failing step drops that winner (alert + continue to the next), and a `submit` throw likewise
 * drops-and-continues rather than aborting the batch.
 */
export async function validateAndSubmitWinners(
  deps: SubmitWinnersDeps,
  input: ValidateAndSubmitWinnersInput,
): Promise<WinnerOutcome[]> {
  const outcomes: WinnerOutcome[] = []
  for (const winner of input.winners) {
    outcomes.push(await processWinner(deps, input, winner))
  }
  return outcomes
}

async function processWinner(
  deps: SubmitWinnersDeps,
  input: ValidateAndSubmitWinnersInput,
  winner: SourcingWinner,
): Promise<WinnerOutcome> {
  const rawPayload = winner.payload
  const rawVariants = rawPayload.variants ?? []
  const pid = rawVariants[0]?.supplierProductId ?? ''

  const drop = async (kind: string, detail: Record<string, unknown>): Promise<WinnerOutcome> => {
    await deps.alert('warning', kind, { runId: input.runId, supplierProductId: pid, detail }).catch(() => {})
    return { supplierProductId: pid, outcome: 'dropped', reason: kind }
  }

  // Step 1: candidate-set membership. This single check transitively re-applies the harvest-side
  // dedupe/denylist/exclusion filters to everything submittable — a winner whose first variant's
  // pid isn't one of the run's harvested candidates cannot have survived those filters honestly.
  // A multi-supplier winner (variant pids disagreeing with the first) is invalid regardless.
  if (!pid || !input.candidateIds.has(pid) || !rawVariants.every((v) => v.supplierProductId === pid)) {
    return drop('sourcing_winner_not_candidate', { claimedSupplierProductId: pid })
  }

  // Step 2: re-validate the payload against the real schema. SourcingWinner's zod type already
  // implies this at parse time upstream (Stage 3), but Stage 4 re-checks because nothing here is
  // trusted — including whatever validation supposedly already ran.
  const parsed = NewListingPayloadSchema.safeParse(rawPayload)
  if (!parsed.success) {
    return drop('sourcing_winner_invalid_payload', { error: parsed.error.message })
  }
  let payload: NewListingPayload = parsed.data

  // Step 3: descriptionHtml allowlist. Agent-authored HTML later renders in the storefront, so
  // it must pass the hardcoded tag/attribute allowlist — reject on violation, never rewrite.
  const htmlIssue = validateDescriptionHtml(payload.descriptionHtml)
  if (htmlIssue) {
    return drop('sourcing_winner_bad_html', { reason: htmlIssue })
  }

  // Step 4: category exclusion re-check over the agent's title + description text + the
  // harvested categoryName recorded for this pid at harvest time (the payload has no tags
  // field of its own).
  const harvestCategoryName = input.candidatesByPid.get(pid)?.categoryName ?? null
  const excludedTerm = matchExcludedCategory(payload.title, htmlToText(payload.descriptionHtml), harvestCategoryName)
  if (excludedTerm) {
    return drop('sourcing_winner_excluded_category', { term: excludedTerm })
  }

  // Step 5: claims scrubber over every owner-facing string the pipeline emits — title,
  // description text, and rationale. Rejects, never rewrites.
  const claimHits = findClaimViolations(payload.title, htmlToText(payload.descriptionHtml), winner.rationale)
  if (claimHits.length > 0) {
    return drop('claims_scrubbed', { terms: claimHits })
  }

  // Step 6: ground-truth re-verification against CJ (spends from the run's shared allowance).
  // Every payload variant's supplierVariantId must exist under the live product; live cost must
  // be within tolerance of the agent's claimed cost — on pass, the LIVE figure overwrites the
  // payload (fulfillment pays what CJ actually charges, never the agent's guess). Verified US
  // stock is checked on the first variant only, mirroring the order-time gate's stock pool.
  try {
    deps.allowance.spend(10, `verify:${pid}`)
    const detail = await deps.adapter.getProduct(pid)
    const liveByVid = new Map(detail.variants.map((v) => [v.supplierVariantId, v]))

    for (const v of payload.variants) {
      const live = liveByVid.get(v.supplierVariantId)
      if (!live) {
        throw new Error(`unknown supplierVariantId ${v.supplierVariantId} at CJ`)
      }
      const driftBps = (Math.abs(live.priceCents - v.supplierCostCents) * 10_000) / v.supplierCostCents
      if (driftBps > COST_TOLERANCE_BPS) {
        throw new Error(
          `live cost ${live.priceCents}c drifted beyond ${COST_TOLERANCE_BPS}bps from claimed ${v.supplierCostCents}c for ${v.supplierVariantId}`,
        )
      }
    }

    payload = {
      ...payload,
      variants: payload.variants.map((v) => ({
        ...v,
        supplierCostCents: liveByVid.get(v.supplierVariantId)!.priceCents,
      })),
    }

    deps.allowance.spend(10, `stock:${pid}`)
    const firstVid = payload.variants[0]!.supplierVariantId
    const stock = await deps.adapter.getVariantStock(firstVid)
    const hasUsStock = stock.some((s) => s.countryCode === 'US' && s.quantity >= 1)
    if (!hasUsStock) {
      throw new Error(`no verified US stock (qty >= 1) for ${firstVid}`)
    }
  } catch (err) {
    return drop('sourcing_winner_unverifiable', { error: errMessage(err) })
  }

  // Step 7: freight-inclusive margin re-check, mirroring the live fulfillment gate in plan.ts
  // exactly: `Math.floor(((total - projected) * 10_000) / total)` — integer bps, floored, never
  // rounded, so a margin a hair under the floor never gets rounded up into a false pass.
  let freightCents: number
  try {
    deps.allowance.spend(10, `freight:${pid}`)
    const firstVid = payload.variants[0]!.supplierVariantId
    const options = await deps.adapter.quoteShipping({
      fromCountry: 'CN',
      toCountry: 'US',
      items: [{ supplierVariantId: firstVid, quantity: 1 }],
    })
    const eligible = options.filter((o) => o.maxDays <= payload.deliveryMaxDays)
    if (eligible.length === 0) {
      throw new Error('no freight within window')
    }
    freightCents = Math.min(...eligible.map((o) => o.priceCents))
  } catch (err) {
    return drop('sourcing_winner_margin_below_floor', { error: errMessage(err) })
  }

  const marginFloorBps = await deps.settings.get('fulfillment.margin_floor_bps')
  let minMarginBps = Infinity
  for (const v of payload.variants) {
    const marginBps = Math.floor(((v.priceCents - v.supplierCostCents - freightCents) * 10_000) / v.priceCents)
    if (marginBps < marginFloorBps) {
      return drop('sourcing_winner_margin_below_floor', { marginBps, marginFloorBps, sku: v.sku })
    }
    if (marginBps < minMarginBps) minMarginBps = marginBps
  }

  // Step 8: submit. The summary is composed by plain code from the already-scrubbed title and
  // the code-computed margin, never from free agent text.
  const summary = `New listing: ${payload.title} — ${payload.variants.length} variant(s), margin ${minMarginBps}bps`
  try {
    await deps.submit(deps.submitDeps, {
      type: 'new_listing',
      summary,
      payload,
      sourceWorkflow: 'sourcing.weekly',
      agentRunId: input.runId,
    })
  } catch (err) {
    return drop('sourcing_winner_submit_failed', { error: errMessage(err) })
  }

  return { supplierProductId: pid, outcome: 'submitted' }
}
