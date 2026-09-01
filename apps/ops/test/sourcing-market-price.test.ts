import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_PRICE_TO_MARKET_BPS,
  MARKET_OFFERS_KEPT,
  MIN_MARKET_OFFERS,
  MarketLookups,
  createSerpApiMarketPrice,
  quantileCents,
  type MarketOffer,
} from '../src/sourcing/market-price.ts'
import type { SerpApiClient } from '../src/sourcing/serpapi.ts'

function fakeClient(response: unknown | null): SerpApiClient & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => response), requestsMade: () => 0 } as never
}

function offers(...cents: number[]): MarketOffer[] {
  return cents.map((c, i) => ({ title: `offer ${i}`, priceCents: c, merchant: 'Chewy', url: `https://x/${i}` }))
}

describe('createSerpApiMarketPrice', () => {
  it('queries google_shopping (gl=us, hl=en) and parses shopping_results into cent offers', async () => {
    const client = fakeClient({
      shopping_results: [
        { title: 'Dog Bed L', extracted_price: 24.99, source: 'Chewy', product_link: 'https://c/1' },
        { title: 'Dog Bed M', extracted_price: 19.5, source: 'Amazon', link: 'https://a/2' },
        { title: 'no price entry', source: 'Walmart' },
        { title: 'bad price', extracted_price: -3 },
      ],
    })
    const provider = createSerpApiMarketPrice({ client })

    const result = await provider.fetchOffers('dog bed large')

    expect(client.get).toHaveBeenCalledWith({ engine: 'google_shopping', q: 'dog bed large', gl: 'us', hl: 'en' })
    expect(result).toEqual([
      { title: 'Dog Bed L', priceCents: 2499, merchant: 'Chewy', url: 'https://c/1' },
      { title: 'Dog Bed M', priceCents: 1950, merchant: 'Amazon', url: 'https://a/2' },
    ])
    expect(provider.key).toBe('serpapi_google_shopping')
  })

  it('null from the client (cap/HTTP/network) propagates as null; a shape without shopping_results is [] not null', async () => {
    expect(await createSerpApiMarketPrice({ client: fakeClient(null) }).fetchOffers('x')).toBeNull()
    expect(await createSerpApiMarketPrice({ client: fakeClient({ other: 1 }) }).fetchOffers('x')).toEqual([])
  })
})

describe('quantileCents', () => {
  it('even count: median (q=0.5) picks the UPPER middle — the stricter side', () => {
    expect(quantileCents([100, 200, 300, 400], 0.5)).toBe(300)
  })
  it('odd count picks the true middle; q=1 clamps to the last element', () => {
    expect(quantileCents([100, 200, 300], 0.5)).toBe(200)
    expect(quantileCents([100, 200, 300], 1)).toBe(300)
  })
})

describe('MarketLookups', () => {
  it('record computes stats over ALL priced offers, keeps only the 5 cheapest, sequential ids', () => {
    const reg = new MarketLookups()
    const l = reg.record({ supplierProductId: 'cjp-1', query: 'Dog Bed', offers: offers(700, 100, 500, 300, 600, 400, 200) })

    expect(l.lookupId).toBe('mkt_1')
    expect(l.offerCount).toBe(7)
    expect(l.medianCents).toBe(400) // sorted [100..700], floor(7*0.5)=3 -> 400
    expect(l.p25Cents).toBe(200)
    expect(l.p75Cents).toBe(600)
    expect(l.offers.map((o) => o.priceCents)).toEqual([100, 200, 300, 400, 500])
    expect(l.offers).toHaveLength(MARKET_OFFERS_KEPT)
    expect(reg.get('mkt_1')).toBe(l)
    expect(reg.get('mkt_2')).toBeUndefined()
    expect(reg.all()).toEqual([l])
  })

  it(`fewer than ${MIN_MARKET_OFFERS} offers is inconclusive: median/p25/p75 all null, offers kept`, () => {
    const l = new MarketLookups().record({ supplierProductId: 'p', query: 'q', offers: offers(100, 200, 300, 400) })
    expect(l.offerCount).toBe(4)
    expect(l.medianCents).toBeNull()
    expect(l.p25Cents).toBeNull()
    expect(l.p75Cents).toBeNull()
  })

  it('find() matches by pid + normalized query (trim/lowercase/collapse whitespace) — cache seam for the tool', () => {
    const reg = new MarketLookups()
    const l = reg.record({ supplierProductId: 'p', query: 'Dog  Bed ', offers: offers(1, 2, 3, 4, 5) })
    expect(reg.find('p', '  dog bed')).toBe(l)
    expect(reg.find('other-pid', 'dog bed')).toBeUndefined()
    expect(reg.find('p', 'dog bowl')).toBeUndefined()
  })

  it('snapshot carries the evidence, never a raw response', () => {
    const l = new MarketLookups().record({ supplierProductId: 'p', query: 'q', offers: offers(100, 200, 300, 400, 500) })
    expect(l.snapshot).toEqual({
      engine: 'google_shopping', offerCount: 5, medianCents: 300, p25Cents: 200, p75Cents: 400, offers: l.offers,
    })
  })

  it('default ratio constant is 13000 bps', () => {
    expect(DEFAULT_MAX_PRICE_TO_MARKET_BPS).toBe(13000)
  })
})
