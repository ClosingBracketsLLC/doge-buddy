/**
 * Stage 1b (spec 2026-09-03 Decisions 1-3): expand the run's base keywords with Google Trends
 * rising related queries, plain-code filtered. Base keywords ALWAYS survive untouched; expansion
 * only appends. Never throws — a failed probe contributes nothing.
 */
import { findClaimViolations, matchExcludedCategory } from './guards.ts'
import type { RisingQuery, TrendsProvider } from './trends.ts'

export const EXPANSION_MAX_REQUESTS = 5
export const EXPANSION_MAX_KEYWORDS = 5
export const KEYWORDS_WITH_EXPANSION_MAX = 10
export const DOG_TOKENS = ['dog', 'dogs', 'puppy', 'puppies', 'pet', 'pets', 'canine'] as const
const MAX_QUERY_CHARS = 60

/** Word-START token match (the 40da0b7 rule): 'dog collar' matches, 'carpet' must not match 'pet'. */
function hasDogToken(query: string): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/)
  return words.some((w) => DOG_TOKENS.some((t) => w === t || w.startsWith(t)))
}

export interface ExpansionResult {
  keywords: string[]
  kept: Array<RisingQuery & { baseKeyword: string }>
  dropped: number
}

export async function expandKeywords(trends: TrendsProvider, base: readonly string[]): Promise<ExpansionResult> {
  const seen = new Set(base.map((k) => k.trim().toLowerCase()))
  const candidates: Array<RisingQuery & { baseKeyword: string }> = []
  let dropped = 0

  for (const keyword of base.slice(0, EXPANSION_MAX_REQUESTS)) {
    const rising = await trends.fetchRisingQueries(keyword)
    if (rising === null) continue
    for (const r of rising) {
      const key = r.query.trim().toLowerCase()
      if (seen.has(key)) continue // duplicate of base or an earlier candidate — not "dropped", just already present
      if (
        r.query.length > MAX_QUERY_CHARS ||
        !hasDogToken(r.query) ||
        matchExcludedCategory(r.query) !== null ||
        findClaimViolations(r.query).length > 0
      ) {
        dropped += 1
        continue
      }
      seen.add(key)
      candidates.push({ ...r, baseKeyword: keyword })
    }
  }

  // Breakout (extractedValue null) first — that's where un-typed winners live — then value desc.
  candidates.sort((a, b) => {
    if ((a.extractedValue == null) !== (b.extractedValue == null)) return a.extractedValue == null ? -1 : 1
    return (b.extractedValue ?? 0) - (a.extractedValue ?? 0)
  })

  const room = Math.min(EXPANSION_MAX_KEYWORDS, Math.max(0, KEYWORDS_WITH_EXPANSION_MAX - base.length))
  const kept = candidates.slice(0, room)
  dropped += candidates.length - kept.length

  return { keywords: [...base, ...kept.map((k) => k.query)], kept, dropped }
}
