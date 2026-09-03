/**
 * Amazon demand cross-check (spec 2026-09-03 Decisions 5-6): CODE-driven Stage-6 probe — never an
 * agent tool. One request per surviving winner, reusing the winner's market-lookup query.
 * FIXTURE-ASSUMPTION: organic_results[].{title, extracted_price, reviews, rating}; `reviews` may
 * be a number or comma-grouped string. Skip-don't-guess; verify on the first live run. Amazon
 * review counts are LIFETIME totals, not velocity — everything downstream labels them ESTIMATES.
 */
import { quantileCents } from './market-price.ts'
import type { SerpApiClient } from './serpapi.ts'

export const AMAZON_RESULTS_SAMPLED = 10
export const MIN_AMAZON_RESULTS = 3

export interface AmazonDemandSnapshot {
  query: string
  resultsSampled: number
  medianPriceCents: number | null
  medianReviews: number | null
  totalReviews: number | null
}

export interface DemandProbeProvider {
  readonly key: string
  /** null = could not look (cap/HTTP) OR < MIN_AMAZON_RESULTS usable entries (inconclusive). */
  probe(query: string): Promise<AmazonDemandSnapshot | null>
}

interface AmazonSearchResponse {
  organic_results?: Array<{ extracted_price?: number; reviews?: number | string }>
}

function parseReviews(raw: number | string | undefined): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null
}

export function createSerpApiAmazonDemand(deps: { client: SerpApiClient }): DemandProbeProvider {
  const { client } = deps
  return {
    key: 'serpapi_amazon',
    async probe(query: string): Promise<AmazonDemandSnapshot | null> {
      const json = (await client.get({ engine: 'amazon', amazon_domain: 'amazon.com', k: query })) as
        | AmazonSearchResponse
        | null
      if (json === null) return null

      const prices: number[] = []
      const reviews: number[] = []
      let sampled = 0
      for (const entry of json.organic_results ?? []) {
        // Compute cents first: a sub-cent extracted_price (e.g. 0.004) rounds to 0, which would
        // fail the schema's medianPriceCents .positive() — such an entry is not usable as a price.
        const priceCents = typeof entry.extracted_price === 'number' && Number.isFinite(entry.extracted_price) ? Math.round(entry.extracted_price * 100) : null
        const priceOk = priceCents !== null && priceCents >= 1
        const reviewCount = parseReviews(entry.reviews)
        if (!priceOk && reviewCount === null) continue
        if (sampled >= AMAZON_RESULTS_SAMPLED) break
        sampled += 1
        if (priceOk) prices.push(priceCents)
        if (reviewCount !== null) reviews.push(reviewCount)
      }
      if (sampled < MIN_AMAZON_RESULTS) return null

      return {
        query,
        resultsSampled: sampled,
        medianPriceCents: prices.length > 0 ? quantileCents(prices.sort((a, b) => a - b), 0.5) : null,
        medianReviews: reviews.length > 0 ? quantileCents(reviews.sort((a, b) => a - b), 0.5) : null,
        totalReviews: reviews.length > 0 ? reviews.reduce((s, n) => s + n, 0) : null,
      }
    },
  }
}
