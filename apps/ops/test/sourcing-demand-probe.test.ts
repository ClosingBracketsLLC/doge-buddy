import { describe, expect, it } from 'vitest'
import { createSerpApiAmazonDemand } from '../src/sourcing/demand-probe.ts'

const fixture = {
  organic_results: [
    { title: 'Bottle A', extracted_price: 21.99, reviews: 3400, rating: 4.5 },
    { title: 'Bottle B', extracted_price: 18.5, reviews: '12,345' }, // comma-string reviews
    { title: 'Bottle C', extracted_price: 25.0 },                    // price only — still usable
    { title: 'Bottle D', reviews: 900 },                             // reviews only — still usable
    { title: 'Junk', rating: 4.0 },                                  // neither — skipped
  ],
}
const clientWith = (json: unknown) => ({ get: async () => json, requestsMade: () => 1 })

describe('createSerpApiAmazonDemand', () => {
  it('sends engine=amazon with amazon_domain and k', async () => {
    const calls: Record<string, string>[] = []
    const client = { get: async (p: Record<string, string>) => (calls.push(p), fixture), requestsMade: () => 1 }
    await createSerpApiAmazonDemand({ client }).probe('dog water bottle')
    expect(calls[0]).toEqual({ engine: 'amazon', amazon_domain: 'amazon.com', k: 'dog water bottle' })
  })

  it('parses prices to cents and comma-grouped review counts; skips unusable entries', async () => {
    const snap = await createSerpApiAmazonDemand({ client: clientWith(fixture) }).probe('q')
    expect(snap).toEqual({
      query: 'q',
      resultsSampled: 4,
      medianPriceCents: 2199,          // sorted [1850, 2199, 2500] -> upper-middle of 3 = index 1
      medianReviews: 3400,             // sorted [900, 3400, 12345] -> index 1
      totalReviews: 16645,
    })
  })

  it('returns null when fewer than MIN_AMAZON_RESULTS usable entries', async () => {
    const thin = { organic_results: [{ extracted_price: 9.99 }, { reviews: 5 }] }
    expect(await createSerpApiAmazonDemand({ client: clientWith(thin) }).probe('q')).toBeNull()
  })

  it('returns null when the client returns null', async () => {
    const client = { get: async () => null, requestsMade: () => 0 }
    expect(await createSerpApiAmazonDemand({ client }).probe('q')).toBeNull()
  })

  it('samples only the first AMAZON_RESULTS_SAMPLED usable entries', async () => {
    const many = { organic_results: Array.from({ length: 15 }, (_, i) => ({ extracted_price: 10 + i, reviews: 100 + i })) }
    const snap = await createSerpApiAmazonDemand({ client: clientWith(many) }).probe('q')
    expect(snap!.resultsSampled).toBe(10)
    expect(snap!.totalReviews).toBe((100 + 109) * 10 / 2) // 100..109
  })
})
