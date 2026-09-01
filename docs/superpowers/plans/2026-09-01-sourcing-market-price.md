# Sourcing Market-Price Tool + Price-to-Market Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the sourcing agent gets a `lookup_market_price` MCP tool (SerpApi Google Shopping) and Stage 6 refuses any winner whose median variant price exceeds 1.3× the code-recorded market median.

**Architecture:** a shared per-run `SerpApiClient` (25-request cap) feeds two providers — the existing trends adapter (refactored onto it) and a new `MarketPriceProvider`. The MCP tool handler records every lookup in a run-scoped `MarketLookups` registry; the winner carries only a `lookupId`; Stage 6 reads the registry, never the agent's numbers. No SerpApi key → both stages degrade with warnings, gate skipped.

**Tech Stack:** TypeScript ESM (`.ts` imports), zod v4, drizzle + Postgres, vitest, `@anthropic-ai/claude-agent-sdk` (mocked via `queryFn` in tests).

**Spec:** `docs/superpowers/specs/2026-09-01-sourcing-market-price-design.md` — read it first; it carries the decisions table and the trust model this plan implements.

## Global Constraints

- All money is **integer cents**, ratios are **integer bps**; gate arithmetic is `Math.floor(cents × bps / 10_000)` — never round up into a false pass (spec Decision 3, §6).
- The SerpApi **api key must never survive into a log line or error message** (scrub, as trends.ts does today).
- The agent's numbers are **untrusted**; Stage 6 reads only the `MarketLookups` registry (spec Decision 2).
- `SETTINGS_DEFAULTS` takes **no `as const`/`satisfies`** (see the comment under it in `apps/ops/src/settings.ts`).
- JSON Schema for structured output must stay **draft-7** (`z.toJSONSchema(..., { target: 'draft-7' })` — already handled by `sourcingOutputJsonSchema`; don't change it).
- DB-backed tests use the shared local Postgres `postgres://doge:doge@localhost:5433/doge_buddy`; always clean up rows you create (see `afterEach` patterns in the test files you touch).
- Run tests with `pnpm --filter @doge-buddy/ops test -- <name-filter>` (vitest run) and `pnpm --filter @doge-buddy/ops typecheck`; db package: `pnpm --filter @doge-buddy/db test`, `pnpm --filter @doge-buddy/db generate`.
- **Deliberate deviation from spec §7:** the pipeline dep is `providersFactory: () => SourcingProviders` (`{ trends, marketPrice }`), not a raw `serpApiFactory`. Same intent (fresh per run — FIX C2; one shared client budget, built in the composition roots), but tests keep injecting stub providers instead of faking SerpApi JSON. Everything else in §7 stands.
- Work on branch `sourcing-market-price` (create from `main` at execution start).

---

### Task 1: Migration 0010 — `market_price` signal source

**Files:**
- Modify: `packages/db/src/schema.ts:28` (the `signalSource` pgEnum)
- Create: `packages/db/migrations/0010_*.sql` (generated — do not hand-write)
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Produces: `signal_source` enum value `'market_price'` — Task 9's `sourcing_signals` inserts use it.

- [ ] **Step 1: Write the failing test** — append to the `describe('migrations', ...)` block in `packages/db/test/migrations.test.ts`:

```ts
  it('signal_source enum includes market_price (migration 0010)', async () => {
    const c = new Client({ connectionString: testUrl })
    await c.connect()
    const res = await c.query(`SELECT unnest(enum_range(NULL::signal_source))::text AS v`)
    await c.end()
    expect(res.rows.map((r) => r.v)).toContain('market_price')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @doge-buddy/db test -- migrations`
Expected: the new test FAILS (`market_price` not in the enum); the pre-existing tests pass.

- [ ] **Step 3: Add the enum value** — in `packages/db/src/schema.ts` change line 28:

```ts
export const signalSource = pgEnum('signal_source', ['cj_trending', 'web_search', 'google_trends', 'owner_manual', 'market_price'])
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @doge-buddy/db generate`
Expected: a new `packages/db/migrations/0010_<name>.sql` containing exactly
`ALTER TYPE "public"."signal_source" ADD VALUE 'market_price';` (precedent: `0001_next_darwin.sql`). If drizzle emits anything else (table churn), STOP — the schema edit went wrong.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @doge-buddy/db test -- migrations`
Expected: PASS (the suite creates a fresh DB per run, so 0010 applies there).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/migrations.test.ts
git commit -m "feat(db): market_price signal_source enum value (migration 0010)"
```

---

### Task 2: `sourcing/serpapi.ts` — shared per-run SerpApi client

**Files:**
- Create: `apps/ops/src/sourcing/serpapi.ts`
- Test: `apps/ops/test/sourcing-serpapi.test.ts` (new)

**Interfaces:**
- Produces (Tasks 3, 4, 9 consume):

```ts
export const SERPAPI_MAX_REQUESTS_PER_RUN = 25
export interface SerpApiClient {
  get(params: Record<string, string>): Promise<unknown | null>
  requestsMade(): number
}
export function scrubApiKey(text: string, apiKey: string): string
export function createSerpApiClient(deps: { apiKey: string; fetchFn?: typeof fetch; maxRequests?: number }): SerpApiClient
```

- [ ] **Step 1: Write the failing tests** — create `apps/ops/test/sourcing-serpapi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { SERPAPI_MAX_REQUESTS_PER_RUN, createSerpApiClient, scrubApiKey } from '../src/sourcing/serpapi.ts'

const FAKE_API_KEY = 'fake-serp-key-for-tests-only'

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('createSerpApiClient', () => {
  it('GETs serpapi.com/search with the params plus api_key and returns the parsed JSON', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      return jsonResponse({ hello: 'world' })
    })
    const client = createSerpApiClient({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch })

    const result = await client.get({ engine: 'google_shopping', q: 'dog bed' })

    expect(result).toEqual({ hello: 'world' })
    const url = new URL(calls[0]!)
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search')
    expect(url.searchParams.get('engine')).toBe('google_shopping')
    expect(url.searchParams.get('q')).toBe('dog bed')
    expect(url.searchParams.get('api_key')).toBe(FAKE_API_KEY)
    expect(client.requestsMade()).toBe(1)
  })

  it('caps at maxRequests: capped calls fire no request, count nothing, and return null', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}))
    const client = createSerpApiClient({ apiKey: FAKE_API_KEY, fetchFn: fetchFn as unknown as typeof fetch, maxRequests: 2 })

    expect(await client.get({ q: 'a' })).toEqual({})
    expect(await client.get({ q: 'b' })).toEqual({})
    expect(await client.get({ q: 'c' })).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(client.requestsMade()).toBe(2)
  })

  it('defaults the cap to SERPAPI_MAX_REQUESTS_PER_RUN (25)', () => {
    expect(SERPAPI_MAX_REQUESTS_PER_RUN).toBe(25)
  })

  it('non-2xx and thrown fetches return null (never throw) and the key never reaches the error log', async () => {
    const logged: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    const http500 = createSerpApiClient({
      apiKey: FAKE_API_KEY,
      fetchFn: (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch,
    })
    expect(await http500.get({ q: 'x' })).toBeNull()

    const throwing = createSerpApiClient({
      apiKey: FAKE_API_KEY,
      fetchFn: (async () => {
        throw new Error(`ECONNRESET talking to https://serpapi.com/search?api_key=${FAKE_API_KEY}`)
      }) as unknown as typeof fetch,
    })
    expect(await throwing.get({ q: 'x' })).toBeNull()
    expect(logged.join('\n')).not.toContain(FAKE_API_KEY)
    errSpy.mockRestore()
  })
})

