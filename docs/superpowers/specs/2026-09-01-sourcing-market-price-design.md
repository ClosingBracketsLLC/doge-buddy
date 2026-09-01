# Sourcing upgrade 1 of 3: Market-price tool + price-to-market gate — Design

**Status: approved by Robert (2026-09-01, chat)** — brainstormed with the other two sourcing
upgrades (demand-signal harvest source, outcome feedback loop) and approved on the recommended
options: Google Shopping via SerpApi as the market source, enforcement in Stage 6 against a
**code-recorded** lookup (never the agent's number), degrade-not-block when SerpApi is absent.

**Parents:** `2026-08-24-phase-5-sourcing-agent-design.md` (the pipeline this extends; its trust
model binds this spec) · `2026-08-31-catalog-p0-design.md` §5 (the knobs pattern) ·
`docs/LAUNCH-BACKLOG.md` P1 "Sourcing agent upgrades" item (1).

**Goal:** the sourcing agent learns what comparable products actually sell for, prices toward the
market instead of blind, and plain code refuses any winner priced above **1.3× the market median**
— an enforced rule, not advice. Today the agent knows only the margin floor, so a $9-cost bed can
come back priced at $60 with a fine margin and no buyers.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Market source | SerpApi `google_shopping` engine behind a swappable `MarketPriceProvider` | One call aggregates Amazon, Chewy, Walmart, Petco. Same vendor/key as trends — no new account, no new bill (SerpApi free tier is a request quota, $0/mo). Amazon-only skews low vs a DTC store; can slot in later behind the same interface |
| 2 | Trust model | The MCP tool handler **records** every lookup in a run-scoped `MarketLookups` registry keyed by a `lookupId`; the winner carries only the id; Stage 6 reads the registry | Same shape as `PointsAllowance`: the agent never types a market number the code trusts. Re-querying SerpApi in Stage 6 would double quota use and force plain code to invent the query from a CJ title (worse comparables) |
| 3 | Gate rule | `medianVariantPrice(payload) ≤ floor(marketMedianCents × maxPriceToMarketBps / 10000)` | Like-for-like: a *typical* variant against a *typical* offer. Google Shopping mixes sizes, and so does a CJ size-graded listing; "every variant" would reject legitimate XL sizes, "first variant" would let an L/XL ride on the S price. Median (upper-middle on even counts — the stricter side) is deterministic and catches uniform overpricing |
| 4 | Conclusiveness | A lookup needs `≥ MIN_MARKET_OFFERS (5)` priced offers to yield a median; fewer → `medianCents: null` (inconclusive) | A 2-offer median is noise. The agent is told to broaden the query once; an inconclusive lookup on a winner still drops it (Decision 5) |
| 5 | Missing data | Provider **available** this run + winner has no conclusive, pid-matching lookup → **drop** (`sourcing_winner_no_market_price`). Provider **absent** (no `SERPAPI_KEY`) → gate skipped, one `warning` alert `market_price_stage_skipped` per run | "Enforced" means enforced whenever the data can exist. Absent SerpApi already degrades trends the same way; blocking every winner on a missing env var would be a silent catalog freeze |
| 6 | The ratio is a knob | `sourcing.max_price_to_market_bps` (default **13000**, range 10000–20000) resolved in Stage 0 via `resolveSourcingKnobs` (throw-not-clamp, like every `sourcing.*` knob) | Owner-tunable on `/admin/settings` (auto-listed from `SETTINGS_DEFAULTS`). Resolved once so the prompt and the gate quote the same number. No CLI flag — YAGNI |
| 7 | SerpApi budget | ONE shared per-run `SerpApiClient` with `SERPAPI_MAX_REQUESTS_PER_RUN = 25` across trends + market lookups (replaces trends' private cap of 10) | What matters for the free quota is the run total. Trends runs first and uses ≤ 2 requests for ≤ 8 keywords; the agent gets the rest. Still a fresh instance per run (Phase 5 FIX C2 — a boot-time instance's counter never resets) |
| 8 | Evidence | Every lookup persisted to `sourcing_signals` (`source = 'market_price'` — enum migration 0010) after the agent run; the code-composed proposal **summary** gains `market $X.XX median ×1.12` | Robert sees the ratio in the Telegram notification and on the proposal page with zero payload-schema change; the full offer list is in the signals row and in the run transcript. `NewListingPayload` stays "what to list", not "why" |
| 9 | Gate position | New **Step 6**, right after the claims scrub and BEFORE the CJ re-verification (old steps 6–8 become 7–9) | The gate is free (registry read); the CJ steps spend points. Don't verify a winner the price rule will drop anyway |
| 10 | Turn budget | `SOURCING_MAX_TURNS` 25 → **30**; `maxBudgetUsd` unchanged ($2.00 default) | One more required tool call per shortlisted candidate (+~6 calls/run); expected +$0.10–0.20/run |

## Architecture — what changes in the pipeline

`pipeline.ts` stage numbering (0 knobs · 1 claim · 2 harvest · 3 trends · 4 points · 5 agent · 6
validate & submit) is unchanged; this adds one dep, one sub-stage, and one gate step.

```
Stage 0  resolveSourcingKnobs  → + maxPriceToMarketBps (setting → range-checked)
Stage 3  trends                → createSerpApiTrends({ client })        client = serpApiFactory()
Stage 5  agent                 → MCP server + lookup_market_price       provider = createSerpApiMarketPrice({ client })
                                  handler records into MarketLookups     (or null when client is null)
Stage 5b persist lookups       → sourcing_signals rows, source 'market_price' (all lookups, conclusive or not)
Stage 6  validate & submit     → Step 6: market gate reads MarketLookups by winner.marketLookupId
```

### 1. `sourcing/serpapi.ts` — the shared client (new)

```ts
export const SERPAPI_MAX_REQUESTS_PER_RUN = 25   // moves here from trends.ts

export interface SerpApiClient {
  /** GET https://serpapi.com/search with `params` + api_key. Returns the parsed JSON, or null when
   *  the run cap is reached, the response is non-2xx, or fetch/JSON throws. NEVER throws. */
  get(params: Record<string, string>): Promise<unknown | null>
  requestsMade(): number
}
export function createSerpApiClient(deps: { apiKey: string; fetchFn?: typeof fetch; maxRequests?: number }): SerpApiClient
```

- The api key never survives into a log line (`scrubApiKey`, moved here from trends.ts).
- A capped call does **not** count as a request and does not fire.
- `trends.ts` keeps `TrendSignal`/`TrendsProvider`/`extractSignal` untouched; `createSerpApiTrends`
  takes `{ client }` instead of `{ apiKey, fetchFn }` and drops its private counter. `null` from
  the client → the batch's keywords score null exactly as a failed request does today.
- `SourcingPipelineDeps.trendsFactory` is **replaced** by `serpApiFactory: () => SerpApiClient | null`
  (same factory-per-run contract, same doc comment). Call sites: `index.ts`, `scripts/run-sourcing.ts`
  (its telemetry `fetchFn` wrapper moves onto the client), `test/sourcing-pipeline.test.ts`.

### 2. `sourcing/market-price.ts` — provider + registry (new)

```ts
export const MIN_MARKET_OFFERS = 5
export const MARKET_OFFERS_KEPT = 5            // top offers kept for display/evidence

export interface MarketOffer { title: string; priceCents: number; merchant: string | null; url: string | null }
export interface MarketLookup {
  lookupId: string                              // 'mkt_1', 'mkt_2', … per run (deterministic in tests)
  supplierProductId: string                     // the candidate the agent said this lookup is for
  query: string
  offerCount: number                            // priced offers parsed
  medianCents: number | null                    // null when offerCount < MIN_MARKET_OFFERS
  p25Cents: number | null
  p75Cents: number | null
  offers: MarketOffer[]                         // ≤ MARKET_OFFERS_KEPT, sorted by price asc
  snapshot: Record<string, unknown>             // { engine, offerCount, p25, p75, offers } — never the raw response
}

export interface MarketPriceProvider {
  readonly key: string                          // 'serpapi_google_shopping'
  /** Resolves to the parsed offers, or null when the client returned null (cap/HTTP/network). */
  fetchOffers(query: string): Promise<MarketOffer[] | null>
}
export function createSerpApiMarketPrice(deps: { client: SerpApiClient }): MarketPriceProvider

/** Run-scoped registry, one instance per pipeline run (mirrors PointsAllowance). */
export class MarketLookups {
  record(input: { supplierProductId: string; query: string; offers: MarketOffer[] }): MarketLookup
  get(lookupId: string): MarketLookup | undefined
  /** Cache hit by (supplierProductId, normalized query) — normalized = trimmed, lower-cased,
   *  whitespace collapsed to single spaces. A repeated identical lookup returns the same
   *  MarketLookup and fires no request. */
  find(supplierProductId: string, query: string): MarketLookup | undefined
  all(): MarketLookup[]
}
export function medianCents(sorted: number[]): number   // sorted[Math.floor(n / 2)] — upper-middle on even n
```

SerpApi request: `engine=google_shopping`, `q=<query>`, `gl=us`, `hl=en`. Parsing
(**FIXTURE-ASSUMPTION — verify on the first live run**): `shopping_results[]` entries carry
`title`, `extracted_price` (number, USD), `price` (display string), `source` (merchant),
`product_link` / `link`. Parser rules: `priceCents = Math.round(extracted_price * 100)`; entries
without a finite positive `extracted_price` are skipped (no string parsing of `price` — if the shape
differs live, the fixture is updated, not the parser guessed); `offers` keep the 5 cheapest for
display; median/p25/p75 are computed over **all** priced offers, not the kept five.

### 3. `agents/mcp-tools.ts` — the fifth tool

```ts
tool('lookup_market_price',
  'Google Shopping offers for a query: median/p25/p75 price in cents, offer count, the 5 cheapest offers. ' +
  'Query as a US shopper would type it ("orthopedic dog bed large"), never a CJ title. ' +
  '≥ 5 offers = conclusive; fewer → broaden the query once. Returns a lookupId you MUST put ' +
  'on the winner as marketLookupId (its supplierProductId must match the winner).',
  { supplierProductId: z.string().min(1), query: z.string().min(2).max(120) },
  handlers.lookup_market_price)
```

Handler (`createSourcingToolHandlers` gains optional `marketPrice?: MarketPriceProvider | null`
and `marketLookups?: MarketLookups`): registered **only when a provider is present** — with SerpApi
absent the tool does not exist and the prompt says so. Behaviour: `find()` cache hit → return the
existing lookup, no request; else `fetchOffers` → `null` → `isError` "SerpApi budget exhausted or
lookup failed — proceed with the lookups you already have"; else `record()` and return the
`MarketLookup` (minus `snapshot`). No CJ points are spent — the client's request cap is the meter.

### 4. `agents/output-schema.ts` + prompt

- `SourcingWinnerSchema` gains `marketLookupId: z.string().min(1).optional()` — optional because a
  SerpApi-less run has no tool to call; Stage 6 decides by provider availability, not schema.
- System prompt: `lookup_market_price` joins the "MUST use before you output" list (when armed).
- User prompt, new section, armed variant:

  > **## Market price — HARD RULE**
  > For every winner call `lookup_market_price` with a generic shopper query for that product and set
  > the winner's `marketLookupId` to the returned id (same `supplierProductId`). Plain code enforces:
  > the median of your variant prices must be ≤ **{ratio}×** the market median (e.g. market $24.99
  > → ceiling {ceiling}). A lookup with < 5 offers is inconclusive — broaden the query once. Winners
  > with no conclusive lookup, a lookup for a different product, or a price above the ceiling are
  > dropped. Price **toward** the market median when the margin floor allows: don't overprice, don't
  > leave money on the table.

  Unarmed variant: "Market price lookup is unavailable this run (no SerpApi). Use web search to
  sanity-check pricing; this is advisory only — the price-to-market gate is skipped."

  `{ratio}` and `{ceiling}` are rendered by `buildPrompt` from `knobs.maxPriceToMarketBps`
  (e.g. `1.3×`, `$32.48` for the $24.99 example); they are not literal text.

- `SourcingRunInput` gains `marketGateArmed: boolean` (the pipeline passes `marketPrice !== null`);
  `buildPrompt`/`buildSystemPrompt` pick the armed or unarmed wording from it. Absent (existing
  callers/tests) means unarmed — today's prompt plus the advisory sentence.
- `SOURCING_MAX_TURNS = 30`.

### 5. `sourcing/knobs.ts` + `settings.ts`

- `SETTINGS_DEFAULTS['sourcing.max_price_to_market_bps'] = 13000` (number kind → auto-rendered on
  `/admin/settings`, same as the other four `sourcing.*` knobs).
- `SOURCING_KNOB_RANGES.maxPriceToMarketBps = { min: 10000, max: 20000, integer: true }`;
  `SourcingKnobs.maxPriceToMarketBps`; `describeSourcingKnobs` prints it. No `SourcingOverrides`
  field and no CLI flag.

### 6. `sourcing/submit-winners.ts` — Step 6, the gate

`SubmitWinnersDeps` gains `marketLookups: MarketLookups | null` (null ⇔ provider absent this run)
and `ValidateAndSubmitWinnersInput` gains `maxPriceToMarketBps: number`.

```
Step 6 (new) — market price gate
  if marketLookups === null → skip (pipeline alerted market_price_stage_skipped once already)
  lookup = winner.marketLookupId ? marketLookups.get(id) : undefined
  if !lookup || lookup.supplierProductId !== pid || lookup.medianCents == null
      → drop 'sourcing_winner_no_market_price' { marketLookupId, reason: 'missing' | 'pid_mismatch' | 'inconclusive', query?, offerCount? }
  ceilingCents = Math.floor(lookup.medianCents * maxPriceToMarketBps / 10_000)
  typicalCents = medianCents(payload.variants.map(v => v.priceCents).sort(asc))
  if typicalCents > ceilingCents
      → drop 'sourcing_winner_price_above_market' { typicalCents, medianCents, ceilingCents, maxPriceToMarketBps, query, offerCount }
Steps 7–9 = today's 6–8 (CJ re-verify, margin, submit), unchanged.
Summary (step 9) → `New listing: <title> — N variant(s), margin Mbps, market $<median> median ×<typical/median to 2dp>`
                   (the market clause is omitted when the gate was skipped)
```

Integer arithmetic throughout (cents × bps / 10 000, floored) — mirroring the margin check's "never
round up into a false pass".

### 7. `pipeline.ts` wiring

- Stage 0: knobs now carry `maxPriceToMarketBps`.
- Stage 3: `const client = serpApiFactory()`; `trends = client ? createSerpApiTrends({ client }) : null`
  (alert `trends_stage_skipped` as today).
- Stage 5: `marketPrice = client ? createSerpApiMarketPrice({ client }) : null`; `marketLookups = new
  MarketLookups()`; if `!marketPrice` → alert `warning` `market_price_stage_skipped` once; pass both
  into `createSourcingMcpServer`; pass `marketGateArmed = marketPrice !== null` into the prompt.
- Stage 5b (immediately after the agent run, **whatever its status** — a failed run's lookups are
  the most useful ones to have on record; before the `agent_failed` early return and before Stage
  6): insert `marketLookups.all()` into `sourcing_signals` — `source: 'market_price'`,
  `supplierProductId`, `keyword: query`, `score: medianCents` (string or null), `evidenceUrl:
  offers[0]?.url ?? null`, `snapshot`. No-op when the registry is empty. Wrapped in its own
  try/catch → `warning` `market_price_persist_failed`; a failed insert never blocks submission (the
  registry in memory is what the gate reads).
- Stage 6: pass `marketLookups: marketPrice ? marketLookups : null` and `maxPriceToMarketBps`.
- Boot log (`index.ts`): "SERPAPI_KEY configured (trends + market-price stages armed)".

### 8. Migration 0010

`pnpm --filter @doge-buddy/db generate` after adding `'market_price'` to the `signalSource` pgEnum
→ `ALTER TYPE "public"."signal_source" ADD VALUE 'market_price';` (precedent: migration 0001's
`supplier_order_status`). `packages/db/test/migrations.test.ts` asserts the value exists.

## Error handling — every path is a clean degrade or a per-winner drop

| Failure | Effect |
|---|---|
| No `SERPAPI_KEY` | Trends + market stages skipped (two `warning` alerts), tool not registered, gate skipped, summary has no market clause. Run otherwise identical to today |
| SerpApi cap (25) reached mid-run | Tool returns `isError`; agent proceeds with existing lookups; winners lacking one are dropped with reason `missing` |
| SerpApi HTTP/network error | Same as cap: `null` from the client, `isError` to the agent, run continues |
| `shopping_results` shape differs live | Parser yields 0 priced offers → inconclusive → winners dropped `inconclusive`; the alert detail carries `offerCount: 0` so the fixture assumption is caught on run 1, not silently passed |
| Agent references a lookup for another candidate | `pid_mismatch` drop |
| Agent omits the tool entirely | Every winner dropped `missing`; `sourcing.run_completed` audit shows `submitted: 0, dropped: N` — visible on the run page and the admin home "needs you" strip |
| `sourcing_signals` insert fails | `market_price_persist_failed` warning; submission unaffected |

## Testing

Mock-tier (vitest, all deterministic, no network):

- `sourcing-serpapi.test.ts` — shared cap counts only fired requests; capped/HTTP-error/throwing
  fetch → `null`, never throws; api key scrubbed from the logged message; `requestsMade()`.
- `sourcing-market-price.test.ts` — fixture JSON in the documented `shopping_results` shape:
  cents rounding, skip non-numeric prices, median/p25/p75 over all offers, 5 cheapest kept, `< 5`
  → `medianCents: null`; `medianCents([a,b,c,d])` returns the upper-middle; `MarketLookups`
  sequential ids, `find()` cache by normalized query (case/whitespace), `all()`.
- `agents-mcp-tools.test.ts` — tool absent without a provider; records + returns id; cache hit
  fires no `fetchOffers`; `null` from provider → `isError` and nothing recorded; no CJ points spent.
- `sourcing-submit-winners.test.ts` — gate skipped when `marketLookups: null` (summary has no
  market clause); `missing` / `pid_mismatch` / `inconclusive` drops with detail; exactly-at-ceiling
  passes, one cent above drops; even-count variant median picks the upper-middle; the gate runs
  BEFORE any CJ adapter call (adapter mocks not invoked on a dropped winner); summary format.
- `sourcing-knobs.test.ts` — default 13000 pinned to `SETTINGS_DEFAULTS`; 9999 and 20001 throw
  naming `setting sourcing.max_price_to_market_bps`.
- `sourcing-trends.test.ts` — adapted to the client; behaviour otherwise unchanged (existing
  assertions must keep passing).
- `sourcing-pipeline.test.ts` — `serpApiFactory` null → both skip alerts, tool-less MCP server,
  Stage 6 gets `marketLookups: null`; non-null → lookups persisted as `market_price` rows after a
  succeeded run; a persist failure alerts and still submits.
- `agents-sourcing-run.test.ts` — prompt contains the HARD RULE section with the resolved ratio
  when armed, the advisory sentence when not; `maxTurns` 30.
- `migrations.test.ts` — `signal_source` has `market_price`.

Live tier (Robert, after merge + migrate): one `run-sourcing --max-winners 2`; check (a) the script's
"SerpApi requests made" ≤ 25, (b) at least one proposal summary carries `market $… median ×…`, (c)
a `market_price` row in `sourcing_signals` with `offerCount ≥ 5` — (c) is the FIXTURE-ASSUMPTION
check; if `offerCount` is 0 the response shape differs and the parser fixture gets corrected.

## Owner setup (blocks the live tier, not the build)

- Confirm `SERPAPI_KEY` is set on the Railway ops service (the local `.env` has it; Railway is
  unreachable from Claude's session) — without it both stages skip on every cron run.
- Read the plan line on the SerpApi dashboard. The Phase 5 design assumed 250 searches/month; this
  spec adds ~8–10 requests per run (≈20/run total, ≈80–100/month at weekly cadence, +~80 for a
  build week). If the plan is 100/month, lower `SERPAPI_MAX_REQUESTS_PER_RUN` to 15 before the first
  build week. Exceeding the quota costs nothing — SerpApi refuses, the stages degrade.

## Non-goals

Amazon as a source (later, same interface) · compare-at "was" pricing (backlog #16) · per-size
lookups for size-graded listings · a price **floor** vs market (underpricing is a margin problem,
already gated) · an admin view of offers (the run transcript and `sourcing_signals` hold them) ·
changing candidate discovery (upgrade 2) · outcome-driven pricing (upgrade 3) · re-pricing products
already live.

## Risks (accepted)

- **Query quality is the agent's.** A too-generic query ("dog bed") for a premium item yields a low
  median and a false drop; a too-specific one is inconclusive. The prompt's example, the
  broaden-once rule, and the offer list on the signals row are the mitigations; the first weeks'
  drop reasons will say whether the ratio or the prompt needs tuning.
- **Google Shopping noise** (bulk packs, used/renewed, accessories in results). The median and the
  ≥ 5-offer floor absorb most of it; p25/p75 are recorded so a later spec can tighten to IQR if
  needed.
- **Quota.** See Owner setup. Degrade is loud (`warning` alerts, `missing` drops), never silent.
