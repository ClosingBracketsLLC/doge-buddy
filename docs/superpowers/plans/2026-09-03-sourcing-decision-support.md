# L1 Sourcing Decision-Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `new_listing` proposal carries code-computed economics + labeled demand estimates; the pipeline expands keywords via Google Trends rising related queries and cross-checks demand on Amazon; the pricing prompt goes floor-first.

**Architecture:** New pipeline Stage 1b (keyword expansion, before harvest), a code-driven Amazon `DemandProbeProvider` in Stage 6 (never an agent tool), a `ReviewsSeen` run-scoped registry fed by the existing `get_reviews` MCP handler, a versioned `ListingDecisionContext` stored in a new nullable `proposals.decision_context` jsonb column and rendered on `/admin` + summarized in Telegram. Nothing agent-typed enters the context.

**Tech Stack:** TypeScript (Node, `.ts` imports), zod v4, drizzle + pg, vitest (mock-tier, no network), Fastify admin (html`` tagged templates), SerpApi (`google_trends` RELATED_QUERIES + `amazon` engines) behind the existing shared per-run `SerpApiClient`.

**Spec:** `docs/superpowers/specs/2026-09-03-sourcing-decision-support-design.md`

## Global Constraints

- Monorepo: run tests with `pnpm --filter @doge-buddy/ops test -- run <file>` (vitest), typecheck with `pnpm -r typecheck`. Core tests: `pnpm --filter @doge-buddy/core test`. DB tests: `pnpm --filter @doge-buddy/db test`.
- All money is integer cents; all ratio math is integer bps, `Math.floor`ed — never round up into a false pass.
- Nothing the agent types is trusted: decision-context inputs must be code-recorded (registries) or code-computed (Stage 6 artifacts).
- Providers NEVER throw for SerpApi problems — `null` means "could not look"; degrade, don't abort a paid run.
- New SerpApi wire shapes (`related_queries.rising`, Amazon `organic_results`) are FIXTURE-ASSUMPTIONS: parse the documented shape, skip unusable entries, never guess-parse; the first live run corrects fixtures, not parsers.
- Word-start term matching only (the `40da0b7` scrubber rule) — no bare substring matches.
- Existing tests must keep passing; two pre-existing full-suite failures are known-benign on this machine (`admin-dashboard` test 13, `scoring-weekly-digest` freshness — orphaned 2099-12-31 seed rows in the local dev DB).
- Constants (copy verbatim): `EXPANSION_MAX_REQUESTS = 5`, `EXPANSION_MAX_KEYWORDS = 5`, `KEYWORDS_WITH_EXPANSION_MAX = 10`, `AMAZON_RESULTS_SAMPLED = 10`, `MIN_AMAZON_RESULTS = 3`, `DOG_TOKENS = ['dog', 'dogs', 'puppy', 'puppies', 'pet', 'pets', 'canine']`.

---

### Task 1: Migration 0011 — `trends_rising` enum value + `proposals.decision_context` column

**Files:**
- Modify: `packages/db/src/schema.ts` (line 28 `signalSource` pgEnum; `proposals` table ~line 215)
- Create: `packages/db/drizzle/0011_*.sql` (via `pnpm --filter @doge-buddy/db generate`)
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sourcingSignals.source` accepts `'trends_rising'`; `proposals.decisionContext` (column `decision_context`, `jsonb`, nullable) on `proposals.$inferSelect` — Tasks 8, 10, 12 rely on the property name `decisionContext`.

- [ ] **Step 1: Write the failing tests** — extend `packages/db/test/migrations.test.ts` following its existing enum-value assertion pattern (see how `market_price` is asserted; copy that idiom):

```ts
// alongside the existing signal_source assertions:
it('signal_source enum includes trends_rising', () => {
  const sql = allMigrationSql() // or however the existing test reads the migration files
  expect(sql).toMatch(/ALTER TYPE "public"\."signal_source" ADD VALUE 'trends_rising'/)
})

it('proposals has decision_context jsonb column', () => {
  const sql = allMigrationSql()
  expect(sql).toMatch(/ALTER TABLE "proposals" ADD COLUMN "decision_context" jsonb/)
})
```

Adapt the exact helper/matcher names to what the file already uses — do not invent a new harness if one exists.

- [ ] **Step 2: Run to verify both fail**

Run: `pnpm --filter @doge-buddy/db test`
Expected: the two new assertions FAIL (no 0011 migration yet).

- [ ] **Step 3: Edit schema + generate migration**

In `packages/db/src/schema.ts`:

```ts
export const signalSource = pgEnum('signal_source', ['cj_trending', 'web_search', 'google_trends', 'owner_manual', 'market_price', 'trends_rising'])
```

In the `proposals` table, after `payload`:

```ts
  /** L1 decision-support (spec 2026-09-03): code-computed economics + demand ESTIMATES for a
   *  new_listing, display-only — never read by apply. Null for other types and legacy rows. */
  decisionContext: jsonb('decision_context'),
```

Then: `pnpm --filter @doge-buddy/db generate` → verify the produced `0011_*.sql` contains exactly the ALTER TYPE and ALTER TABLE statements (precedent: 0010 for the enum ALTER).

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @doge-buddy/db test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/ packages/db/test/migrations.test.ts
git commit -m "feat(db): migration 0011 — trends_rising signal source + proposals.decision_context"
```

---

### Task 2: `ListingDecisionContextSchema` in `@doge-buddy/core`

**Files:**
- Modify: `packages/core/src/proposals.ts`
- Test: `packages/core/test/proposals.test.ts`

**Interfaces:**
- Consumes: the file-local `const cents = z.number().int('must be integer cents')` already at the top of `proposals.ts`.
- Produces: `export const ListingDecisionContextSchema` and `export type ListingDecisionContext = z.infer<typeof ListingDecisionContextSchema>` — consumed by Tasks 7, 8, 10, 12. Exact shape below is normative.

- [ ] **Step 1: Write failing tests** in `packages/core/test/proposals.test.ts`:

```ts
import { ListingDecisionContextSchema } from '../src/proposals.ts'

const validContext = {
  version: 1,
  economics: {
    freight: { priceCents: 649, name: 'USPS Ground', minDays: 3, maxDays: 7 },
    variants: [{ sku: 'DB-1', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: 4743 }],
    market: { query: 'dog water bottle', offerCount: 12, medianCents: 2199, typicalCents: 2399, ceilingCents: 2858, maxPriceToMarketBps: 13000 },
    usStockUnits: 214,
  },
  demand: {
    cjListedCount: 1200,
    cjReviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
    marketOfferCount: 12,
    trends: { keyword: 'dog leash', score: 62.1, momentum: 8 },
    amazon: { query: 'dog water bottle', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000, },
  },
}

describe('ListingDecisionContextSchema', () => {
  it('accepts a fully populated context', () => {
    expect(ListingDecisionContextSchema.safeParse(validContext).success).toBe(true)
  })
  it('accepts every nullable source as null (market-gate-skipped run)', () => {
    const degraded = {
      ...validContext,
      economics: { ...validContext.economics, market: null, usStockUnits: null },
      demand: { cjListedCount: null, cjReviews: null, marketOfferCount: null, trends: null, amazon: null },
    }
    expect(ListingDecisionContextSchema.safeParse(degraded).success).toBe(true)
  })
  it('rejects version 2 and missing economics', () => {
    expect(ListingDecisionContextSchema.safeParse({ ...validContext, version: 2 }).success).toBe(false)
    expect(ListingDecisionContextSchema.safeParse({ version: 1, demand: validContext.demand }).success).toBe(false)
  })
  it('rejects non-integer cents', () => {
    const bad = structuredClone(validContext)
    bad.economics.variants[0].priceCents = 23.99
    expect(ListingDecisionContextSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/core test` → FAIL (export missing).