describe('scrubApiKey', () => {
  it('replaces every occurrence of the key with [redacted]', () => {
    expect(scrubApiKey(`a ${FAKE_API_KEY} b ${FAKE_API_KEY}`, FAKE_API_KEY)).toBe('a [redacted] b [redacted]')
  })
  it('empty key is a no-op', () => {
    expect(scrubApiKey('text', '')).toBe('text')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-serpapi`
Expected: FAIL — module `../src/sourcing/serpapi.ts` not found.

- [ ] **Step 3: Implement** — create `apps/ops/src/sourcing/serpapi.ts`:

```ts
/**
 * Shared per-run SerpApi HTTP client (spec 2026-09-01 market-price §1 / Decision 7). ONE instance
 * serves both the trends provider (Stage 3) and the market-price provider (Stage 5's MCP tool), so
 * the request cap below is the RUN total across both. One instance = one run — the counter never
 * resets (Phase 5 FIX C2), so composition roots construct a fresh client per pipeline run.
 */
export const SERPAPI_MAX_REQUESTS_PER_RUN = 25

const SERPAPI_URL = 'https://serpapi.com/search'

export interface SerpApiClient {
  /** GET SERPAPI_URL with `params` + api_key. Returns parsed JSON, or null when the run cap is
   *  reached (no request fired, nothing counted), the response is non-2xx, or fetch/json throws.
   *  NEVER throws — a SerpApi problem degrades the caller, it must not abort a paid run. */
  get(params: Record<string, string>): Promise<unknown | null>
  requestsMade(): number
}

/** Guarantees the raw api key value can never survive into a log line or error message. */
export function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('[redacted]')
}

export function createSerpApiClient(deps: { apiKey: string; fetchFn?: typeof fetch; maxRequests?: number }): SerpApiClient {
  const { apiKey } = deps
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const maxRequests = deps.maxRequests ?? SERPAPI_MAX_REQUESTS_PER_RUN
  let requestsMade = 0

  return {
    async get(params: Record<string, string>): Promise<unknown | null> {
      if (requestsMade >= maxRequests) return null
      requestsMade += 1
      try {
        const search = new URLSearchParams({ ...params, api_key: apiKey })
        const res = await fetchFn(`${SERPAPI_URL}?${search.toString()}`)
        if (!res.ok) throw new Error(`SerpApi responded with HTTP ${res.status}`)
        return (await res.json()) as unknown
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[serpapi] request failed:', scrubApiKey(message, apiKey))
        return null
      }
    },
    requestsMade: () => requestsMade,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-serpapi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/serpapi.ts apps/ops/test/sourcing-serpapi.test.ts
git commit -m "feat(sourcing): shared per-run SerpApi client with 25-request cap"
```

---

### Task 3: Refactor `trends.ts` onto the shared client

**Files:**
- Modify: `apps/ops/src/sourcing/trends.ts`
- Modify: `apps/ops/test/sourcing-trends.test.ts`

**Interfaces:**
- Consumes: `SerpApiClient` from Task 2.
- Produces: `createSerpApiTrends(deps: { client: SerpApiClient }): TrendsProvider` — signature change; `TrendSignal`, `TrendsProvider`, `SERPAPI_BATCH_SIZE` behaviour unchanged. `SERPAPI_MAX_REQUESTS_PER_RUN` and `scrubApiKey` are **deleted here** (they moved to `serpapi.ts`).
- Note: `pipeline.ts`, `index.ts`, `run-sourcing.ts` still call the OLD signature after this task — they are updated in Task 9. `apps/ops` typecheck will fail between Tasks 3 and 9; the vitest suites named in each task must pass.

- [ ] **Step 1: Update the tests** — in `apps/ops/test/sourcing-trends.test.ts`:
  1. Replace the import line for trends/serpapi with:

```ts
import { createSerpApiTrends } from '../src/sourcing/trends.ts'
import { createSerpApiClient } from '../src/sourcing/serpapi.ts'
```

  2. Add a local helper next to `jsonResponse` and change **every** `createSerpApiTrends({ apiKey: FAKE_API_KEY, fetchFn: ... })` call to use it:

```ts
function provider(fetchFn: typeof fetch, maxRequests?: number) {
  return createSerpApiTrends({ client: createSerpApiClient({ apiKey: FAKE_API_KEY, fetchFn, maxRequests }) })
}
```

  3. The existing cap test (it referenced `SERPAPI_MAX_REQUESTS_PER_RUN` = 10 requests) becomes a client-cap degrade test — replace it with:

```ts
  it('a capped client degrades remaining batches to score-null signals instead of throwing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(serpApiFixture([
      { date: 'Jan 1', values: [{ query: 'k1', extracted_value: 50 }] },
    ])))
    const p = provider(fetchFn as unknown as typeof fetch, 1) // cap after ONE request
    const signals = await p.fetchInterest(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) // 2 batches

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(signals.find((s) => s.keyword === 'k1')?.score).toBe(50)
    expect(signals.find((s) => s.keyword === 'k6')?.score).toBeNull() // second batch never fired
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-trends`
Expected: FAIL — `createSerpApiTrends` does not accept `{ client }` yet.

- [ ] **Step 3: Refactor the implementation** — in `apps/ops/src/sourcing/trends.ts`:
  - Delete `SERPAPI_MAX_REQUESTS_PER_RUN`, `SERPAPI_URL`, `buildUrl`, `scrubApiKey`, and the `requestsMade` counter.
  - Add `import type { SerpApiClient } from './serpapi.ts'`.
  - Keep `TrendSignal`, `TrendsProvider`, `SERPAPI_BATCH_SIZE`, `SERPAPI_DATE_RANGE`, `chunk`, `nullSignalsFor`, `findValueForKeyword`, `extractSignal`, and the response interfaces exactly as they are.
  - Replace the factory:

```ts
/**
 * SerpApi `google_trends` adapter (TIMESERIES). Batches keywords 5 at a time and never throws: a
 * failed request — or a client whose shared per-run cap is spent — yields `score: null` signals for
 * that batch's keywords, so trends problems degrade the run rather than aborting it. The request
 * budget itself lives on the SHARED SerpApiClient (serpapi.ts), spent jointly with the
 * market-price provider; one instance of the client = one run.
 */
export function createSerpApiTrends(deps: { client: SerpApiClient }): TrendsProvider {
  const { client } = deps

  async function fetchBatch(batch: string[]): Promise<TrendSignal[]> {
    const json = (await client.get({
      engine: 'google_trends',
      data_type: 'TIMESERIES',
      q: batch.join(','),
      date: SERPAPI_DATE_RANGE,
    })) as SerpApiTrendsResponse | null
    if (json === null) return nullSignalsFor(batch)
    const timelineData = json.interest_over_time?.timeline_data ?? []
    return batch.map((keyword, index) => extractSignal(keyword, index, timelineData))
  }

  return {
    key: 'serpapi',
    async fetchInterest(keywords: string[]): Promise<TrendSignal[]> {
      const results: TrendSignal[] = []
      for (const batch of chunk(keywords, SERPAPI_BATCH_SIZE)) {
        results.push(...(await fetchBatch(batch)))
      }
      return results
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-trends sourcing-serpapi`
Expected: PASS (all pre-existing trends assertions — batching, positional fallback, mean scoring — still green).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/trends.ts apps/ops/test/sourcing-trends.test.ts
git commit -m "refactor(sourcing): trends provider consumes the shared SerpApi client"
```

---

### Task 4: `sourcing/market-price.ts` — provider, registry, quantiles

**Files:**
- Create: `apps/ops/src/sourcing/market-price.ts`
- Test: `apps/ops/test/sourcing-market-price.test.ts` (new)

**Interfaces:**
- Consumes: `SerpApiClient` (Task 2).
- Produces (Tasks 5–9 consume — exact shapes):

```ts
export const MIN_MARKET_OFFERS = 5
export const MARKET_OFFERS_KEPT = 5
export const DEFAULT_MAX_PRICE_TO_MARKET_BPS = 13000
export interface MarketOffer { title: string; priceCents: number; merchant: string | null; url: string | null }
export interface MarketLookup {
  lookupId: string; supplierProductId: string; query: string; offerCount: number
  medianCents: number | null; p25Cents: number | null; p75Cents: number | null
  offers: MarketOffer[]; snapshot: Record<string, unknown>
}
export interface MarketPriceProvider { readonly key: string; fetchOffers(query: string): Promise<MarketOffer[] | null> }
export function createSerpApiMarketPrice(deps: { client: SerpApiClient }): MarketPriceProvider
export function quantileCents(sortedAsc: number[], q: number): number  // sortedAsc[min(n-1, floor(n*q))]
export class MarketLookups {
  record(input: { supplierProductId: string; query: string; offers: MarketOffer[] }): MarketLookup
  get(lookupId: string): MarketLookup | undefined
  find(supplierProductId: string, query: string): MarketLookup | undefined
  all(): MarketLookup[]
}
```

- [ ] **Step 1: Write the failing tests** — create `apps/ops/test/sourcing-market-price.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-market-price`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `apps/ops/src/sourcing/market-price.ts`:

```ts
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
    this.byKey.set(`${input.supplierProductId} ${normalizeQuery(input.query)}`, lookup)
    return lookup
  }

  get(lookupId: string): MarketLookup | undefined {
    return this.byId.get(lookupId)
  }

  find(supplierProductId: string, query: string): MarketLookup | undefined {
    return this.byKey.get(`${supplierProductId} ${normalizeQuery(query)}`)
  }

  all(): MarketLookup[] {
    return [...this.byId.values()]
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-market-price`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/market-price.ts apps/ops/test/sourcing-market-price.test.ts
git commit -m "feat(sourcing): Google Shopping market-price provider + run-scoped lookup registry"
```

---

### Task 5: The `sourcing.max_price_to_market_bps` knob

**Files:**
- Modify: `apps/ops/src/settings.ts` (SETTINGS_DEFAULTS)
- Modify: `apps/ops/src/sourcing/knobs.ts`
- Test: `apps/ops/test/sourcing-knobs.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MAX_PRICE_TO_MARKET_BPS` (Task 4).
- Produces: `SourcingKnobs.maxPriceToMarketBps: number` (Tasks 7 and 9 consume); setting key `'sourcing.max_price_to_market_bps'` (number kind — auto-listed on `/admin/settings` by `routes.ts:1341`, no admin change needed).

- [ ] **Step 1: Write the failing tests** — in `apps/ops/test/sourcing-knobs.test.ts`, add to the imports `DEFAULT_MAX_PRICE_TO_MARKET_BPS` from `'../src/sourcing/market-price.ts'`, then add inside `describe('resolveSourcingKnobs', ...)`:

```ts
  it('max_price_to_market default is pinned to the code constant (13000 bps)', async () => {
    expect(SETTINGS_DEFAULTS['sourcing.max_price_to_market_bps']).toBe(DEFAULT_MAX_PRICE_TO_MARKET_BPS)
    const knobs = await resolveSourcingKnobs(fakeSettings())
    expect(knobs.maxPriceToMarketBps).toBe(13000)
  })

  it('max_price_to_market setting beats the constant and is range-checked (10000-20000, integer)', async () => {
    const knobs = await resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 15000 }))
    expect(knobs.maxPriceToMarketBps).toBe(15000)

    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 9999 }))).rejects.toThrow(
      /maxPriceToMarketBps \(setting sourcing\.max_price_to_market_bps\) must be between 10000 and 20000/,
    )
    await expect(resolveSourcingKnobs(fakeSettings({ 'sourcing.max_price_to_market_bps': 20001 }))).rejects.toThrow(
      /must be between 10000 and 20000/,
    )
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-knobs`
Expected: FAIL — unknown setting key / missing knob field.

- [ ] **Step 3: Implement.**
  In `apps/ops/src/settings.ts`, after `'sourcing.max_budget_cents': 200,` add:

```ts
  // Price-to-market ceiling for sourcing winners (spec 2026-09-01 market-price Decision 6):
  // median variant price must be <= this many bps of the Google Shopping market median. 13000 =
  // 1.3x. Enforced in Stage 6 only when SERPAPI_KEY is configured; the default is pinned to
  // DEFAULT_MAX_PRICE_TO_MARKET_BPS by sourcing-knobs.test.ts.
  'sourcing.max_price_to_market_bps': 13000,
