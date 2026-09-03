import { describe, expect, it } from 'vitest'
import { expandKeywords, EXPANSION_MAX_KEYWORDS, KEYWORDS_WITH_EXPANSION_MAX } from '../src/sourcing/keyword-expansion.ts'
import { CLAIM_TERMS, EXCLUDED_CATEGORY_TERMS } from '../src/sourcing/guards.ts'
import type { RisingQuery, TrendsProvider } from '../src/sourcing/trends.ts'

function providerWith(byKeyword: Record<string, RisingQuery[] | null>): TrendsProvider {
  return {
    key: 'fake',
    fetchInterest: async () => [],
    fetchRisingQueries: async (kw) => byKeyword[kw] ?? [],
  }
}
const rq = (query: string, extractedValue: number | null = 100): RisingQuery => ({
  query, value: extractedValue == null ? 'Breakout' : `+${extractedValue}%`, extractedValue,
})

describe('expandKeywords', () => {
  it('keeps dog-token rising queries and appends them after the base keywords', async () => {
    const r = await expandKeywords(providerWith({ 'dog toy': [rq('puppy teething ring'), rq('dog collar led')] }), ['dog toy'])
    expect(r.keywords).toEqual(['dog toy', 'puppy teething ring', 'dog collar led'])
    expect(r.kept.map((k) => k.baseKeyword)).toEqual(['dog toy', 'dog toy'])
  })

  it('drops queries without a dog token (word-start), counting them as dropped', async () => {
    const r = await expandKeywords(providerWith({ dog: [rq('collar'), rq('cat tree'), rq('carpet cleaner')] }), ['dog'])
    expect(r.keywords).toEqual(['dog'])
    expect(r.dropped).toBe(3) // 'carpet' must NOT match 'pet' mid-word
  })

  it('drops excluded-category and claim-term queries', async () => {
    const excludedTerm = EXCLUDED_CATEGORY_TERMS[0]
    const claimTerm = CLAIM_TERMS[0]
    const r = await expandKeywords(
      providerWith({
        dog: [rq(`dog ${excludedTerm}`), rq(`dog ${claimTerm}`.trim())],
      }),
      ['dog'],
    )
    expect(r.keywords).toEqual(['dog'])
    expect(r.kept).toEqual([])
    expect(r.dropped).toBe(2)
  })

  it('dedupes case-insensitively against base and other kept queries, first wins', async () => {
    const r = await expandKeywords(providerWith({ 'dog toy': [rq('Dog Toy'), rq('dog rope toy'), rq('DOG ROPE TOY')] }), ['dog toy'])
    expect(r.keywords).toEqual(['dog toy', 'dog rope toy'])
  })

  it('orders Breakout entries first, then extracted_value desc, and caps at EXPANSION_MAX_KEYWORDS', async () => {
    const rising = [rq('dog a', 10), rq('dog b', null), rq('dog c', 500), rq('dog d', 50), rq('dog e', 200), rq('dog f', 90), rq('dog g', null)]
    const r = await expandKeywords(providerWith({ dog: rising }), ['dog'])
    expect(r.kept.map((k) => k.query)).toEqual(['dog b', 'dog g', 'dog c', 'dog e', 'dog f'])
    expect(r.kept).toHaveLength(EXPANSION_MAX_KEYWORDS)
  })

  it('probes only the first EXPANSION_MAX_REQUESTS base keywords', async () => {
    const probed: string[] = []
    const provider: TrendsProvider = {
      key: 'fake', fetchInterest: async () => [],
      fetchRisingQueries: async (kw) => (probed.push(kw), []),
    }
    await expandKeywords(provider, ['k1 dog', 'k2 dog', 'k3 dog', 'k4 dog', 'k5 dog', 'k6 dog', 'k7 dog', 'k8 dog'])
    expect(probed).toEqual(['k1 dog', 'k2 dog', 'k3 dog', 'k4 dog', 'k5 dog'])
  })

  it('caps total keywords at KEYWORDS_WITH_EXPANSION_MAX and never loses a base keyword', async () => {
    const base = ['b1 dog', 'b2 dog', 'b3 dog', 'b4 dog', 'b5 dog', 'b6 dog', 'b7 dog', 'b8 dog']
    const r = await expandKeywords(providerWith({ 'b1 dog': [rq('dog x'), rq('dog y'), rq('dog z')] }), base)
    expect(r.keywords.slice(0, 8)).toEqual(base)
    expect(r.keywords.length).toBeLessThanOrEqual(KEYWORDS_WITH_EXPANSION_MAX)
  })

  it('a null (failed) probe contributes nothing and does not throw', async () => {
    const r = await expandKeywords(providerWith({ dog: null }), ['dog'])
    expect(r).toEqual({ keywords: ['dog'], kept: [], dropped: 0 })
  })

  it('drops queries longer than 60 chars', async () => {
    const long = `dog ${'x'.repeat(60)}`
    const r = await expandKeywords(providerWith({ dog: [rq(long)] }), ['dog'])
    expect(r.kept).toEqual([])
  })
})