- [ ] **Step 3: Implement** in `packages/core/src/proposals.ts` (after the payload schemas, before `ProposalPayloadSchema`):

```ts
/**
 * L1 decision-support context (spec 2026-09-03): the code-computed numbers Robert decides a
 * new_listing on — economics per variant plus demand ESTIMATES. Produced ONLY by Stage 6
 * (plain code) and stored on `proposals.decision_context`; display-only, never read by apply.
 * `profitCents` may be any integer in principle, but every producer runs AFTER the margin-floor
 * gate. `demand.*` are estimates — every renderer labels them so.
 */
export const ListingDecisionContextSchema = z.object({
  version: z.literal(1),
  economics: z.object({
    freight: z.object({
      priceCents: cents.nonnegative(),
      name: z.string(),
      minDays: z.number().int().nonnegative(),
      maxDays: z.number().int().nonnegative(),
    }),
    variants: z
      .array(
        z.object({
          sku: z.string(),
          priceCents: cents.positive(),
          supplierCostCents: cents.nonnegative(),
          landedCents: cents.nonnegative(),
          profitCents: z.number().int(),
          marginBps: z.number().int(),
        }),
      )
      .min(1),
    market: z
      .object({
        query: z.string(),
        offerCount: z.number().int().nonnegative(),
        medianCents: cents.positive(),
        typicalCents: cents.positive(),
        ceilingCents: cents.nonnegative(),
        maxPriceToMarketBps: z.number().int(),
      })
      .nullable(),
    usStockUnits: z.number().int().nonnegative().nullable(),
  }),
  demand: z.object({
    cjListedCount: z.number().int().nonnegative().nullable(),
    cjReviews: z
      .object({
        page1Count: z.number().int().nonnegative(),
        ratedCount: z.number().int().nonnegative(),
        avgRating: z.number().min(1).max(5).nullable(),
      })
      .nullable(),
    marketOfferCount: z.number().int().nonnegative().nullable(),
    trends: z.object({ keyword: z.string(), score: z.number().nullable(), momentum: z.number().nullable() }).nullable(),
    amazon: z
      .object({
        query: z.string(),
        resultsSampled: z.number().int().nonnegative(),
        medianPriceCents: cents.positive().nullable(),
        medianReviews: z.number().int().nonnegative().nullable(),
        totalReviews: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
})
export type ListingDecisionContext = z.infer<typeof ListingDecisionContextSchema>
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/core test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proposals.ts packages/core/test/proposals.test.ts
git commit -m "feat(core): ListingDecisionContextSchema — versioned economics+demand block for new_listing proposals"
```

---

### Task 3: `fetchRisingQueries` on the trends provider

**Files:**
- Modify: `apps/ops/src/sourcing/trends.ts`
- Test: `apps/ops/test/sourcing-trends.test.ts`

**Interfaces:**
- Consumes: `SerpApiClient.get(params)` (existing; returns parsed JSON or null).
- Produces: `export interface RisingQuery { query: string; value: string | null; extractedValue: number | null }` and `TrendsProvider.fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null>` — consumed by Task 4.

