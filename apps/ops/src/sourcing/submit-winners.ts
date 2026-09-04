import { formatCents, NewListingPayloadSchema, type NewListingPayload } from '@doge-buddy/core'
import type { createDb } from '@doge-buddy/db'
import type { ShippingOption, SupplierAdapter, WarehouseStock } from '@doge-buddy/supplier'
import type { SourcingWinner } from '../agents/output-schema.ts'
import type { PointsAllowance } from '../agents/points.ts'
import { submitProposal, type SubmitProposalDeps } from '../proposals/submit.ts'
import type { Settings } from '../settings.ts'
import { buildListingDecisionContext, type ReviewsSeen } from './decision-context.ts'
import type { AmazonDemandSnapshot, DemandProbeProvider } from './demand-probe.ts'
import { findClaimViolations, htmlToText, matchExcludedCategory, validateDescriptionHtml } from './guards.ts'
import type { HarvestCandidate } from './harvest.ts'
import { quantileCents, type MarketLookup, type MarketLookups } from './market-price.ts'
import type { TrendSignal } from './trends.ts'

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
  /** The run's recorded market lookups, or null when the market-price provider was absent this
   *  run (no SERPAPI_KEY) — null SKIPS step 6 entirely (spec Decision 5). Required, not optional:
   *  every caller must decide, absence is not a default. */
  marketLookups: MarketLookups | null
  /** Amazon demand cross-check provider, or null when the market-price provider was absent this
   *  run (no SERPAPI_KEY) — null SKIPS step 8b's probe entirely (same stance as `marketLookups`).
   *  Required, not optional: every caller must decide, absence is not a default. */
  demandProbe: DemandProbeProvider | null
  /** Run-scoped registry of what the agent's own get_reviews calls actually saw (spec 2026-09-03
   *  Decision 8) — code-recorded provenance, mirroring `marketLookups`. Required, not optional. */
  reviewsSeen: ReviewsSeen
  /** Trend signals fetched once per run keyed by keyword (spec 2026-09-03 Decision 9) — display
   *  support only, never a gate input. Required, not optional: every caller must decide. */
  trendSignalsByKeyword: Map<string, TrendSignal>
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
  /** Resolved `sourcing.max_price_to_market_bps` knob (Stage 0) — the step-6 ceiling in bps. */
  maxPriceToMarketBps: number
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

  // Step 2b: v2 content gate (spec 2026-09-01 §A3). Every winner in THIS pipeline is a
  // `sourcing.weekly` submission (see the hardcoded sourceWorkflow at the submit call below), and
  // the prompt demands highlights + specs — a winner without them is an agent that ignored the
  // task, not a legacy payload (legacy/support payloads enter via submitProposal directly and
  // never pass through here; they parse and apply fine without content, rendering the pre-v2 page).
  if (!payload.highlights || !payload.specs) {
    return drop('sourcing_winner_missing_content', {
      hasHighlights: Boolean(payload.highlights),
      hasSpecs: Boolean(payload.specs),
    })
  }

  // Step 3: descriptionHtml allowlist. Agent-authored HTML later renders in the storefront, so
  // it must pass the hardcoded tag/attribute allowlist — reject on violation, never rewrite.
  const htmlIssue = validateDescriptionHtml(payload.descriptionHtml)
  if (htmlIssue) {
    return drop('sourcing_winner_bad_html', { reason: htmlIssue })
  }

  // v2: the structured-content strings ride through BOTH text gates below exactly like
  // title/description (spec 2026-09-01 §A3). Labels are scanned as well as values — a claim
  // smuggled into a label is still our publication (small deliberate widening of the spec's
  // "values" wording, same reject stance).
  const contentStrings = [
    ...(payload.highlights ?? []),
    ...(payload.specs ?? []).flatMap((s) => [s.label, s.value]),
    payload.whatsInBox,
  ]

  // Step 4: category exclusion re-check over the agent's title + description text + the
  // harvested categoryName recorded for this pid at harvest time (the payload has no tags
  // field of its own).
  const harvestCategoryName = input.candidatesByPid.get(pid)?.categoryName ?? null
  const excludedTerm = matchExcludedCategory(
    payload.title,
    htmlToText(payload.descriptionHtml),
    harvestCategoryName,
    ...contentStrings,
  )
  if (excludedTerm) {
    return drop('sourcing_winner_excluded_category', { term: excludedTerm })
  }

  // Step 5: claims scrubber over every owner-facing string the pipeline emits — title,
  // description text, and rationale. Rejects, never rewrites.
  const claimHits = findClaimViolations(payload.title, htmlToText(payload.descriptionHtml), winner.rationale, ...contentStrings)
  if (claimHits.length > 0) {
    return drop('claims_scrubbed', { terms: claimHits })
  }

  // Step 6: price-to-market gate (spec 2026-09-01 market-price §6 / Decisions 2-5). Runs BEFORE
  // the CJ steps because it is free — a registry read — while steps 7-8 spend CJ points. Reads
  // ONLY what the tool handler recorded (MarketLookups), never a number the agent typed; the
  // agent's marketLookupId is a key, and a key for the wrong product is as dead as no key.
  let marketClause = ''
  let marketLookup: MarketLookup | null = null
  let amazon: AmazonDemandSnapshot | null = null
  if (deps.marketLookups !== null) {
    const lookup = winner.marketLookupId ? deps.marketLookups.get(winner.marketLookupId) : undefined
    if (!lookup || lookup.supplierProductId !== pid || lookup.medianCents == null) {
      const reason = !lookup ? 'missing' : lookup.supplierProductId !== pid ? 'pid_mismatch' : 'inconclusive'
      return drop('sourcing_winner_no_market_price', {
        marketLookupId: winner.marketLookupId ?? null,
        reason,
        query: lookup?.query,
        offerCount: lookup?.offerCount,
      })
    }
    // Integer bps arithmetic, floored — a ceiling a hair under is never rounded up (mirrors step 8).
    const ceilingCents = Math.floor((lookup.medianCents * input.maxPriceToMarketBps) / 10_000)
    const typicalCents = quantileCents(payload.variants.map((v) => v.priceCents).sort((a, b) => a - b), 0.5)
    if (typicalCents > ceilingCents) {
      return drop('sourcing_winner_price_above_market', {
        typicalCents,
        medianCents: lookup.medianCents,
        ceilingCents,
        maxPriceToMarketBps: input.maxPriceToMarketBps,
        query: lookup.query,
        offerCount: lookup.offerCount,
      })
    }
    marketClause = `, market $${(lookup.medianCents / 100).toFixed(2)} median ×${(typicalCents / lookup.medianCents).toFixed(2)}`
    marketLookup = lookup

    // Step 6b: the AMAZON ceiling (owner ruling 2026-09-03, the $140-stroller-vs-$47-Amazon
    // catch). Google Shopping's MEDIAN is inflated by premium brands in wide-spread categories,
    // so the same maxPriceToMarketBps ratio is ALSO enforced against Amazon's median price for
    // the identical shopper query — the number buyers actually comparison-shop against. The
    // probe was display-only before (L1 Decision 5); it now bites. Probe failure/inconclusive
    // degrades to display-null and no Amazon gate — same absence semantics as SerpApi-less runs.
    if (deps.demandProbe) {
      try {
        amazon = await deps.demandProbe.probe(lookup.query)
      } catch (err) {
        await deps.alert('info', 'demand_probe_failed', { runId: input.runId, supplierProductId: pid, error: errMessage(err) }).catch(() => {})
      }
      if (amazon?.medianPriceCents != null) {
        const amazonCeilingCents = Math.floor((amazon.medianPriceCents * input.maxPriceToMarketBps) / 10_000)
        if (typicalCents > amazonCeilingCents) {
          return drop('sourcing_winner_price_above_market', {
            source: 'amazon',
            typicalCents,
            amazonMedianCents: amazon.medianPriceCents,
            ceilingCents: amazonCeilingCents,
            maxPriceToMarketBps: input.maxPriceToMarketBps,
            query: lookup.query,
            resultsSampled: amazon.resultsSampled,
          })
        }
      }
    }
  }

  // Step 7: ground-truth re-verification against CJ (spends from the run's shared allowance).
  // Every payload variant's supplierVariantId must exist under the live product; live cost must
  // be within tolerance of the agent's claimed cost — on pass, the LIVE figure overwrites the
  // payload (fulfillment pays what CJ actually charges, never the agent's guess). Verified US
  // stock is checked on the first variant only, mirroring the order-time gate's stock pool.
  let stockRows: WarehouseStock[] = []
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
      variants: payload.variants.map((v) => {
        const live = liveByVid.get(v.supplierVariantId)!
        // v2 (spec 2026-09-01 Decision 1): the LIVE CJ variant image replaces whatever the agent
        // proposed — undefined CLEARS it (a variant CJ shows no image for gets none), and a
        // non-http(s) live value is treated as absent so this overwrite can never plant an
        // unfetchable URL in the payload. Same trust pattern as the cost overwrite above.
        const liveImage =
          live.imageUrl && (live.imageUrl.startsWith('http://') || live.imageUrl.startsWith('https://'))
            ? live.imageUrl
            : undefined
        return { ...v, supplierCostCents: live.priceCents, imageUrl: liveImage }
      }),
    }

    deps.allowance.spend(10, `stock:${pid}`)
    const firstVid = payload.variants[0]!.supplierVariantId
    const stock = await deps.adapter.getVariantStock(firstVid)
    stockRows = stock
    const hasUsStock = stock.some((s) => s.countryCode === 'US' && s.quantity >= 1)
    if (!hasUsStock) {
      throw new Error(`no verified US stock (qty >= 1) for ${firstVid}`)
    }
  } catch (err) {
    return drop('sourcing_winner_unverifiable', { error: errMessage(err) })
  }

  // Step 8: freight-inclusive margin re-check, mirroring the live fulfillment gate in plan.ts
  // exactly: `Math.floor(((total - projected) * 10_000) / total)` — integer bps, floored, never
  // rounded, so a margin a hair under the floor never gets rounded up into a false pass.
  let freightCents: number
  let freightOption: ShippingOption
  try {
    deps.allowance.spend(10, `freight:${pid}`)
    const firstVid = payload.variants[0]!.supplierVariantId
    const options = await deps.adapter.quoteShipping({
      // US-origin freight, mirroring the live order-time gate in run-place-order.ts: these listings
      // are shipsFrom:'US' and Stage 4.6 verified US stock above, so freight must be quoted from US.
      // A CN quote returns China-origin (~15-30 day) options that all fail the deliveryMaxDays
      // filter below, silently dropping every real winner (FIX C5).
      fromCountry: 'US',
      toCountry: 'US',
      items: [{ supplierVariantId: firstVid, quantity: 1 }],
    })
    const eligible = options.filter((o) => o.maxDays <= payload.deliveryMaxDays)
    if (eligible.length === 0) {
      throw new Error('no freight within window')
    }
    const chosen = eligible.reduce((a, b) => (b.priceCents < a.priceCents ? b : a))
    freightOption = chosen
    freightCents = chosen.priceCents
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

  // Step 8b: decision context (spec 2026-09-03 Decisions 5, 8, 11). The Amazon snapshot was
  // fetched at step 6b (where it now also GATES price — owner ruling 2026-09-03); here it is
  // reused for display, never re-probed.
  const candidate = input.candidatesByPid.get(pid)
  const decisionContext = buildListingDecisionContext({
    payload,
    freightCents,
    freightOption,
    lookup: marketLookup,
    maxPriceToMarketBps: input.maxPriceToMarketBps,
    stockRows,
    candidate,
    trendSignal: candidate ? deps.trendSignalsByKeyword.get(candidate.keyword) : undefined,
    reviews: deps.reviewsSeen.get(pid),
    amazon,
  })

  // Step 9: summary stays code-composed. Profit range + estimate clauses; null sources are
  // OMITTED, never rendered as 0 — an absent number must read as unknown.
  const profits = decisionContext.economics.variants.map((v) => v.profitCents)
  const minProfit = Math.min(...profits)
  const maxProfit = Math.max(...profits)
  const profitClause = minProfit === maxProfit ? `, profit ${formatCents(minProfit)}` : `, profit ${formatCents(minProfit)}–${formatCents(maxProfit)}`
  const estParts: string[] = []
  if (decisionContext.demand.amazon?.medianReviews != null) estParts.push(`amzn ~${decisionContext.demand.amazon.medianReviews} reviews`)
  if (decisionContext.demand.cjListedCount != null) estParts.push(`CJ ${decisionContext.demand.cjListedCount} listed`)
  if (decisionContext.demand.trends?.score != null) {
    const momentum = decisionContext.demand.trends.momentum
    estParts.push(`trends ${Math.round(decisionContext.demand.trends.score)}${momentum != null ? ` (${momentum >= 0 ? '+' : ''}${momentum})` : ''}`)
  }
  const estClause = estParts.length > 0 ? ` | est: ${estParts.join(', ')}` : ''
  const summary = `New listing: ${payload.title} — ${payload.variants.length} variant(s), ${payload.imageUrls.length} image(s), margin ${minMarginBps}bps${marketClause}${profitClause}${estClause}`
  try {
    await deps.submit(deps.submitDeps, {
      type: 'new_listing',
      summary,
      payload,
      sourceWorkflow: 'sourcing.weekly',
      agentRunId: input.runId,
      decisionContext,
    })
  } catch (err) {
    return drop('sourcing_winner_submit_failed', { error: errMessage(err) })
  }

  return { supplierProductId: pid, outcome: 'submitted' }
}
