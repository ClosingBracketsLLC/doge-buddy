/**
 * L1 decision-support assembly (spec 2026-09-03 Decisions 7-9): the run-scoped ReviewsSeen
 * registry (mirrors MarketLookups — code-recorded provenance for what the agent's own
 * get_reviews calls saw), trend momentum from the signal's already-stored timeline, and the
 * pure builder Stage 6 calls after its gates pass. Everything here is code-recorded or
 * code-computed; nothing agent-typed enters the context.
 */
import type { ListingDecisionContext, NewListingPayload } from '@doge-buddy/core'
import type { ShippingOption, SupplierProductReview, WarehouseStock } from '@doge-buddy/supplier'
import type { AmazonDemandSnapshot } from './demand-probe.ts'
import type { HarvestCandidate } from './harvest.ts'
import { quantileCents, type MarketLookup } from './market-price.ts'
import type { TrendSignal } from './trends.ts'

export interface ReviewsSeenEntry {
  page1Count: number
  ratedCount: number
  avgRating: number | null
}

/** Run-scoped, one per pipeline run. Page-1 only; first recording per pid wins. */
export class ReviewsSeen {
  private readonly byPid = new Map<string, ReviewsSeenEntry>()

  record(supplierProductId: string, reviews: SupplierProductReview[]): void {
    if (this.byPid.has(supplierProductId)) return
    const rated = reviews.filter((r) => typeof r.rating === 'number')
    // Fail-safe stance (reviews pipeline): average over RATED only, null when none — never fabricate stars.
    const avgRating = rated.length > 0 ? rated.reduce((s, r) => s + r.rating!, 0) / rated.length : null
    this.byPid.set(supplierProductId, { page1Count: reviews.length, ratedCount: rated.length, avgRating })
  }

  get(supplierProductId: string): ReviewsSeenEntry | undefined {
    return this.byPid.get(supplierProductId)
  }
}

/** mean(last third) − mean(first third) over the timeline's numeric values, rounded; null < 3 points. */
export function computeTrendMomentum(points: Array<{ value: number }>): number | null {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v))
  if (values.length < 3) return null
  const third = Math.ceil(values.length / 3)
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.round(mean(values.slice(-third)) - mean(values.slice(0, third)))
}

/** Defensive read of TrendSignal.snapshot.timelineData (jsonb-shaped: Record<string, unknown>). */
function timelinePoints(signal: TrendSignal | undefined): Array<{ value: number }> {
  const raw = signal?.snapshot?.['timelineData']
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is { value: number } => typeof p === 'object' && p !== null && Number.isFinite((p as { value?: unknown }).value as number))
    .map((p) => ({ value: p.value }))
}

export interface DecisionContextInput {
  payload: NewListingPayload
  freightCents: number
  freightOption: ShippingOption
  lookup: MarketLookup | null
  maxPriceToMarketBps: number
  stockRows: WarehouseStock[]
  candidate: HarvestCandidate | undefined
  trendSignal: TrendSignal | undefined
  reviews: ReviewsSeenEntry | undefined
  amazon: AmazonDemandSnapshot | null
}

export function buildListingDecisionContext(input: DecisionContextInput): ListingDecisionContext {
  const { payload, freightCents, freightOption, lookup, maxPriceToMarketBps, stockRows, candidate, trendSignal, reviews, amazon } = input

  const variants = payload.variants.map((v) => {
    const landedCents = v.supplierCostCents + freightCents
    const profitCents = v.priceCents - landedCents
    // Same integer-bps formula as the step-8 gate — floored, never rounded up.
    const marginBps = Math.floor(((v.priceCents - v.supplierCostCents - freightCents) * 10_000) / v.priceCents)
    return { sku: v.sku, priceCents: v.priceCents, supplierCostCents: v.supplierCostCents, landedCents, profitCents, marginBps }
  })

  const market =
    lookup && lookup.medianCents != null
      ? {
          query: lookup.query,
          offerCount: lookup.offerCount,
          medianCents: lookup.medianCents,
          typicalCents: quantileCents(payload.variants.map((v) => v.priceCents).sort((a, b) => a - b), 0.5),
          ceilingCents: Math.floor((lookup.medianCents * maxPriceToMarketBps) / 10_000),
          maxPriceToMarketBps,
        }
      : null

  const usRows = stockRows.filter((s) => s.countryCode === 'US')
  const usStockUnits = usRows.length > 0 ? usRows.reduce((s, r) => s + r.quantity, 0) : null

  // Live-data guard: candidate.listedNum comes raw off CJ's wire (agent-untyped, but not
  // schema-typed either) — the core schema requires a nonnegative integer. A weird live value
  // (non-integer, negative) degrades to null (unknown) rather than throwing at submit.
  const listed = candidate?.listedNum
  const cjListedCount = typeof listed === 'number' && Number.isInteger(listed) && listed >= 0 ? listed : null

  return {
    version: 1,
    economics: {
      freight: { priceCents: freightOption.priceCents, name: freightOption.name, minDays: freightOption.minDays, maxDays: freightOption.maxDays },
      variants,
      market,
      usStockUnits,
    },
    demand: {
      cjListedCount,
      cjReviews: reviews ?? null,
      marketOfferCount: lookup?.offerCount ?? null,
      trends: trendSignal ? { keyword: trendSignal.keyword, score: trendSignal.score, momentum: computeTrendMomentum(timelinePoints(trendSignal)) } : null,
      amazon,
    },
  }
}