- [ ] **Step 1: Write failing tests** in `apps/ops/test/sourcing-trends.test.ts` (follow the file's existing fake-client pattern):

```ts
describe('fetchRisingQueries', () => {
  const risingFixture = {
    related_queries: {
      rising: [
        { query: 'dog water bottle', value: '+120%', extracted_value: 120 },
        { query: 'led dog collar', value: 'Breakout' }, // no extracted_value
        { value: '+50%', extracted_value: 50 }, // no query — skipped
        { query: '', value: '+10%', extracted_value: 10 }, // empty query — skipped
      ],
      top: [{ query: 'dog bed', value: '100', extracted_value: 100 }], // ignored
    },
  }

  it('parses rising entries, skipping those without a non-empty query', async () => {
    const client = fakeClient(risingFixture) // existing helper idiom: client.get resolves the fixture
    const trends = createSerpApiTrends({ client })
    const rising = await trends.fetchRisingQueries('dog bottle')
    expect(rising).toEqual([
      { query: 'dog water bottle', value: '+120%', extractedValue: 120 },
      { query: 'led dog collar', value: 'Breakout', extractedValue: null },
    ])
  })

  it('sends a single-q RELATED_QUERIES request with the shared date window', async () => {
    const calls: Record<string, string>[] = []
    const client = { get: async (p: Record<string, string>) => (calls.push(p), risingFixture), requestsMade: () => 1 }
    await createSerpApiTrends({ client }).fetchRisingQueries('dog bottle')
    expect(calls[0]).toEqual({ engine: 'google_trends', data_type: 'RELATED_QUERIES', q: 'dog bottle', date: 'today 3-m' })
  })

  it('returns null when the client returns null (cap/HTTP)', async () => {
    const client = { get: async () => null, requestsMade: () => 0 }
    expect(await createSerpApiTrends({ client }).fetchRisingQueries('dog')).toBeNull()
  })

  it('returns [] when the response has no rising list', async () => {
    const client = fakeClient({ related_queries: {} })
    expect(await createSerpApiTrends({ client }).fetchRisingQueries('dog')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-trends` → FAIL (`fetchRisingQueries` not a function).

- [ ] **Step 3: Implement** in `trends.ts`:

```ts
/** One rising related query for a base keyword. `value` is SerpApi's display string ("+120%",
 *  "Breakout"); `extractedValue` its numeric form when present (absent for Breakout). */
export interface RisingQuery {
  query: string
  value: string | null
  extractedValue: number | null
}

interface SerpApiRelatedQueriesResponse {
  related_queries?: {
    rising?: Array<{ query?: string; value?: string | number; extracted_value?: number }>
  }
}
```

Add to the `TrendsProvider` interface:

```ts
  /** Rising related queries for ONE keyword (RELATED_QUERIES takes a single q per request,
   *  unlike TIMESERIES's 5-comma batch). null = client could not look (cap/HTTP); [] = looked,
   *  nothing rising. FIXTURE-ASSUMPTION on the rising[] shape — verify on the first live run. */
  fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null>
```

And in the object `createSerpApiTrends` returns:

```ts
    async fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null> {
      const json = (await client.get({
        engine: 'google_trends',
        data_type: 'RELATED_QUERIES',
        q: keyword,
        date: SERPAPI_DATE_RANGE,
      })) as SerpApiRelatedQueriesResponse | null
      if (json === null) return null
      const rising: RisingQuery[] = []
      for (const entry of json.related_queries?.rising ?? []) {
        if (typeof entry.query !== 'string' || entry.query.trim().length === 0) continue
        rising.push({
          query: entry.query.trim(),
          value: entry.value != null ? String(entry.value) : null,
          extractedValue: typeof entry.extracted_value === 'number' && Number.isFinite(entry.extracted_value) ? entry.extracted_value : null,
        })
      }
      return rising
    },
```

NOTE: any other test double implementing `TrendsProvider` (grep `sourcing-pipeline.test.ts` and helpers for `fetchInterest`) now needs a `fetchRisingQueries` member — add `fetchRisingQueries: async () => []` (or `null`) to those fakes in the same commit so the suite compiles.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-trends sourcing-pipeline` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/trends.ts apps/ops/test/sourcing-trends.test.ts apps/ops/test/sourcing-pipeline.test.ts
git commit -m "feat(sourcing): fetchRisingQueries — Google Trends RELATED_QUERIES rising list on the trends provider"
```

---

### Task 4: `sourcing/keyword-expansion.ts`

**Files:**
- Create: `apps/ops/src/sourcing/keyword-expansion.ts`
- Test: `apps/ops/test/sourcing-keyword-expansion.test.ts`

**Interfaces:**
- Consumes: `TrendsProvider.fetchRisingQueries` (Task 3), `matchExcludedCategory(...texts)` and `findClaimViolations(...texts)` from `./guards.ts` (both variadic over `(string | null | undefined)[]`).
- Produces:

```ts
export const EXPANSION_MAX_REQUESTS = 5
export const EXPANSION_MAX_KEYWORDS = 5
export const KEYWORDS_WITH_EXPANSION_MAX = 10
export const DOG_TOKENS: readonly string[]
export interface ExpansionResult {
  keywords: string[]                                   // base first (original casing), then kept rising queries; ≤ 10
  kept: Array<RisingQuery & { baseKeyword: string }>   // in kept order
  dropped: number                                      // rising entries filtered out or over-cap
}
export async function expandKeywords(trends: TrendsProvider, base: readonly string[]): Promise<ExpansionResult>
```

Consumed by Task 9 (pipeline Stage 1b).

- [ ] **Step 1: Write failing tests** in `apps/ops/test/sourcing-keyword-expansion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { expandKeywords, EXPANSION_MAX_KEYWORDS, KEYWORDS_WITH_EXPANSION_MAX } from '../src/sourcing/keyword-expansion.ts'
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
    // pick one real term from EXCLUDED_CATEGORY_TERMS and one from CLAIM_TERMS (import them) and
    // embed each in an otherwise-valid dog query; assert both are dropped.
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
```

(Fill in the excluded/claim-term test with real terms from `guards.ts` at implementation time — import `EXCLUDED_CATEGORY_TERMS` / `CLAIM_TERMS` and use `[0]` of each.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-keyword-expansion` → FAIL (module not found).

- [ ] **Step 3: Implement** `apps/ops/src/sourcing/keyword-expansion.ts`:

```ts
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
```

CAREFUL with `hasDogToken`: `w.startsWith(t)` makes 'dogs'/'doggy' match token 'dog' — intended (word-START matching). 'carpet'.startsWith('pet') is false — correct. A bare `w === t` alone would miss plurals the token list doesn't carry.

Wait — the dedupe branch does not increment `dropped`, but the null-probe test expects `dropped: 0` and the sort/cap test expects specific keeps. The dedupe-test expects `dropped` uncounted for dupes — the test above only asserts `keywords`; keep dupes uncounted (they are not filtered signal, just already present).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-keyword-expansion` → PASS. Verify the word-start test really exercises 'carpet cleaner' NOT matching.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/keyword-expansion.ts apps/ops/test/sourcing-keyword-expansion.test.ts
git commit -m "feat(sourcing): keyword expansion — rising related queries, dog-token + guards filter, breakout-first cap"
```

---

### Task 5: `sourcing/demand-probe.ts` — Amazon demand cross-check provider

**Files:**
- Create: `apps/ops/src/sourcing/demand-probe.ts`
- Test: `apps/ops/test/sourcing-demand-probe.test.ts`

**Interfaces:**
- Consumes: `SerpApiClient` (existing).
- Produces:

```ts
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
  readonly key: string // 'serpapi_amazon'
  probe(query: string): Promise<AmazonDemandSnapshot | null>
}
export function createSerpApiAmazonDemand(deps: { client: SerpApiClient }): DemandProbeProvider
```

Consumed by Tasks 8 (builder input type), 10 (Stage 6), 11 (composition roots).

- [ ] **Step 1: Write failing tests**:

```ts
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
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-demand-probe` → FAIL.

- [ ] **Step 3: Implement**:

```ts
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
        const priceOk = typeof entry.extracted_price === 'number' && Number.isFinite(entry.extracted_price) && entry.extracted_price > 0
        const reviewCount = parseReviews(entry.reviews)
        if (!priceOk && reviewCount === null) continue
        if (sampled >= AMAZON_RESULTS_SAMPLED) break
        sampled += 1
        if (priceOk) prices.push(Math.round(entry.extracted_price! * 100))
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
```

(`quantileCents` is generic integer-median math despite its name — reusing it keeps the "upper-middle on even counts" convention in one place.)

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-demand-probe` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/demand-probe.ts apps/ops/test/sourcing-demand-probe.test.ts
git commit -m "feat(sourcing): Amazon demand probe — code-driven SerpApi cross-check, skip-dont-guess parser"
```

---

### Task 6: `sourcing/decision-context.ts` — ReviewsSeen + momentum + builder

**Files:**
- Create: `apps/ops/src/sourcing/decision-context.ts`
- Test: `apps/ops/test/sourcing-decision-context.test.ts`

**Interfaces:**
- Consumes: `ListingDecisionContext` type (Task 2), `AmazonDemandSnapshot` (Task 5), `MarketLookup` + `quantileCents` (existing `market-price.ts`), `TrendSignal` (existing), `HarvestCandidate` (existing), `NewListingPayload` + `SupplierProductReview`/`WarehouseStock`/`ShippingOption` (existing `@doge-buddy/core` / `@doge-buddy/supplier`).
- Produces:

```ts
export interface ReviewsSeenEntry { page1Count: number; ratedCount: number; avgRating: number | null }
export class ReviewsSeen {
  record(supplierProductId: string, reviews: SupplierProductReview[]): void   // page-1 results only; first recording per pid wins
  get(supplierProductId: string): ReviewsSeenEntry | undefined
}
export function computeTrendMomentum(points: Array<{ value: number }>): number | null
export interface DecisionContextInput {
  payload: NewListingPayload            // post-step-7 (live costs)
  freightCents: number
  freightOption: ShippingOption
  lookup: MarketLookup | null           // step-6 conclusive lookup; null ⇔ gate skipped
  maxPriceToMarketBps: number
  stockRows: WarehouseStock[]           // step-7 first-variant response
  candidate: HarvestCandidate | undefined
  trendSignal: TrendSignal | undefined
  reviews: ReviewsSeenEntry | undefined
  amazon: AmazonDemandSnapshot | null
}
export function buildListingDecisionContext(input: DecisionContextInput): ListingDecisionContext
```

Consumed by Tasks 7 (mcp-tools), 9 (pipeline), 10 (submit-winners).

- [ ] **Step 1: Write failing tests**:

```ts
import { describe, expect, it } from 'vitest'
import { ListingDecisionContextSchema } from '@doge-buddy/core'
import { buildListingDecisionContext, computeTrendMomentum, ReviewsSeen } from '../src/sourcing/decision-context.ts'

describe('ReviewsSeen', () => {
  it('summarizes rated reviews only; avg over rated; never fabricates a rating', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ rating: 5, content: 'a' }, { rating: 4, content: 'b' }, { content: 'unrated' }])
    expect(seen.get('pid1')).toEqual({ page1Count: 3, ratedCount: 2, avgRating: 4.5 })
  })
  it('avgRating null when nothing rated', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ content: 'x' }])
    expect(seen.get('pid1')).toEqual({ page1Count: 1, ratedCount: 0, avgRating: null })
  })
  it('first recording per pid wins', () => {
    const seen = new ReviewsSeen()
    seen.record('pid1', [{ rating: 5, content: 'a' }])
    seen.record('pid1', [{ content: 'b' }, { content: 'c' }])
    expect(seen.get('pid1')!.page1Count).toBe(1)
  })
})