```

  In `apps/ops/src/sourcing/knobs.ts`:
  1. `import { DEFAULT_MAX_PRICE_TO_MARKET_BPS } from './market-price.ts'` (import is used only by the doc comment contract — actually used in nothing at runtime; **skip the import** and just add the range + resolution below; the default flows in via `SETTINGS_DEFAULTS`).
  2. Extend the ranges:

```ts
export const SOURCING_KNOB_RANGES = {
  maxWinners: { min: 1, max: 12, integer: true },
  // Floor is MIN_CANDIDATES: below it every harvest would short-circuit as `no_candidates`.
  candidateTarget: { min: 3, max: 80, integer: true },
  maxPages: { min: 1, max: 40, integer: true },
  maxBudgetUsd: { min: 0.5, max: 10, integer: false },
  // 10000 (never above market) .. 20000 (2x market) — outside that is an owner typo, not intent.
  maxPriceToMarketBps: { min: 10_000, max: 20_000, integer: true },
} as const
```

  3. Extend the resolved type (there is no override/CLI flag for this knob — spec Decision 6):

```ts
export type SourcingKnobs = Required<Omit<SourcingOverrides, 'keywords'>> & {
  keywords: readonly string[]
  /** No override tier: setting > constant only (spec 2026-09-01 market-price Decision 6). */
  maxPriceToMarketBps: number
}
```

  4. In `resolveSourcingKnobs`, add `settings.get('sourcing.max_price_to_market_bps')` to the `Promise.all` (fifth element, `maxPriceToMarketBps`) and to the returned object:

```ts
    maxPriceToMarketBps: checkRange('maxPriceToMarketBps', maxPriceToMarketBps, 'setting sourcing.max_price_to_market_bps'),
