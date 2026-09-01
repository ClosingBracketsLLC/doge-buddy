/**
 * Market-price lookup for the sourcing agent (spec 2026-09-01 market-price §2). The PROVIDER
 * fetches Google Shopping offers via the shared SerpApiClient; the REGISTRY records every lookup
 * the MCP tool makes, run-scoped (one instance per pipeline run, like PointsAllowance), so Stage 6
 * can enforce the price-to-market rule against numbers PLAIN CODE computed — the agent only ever
 * hands back a lookupId, never a price the gate trusts.
 */
import type { SerpApiClient } from './serpapi.ts'

/** Fewer priced offers than this and the lookup is inconclusive (median null) — a 2-offer median
 *  is noise, and Stage 6 drops winners whose only lookup is inconclusive (spec Decision 4). */
export const MIN_MARKET_OFFERS = 5
/** How many offers (the cheapest) are kept on the lookup for evidence/display. Stats are computed
 *  over ALL priced offers, not just these. */
export const MARKET_OFFERS_KEPT = 5
/** Default for the `sourcing.max_price_to_market_bps` knob — 1.3× market median. Lives here (not
 *  knobs.ts / sourcing-run.ts) so knobs, the prompt, and tests can all import it without cycles. */
export const DEFAULT_MAX_PRICE_TO_MARKET_BPS = 13000

export interface MarketOffer {
  title: string
  priceCents: number
  merchant: string | null
  url: string | null
}

export interface MarketLookup {
  lookupId: string
  supplierProductId: string
  query: string
  offerCount: number
  medianCents: number | null
  p25Cents: number | null
  p75Cents: number | null
  offers: MarketOffer[]
  snapshot: Record<string, unknown>
}

export interface MarketPriceProvider {
  readonly key: string // 'serpapi_google_shopping'
  /** Parsed offers for the query, [] when the response held none, or null when the client
   *  returned null (shared cap spent / HTTP / network) — null means "could not look", not "no offers". */
  fetchOffers(query: string): Promise<MarketOffer[] | null>
}

/** FIXTURE-ASSUMPTION (spec §2): shopping_results[].{title, extracted_price, source,
 *  product_link|link}. Verified against the first live run; entries without a finite positive
 *  extracted_price are skipped — no fallback parsing of the display `price` string. */
interface GoogleShoppingResponse {
  shopping_results?: Array<{
    title?: string
    extracted_price?: number
    source?: string
    product_link?: string
    link?: string
  }>
}

export function createSerpApiMarketPrice(deps: { client: SerpApiClient }): MarketPriceProvider {
  const { client } = deps
  return {
    key: 'serpapi_google_shopping',
    async fetchOffers(query: string): Promise<MarketOffer[] | null> {
      const json = (await client.get({ engine: 'google_shopping', q: query, gl: 'us', hl: 'en' })) as
        | GoogleShoppingResponse
        | null
      if (json === null) return null
      const offers: MarketOffer[] = []
      for (const entry of json.shopping_results ?? []) {
        const price = entry.extracted_price
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue
        offers.push({
          title: entry.title ?? '',
          priceCents: Math.round(price * 100),
          merchant: entry.source ?? null,
          url: entry.product_link ?? entry.link ?? null,
        })
      }
      return offers
    },
  }
}

/** `sortedAsc[min(n-1, floor(n*q))]` — for q=0.5 on an even count this is the UPPER middle, the
 *  stricter side for a ceiling computed from it (spec Decision 3). Callers guarantee n >= 1. */
export function quantileCents(sortedAsc: number[], q: number): number {
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q))]!
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Run-scoped lookup registry — one instance per pipeline run, mirroring PointsAllowance. */
export class MarketLookups {
  private readonly byId = new Map<string, MarketLookup>()
  private readonly byKey = new Map<string, MarketLookup>()

  record(input: { supplierProductId: string; query: string; offers: MarketOffer[] }): MarketLookup {
    const sorted = input.offers.map((o) => o.priceCents).sort((a, b) => a - b)
    const conclusive = sorted.length >= MIN_MARKET_OFFERS
    const medianCents = conclusive ? quantileCents(sorted, 0.5) : null
    const p25Cents = conclusive ? quantileCents(sorted, 0.25) : null
    const p75Cents = conclusive ? quantileCents(sorted, 0.75) : null
    const kept = [...input.offers].sort((a, b) => a.priceCents - b.priceCents).slice(0, MARKET_OFFERS_KEPT)
    const lookup: MarketLookup = {
      lookupId: `mkt_${this.byId.size + 1}`,
      supplierProductId: input.supplierProductId,
      query: input.query,
      offerCount: sorted.length,
      medianCents,
      p25Cents,
      p75Cents,
      offers: kept,
      snapshot: { engine: 'google_shopping', offerCount: sorted.length, medianCents, p25Cents, p75Cents, offers: kept },
    }
    this.byId.set(lookup.lookupId, lookup)
    this.byKey.set(`${input.supplierProductId} ${normalizeQuery(input.query)}`, lookup)
    return lookup
  }

  get(lookupId: string): MarketLookup | undefined {
    return this.byId.get(lookupId)
  }

  find(supplierProductId: string, query: string): MarketLookup | undefined {
    return this.byKey.get(`${supplierProductId} ${normalizeQuery(query)}`)
  }

  all(): MarketLookup[] {
    return [...this.byId.values()]
  }
}