describe('computeTrendMomentum', () => {
  it('mean(last third) - mean(first third), rounded', () => {
    const points = [10, 10, 10, 50, 50, 50, 90, 90, 90].map((value) => ({ value }))
    expect(computeTrendMomentum(points)).toBe(80)
  })
  it('null under 3 points', () => {
    expect(computeTrendMomentum([{ value: 1 }, { value: 2 }])).toBeNull()
    expect(computeTrendMomentum([])).toBeNull()
  })
  it('negative momentum survives', () => {
    const points = [90, 90, 90, 50, 50, 50, 10, 10, 10].map((value) => ({ value }))
    expect(computeTrendMomentum(points)).toBe(-80)
  })
})

describe('buildListingDecisionContext', () => {
  const payload = {
    type: 'new_listing', title: 'T', descriptionHtml: '<p>d</p>', categoryTag: 'walks',
    imageUrls: ['https://x/a.jpg'], shipsFrom: 'US', deliveryMinDays: 2, deliveryMaxDays: 7,
    variants: [
      { sku: 'A', supplierProductId: 'p1', supplierVariantId: 'v1', priceCents: 2399, supplierCostCents: 612 },
      { sku: 'B', supplierProductId: 'p1', supplierVariantId: 'v2', priceCents: 2899, supplierCostCents: 750 },
    ],
  } as never // shape per NewListingPayload; cast keeps the test focused (builder reads, never validates)
  const base = {
    payload,
    freightCents: 649,
    freightOption: { name: 'USPS', priceCents: 649, minDays: 3, maxDays: 7 },
    lookup: { lookupId: 'mkt_1', supplierProductId: 'p1', query: 'dog thing', offerCount: 12, medianCents: 2199, p25Cents: 1800, p75Cents: 2600, offers: [], snapshot: {} },
    maxPriceToMarketBps: 13000,
    stockRows: [
      { countryCode: 'US', quantity: 200, verified: true },
      { countryCode: 'US', quantity: 14, verified: true },
      { countryCode: 'CN', quantity: 999, verified: true },
    ],
    candidate: { supplierProductId: 'p1', title: 't', categoryName: null, sellPriceCents: null, listedNum: 1200, imageUrl: null, keyword: 'dog leash' },
    trendSignal: { keyword: 'dog leash', score: 62.1, snapshot: { timelineData: [10, 10, 10, 50, 50, 50, 90, 90, 90].map((value) => ({ value })) } },
    reviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
    amazon: { query: 'dog thing', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000 },
  }

  it('assembles a schema-valid context with correct arithmetic', () => {
    const ctx = buildListingDecisionContext(base as never)
    expect(ListingDecisionContextSchema.safeParse(ctx).success).toBe(true)
    expect(ctx.economics.variants[0]).toEqual({ sku: 'A', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: Math.floor(((2399 - 612 - 649) * 10_000) / 2399) })
    expect(ctx.economics.market).toMatchObject({ medianCents: 2199, typicalCents: 2899, ceilingCents: Math.floor((2199 * 13000) / 10_000), offerCount: 12 })
    expect(ctx.economics.usStockUnits).toBe(214)
    expect(ctx.demand.trends).toEqual({ keyword: 'dog leash', score: 62.1, momentum: 80 })
    expect(ctx.demand.cjListedCount).toBe(1200)
  })

  it('degrades every missing source to null and stays schema-valid', () => {
    const ctx = buildListingDecisionContext({ ...base, lookup: null, candidate: undefined, trendSignal: undefined, reviews: undefined, amazon: null, stockRows: [{ countryCode: 'CN', quantity: 5, verified: true }] } as never)
    expect(ctx.economics.market).toBeNull()
    expect(ctx.economics.usStockUnits).toBeNull()
    expect(ctx.demand).toEqual({ cjListedCount: null, cjReviews: null, marketOfferCount: null, trends: null, amazon: null })
    expect(ListingDecisionContextSchema.safeParse(ctx).success).toBe(true)
  })

  it('candidate with null listedNum yields cjListedCount null (never 0-for-unknown)', () => {
    const ctx = buildListingDecisionContext({ ...base, candidate: { ...base.candidate, listedNum: null } } as never)
    expect(ctx.demand.cjListedCount).toBeNull()
  })
})
```

Note the momentum snapshot read: `trendSignal.snapshot.timelineData` is `Array<{ date?: string; value: number }>` (what `extractSignal` stores). The builder must read it DEFENSIVELY (it round-trips through jsonb-typed `Record<string, unknown>`): treat a missing/non-array/malformed `timelineData` as no-momentum (null), filter entries to those with a finite numeric `value`.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-decision-context` → FAIL.

- [ ] **Step 3: Implement** `apps/ops/src/sourcing/decision-context.ts`:

```ts
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

  return {
    version: 1,
    economics: {
      freight: { priceCents: freightOption.priceCents, name: freightOption.name, minDays: freightOption.minDays, maxDays: freightOption.maxDays },
      variants,
      market,
      usStockUnits,
    },
    demand: {
      cjListedCount: candidate?.listedNum ?? null,
      cjReviews: reviews ?? null,
      marketOfferCount: lookup?.offerCount ?? null,
      trends: trendSignal ? { keyword: trendSignal.keyword, score: trendSignal.score, momentum: computeTrendMomentum(timelinePoints(trendSignal)) } : null,
      amazon,
    },
  }
}
```

NOTE: `avgRating` must satisfy the core schema's `z.number().min(1).max(5).nullable()` — CJ's mapper already clamps ratings to 1–5, so the mean stays in range.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-decision-context` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/decision-context.ts apps/ops/test/sourcing-decision-context.test.ts
git commit -m "feat(sourcing): decision-context — ReviewsSeen registry, trend momentum, pure economics+demand builder"
```

---

### Task 7: `get_reviews` handler records into ReviewsSeen

**Files:**
- Modify: `apps/ops/src/agents/mcp-tools.ts`
- Test: `apps/ops/test/agents-mcp-tools.test.ts`

**Interfaces:**
- Consumes: `ReviewsSeen` (Task 6).
- Produces: `SourcingMcpDeps` gains `reviewsSeen?: ReviewsSeen` — Task 9 passes it from the pipeline.