```

  5. In `describeSourcingKnobs`, append `` `maxPriceToMarketBps=${knobs.maxPriceToMarketBps}` `` to the array.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-knobs settings admin-settings`
Expected: PASS (the settings/admin-settings suites confirm the new key renders and round-trips as a number).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/settings.ts apps/ops/src/sourcing/knobs.ts apps/ops/test/sourcing-knobs.test.ts
git commit -m "feat(sourcing): sourcing.max_price_to_market_bps knob (default 13000, range 10000-20000)"
```

---

### Task 6: The `lookup_market_price` MCP tool

**Files:**
- Modify: `apps/ops/src/agents/mcp-tools.ts`
- Test: `apps/ops/test/agents-mcp-tools.test.ts`

**Interfaces:**
- Consumes: `MarketPriceProvider`, `MarketLookups`, `MarketLookup` (Task 4).
- Produces: `SourcingMcpDeps` gains `marketPrice?: MarketPriceProvider | null` and `marketLookups?: MarketLookups`; handler `lookup_market_price(args: { supplierProductId: string; query: string })` returning the recorded lookup **without** `snapshot`; the tool is registered in `createSourcingMcpServer` ONLY when both new deps are present. Task 9 wires them.

- [ ] **Step 1: Write the failing tests** — in `apps/ops/test/agents-mcp-tools.test.ts`, add imports:

```ts
import { MarketLookups, type MarketOffer, type MarketPriceProvider } from '../src/sourcing/market-price.ts'
```

and a new describe block (reuse the existing `makeStubAdapter`; the existing suites construct handlers via `createSourcingToolHandlers({ adapter, allowance })` — that must keep compiling unchanged, which is why the new deps are optional):

```ts
describe('lookup_market_price tool', () => {
  function offers(...cents: number[]): MarketOffer[] {
    return cents.map((c, i) => ({ title: `o${i}`, priceCents: c, merchant: null, url: null }))
  }
  function makeMarketDeps(fetchOffers: MarketPriceProvider['fetchOffers']) {
    const marketLookups = new MarketLookups()
    const marketPrice: MarketPriceProvider = { key: 'serpapi_google_shopping', fetchOffers }
    const handlers = createSourcingToolHandlers({
      adapter: makeStubAdapter(), allowance: new PointsAllowance(), marketPrice, marketLookups,
    })
    return { handlers, marketLookups }
  }

  it('records the lookup and returns it (id + stats + offers, no snapshot); spends NO CJ points', async () => {
    const allowance = new PointsAllowance()
    const marketLookups = new MarketLookups()
    const handlers = createSourcingToolHandlers({
      adapter: makeStubAdapter(), allowance,
      marketPrice: { key: 'serpapi_google_shopping', fetchOffers: vi.fn(async () => offers(100, 200, 300, 400, 500)) },
      marketLookups,
    })

    const result = await handlers.lookup_market_price({ supplierProductId: 'cjp-1', query: 'dog bed' })

    expect(result.isError).toBeUndefined()
    const body = JSON.parse((result.content[0] as { text: string }).text)
    expect(body).toEqual({
      lookupId: 'mkt_1', supplierProductId: 'cjp-1', query: 'dog bed', offerCount: 5,
      medianCents: 300, p25Cents: 200, p75Cents: 400,
      offers: offers(100, 200, 300, 400, 500),
    })
    expect(marketLookups.get('mkt_1')?.medianCents).toBe(300)
    expect(allowance.spent()).toBe(0)
  })

  it('identical (pid, query modulo case/whitespace) repeat returns the SAME lookup, no second fetch', async () => {
    const fetchOffers = vi.fn(async () => offers(1, 2, 3, 4, 5))
    const { handlers } = makeMarketDeps(fetchOffers)

    const first = JSON.parse(((await handlers.lookup_market_price({ supplierProductId: 'p', query: 'Dog  Bed' })).content[0] as { text: string }).text)
    const second = JSON.parse(((await handlers.lookup_market_price({ supplierProductId: 'p', query: ' dog bed ' })).content[0] as { text: string }).text)

    expect(fetchOffers).toHaveBeenCalledTimes(1)
    expect(second.lookupId).toBe(first.lookupId)
  })

  it('null from the provider (cap/HTTP) -> isError, nothing recorded', async () => {
    const { handlers, marketLookups } = makeMarketDeps(vi.fn(async () => null))
    const result = await handlers.lookup_market_price({ supplierProductId: 'p', query: 'q' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('proceed with the lookups you already have')
    expect(marketLookups.all()).toEqual([])
  })

  it('server registers the tool only when a provider is wired', () => {
    const base = { adapter: makeStubAdapter(), allowance: new PointsAllowance() }
    // instance.options.tools is the SDK's registered tool list (name property per tool)
    const without = createSourcingMcpServer(base) as unknown as { instance?: unknown }
    const withMarket = createSourcingMcpServer({
      ...base,
      marketPrice: { key: 'serpapi_google_shopping', fetchOffers: async () => [] },
      marketLookups: new MarketLookups(),
    })
    // Both construct; the armed one exposes a lookup_market_price handler, the bare one does not.
    const bareHandlers = createSourcingToolHandlers(base)
    expect(bareHandlers.lookup_market_price).toBeDefined() // handler exists...
    const bareResult = bareHandlers.lookup_market_price({ supplierProductId: 'p', query: 'q' })
    expect(without).toBeDefined()
    expect(withMarket).toBeDefined()
    return expect(bareResult).resolves.toMatchObject({ isError: true }) // ...but reports unavailable
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- agents-mcp-tools`
Expected: FAIL — `lookup_market_price` not on the handlers.

- [ ] **Step 3: Implement** — in `apps/ops/src/agents/mcp-tools.ts`:
  1. Imports:

```ts
import { MarketLookups, type MarketPriceProvider } from '../sourcing/market-price.ts'
```

  2. Extend deps + add the exhausted message next to `ALLOWANCE_EXHAUSTED_MESSAGE`:

```ts
const MARKET_LOOKUP_UNAVAILABLE_MESSAGE =
  'Market price lookup failed or the SerpApi budget is exhausted — proceed with the lookups you already have.'

export interface SourcingMcpDeps {
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews' | 'getVariantStock' | 'quoteShipping'>
  allowance: PointsAllowance
  /** Both present => the lookup_market_price tool is registered (SERPAPI_KEY configured);
   *  absent => the tool does not exist and the prompt says the gate is skipped (spec Decision 5). */
  marketPrice?: MarketPriceProvider | null
  marketLookups?: MarketLookups
}
```

  3. In `createSourcingToolHandlers`, add the handler (SerpApi is the meter — no `trySpend`):

```ts
    async lookup_market_price(args: { supplierProductId: string; query: string }, _extra?: unknown): Promise<CallToolResult> {
      if (!deps.marketPrice || !deps.marketLookups) {
        return errorResult(MARKET_LOOKUP_UNAVAILABLE_MESSAGE)
      }
      const cached = deps.marketLookups.find(args.supplierProductId, args.query)
      if (cached) {
        const { snapshot: _snapshot, ...body } = cached
        return ok(body)
      }
      try {
        const offers = await deps.marketPrice.fetchOffers(args.query)
        if (offers === null) return errorResult(MARKET_LOOKUP_UNAVAILABLE_MESSAGE)
        const lookup = deps.marketLookups.record({ supplierProductId: args.supplierProductId, query: args.query, offers })
        const { snapshot: _snapshot, ...body } = lookup
        return ok(body)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },
```

  4. In `createSourcingMcpServer`, build the tools array conditionally:

```ts
  const tools = [
    /* the four existing tool(...) entries, unchanged */
  ]
  if (deps.marketPrice && deps.marketLookups) {
    tools.push(
      tool(
        'lookup_market_price',
        'Google Shopping offers for a query: median/p25/p75 price in cents, offer count, the 5 cheapest offers. ' +
          'Query as a US shopper would type it ("orthopedic dog bed large"), never a CJ title. ' +
          '>= 5 offers = conclusive; fewer -> broaden the query once. Returns a lookupId you MUST put ' +
          'on the winner as marketLookupId (its supplierProductId must match the winner).',
        { supplierProductId: z.string().min(1), query: z.string().min(2).max(120) },
        handlers.lookup_market_price,
      ),
    )
  }
  return createSdkMcpServer({ name: 'sourcing', version: '1.0.0', tools })
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- agents-mcp-tools`
Expected: PASS, including all pre-existing tool tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/mcp-tools.ts apps/ops/test/agents-mcp-tools.test.ts
git commit -m "feat(agents): lookup_market_price MCP tool recording into the run-scoped registry"
```

---

### Task 7: Winner schema + prompt (armed/unarmed) + turn budget

**Files:**
- Modify: `apps/ops/src/agents/output-schema.ts`
- Modify: `apps/ops/src/agents/sourcing-run.ts`
- Test: `apps/ops/test/agents-sourcing-run.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MAX_PRICE_TO_MARKET_BPS` (Task 4).
- Produces: `SourcingWinnerSchema` field `marketLookupId?: string`; `SourcingRunInput.marketGateArmed?: boolean` (absent = unarmed = today's behaviour + advisory sentence); `SOURCING_MAX_TURNS = 30`. Task 9 passes `marketGateArmed`; Task 8 reads `winner.marketLookupId`.

- [ ] **Step 1: Write the failing tests** — in `apps/ops/test/agents-sourcing-run.test.ts` (the `deps`/`stream`/`claimRow` helpers already exist — follow the `it('prompt pins the US-stock hard rule...')` pattern at line 93):

```ts
  it('armed: prompt carries the market-price HARD RULE with the resolved ratio and lookup contract', async () => {
    const runId = await claimRow('market-armed')
    let capturedPrompt = ''
    let capturedSystem = ''
    const d = deps((args) => {
      capturedPrompt = args.prompt
      capturedSystem = String(args.options?.systemPrompt ?? '')
      return stream()
    })
    await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: [], marketGateArmed: true })

    expect(capturedPrompt).toContain('## Market price — HARD RULE')
    expect(capturedPrompt).toContain('1.3×') // DEFAULT_MAX_PRICE_TO_MARKET_BPS rendered
    expect(capturedPrompt).toContain('marketLookupId')
    expect(capturedPrompt).toContain('fewer than 5 offers')
    expect(capturedSystem).toContain('lookup_market_price')
  })

  it('unarmed (flag absent): advisory sentence, no HARD RULE, no marketLookupId contract', async () => {
    const runId = await claimRow('market-unarmed')
    let capturedPrompt = ''
    const d = deps((args) => { capturedPrompt = args.prompt; return stream() })
    await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: [] })

    expect(capturedPrompt).toContain('Market price lookup is unavailable this run')
    expect(capturedPrompt).not.toContain('## Market price — HARD RULE')
  })

  it('a winner with marketLookupId parses; SOURCING_MAX_TURNS is 30', async () => {
    const winner = { ...validWinner(), marketLookupId: 'mkt_1' }
    expect(SourcingOutputSchema.safeParse({ winners: [winner] }).success).toBe(true)
    expect(SOURCING_MAX_TURNS).toBe(30)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- agents-sourcing-run`
Expected: the three new tests FAIL (unknown key `marketLookupId` fails strict parse; no market section; turns = 25).

- [ ] **Step 3: Implement.**
  In `apps/ops/src/agents/output-schema.ts`, inside `SourcingWinnerSchema`:

```ts
export const SourcingWinnerSchema = z.object({
  payload: NewListingPayloadSchema, // from @doge-buddy/core
  rationale: z.string().min(1).max(2000),
  marginPct: z.number(),
  freightEstimateCents: z.number().int().nonnegative(),
  /** The lookup_market_price lookupId backing this winner's pricing. Optional at the SCHEMA level
   *  only because a SerpApi-less run has no tool to call — when the gate is armed, Stage 6 drops
   *  winners without a conclusive, pid-matching lookup (spec Decision 5). UNTRUSTED like every
   *  other field: it is a registry KEY, never a number. */
  marketLookupId: z.string().min(1).optional(),
})
```

  In `apps/ops/src/agents/sourcing-run.ts`:
  1. `import { DEFAULT_MAX_PRICE_TO_MARKET_BPS } from '../sourcing/market-price.ts'`
  2. `export const SOURCING_MAX_TURNS = 30` (was 25 — one extra required tool call per shortlisted candidate, spec Decision 10).
  3. `SourcingRunInput` gains:

```ts
  /** True when the market-price tool is registered this run (SERPAPI_KEY configured) — picks the
   *  armed prompt wording. Absent/false = unarmed = advisory sentence only. */
  marketGateArmed?: boolean
```

  4. `buildSystemPrompt(maxWinners: number, marketGateArmed: boolean)` — when armed, extend the "You MUST use the read-only mcp__sourcing__* tools" sentence's tool list with `lookup_market_price` by appending after "quote_freight on the candidates you are evaluating.":

```
' When the lookup_market_price tool is available you MUST call it for every winner and carry its lookupId.'
```

  (append the sentence only when `marketGateArmed`).
  5. In `buildPrompt(input, maxWinners)`, resolve the ratio and insert a section between "## US stock — HARD RULE" and "## Task":

```ts
  const bps = input.knobs?.maxPriceToMarketBps ?? DEFAULT_MAX_PRICE_TO_MARKET_BPS
  const ratio = (bps / 10_000).toFixed(1)
  const exampleCeiling = (Math.floor(2499 * bps / 10_000) / 100).toFixed(2)
  const marketSection = input.marketGateArmed
    ? [
        '## Market price — HARD RULE',
        'For every winner call lookup_market_price with a generic US-shopper query for that product',
        '(e.g. "orthopedic dog bed large", never a CJ title) and set the winner\'s marketLookupId to the',
        `returned id (same supplierProductId). Plain code enforces: the median of your variant prices`,
        `must be <= ${ratio}× the market median (e.g. market $24.99 → ceiling $${exampleCeiling}). A lookup with`,
        'fewer than 5 offers is inconclusive — broaden the query once. Winners with no conclusive lookup,',
        'a lookup for a different product, or a price above the ceiling are dropped. Price TOWARD the',
        "market median when the margin floor allows: don't overprice, don't leave money on the table.",
      ]
    : [
        '## Market price',
        'Market price lookup is unavailable this run (no SerpApi). Use web search to sanity-check',
        'pricing; this is advisory only — the price-to-market gate is skipped.',
      ]
```

  splice `...marketSection, ''` into the returned array right before `'## Task'`, and pass `input.marketGateArmed ?? false` into `buildSystemPrompt` at the `runSourcingAgent` call site.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- agents-sourcing-run sourcing-submit-winners`
Expected: PASS — including every pre-existing prompt/knob/schema test (they pass no `marketGateArmed`, so they get the unarmed wording; if one asserts an exact full-prompt string, update it to `toContain` assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/agents/output-schema.ts apps/ops/src/agents/sourcing-run.ts apps/ops/test/agents-sourcing-run.test.ts
git commit -m "feat(agents): marketLookupId on winners + armed/unarmed market prompt, 30 turns"
```

---

### Task 8: Stage 6 gate — Step 6 in `submit-winners.ts`

**Files:**
- Modify: `apps/ops/src/sourcing/submit-winners.ts`
- Test: `apps/ops/test/sourcing-submit-winners.test.ts`

**Interfaces:**
- Consumes: `MarketLookups`, `MarketLookup`, `quantileCents` (Task 4); `winner.marketLookupId` (Task 7).
- Produces: `SubmitWinnersDeps.marketLookups: MarketLookups | null` (REQUIRED field — every caller must decide) and `ValidateAndSubmitWinnersInput.maxPriceToMarketBps: number`. Drop reasons `'sourcing_winner_no_market_price'` and `'sourcing_winner_price_above_market'`. Summary suffix `, market $X.XX median ×Y.YY` when the gate ran. Task 9 wires the pipeline call.

- [ ] **Step 1: Write the failing tests** — in `apps/ops/test/sourcing-submit-winners.test.ts`. The file's existing `makeDeps`-style construction must gain the two new fields; update the shared builder(s) so every existing test passes `marketLookups: null` and `maxPriceToMarketBps: 13000` by default, then add:

```ts
import { MarketLookups, type MarketOffer } from '../src/sourcing/market-price.ts'

function marketOffers(...cents: number[]): MarketOffer[] {
  return cents.map((c, i) => ({ title: `o${i}`, priceCents: c, merchant: null, url: null }))
}

describe('step 6: price-to-market gate', () => {
  it('gate skipped when marketLookups is null: winner submits, summary has NO market clause', async () => {
    // build deps as the existing happy-path test does, with marketLookups: null
    // assert outcome 'submitted' and submitted summary does NOT match /market \$/
  })

  it('armed + no marketLookupId -> dropped sourcing_winner_no_market_price (reason missing), BEFORE any CJ call', async () => {
    // deps with marketLookups: new MarketLookups() (empty), winner without marketLookupId
    // assert outcome dropped, reason 'sourcing_winner_no_market_price'
    // assert adapter.getProduct was NOT called (gate precedes CJ re-verify — spec Decision 9)
  })

  it('armed + lookup for a DIFFERENT pid -> dropped (pid_mismatch)', async () => {
    // registry.record({ supplierProductId: 'other-pid', query: 'q', offers: marketOffers(1,2,3,4,5) })
    // winner.marketLookupId = 'mkt_1' -> dropped 'sourcing_winner_no_market_price'
    // alert detail contains reason: 'pid_mismatch'
  })

  it('armed + inconclusive lookup (4 offers) -> dropped (inconclusive)', async () => {
    // record with marketOffers(100, 200, 300, 400) for the winner pid -> medianCents null
    // -> dropped 'sourcing_winner_no_market_price', detail reason: 'inconclusive'
  })

  it('median variant price at the ceiling passes; one cent above drops with full detail', async () => {
    // lookup: marketOffers(2000, 2400, 2499, 2600, 3000) -> median 2499
    // maxPriceToMarketBps 13000 -> ceiling floor(2499*13000/10000) = 3248
    // winner A: single variant priceCents 3248 -> submitted, summary contains 'market $24.99 median ×1.30'
    // winner B: single variant priceCents 3249 -> dropped 'sourcing_winner_price_above_market'
    //   alert detail: { typicalCents: 3249, medianCents: 2499, ceilingCents: 3248, maxPriceToMarketBps: 13000 }
  })

  it('multi-variant: the MEDIAN variant price is gated (upper-middle on even counts)', async () => {
    // lookup median 2499, ceiling 3248
    // variants priced [1999, 3249, 3300, 5999] -> median = index floor(4*0.5)=2 -> 3300 -> DROPPED
    // variants priced [1999, 3200, 3248, 5999] -> median 3248 -> PASSES (margin numbers kept valid
    //   per the file's existing winnerFor helper: supplierCostCents/live cost 1000, freight 500)
  })
})
```

  Write these as full tests using the file's existing `candidate`/`winnerFor` helpers and deps builder — each needs: the candidate registered, a `MarketLookups` seeded via `record()` with the winner's real pid, `winner: { marketLookupId: 'mkt_1' }` overrides, and assertions on the outcome array + the `alert` mock's calls + the `submit` mock's captured `summary`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-submit-winners`
Expected: new tests FAIL (unknown deps fields / no gate); existing tests fail to compile until the builder passes the two new fields — add those defaults first so ONLY the new behaviour is red.

- [ ] **Step 3: Implement** — in `apps/ops/src/sourcing/submit-winners.ts`:
  1. Imports:

```ts
import { quantileCents, type MarketLookups } from './market-price.ts'
```

  2. Extend the interfaces:

```ts
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
}

export interface ValidateAndSubmitWinnersInput {
  runId: string
  candidateIds: Set<string>
  candidatesByPid: Map<string, HarvestCandidate>
  winners: SourcingWinner[]
  /** Resolved `sourcing.max_price_to_market_bps` knob (Stage 0) — the step-6 ceiling in bps. */
  maxPriceToMarketBps: number
}
```

  3. In `processWinner`, insert between Step 5 (claims scrub) and the CJ re-verification block (renumber the existing comments: CJ re-verify becomes Step 7, margin Step 8, submit Step 9):

```ts
  // Step 6: price-to-market gate (spec 2026-09-01 market-price §6 / Decisions 2-5). Runs BEFORE
  // the CJ steps because it is free — a registry read — while steps 7-8 spend CJ points. Reads
  // ONLY what the tool handler recorded (MarketLookups), never a number the agent typed; the
  // agent's marketLookupId is a key, and a key for the wrong product is as dead as no key.
  let marketClause = ''
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
  }
```

  4. Extend the summary line (old Step 8, now Step 9):

```ts
  const summary = `New listing: ${payload.title} — ${payload.variants.length} variant(s), margin ${minMarginBps}bps${marketClause}`
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-submit-winners`
Expected: PASS — every pre-existing step test still green (they run with `marketLookups: null`).

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/sourcing/submit-winners.ts apps/ops/test/sourcing-submit-winners.test.ts
git commit -m "feat(sourcing): stage-6 price-to-market gate against code-recorded lookups"
```

---

### Task 9: Pipeline wiring + composition roots

**Files:**
- Modify: `apps/ops/src/sourcing/pipeline.ts`
- Modify: `apps/ops/src/index.ts:186-188` (boot log) and `:435-444` (factory wiring)
- Modify: `apps/ops/scripts/run-sourcing.ts` (trends factory → providers factory)
- Test: `apps/ops/test/sourcing-pipeline.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `SourcingPipelineDeps.providersFactory: () => SourcingProviders` **replacing** `trendsFactory`, with

```ts
export interface SourcingProviders {
  trends: TrendsProvider | null
  marketPrice: MarketPriceProvider | null
}
export async function persistMarketLookups(db: Db, alert: Alert, lookups: MarketLookup[]): Promise<void>
```

- [ ] **Step 1: Update the pipeline tests** — in `apps/ops/test/sourcing-pipeline.test.ts`:
  1. `baseDeps` (line ~232): replace `trendsFactory: () => stubTrends(),` with `providersFactory: () => ({ trends: stubTrends(), marketPrice: null }),` and mechanically update the four override call sites (`trendsFactory: () => trends` → `providersFactory: () => ({ trends, marketPrice: null })`, `trendsFactory: () => null` → `providersFactory: () => ({ trends: null, marketPrice: null })`, the `vi.fn` factory test and the throwing-factory test analogously — the factory-called-per-run and throw-propagation assertions keep their meaning).
  2. New tests:

```ts
  it('no market provider: market_price_stage_skipped warning fires, winners submit without a lookup', async () => {
    // providersFactory: () => ({ trends: stubTrends(), marketPrice: null })
    // winner WITHOUT marketLookupId via fakeQueryFn -> outcome completed, submitted 1
    // expect(alert).toHaveBeenCalledWith('warning', 'market_price_stage_skipped', expect.anything())
  })

  it('market provider present: a winner without a lookup is dropped end-to-end (armed wiring proof)', async () => {
    // providersFactory: () => ({ trends: stubTrends(), marketPrice: { key: 'stub', fetchOffers: async () => [] } })
    // fakeQueryFn returns one winner with no marketLookupId (the fake stream makes no tool calls,
    // so the registry stays empty) -> outcome completed, submitted 0
    // expect(alert).toHaveBeenCalledWith('warning', 'sourcing_winner_no_market_price', expect.anything())
    // and NO market_price_stage_skipped alert
  })

  it('persistMarketLookups writes market_price sourcing_signals rows and never throws', async () => {
    const reg = new MarketLookups()
    const conclusive = reg.record({ supplierProductId: pidA, query: 'dog bed', offers: [/* 5 offers */] })
    const inconclusive = reg.record({ supplierProductId: pidB, query: 'weird thing', offers: [] })
    await persistMarketLookups(db, vi.fn(async () => {}), reg.all())
    // select from sourcingSignals where source='market_price' and supplierProductId in (pidA,pidB)
    // conclusive row: keyword 'dog bed', score = String(medianCents), snapshot.offerCount = 5
    // inconclusive row: score null
    // (register pidA/pidB in createdPids for cleanup; extend the afterEach source list to sweep
    //  'market_price' rows by pid — the existing pid-based delete already covers them)
    // second call with a db whose insert throws (pass a poisoned db stub) -> resolves, alert called
    //  with ('warning', 'market_price_persist_failed', ...)
  })
```

  Write these fully using the file's `candidateSpecs`/`fakeQueryFn`/`baseDeps` helpers and its cleanup registries; import `MarketLookups` from `../src/sourcing/market-price.ts` and `persistMarketLookups`, `type SourcingProviders` from `../src/sourcing/pipeline.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-pipeline`
Expected: FAIL — `providersFactory` unknown.

- [ ] **Step 3: Implement the pipeline** — in `apps/ops/src/sourcing/pipeline.ts`:
  1. Imports: add `MarketLookups, createSerpApiMarketPrice is NOT needed here (providers arrive built); import { MarketLookups, type MarketLookup, type MarketPriceProvider } from './market-price.ts'` and `sourcingSignals` is already imported.
  2. Replace the `trendsFactory` dep (keep the FIX C2 doc comment, reworded for providers):

```ts
export interface SourcingProviders {
  trends: TrendsProvider | null
  marketPrice: MarketPriceProvider | null
}
```

```ts
  /**
   * Produces FRESH providers per pipeline run (both null when SERPAPI_KEY is absent — trends stage
   * skipped per spec §Stage 2, market gate skipped per market-price spec Decision 5). A factory,
   * not instances, for the same reason trendsFactory was (Phase 5 FIX C2): both providers share
   * ONE SerpApiClient whose per-run request cap never resets — composition roots build
   * client + both providers fresh inside this factory so every run starts with a zero counter.
   */
  providersFactory: () => SourcingProviders
```

  3. Stage 3 becomes:

```ts
    const { trends, marketPrice } = deps.providersFactory()
```

  (rest of the trends block unchanged).
  4. Stage 5 block:

```ts
    const allowance = new PointsAllowance()
    allowance.spend(pagesFetched * 50, 'harvest')

    // --- Stage 5: the agent run (Task 10 MCP server + Task 12 runner) -------------------------
    const marketLookups = new MarketLookups()
    if (!marketPrice) {
      await alert('warning', 'market_price_stage_skipped', {}).catch(() => {})
    }
    const mcpServer = createSourcingMcpServer({ adapter, allowance, marketPrice, marketLookups })
    const agentResult = await runSourcingAgent(
      { db, alert, mcpServer, queryFn },
      { runId, candidates, trendSignals, knobs, marketGateArmed: marketPrice !== null },
    )

    // --- Stage 5b: persist the run's market lookups, whatever the agent's status --------------
    // (a failed run's lookups are the most useful ones to have on record; spec §7). Never blocks.
    await persistMarketLookups(db, alert, marketLookups.all())

    if (agentResult.status !== 'succeeded' || !agentResult.output) {
      return { runId, outcome: 'agent_failed', submitted: 0 }
    }
```

  5. Stage 6 call gains the two new fields:

```ts
    const submitDeps: SubmitWinnersDeps = { db, adapter, allowance, submit: submitProposal, submitDeps: proposalDeps, settings, alert, marketLookups: marketPrice ? marketLookups : null }
```

  (match the file's actual local naming — today it builds `submitDeps: SubmitProposalDeps` then an inline deps object for `validateAndSubmitWinners`; add `marketLookups: marketPrice ? marketLookups : null` to that inline object and `maxPriceToMarketBps: knobs.maxPriceToMarketBps` to the input object.)
  6. Export the persist helper at module level:

```ts
/** Stage 5b: one insert for the run's recorded market lookups (source 'market_price'). Its own
 *  try/catch — a persist failure warns and moves on; the in-memory registry is what the gate
 *  reads, so submission must never hinge on this insert (spec §7). */
export async function persistMarketLookups(db: Db, alert: Alert, lookups: MarketLookup[]): Promise<void> {
  if (lookups.length === 0) return
  try {
    await db.insert(sourcingSignals).values(
      lookups.map((l) => ({
        source: 'market_price' as const,
        keyword: l.query,
        supplierProductId: l.supplierProductId,
        score: l.medianCents != null ? String(l.medianCents) : null,
        evidenceUrl: l.offers[0]?.url ?? null,
        snapshot: l.snapshot,
      })),
    )
  } catch (err) {
    await alert('warning', 'market_price_persist_failed', { error: errorMessage(err) }).catch(() => {})
  }
}
```

- [ ] **Step 4: Update `index.ts`.** Replace lines 435-444's factory + deps with:

```ts
  // A FACTORY, not baked-in instances (FIX C2): both providers share ONE SerpApiClient whose
  // per-run request cap (25, trends + market lookups combined) never resets — a fresh client per
  // run resets it every run. No SERPAPI_KEY => both null: trends stage skipped AND the market
  // gate skipped (each with its own warning alert), the run otherwise proceeds.
  const providersFactory = (): SourcingProviders => {
    if (!config.serpapi) return { trends: null, marketPrice: null }
    const client = createSerpApiClient({ apiKey: config.serpapi.apiKey })
    return { trends: createSerpApiTrends({ client }), marketPrice: createSerpApiMarketPrice({ client }) }
  }
  const sourcingDeps: SourcingPipelineDeps = {
    db, adapter: supplierAdapter, settings, alert, enqueue, notify, adminBaseUrl: config.adminBaseUrl, providersFactory,
  }
```

  with imports `createSerpApiClient` from `./sourcing/serpapi.ts`, `createSerpApiMarketPrice` from `./sourcing/market-price.ts`, `type SourcingProviders` from `./sourcing/pipeline.ts`. Update the boot log at line 188:

```ts
if (config.serpapi) app.log.info('sourcing agent: SERPAPI_KEY configured (trends + market-price stages armed)')
else app.log.warn('sourcing trends + market-price stages disabled: SERPAPI_KEY not set — runs proceed without google_trends signals and without the price-to-market gate')
```

- [ ] **Step 5: Update `scripts/run-sourcing.ts`.** Replace the `trendsFactory` block (keep the counting `fetchFn` — it moves onto the shared client, so the printed tally now covers trends + market lookups):

```ts
let serpApiRequests = 0
// Factory (FIX C2): fresh client per run so the shared 25-request cap resets. This script drives
// exactly one run; the counting fetchFn tallies BOTH stages' requests for the telemetry line.
const providersFactory = (): SourcingProviders => {
  if (!config.serpapi) return { trends: null, marketPrice: null }
  const client = createSerpApiClient({
    apiKey: config.serpapi.apiKey,
    fetchFn: (...args: Parameters<typeof fetch>) => {
      serpApiRequests += 1
      return fetch(...args)
    },
  })
  return { trends: createSerpApiTrends({ client }), marketPrice: createSerpApiMarketPrice({ client }) }
}
```

  Update the deps object (`trendsFactory` → `providersFactory`), the imports (`createSerpApiClient` from `../src/sourcing/serpapi.ts`, `createSerpApiMarketPrice` from `../src/sourcing/market-price.ts`, `type SourcingProviders` from `../src/sourcing/pipeline.ts`), and the final telemetry line's text to `` `run-sourcing: SerpApi requests made ${serpApiRequests} (trends + market lookups)${config.serpapi ? '' : ' (SERPAPI_KEY not set — trends and market-price stages skipped)'}` ``.

- [ ] **Step 6: Run the touched suites, then typecheck**

Run: `pnpm --filter @doge-buddy/ops test -- sourcing-pipeline sourcing-trends agents-sourcing-run`
Expected: PASS.
Run: `pnpm --filter @doge-buddy/ops typecheck && pnpm --filter @doge-buddy/db typecheck`
Expected: clean — this is the task that repairs the Task-3→8 window where call sites lagged.

- [ ] **Step 7: Commit**

```bash
git add apps/ops/src/sourcing/pipeline.ts apps/ops/src/index.ts apps/ops/scripts/run-sourcing.ts apps/ops/test/sourcing-pipeline.test.ts
git commit -m "feat(sourcing): wire market-price provider + gate through the pipeline and roots"
```

---

### Task 10: Full verification + docs

**Files:**
- Modify: `docs/OWNER-CHECKLIST.md` (footer pointer), `docs/LAUNCH-BACKLOG.md` (P1 sourcing-upgrades item)

- [ ] **Step 1: Full test run**

Run: `pnpm -r test`
Expected: ALL suites green (needs the local Postgres at :5433 up). Fix anything red before proceeding — pay attention to `sourcing-guards`, `run-harness`, `admin-runs`, `admin-dashboard` (they touch neighboring code paths and must be untouched by this work).

- [ ] **Step 2: Full typecheck + lint (if configured)**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 3: Update the docs.**
  - `docs/LAUNCH-BACKLOG.md`: in the P1 sourcing-upgrades item, change "Spec (1) written: … — plan next." to "**(1) BUILT <today's date> (branch `sourcing-market-price`)** — live check pending (one `run-sourcing --max-winners 2`: SerpApi requests ≤ 25, a proposal summary carrying `market $… median ×…`, a `market_price` row in `sourcing_signals` with offerCount ≥ 5). (2) is next to spec."
  - `docs/OWNER-CHECKLIST.md` footer pointer: replace the "Robert reviews, then Claude writes the plan and builds" clause with the built-status + live-check instructions above, keeping the two owner items (Railway `SERPAPI_KEY`, SerpApi plan quota) verbatim.

- [ ] **Step 4: Commit**

```bash
git add docs/OWNER-CHECKLIST.md docs/LAUNCH-BACKLOG.md
git commit -m "docs: sourcing market-price gate built — live-check runbook + owner items"
```

- [ ] **Step 5: Finish the branch** — use the `superpowers:finishing-a-development-branch` skill (do NOT push or merge without Robert's say-so; pushes are his).

---

## Self-review notes (already applied)

- Spec §1–§8 each map to a task (client→2, trends→3, provider/registry→4, knob→5, tool→6, schema/prompt→7, gate→8, pipeline/roots/migration→9/1); §Testing's suites are distributed into each task's Step 1; §7's `serpApiFactory` is implemented as `providersFactory` (recorded as a Global-Constraints deviation, same intent).
- The spec's Stage 5b "before the `agent_failed` early return" is honored in Task 9 Step 3.4.
- Type consistency: `MarketLookups`/`MarketLookup`/`quantileCents`/`DEFAULT_MAX_PRICE_TO_MARKET_BPS` names are identical across Tasks 4–9; `marketGateArmed` (7↔9); `maxPriceToMarketBps` (5↔8↔9).
- Known inter-task typecheck gap (Tasks 3–8) is declared in Task 3 and closed in Task 9 Step 6.