- [ ] **Step 1: Write failing tests** (follow the file's existing handler-call idiom — handlers are called directly, adapter mocked):

```ts
describe('get_reviews ReviewsSeen recording', () => {
  it('records page-1 results', async () => {
    const reviewsSeen = new ReviewsSeen()
    const handlers = createSourcingToolHandlers({ adapter, allowance: new PointsAllowance(), reviewsSeen })
    // adapter.getProductReviews resolves [{ rating: 4, content: 'ok' }, { content: 'unrated' }]
    await handlers.get_reviews({ supplierProductId: 'pid1' })
    expect(reviewsSeen.get('pid1')).toEqual({ page1Count: 2, ratedCount: 1, avgRating: 4 })
  })
  it('explicit page 1 records; page 2 does not', async () => {
    const reviewsSeen = new ReviewsSeen()
    const handlers = createSourcingToolHandlers({ adapter, allowance: new PointsAllowance(), reviewsSeen })
    await handlers.get_reviews({ supplierProductId: 'pid2', page: 2 })
    expect(reviewsSeen.get('pid2')).toBeUndefined()
    await handlers.get_reviews({ supplierProductId: 'pid2', page: 1 })
    expect(reviewsSeen.get('pid2')).toBeDefined()
  })
  it('an adapter error records nothing', async () => {
    const reviewsSeen = new ReviewsSeen()
    const failing = { ...adapter, getProductReviews: async () => { throw new Error('cj down') } }
    const handlers = createSourcingToolHandlers({ adapter: failing, allowance: new PointsAllowance(), reviewsSeen })
    const res = await handlers.get_reviews({ supplierProductId: 'pid3' })
    expect(res.isError).toBe(true)
    expect(reviewsSeen.get('pid3')).toBeUndefined()
  })
  it('absent registry is a no-op (existing callers unaffected)', async () => {
    const handlers = createSourcingToolHandlers({ adapter, allowance: new PointsAllowance() })
    const res = await handlers.get_reviews({ supplierProductId: 'pid4' })
    expect(res.isError).not.toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run agents-mcp-tools` → FAIL (`reviewsSeen` not a known dep / recording absent).

- [ ] **Step 3: Implement** — in `mcp-tools.ts`: import `ReviewsSeen` from `../sourcing/decision-context.ts`; add to `SourcingMcpDeps`:

```ts
  /** L1 (spec 2026-09-03 Decision 7): when present, page-1 get_reviews results are summarized
   *  into this run-scoped registry as they pass through — code-recorded provenance for the
   *  proposal demand block, zero extra CJ calls. Absent = no recording (existing callers). */
  reviewsSeen?: ReviewsSeen
```

Destructure `reviewsSeen` in `createSourcingToolHandlers` and change the `get_reviews` success path:

```ts
      try {
        const result = await adapter.getProductReviews(args.supplierProductId, { page: args.page })
        if (args.page === undefined || args.page === 1) {
          reviewsSeen?.record(args.supplierProductId, result)
        }
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run agents-mcp-tools` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/mcp-tools.ts apps/ops/test/agents-mcp-tools.test.ts
git commit -m "feat(agents): get_reviews handler records page-1 results into ReviewsSeen"
```

---

### Task 8: `submitProposal` carries `decisionContext`

**Files:**
- Modify: `apps/ops/src/proposals/submit.ts`
- Test: `apps/ops/test/proposal-submit.test.ts`

**Interfaces:**
- Consumes: `ListingDecisionContextSchema`/`ListingDecisionContext` (Task 2), `proposals.decisionContext` column (Task 1).
- Produces: `SubmitProposalInput.decisionContext?: ListingDecisionContext` — Task 10 passes it.

- [ ] **Step 1: Write failing tests** in `proposal-submit.test.ts` (reuse its existing deps/fixture helpers — it already exercises manual and auto paths with a fake db):

```ts
it('persists a valid decisionContext on the manual path', async () => {
  const result = await submitProposal(deps, { ...newListingInput, decisionContext: validContext })
  // assert the inserted row's decisionContext === validContext (however the fake db exposes inserts)
})
it('persists decisionContext on the auto path too', async () => { /* mode auto + decisionContext */ })
it('inserts null when decisionContext absent (existing callers unchanged)', async () => { /* no field -> row.decisionContext == null */ })
it('throws on a decisionContext that fails its schema', async () => {
  await expect(submitProposal(deps, { ...newListingInput, decisionContext: { version: 2 } as never })).rejects.toThrow()
})
```

(`validContext` = the same fixture shape as Task 2's test.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run proposal-submit` → FAIL.

- [ ] **Step 3: Implement** — in `submit.ts`: import `ListingDecisionContextSchema, type ListingDecisionContext` from `@doge-buddy/core`. Add to `SubmitProposalInput`:

```ts
  /** L1 (spec 2026-09-03 Decision 10): code-computed decision numbers for a new_listing —
   *  validated here, stored on the row's decision_context column, display-only downstream. */
  decisionContext?: ListingDecisionContext
```

At the top of `submitProposal`, right after `const parsed = schema.parse(...)`:

```ts
  const decisionContext = input.decisionContext !== undefined ? ListingDecisionContextSchema.parse(input.decisionContext) : null
```

Add `decisionContext,` to BOTH `.values({...})` inserts (manual and auto paths).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run proposal-submit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/proposals/submit.ts apps/ops/test/proposal-submit.test.ts
git commit -m "feat(proposals): submitProposal validates and persists decisionContext"
```

---

### Task 9: Pipeline Stage 1b + provider/registry threading

**Files:**
- Modify: `apps/ops/src/sourcing/pipeline.ts`
- Test: `apps/ops/test/sourcing-pipeline.test.ts`

**Interfaces:**
- Consumes: `expandKeywords`/`ExpansionResult` (Task 4), `DemandProbeProvider` (Task 5), `ReviewsSeen` (Task 6).
- Produces: `SourcingProviders` gains `demand: DemandProbeProvider | null` (Task 11's roots must build it); `validateAndSubmitWinners` receives `demandProbe`, `reviewsSeen`, `trendSignalsByKeyword` (Task 10 defines those dep fields — if executing in order, Task 10 lands first or this task compiles against Task 10's deps; **execute Task 10 BEFORE Task 9** if the type errors bite; they are written in this order because the pipeline test needs the submit-winners surface described there).

**Ordering note:** implement Task 10 first if TypeScript complains — the two tasks are staged as written for narrative clarity, but Task 10's `SubmitWinnersDeps` fields must exist for `pipeline.ts` to compile.

- [ ] **Step 1: Write failing tests** in `sourcing-pipeline.test.ts` (reuse its existing fake providers/db harness):

```ts
it('Stage 1b: expanded keywords reach harvest, trends_rising rows persist, expansion alert fires', async () => {
  // providersFactory returns trends whose fetchRisingQueries yields [rq('dog water bottle', 120)]
  // for the first base keyword and [] for the rest; run the pipeline; assert:
  // - harvest (adapter.searchProducts) was called with 'dog water bottle' among its keywords
  // - a sourcing_signals insert happened with source 'trends_rising', keyword 'dog water bottle',
  //   score '120', snapshot { baseKeyword, value: '+120%', extractedValue: 120 }
  // - alert('info', 'sourcing_keywords_expanded', { added: ['dog water bottle'], dropped: 0 })
})
it('Stage 1b: null providers -> base keywords only, no expansion alert, both existing skip alerts unchanged', async () => {})
it('Stage 1b: a trends_rising persist failure warns and the run continues with expanded keywords', async () => {
  // db insert for trends_rising throws -> alert('warning', 'keyword_expansion_persist_failed', ...) and
  // harvest still receives the expanded keyword list
})
it('Stage 6 receives demandProbe, reviewsSeen, and trendSignalsByKeyword', async () => {
  // spy on validateAndSubmitWinners deps (the test file already asserts marketLookups threading — extend it)
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-pipeline` → FAIL.

- [ ] **Step 3: Implement** in `pipeline.ts`:

1. `SourcingProviders` gains:

```ts
  demand: DemandProbeProvider | null
```

2. Move `const { trends, marketPrice, demand } = providersFactory()` from Stage 3 up to just after the claim succeeds (before Stage 2), keeping the FIX C2 comment with it.

3. Insert Stage 1b between the claim and harvest (inside the big try):

```ts
    // --- Stage 1b: keyword expansion (spec 2026-09-03 Decisions 1-4) — best-effort, never blocks.
    // Base keywords always survive; expansion only appends. Persist/alert failures must not cost
    // the run its expanded keywords (same stance as persistMarketLookups).
    let runKeywords: readonly string[] = knobs.keywords
    if (trends) {
      const expansion = await expandKeywords(trends, knobs.keywords)
      runKeywords = expansion.keywords
      if (expansion.kept.length > 0) {
        try {
          await db.insert(sourcingSignals).values(
            expansion.kept.map((k) => ({
              source: 'trends_rising' as const,
              keyword: k.query,
              score: k.extractedValue != null ? String(k.extractedValue) : null,
              snapshot: { baseKeyword: k.baseKeyword, value: k.value, extractedValue: k.extractedValue },
            })),
          )
        } catch (err) {
          await alert('warning', 'keyword_expansion_persist_failed', { error: errorMessage(err) }).catch(() => {})
        }
        await alert('info', 'sourcing_keywords_expanded', { added: expansion.kept.map((k) => k.query), dropped: expansion.dropped }).catch(() => {})
      }
    }
```

4. Harvest call: `keywords: runKeywords` (was `knobs.keywords`).

5. Stage 3 keeps its trends-skip alert and TIMESERIES logic unchanged (it now scores candidates fetched under expanded keywords automatically — candidates carry their keyword).

6. Stage 5: `const reviewsSeen = new ReviewsSeen()`; pass into `createSourcingMcpServer({ adapter, allowance, marketPrice, marketLookups, reviewsSeen })`.

7. Stage 6 deps gain:

```ts
        demandProbe: demand,
        reviewsSeen,
        trendSignalsByKeyword: new Map(trendSignals.map((s) => [s.keyword, s])),
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-pipeline` → PASS (with Task 10 landed).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/pipeline.ts apps/ops/test/sourcing-pipeline.test.ts
git commit -m "feat(sourcing): pipeline Stage 1b keyword expansion + demand/reviews/trends threading into Stage 6"
```

---

### Task 10: Stage 6 — step 8b decision context + summary clauses

**Files:**
- Modify: `apps/ops/src/sourcing/submit-winners.ts`
- Test: `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Consumes: `buildListingDecisionContext`/`ReviewsSeen`/`DecisionContextInput` (Task 6), `DemandProbeProvider`/`AmazonDemandSnapshot` (Task 5), `TrendSignal` (existing), `SubmitProposalInput.decisionContext` (Task 8), `formatCents` from `@doge-buddy/core`.
- Produces: `SubmitWinnersDeps` gains

```ts
  demandProbe: DemandProbeProvider | null       // null ⇔ no SERPAPI_KEY this run
  reviewsSeen: ReviewsSeen
  trendSignalsByKeyword: Map<string, TrendSignal>
```

(required, not optional — every caller must decide, same stance as `marketLookups`).

- [ ] **Step 1: Write failing tests** in `sourcing-submit-winners.test.ts` (extend its existing winner/adapter fixtures; add the three new deps to the helper that builds `SubmitWinnersDeps` — `demandProbe: null, reviewsSeen: new ReviewsSeen(), trendSignalsByKeyword: new Map()` as the neutral defaults so existing tests keep passing):

```ts
describe('step 8b decision context', () => {
  it('submits with a populated decisionContext and extended summary', async () => {
    // arrange: market gate armed with a conclusive lookup (median 2199), probe resolves an
    // AmazonDemandSnapshot (medianReviews 3400), reviewsSeen primed for the pid, candidate has
    // listedNum 1200, trendSignalsByKeyword has the candidate's keyword with score 62.1.
    // assert submit received input.decisionContext matching ListingDecisionContextSchema with:
    //   economics.variants[0].landedCents === liveCost + freight
    //   economics.market.medianCents === 2199
    //   demand.amazon.medianReviews === 3400
    // and input.summary contains ', profit $' and ' | est: amzn ~3400 reviews, CJ 1200 listed, trends 62'
  })
  it('probes ONLY survivors, reusing the lookup query', async () => {
    // two winners: one dropped at step 6 (no lookup), one submitted.
    // assert probe called exactly once, with the surviving winner's lookup.query.
  })
  it('a probe throw alerts info demand_probe_failed and still submits (amazon null)', async () => {})
  it('market gate skipped run: market and amazon are null, economics still populated, summary has no est amzn clause', async () => {})
  it('null-source clauses are omitted, never rendered as 0', async () => {
    // candidate listedNum null + no trend signal + probe null -> summary has no 'CJ ... listed', no 'trends', no 'amzn'
  })
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run sourcing-submit-winners` → FAIL.

- [ ] **Step 3: Implement** in `submit-winners.ts`:

1. Add the three dep fields (doc comments mirroring `marketLookups`'s "required, not optional" stance).
2. Step 6: hoist the lookup — replace `const lookup = ...` with a function-scoped `let marketLookup: MarketLookup | null = null`; on the pass path set `marketLookup = lookup`.
3. Step 7: keep the stock rows — `const stock = await deps.adapter.getVariantStock(firstVid)` already exists; hoist to `let stockRows: WarehouseStock[] = []` before the try and assign inside.
4. Step 8: keep the chosen option — replace `freightCents = Math.min(...eligible.map((o) => o.priceCents))` with:

```ts
    const chosen = eligible.reduce((a, b) => (b.priceCents < a.priceCents ? b : a))
    freightOption = chosen
    freightCents = chosen.priceCents
```

(`let freightOption: ShippingOption` hoisted next to `freightCents`.)
5. After the step-8 margin loop passes, add step 8b + extend step 9:

```ts
  // Step 8b: decision context (spec 2026-09-03 Decisions 5, 8, 11). Everything here is
  // display-support for the owner: a probe failure must NEVER drop a winner that already
  // passed every gate.
  let amazon: AmazonDemandSnapshot | null = null
  if (deps.demandProbe && marketLookup) {
    try {
      amazon = await deps.demandProbe.probe(marketLookup.query)
    } catch (err) {
      await deps.alert('info', 'demand_probe_failed', { runId: input.runId, supplierProductId: pid, error: errMessage(err) }).catch(() => {})
    }
  }
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
```

and pass `decisionContext` in the `deps.submit(...)` input.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run sourcing-submit-winners` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/submit-winners.ts apps/ops/test/sourcing-submit-winners.test.ts
git commit -m "feat(sourcing): step 8b — decision context assembly, Amazon probe for survivors, profit+est summary clauses"
```

---

### Task 11: Composition roots + `SERPAPI_MAX_REQUESTS_PER_RUN` env

**Files:**
- Modify: `apps/ops/src/config.ts` (EnvSchema ~line 31; `Config.serpapi` ~line 120; loader ~line 170)
- Modify: `apps/ops/src/index.ts` (providersFactory ~line 441)
- Modify: `apps/ops/scripts/run-sourcing.ts` (providersFactory ~line 152)
- Test: `apps/ops/test/config.test.ts`

**Interfaces:**
- Consumes: `createSerpApiAmazonDemand` (Task 5), `SourcingProviders.demand` (Task 9), `createSerpApiClient`'s existing `maxRequests` option.
- Produces: `config.serpapi` becomes `{ apiKey: string; maxRequestsPerRun?: number }`.

- [ ] **Step 1: Write failing tests** in `config.test.ts` (follow its existing loadConfig idiom):

```ts
it('parses SERPAPI_MAX_REQUESTS_PER_RUN into serpapi.maxRequestsPerRun', () => {
  const c = loadConfig({ ...baseEnv, SERPAPI_KEY: 'k', SERPAPI_MAX_REQUESTS_PER_RUN: '35' })
  expect(c.serpapi).toEqual({ apiKey: 'k', maxRequestsPerRun: 35 })
})
it('rejects an out-of-range or non-integer cap loudly', () => {
  expect(() => loadConfig({ ...baseEnv, SERPAPI_KEY: 'k', SERPAPI_MAX_REQUESTS_PER_RUN: '0' })).toThrow(/SERPAPI_MAX_REQUESTS_PER_RUN/)
  expect(() => loadConfig({ ...baseEnv, SERPAPI_KEY: 'k', SERPAPI_MAX_REQUESTS_PER_RUN: 'lots' })).toThrow()
})
it('cap without SERPAPI_KEY is ignored (serpapi stays undefined)', () => {
  const c = loadConfig({ ...baseEnv, SERPAPI_MAX_REQUESTS_PER_RUN: '35' })
  expect(c.serpapi).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run config` → FAIL.

- [ ] **Step 3: Implement**

`config.ts` EnvSchema (after `SERPAPI_KEY`):

```ts
    SERPAPI_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).max(200).optional(),
```

Config type: `serpapi?: { apiKey: string; maxRequestsPerRun?: number }`. Loader:

```ts
  if (data.SERPAPI_KEY !== undefined) {
    config.serpapi = {
      apiKey: data.SERPAPI_KEY,
      ...(data.SERPAPI_MAX_REQUESTS_PER_RUN !== undefined ? { maxRequestsPerRun: data.SERPAPI_MAX_REQUESTS_PER_RUN } : {}),
    }
  }
```

`index.ts` providersFactory:

```ts
  const providersFactory = (): SourcingProviders => {
    if (!config.serpapi) return { trends: null, marketPrice: null, demand: null }
    const client = createSerpApiClient({ apiKey: config.serpapi.apiKey, maxRequests: config.serpapi.maxRequestsPerRun })
    return { trends: createSerpApiTrends({ client }), marketPrice: createSerpApiMarketPrice({ client }), demand: createSerpApiAmazonDemand({ client }) }
  }
```

`scripts/run-sourcing.ts` providersFactory: same three-provider + `maxRequests` change (keep the counting `fetchFn`); update its telemetry line suffix to `(trends + market + amazon)`:

```ts
    `run-sourcing: SerpApi requests made ${serpApiRequests} (trends + market + amazon lookups)${config.serpapi ? '' : ' (SERPAPI_KEY not set — trends, market-price and demand stages skipped)'}`,
```

(`createSerpApiClient` treats `maxRequests: undefined` as the default 25 already — no change there.)

- [ ] **Step 4: Run to verify pass + typecheck** — `pnpm --filter @doge-buddy/ops test -- run config sourcing-pipeline` → PASS; `pnpm -r typecheck` → clean (this is the task where any missed `SourcingProviders` literal in tests surfaces — fix by adding `demand: null`).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/config.ts apps/ops/src/index.ts apps/ops/scripts/run-sourcing.ts apps/ops/test/config.test.ts
git commit -m "feat(ops): wire Amazon demand provider into both roots; SERPAPI_MAX_REQUESTS_PER_RUN env cap"
```

---

### Task 12: Admin proposal page — "Decision numbers" section

**Files:**
- Modify: `apps/ops/src/http/admin/render-proposal.ts`
- Test: `apps/ops/test/admin-proposals-pages.test.ts`

**Interfaces:**
- Consumes: `ProposalRow` already includes `decisionContext` after Task 1 (`$inferSelect`); `ListingDecisionContextSchema` (Task 2); `formatCents` (already imported).
- Produces: rendered section — no exports consumed elsewhere.

- [ ] **Step 1: Write failing tests** in `admin-proposals-pages.test.ts` (extend its existing new_listing detail-page fixtures — build a row with `decisionContext: validContext` from Task 2's shape):

```ts
it('renders the Decision numbers section from decision_context', () => {
  const out = String(renderProposalDetail({ ...newListingRow, decisionContext: validContext }))
  expect(out).toContain('Decision numbers')
  expect(out).toContain('Demand signals — ESTIMATES, not sales')
  expect(out).toContain('$12.61')      // landed for variant A (1261)
  expect(out).toContain('47.4%')       // 4743 bps
  expect(out).toContain('×1.09')       // 2399/2199 -> ratio rendering (see impl: typical/median 2dp)
  expect(out).toContain('~3400 reviews')
})
it('renders identically to today when decision_context is null', () => {
  const withNull = String(renderProposalDetail({ ...newListingRow, decisionContext: null }))
  expect(withNull).not.toContain('Decision numbers')
})
it('refuses to render an unparseable context (section absent, page intact)', () => {
  const out = String(renderProposalDetail({ ...newListingRow, decisionContext: { version: 99 } }))
  expect(out).not.toContain('Decision numbers')
  expect(out).toContain(newListingRow.summary ?? '')  // page still renders
})
it('omits null demand lines rather than printing 0', () => {
  const degraded = { ...validContext, demand: { ...validContext.demand, cjListedCount: null } }
  const out = String(renderProposalDetail({ ...newListingRow, decisionContext: degraded }))
  expect(out).not.toContain('CJ listings')
})
```

(Match the exact assertion idiom the file already uses for rendered HTML — adjust `String(...)` to its helper.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run admin-proposals-pages` → FAIL.

- [ ] **Step 3: Implement** in `render-proposal.ts` — new renderer + call it from `renderProposalDetail` for `new_listing` rows (right after `renderNewListingPreview`):

```ts
/**
 * L1 "Decision numbers" (spec 2026-09-03 Decision 11): economics table + demand ESTIMATES from
 * the row's decision_context. safeParse, not cast — display code refuses to render a context
 * that doesn't match the schema (section absent) rather than crashing the page; a null/absent
 * context renders nothing, so legacy and support-path proposals look exactly as before.
 */
function renderDecisionContext(rawContext: unknown): RawHtml {
  const parsed = ListingDecisionContextSchema.safeParse(rawContext)
  if (!parsed.success) return html``
  const ctx = parsed.data
  const { market, usStockUnits, freight } = ctx.economics
  const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`
  return html`<section>
    <h3>Decision numbers</h3>
    <div class="table-wrap"><table class="rows">
      <thead><tr><th>SKU</th><th>Price</th><th>CJ cost</th><th>Freight</th><th>Landed</th><th>Profit</th><th>Margin</th></tr></thead>
      <tbody>
        ${ctx.economics.variants.map(
          (v) => html`<tr>
            <td data-label="SKU">${v.sku}</td>
            <td data-label="Price">${formatCents(v.priceCents)}</td>
            <td data-label="CJ cost">${formatCents(v.supplierCostCents)}</td>
            <td data-label="Freight">${formatCents(freight.priceCents)}</td>
            <td data-label="Landed">${formatCents(v.landedCents)}</td>
            <td data-label="Profit">${formatCents(v.profitCents)}</td>
            <td data-label="Margin">${pct(v.marginBps)}</td>
          </tr>`,
        )}
      </tbody>
    </table></div>
    <p>Freight: ${formatCents(freight.priceCents)} ${freight.name} (${freight.minDays}–${freight.maxDays} days)${
      usStockUnits != null ? html` · US stock (first variant): ${usStockUnits} units` : html``
    }</p>
    ${market
      ? html`<p>Market ("${market.query}"): ${formatCents(market.medianCents)} median (${market.offerCount} offers) — ours ×${(market.typicalCents / market.medianCents).toFixed(2)} vs ceiling ${formatCents(market.ceilingCents)}</p>`
      : html`<p>Market: gate skipped this run (no SerpApi)</p>`}
    <h3>Demand signals — ESTIMATES, not sales</h3>
    <ul>
      ${ctx.demand.cjListedCount != null ? html`<li>CJ listings using this product: ${ctx.demand.cjListedCount}</li>` : html``}
      ${ctx.demand.cjReviews ? html`<li>CJ reviews (page-1 sample): ${ctx.demand.cjReviews.ratedCount} rated of ${ctx.demand.cjReviews.page1Count}${ctx.demand.cjReviews.avgRating != null ? html`, avg ${ctx.demand.cjReviews.avgRating.toFixed(1)}` : html``}</li>` : html``}
      ${ctx.demand.marketOfferCount != null ? html`<li>Market offers found: ${ctx.demand.marketOfferCount}</li>` : html``}
      ${ctx.demand.trends && ctx.demand.trends.score != null ? html`<li>Trends "${ctx.demand.trends.keyword}": ${Math.round(ctx.demand.trends.score)} mean interest${ctx.demand.trends.momentum != null ? html` (momentum ${ctx.demand.trends.momentum >= 0 ? '+' : ''}${ctx.demand.trends.momentum})` : html``}</li>` : html``}
      ${ctx.demand.amazon ? html`<li>Amazon "${ctx.demand.amazon.query}" (${ctx.demand.amazon.resultsSampled} sampled): ${ctx.demand.amazon.medianReviews != null ? html`median ~${ctx.demand.amazon.medianReviews} reviews` : html``}${ctx.demand.amazon.medianPriceCents != null ? html`, median price ${formatCents(ctx.demand.amazon.medianPriceCents)}` : html``}${ctx.demand.amazon.totalReviews != null ? html`, ~${ctx.demand.amazon.totalReviews} total` : html``}</li>` : html``}
    </ul>
  </section>`
}
```

In `renderProposalDetail`'s new_listing branch (line ~334): `${renderNewListingPreview(...)}${renderDecisionContext(p.decisionContext)}`.

Import `ListingDecisionContextSchema` from `@doge-buddy/core`.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run admin-proposals-pages` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/http/admin/render-proposal.ts apps/ops/test/admin-proposals-pages.test.ts
git commit -m "feat(admin): Decision numbers section on new_listing proposals — economics table + labeled demand estimates"
```

---

### Task 13: Floor-first pricing prompt

**Files:**
- Modify: `apps/ops/src/agents/sourcing-run.ts` (armed `marketSection`, ~lines 88–98)
- Test: `apps/ops/test/agents-sourcing-run.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write failing tests** (extend the existing armed/unarmed prompt assertions):

```ts
it('armed prompt prices floor-first', () => {
  // build the prompt with marketGateArmed: true (existing helper)
  expect(prompt).toContain('clear the freight-inclusive margin floor FIRST')
  expect(prompt).toContain('Anchor toward the market median only when the floor is already comfortably cleared')
  expect(prompt).not.toContain('Price TOWARD the')
})
it('unarmed prompt unchanged', () => { /* existing advisory sentence still present, new wording absent */ })
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @doge-buddy/ops test -- run agents-sourcing-run` → FAIL.

- [ ] **Step 3: Implement** — replace the armed variant's last three lines:

```ts
        'fewer than 5 offers is inconclusive — broaden the query once. Winners with no conclusive lookup,',
        'a lookup for a different product, or a price above the ceiling are dropped. Set each variant price',
        'to clear the freight-inclusive margin floor FIRST — price up to the ceiling when freight demands it.',
        'Anchor toward the market median only when the floor is already comfortably cleared. Never exceed',
        "the ceiling; don't leave money on the table.",
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @doge-buddy/ops test -- run agents-sourcing-run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/sourcing-run.ts apps/ops/test/agents-sourcing-run.test.ts
git commit -m "feat(agents): floor-first pricing wording in the market HARD RULE"
```

---

### Task 14: Full verification + docs

**Files:**
- Modify: `docs/LAUNCH-PLAN.md` (L1 section → BUILT, live-check pointer)
- Modify: `docs/OWNER-CHECKLIST.md` (footer pointer → L1 built, live check + SERPAPI env decision; new live-check item with the full command)

- [ ] **Step 1: Full suite** — `pnpm --filter @doge-buddy/ops test`, `pnpm --filter @doge-buddy/core test`, `pnpm --filter @doge-buddy/db test`.
Expected: green except the two known-benign dev-DB failures (`admin-dashboard` test 13, `scoring-weekly-digest` freshness).

- [ ] **Step 2: Typecheck** — `pnpm -r typecheck`. Expected: clean.

- [ ] **Step 3: Docs** — LAUNCH-PLAN L1 marked BUILT (date, spec+plan paths, live-check summary); OWNER-CHECKLIST gains one ⚪ item: the L1 live check (full `railway ssh` preamble + `pnpm --filter @doge-buddy/ops run-sourcing --max-winners 2 --force`, the four pass criteria from the spec's Live tier, and the `SERPAPI_MAX_REQUESTS_PER_RUN` env decision table), and the footer pointer advances to L2 (quota check first).

- [ ] **Step 4: Commit**

```bash
git add docs/LAUNCH-PLAN.md docs/OWNER-CHECKLIST.md
git commit -m "docs: L1 decision-support BUILT — live-check item + footer pointer to L2"
```

---

## Self-Review Notes

- **Spec coverage:** Decisions 1–4 → Tasks 3, 4, 9; Decision 5–6 → Task 5 (+10 for placement); 7 → Tasks 6, 7; 8–9 → Tasks 6, 10; 10 → Tasks 1, 2, 8; 11 → Tasks 10, 12; 12 → Task 13; 13 → Task 11. Live-tier checks land in docs (Task 14).
- **Ordering:** Tasks 1–8 are independent of each other except 6→7, 2→6, 2→8. Task 10 must land before Task 9 compiles (noted in Task 9). Task 11 last of the wiring so the `SourcingProviders` literal sweep happens once.
- **Type consistency:** `decisionContext` (property) / `decision_context` (column) / `ListingDecisionContext` (type) used consistently; `demandProbe`/`reviewsSeen`/`trendSignalsByKeyword` dep names identical in Tasks 9 and 10; `fetchRisingQueries` identical in Tasks 3 and 4.
