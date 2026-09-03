# L1 — Sourcing decision-support: keyword expansion + demand cross-check + proposal decision numbers — Design

**Status: written 2026-09-03 under Robert's standing launch directives (LAUNCH-PLAN L1, all four
parts pre-approved in principle 2026-09-02/03); spec-time decisions below are Claude's, flagged
where they were judgment calls.** Robert reviews this doc; the build proceeds on the launch-call
authority unless he objects.

**Parents:** `2026-09-01-sourcing-market-price-design.md` (the SerpApi client, MarketLookups
registry, and Stage-6 gate this extends — its trust model binds this spec) ·
`2026-08-24-phase-5-sourcing-agent-design.md` (the pipeline) · `docs/LAUNCH-PLAN.md` §L1 (the
mandate) · `docs/supplier-trend-research-2026-09-02.md` (research grounding: Amazon engine
verified to exist on SerpApi; no TikTok API at any price; triangulate cheap signals).

**Goal:** every `new_listing` proposal reaches Robert carrying the decision numbers — real
economics per variant AND labeled demand estimates — so 100 approvals during the L2 wave are each
a 10-second read, not a research task; and the pipeline finds keywords Robert wouldn't have typed,
via Google Trends rising related queries, cross-checked against Amazon demand.

## Spec-time verifications (done 2026-09-03, this session)

- **CJ sold/listing counts on product DETAIL: not available.** The live-recorded
  `product-query.json` fixture (re-recorded from real CJ 2026-08-23; cj-api-notes rule: fixtures
  authoritative, never build on unseen fields) carries no `sellQuantity`/`soldNum`/`listedNum`.
  Only the SEARCH list (`product-listV2`) carries `listedNum` → `SupplierProductSummary.listedCount`,
  which harvest already stores per candidate. **Decision: the demand block uses harvest's
  `listedNum`; a CJ "sold" number is omitted entirely rather than fixture-assumed.**
- `getProductReviews` returns a bare page (`SupplierProductReview[]`), no total — so CJ review
  evidence is a **page-1 sample**, labeled as such.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Expansion source | SerpApi `google_trends` `data_type=RELATED_QUERIES`, **rising** list only, ONE request per base keyword, capped at the first **5** base keywords (`EXPANSION_MAX_REQUESTS`) | Rising (not top) is where un-typed winners live. RELATED_QUERIES takes a single `q` per request (unlike TIMESERIES's 5-comma batch). Cap keeps wave-run budget arithmetic sane (§Budget) |
| 2 | Expansion position | New **Stage 1b**, after the day-claim and before harvest; `providersFactory()` moves up so the client exists there | Harvest consumes keywords; expanding after it would be decoration. Runs on both cron and `--keywords` runs — the wave rotates keywords and still wants discovery on top |
| 3 | Expansion filter | Plain code, reject-not-rewrite: keep a rising query only if it (a) word-start-contains a dog token (`dog`, `dogs`, `puppy`, `puppies`, `pet`, `pets`, `canine`), (b) survives `matchExcludedCategory` AND `findClaimViolations` over the query text, (c) is ≤ 60 chars; dedupe case-insensitively against base keywords and each other; order Breakout entries first (no `extracted_value`), then `extracted_value` desc; keep at most `EXPANSION_MAX_KEYWORDS = 5`, total run keywords ≤ `KEYWORDS_WITH_EXPANSION_MAX = 10` | A rising query is raw Google-user text. "collar" alone is too broad (no dog token); "dog arthritis bed" harvests trouble the claims scrubber would kill at listing time anyway — cheaper to never spend CJ pages on it. Same guard functions the listing gate uses, same word-start matching fixed in `40da0b7` |
| 4 | Expansion evidence | Every KEPT rising query → `sourcing_signals` row, new enum value **`trends_rising`** (migration 0011): `keyword` = the rising query, `score` = `extracted_value` (null for Breakout), `snapshot` = `{ baseKeyword, value, extractedValue }`; plus one `info` alert `sourcing_keywords_expanded { added, dropped }` per run with any expansion | Same append-only evidence pattern as every other signal source; the run page and SQL can answer "where did this keyword come from" |
| 5 | Amazon cross-check | Code-driven Stage-6 probe (`DemandProbeProvider`, `engine=amazon`, `amazon_domain=amazon.com`, `k=<query>`), ONE request per winner that SURVIVES the gates, reusing the winner's own market-lookup query. **Not an MCP tool, not in the prompt** | The numbers are decision support for ROBERT (directive 1), so they must be code-fetched and code-recorded — an agent tool would add turns, prompt surface, and an untrusted path for no gain. Reusing the market query means zero new query-quality risk. Probing only survivors spends nothing on winners the gate drops |
| 6 | Amazon parse | `organic_results[]` → keep entries with a finite positive `extracted_price` OR a finite `reviews` count; over the first `AMAZON_RESULTS_SAMPLED = 10` kept entries compute `medianPriceCents`, `medianReviews`, `totalReviews`; fewer than 3 usable entries → probe inconclusive (`null`) | **FIXTURE-ASSUMPTION** (research verified the engine exists, not the wire shape) — same stance as the Google Shopping parser: verify on the first live run, correct the fixture if it differs, never guess-parse display strings. Amazon review counts are lifetime-cumulative, hence ESTIMATES labeling |
| 7 | CJ review evidence | `ReviewsSeen` run-scoped registry (mirrors `MarketLookups`); the existing `get_reviews` MCP handler records page-1 results per pid as they pass through: `{ page1Count, ratedCount, avgRating }`. First page-1 call per pid wins. No new CJ calls, no new points | The agent already calls `get_reviews` per the prompt; recording in the handler gives code-recorded provenance for free. A winner the agent never called reviews on shows "—" — acceptable for an ESTIMATES block |
| 8 | Economics block | Computed in Stage 6 `processWinner` from values already in scope — per variant: price, LIVE CJ cost (step 7 overwrite), landed = cost + freight, profit $, margin bps; product-level: chosen freight option (price/name/days, step 8), market `{query, offerCount, medianCents, typicalCents, ceilingCents, maxPriceToMarketBps}` (step 6 lookup; null when gate skipped), US stock units = sum of US-warehouse quantities from step 7's existing first-variant `getVariantStock` response | LAUNCH-PLAN wording: "from numbers Stage 6 already computes". Zero new CJ calls; the only change to step 7 is keeping the stock quantities it already fetched instead of reducing straight to a boolean |
| 9 | Trends momentum | Per winner, from the run's own `TrendSignal` for the candidate's harvest keyword: `score` (0–100 mean) plus `momentum` = mean(last third of timeline points) − mean(first third), rounded; null when < 3 points | The timeline is already in the signal's snapshot; momentum from it is free and honest. No extra requests |
| 10 | Storage | New nullable `proposals.decision_context` jsonb column (migration 0011); `ListingDecisionContextSchema` (versioned, `version: 1`) in `@doge-buddy/core` next to the payload schemas; `submitProposal` parses it when provided | `NewListingPayload` stays "what to list", not "why" (market-price Decision 8) — decision numbers must NOT flow into `apply-new-listing`. A column (not a side table) because it is 1:1, write-once, display-only |
| 11 | Surfacing | `/admin` proposal page renders an "Economics" table + a "Demand signals — ESTIMATES" list from `decision_context`; the Stage-6 summary line (→ Telegram + proposals.summary) gains ` profit $A–$B` and a compact demand clause | Directive 1 verbatim. Renderer is display-not-revalidation like every other section; absent context (legacy/support-path proposals) renders exactly as today |
| 12 | Pricing prompt tweak | The HARD-RULE section's pricing sentence becomes floor-first: "Set each variant's price to clear the freight-inclusive margin floor FIRST — price up to the {ratio}× ceiling when freight demands it. Anchor toward the market median only when the floor is already comfortably cleared. Never exceed the ceiling; don't leave money on the table." | Parked directive from 2026-09-03: the live a6df7732 run showed the agent pricing freight-aware on its own, but median-anchoring first occasionally fights the floor. Wording change only; both gates unchanged |
| 13 | SerpApi cap becomes env-tunable | `SERPAPI_MAX_REQUESTS_PER_RUN` stays the code default (25); composition roots read an optional `SERPAPI_MAX_REQUESTS_PER_RUN` env var to override per deployment | The OWNER-CHECKLIST already tells Robert to "lower SERPAPI_MAX_REQUESTS_PER_RUN to 15" if his plan is 100/mo — today that is a code edit. His L2 quota check can now set it (down OR up for the wave month) without a deploy. Env var, not a setting: it is a vendor-quota knob, not store behaviour |

## Budget arithmetic (the 25-request shared cap)

| Run shape | Expansion | TIMESERIES | Agent market lookups | Amazon probes | Total |
|---|---|---|---|---|---|
| Cron default (5 kw, maxWinners 3) | 5 | 2 (≤10 kw) | ~4–6 | ≤3 | **14–16** |
| Wave run (8 kw, `--max-winners 8`) | 5 (capped) | 3 (≤13 kw) | ~8–10 | ≤8 | **24–26** |

The wave shape can graze the cap; the degrade order is deliberate — expansion and trends spend
first (they shape the run), the agent's lookups next (gate-critical: a winner without one is
dropped), Amazon probes last (display-only: a starved probe yields `amazon: null` in the demand
block, nothing else changes). If Robert's quota check clears it, `SERPAPI_MAX_REQUESTS_PER_RUN=35`
on the Railway service removes the squeeze for the wave month (Decision 13).

## Architecture

Stage numbering: 0 knobs · 1 claim · **1b expand (new)** · 2 harvest · 3 trends · 4 points ·
5 agent (+5b persist lookups) · 6 validate & submit.

```
Stage 0   knobs                    (unchanged — no new knobs/settings)
Stage 1   claimDailyRun            (unchanged)
Stage 1b  providersFactory() moves here; trends?.fetchRisingQueries per base kw (≤5 requests)
          → filter/dedupe/cap (Decision 3) → knobs.keywords + kept queries = run keywords
          → sourcing_signals rows 'trends_rising' + info alert (Decision 4)
Stage 2   harvest                  (unchanged, receives the expanded keyword list)
Stage 3   trends TIMESERIES        (unchanged mechanics — now scores expanded keywords too,
                                    since candidates carry whichever keyword fetched them)
Stage 5   agent                    (prompt: pricing sentence only; ReviewsSeen registry wired
                                    into the get_reviews handler)
Stage 6   validate & submit        (steps 1–8 unchanged; NEW post-gate: economics assembly,
                                    Amazon probe, decisionContext build, summary extension,
                                    submit carries decisionContext)
```

### 1. `sourcing/trends.ts` — rising related queries

```ts
export interface RisingQuery { query: string; value: string | null; extractedValue: number | null }
// TrendsProvider gains:
fetchRisingQueries(keyword: string): Promise<RisingQuery[] | null>
// null = client cap/HTTP/network (could not look); [] = looked, nothing rising.
```

Request: `engine=google_trends`, `data_type=RELATED_QUERIES`, `q=<single keyword>`,
`date='today 3-m'` (same window as TIMESERIES). Parse (**FIXTURE-ASSUMPTION** — verify live):
`related_queries.rising[]` entries carry `query` (string), `value` (display string, e.g. `"+120%"`
or `"Breakout"`), `extracted_value` (number, absent/huge for Breakout). Entries without a
non-empty `query` string are skipped. Never throws; a null client response degrades to null.

### 2. `sourcing/keyword-expansion.ts` (new)

```ts
export const EXPANSION_MAX_REQUESTS = 5      // base keywords probed, first-N of the run's list
export const EXPANSION_MAX_KEYWORDS = 5      // rising queries kept
export const KEYWORDS_WITH_EXPANSION_MAX = 10
export const DOG_TOKENS = ['dog', 'dogs', 'puppy', 'puppies', 'pet', 'pets', 'canine']

export interface ExpansionResult {
  keywords: string[]                          // base + kept, order: base first, ≤ 10
  kept: Array<RisingQuery & { baseKeyword: string }>
  dropped: number                             // filtered-out rising count (for the alert)
}
export async function expandKeywords(
  trends: TrendsProvider, base: readonly string[],
): Promise<ExpansionResult>
```

Pure orchestration + filter, unit-testable without network. Filter per Decision 3; the dog-token
match is word-START (`\b<token>` semantics via the same word-boundary approach `guards.ts` uses
post-`40da0b7`, applied to the query's words). Dedupe is case-insensitive first-wins. On
`fetchRisingQueries` → null for a base keyword, that keyword contributes nothing (no throw); base
keywords always survive into `keywords` untouched.

### 3. `sourcing/demand-probe.ts` (new)

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
  readonly key: string                        // 'serpapi_amazon'
  /** null = could not look (cap/HTTP) OR < MIN_AMAZON_RESULTS usable entries (inconclusive). */
  probe(query: string): Promise<AmazonDemandSnapshot | null>
}
export function createSerpApiAmazonDemand(deps: { client: SerpApiClient }): DemandProbeProvider
```

Parse per Decision 6. `reviews` may arrive as a number or a comma-grouped string — accept
`typeof number` and `Number(String(x).replace(/,/g, ''))` when that yields a finite non-negative
integer; skip otherwise (same skip-don't-guess stance as the Shopping parser, slightly widened
because Amazon result counts are commonly comma-grouped — flagged as part of the same
FIXTURE-ASSUMPTION).

### 4. `agents/mcp-tools.ts` — ReviewsSeen recording

```ts
// sourcing/decision-context.ts
export class ReviewsSeen {
  /** Records a page-1 get_reviews result for a pid; first page-1 recording wins. */
  record(supplierProductId: string, reviews: SupplierProductReview[]): void
  get(supplierProductId: string): { page1Count: number; ratedCount: number; avgRating: number | null } | undefined
}
```

`SourcingMcpDeps` gains optional `reviewsSeen?: ReviewsSeen`. The `get_reviews` handler, on a
successful adapter call with `page` absent or `1`, calls `reviewsSeen?.record(...)` before
returning — recording never changes the tool result and a registry absence is a no-op (existing
tests unaffected). `avgRating` is the mean over RATED reviews only, null when none are rated
(fail-safe stance from the reviews pipeline: never fabricate stars).

### 5. `@doge-buddy/core` — the context schema

In `packages/core/src/proposals.ts`:

```ts
export const ListingDecisionContextSchema = z.object({
  version: z.literal(1),
  economics: z.object({
    freight: z.object({ priceCents: cents, name: z.string(), minDays: z.number().int(), maxDays: z.number().int() }),
    variants: z.array(z.object({
      sku: z.string(), priceCents: cents, supplierCostCents: cents,
      landedCents: cents, profitCents: z.number().int(), marginBps: z.number().int(),
    })).min(1),
    market: z.object({
      query: z.string(), offerCount: z.number().int(), medianCents: cents,
      typicalCents: cents, ceilingCents: cents, maxPriceToMarketBps: z.number().int(),
    }).nullable(),                            // null ⇔ gate skipped this run (no SERPAPI_KEY)
    usStockUnits: z.number().int().nullable(),// first-variant US pool sum; null = stock response had no US rows (cannot happen post-gate, but display must not lie)
  }),
  demand: z.object({                          // ESTIMATES — labeled so everywhere it renders
    cjListedCount: z.number().int().nullable(),
    cjReviews: z.object({ page1Count: z.number().int(), ratedCount: z.number().int(), avgRating: z.number().nullable() }).nullable(),
    marketOfferCount: z.number().int().nullable(),
    trends: z.object({ keyword: z.string(), score: z.number().nullable(), momentum: z.number().nullable() }).nullable(),
    amazon: z.object({
      query: z.string(), resultsSampled: z.number().int(),
      medianPriceCents: cents.nullable(), medianReviews: z.number().int().nullable(), totalReviews: z.number().int().nullable(),
    }).nullable(),
  }),
})
export type ListingDecisionContext = z.infer<typeof ListingDecisionContextSchema>
```

### 6. `sourcing/decision-context.ts` — the builder

`buildListingDecisionContext(input)` — pure function assembling the schema above from: the
verified payload (post-step-7 live costs), `freightCents` + the chosen `ShippingOption`, the
step-6 `MarketLookup | null`, the step-7 stock rows, the candidate (`listedNum`, `keyword`), the
run's `TrendSignal` for that keyword (momentum computed here per Decision 9), the `ReviewsSeen`
entry, and the `AmazonDemandSnapshot | null`. Deterministic, fully unit-tested; every input it
consumes is code-recorded or code-computed — nothing agent-typed enters the context.

### 7. `sourcing/submit-winners.ts` — post-gate assembly

`SubmitWinnersDeps` gains `demandProbe: DemandProbeProvider | null`, `reviewsSeen: ReviewsSeen`,
and `trendSignalsByKeyword: Map<string, TrendSignal>`. After step 8 passes (winner will submit):

```
Step 8b (new) — decision context
  stockRows/freightOption/lookup captured from steps 6–8 (step 7 keeps its stock response;
    step 8 keeps the chosen eligible option object, not just priceCents)
  amazon = demandProbe && lookup ? await demandProbe.probe(lookup.query) : null
    (its own try/catch → null + info alert 'demand_probe_failed'; NEVER drops the winner)
  ctx = buildListingDecisionContext(...)
Step 9 — summary gains: `, profit $A–$B` (min/max variant profitCents) and, when present,
  ` | est: amzn ~<medianReviews> reviews, CJ <listedNum> listed, trends <score> (<signed momentum>)`
  (clauses independently omitted when their source is null — never "0" for "unknown");
  submit(... { decisionContext: ctx }) — carried on SubmitProposalInput, stored by submitProposal.
```

When the market gate was skipped (no SERPAPI_KEY): `market: null`, `amazon: null` (no query to
probe), economics/CJ/trends parts still populate — the block degrades exactly as far as its
missing source and no further.

### 8. `proposals/submit.ts` + DB + render

- `SubmitProposalInput` gains `decisionContext?: ListingDecisionContext` — parsed via
  `ListingDecisionContextSchema` when present (throw = drop at the Stage-6 `submit_failed`
  catch, like any submit throw), inserted into the new column on BOTH manual and auto paths.
- Migration 0011 (`pnpm --filter @doge-buddy/db generate`): `ALTER TYPE signal_source ADD VALUE
  'trends_rising'` + `ALTER TABLE proposals ADD COLUMN decision_context jsonb` (nullable, no
  default). `migrations.test.ts` asserts both.
- `render-proposal.ts`: `renderNewListingPreview` gains a "Decision numbers" section rendered
  ONLY when the row's `decision_context` parses against the schema (safeParse — display code
  refuses to render a context that doesn't match rather than crashing the page): the per-variant
  economics table (SKU · price · CJ cost · freight · landed · profit · margin%), the product line
  (market median (n) · our ×median vs the ceiling · US stock units · freight option/days), and
  the demand list under the literal heading "Demand signals — ESTIMATES, not sales". Absent or
  unparseable context → section absent, page renders exactly as today.

### 9. Prompt (Decision 12) — `agents/sourcing-run.ts`

Armed-variant HARD-RULE section: the final pricing sentence replaced per Decision 12 (rendered
`{ratio}` unchanged). Unarmed variant untouched. No other prompt, tool-description, schema, turn,
or budget changes — the agent's job did not change; Robert's information did.

### 10. Composition roots — `index.ts`, `scripts/run-sourcing.ts`, tests

`SourcingProviders` gains `demand: DemandProbeProvider | null`. Both roots build
`createSerpApiAmazonDemand({ client })` from the same shared per-run client (null when no
`SERPAPI_KEY`), and read the optional `SERPAPI_MAX_REQUESTS_PER_RUN` env var (integer 1–200;
unparseable → default 25 + one boot warning) into `createSerpApiClient`'s `maxRequests`.
`run-sourcing`'s closing line stays the single source of request-count truth.

## Error handling — every path degrades or drops per-winner, never aborts

| Failure | Effect |
|---|---|
| No `SERPAPI_KEY` | Stages 1b/3 skipped (existing `trends_stage_skipped` alert covers both — expansion is part of the trends provider), market gate skipped as today, `demandProbe` null → `market`/`amazon`/`trends` null in the context; economics + CJ parts still render |
| `RELATED_QUERIES` request fails / cap spent | That base keyword expands to nothing; base keywords always harvest |
| `related_queries` shape differs live | 0 rising kept → run proceeds on base keywords; `sourcing_keywords_expanded` alert absent → visible on run 1 (live-check item) |
| All rising queries filtered out | Same as above, `dropped` count in no alert (nothing kept) — signals rows show nothing, by design |
| Amazon probe null / shape differs / throws | `amazon: null` + info `demand_probe_failed` (throw path only); winner submits regardless |
| Agent never called `get_reviews` for a winner | `cjReviews: null` → "—" in the block |
| `decisionContext` fails its own schema parse at submit | The submit throws → existing `sourcing_winner_submit_failed` drop path (a builder bug, loud in tests long before live) |
| Legacy/support-path `new_listing` (no context) | Column null, page renders as today, Telegram body unchanged |

## Testing (mock-tier, deterministic, no network)

- `sourcing-trends.test.ts` — `fetchRisingQueries`: fixture in the documented rising shape;
  Breakout entry (no extracted_value) parses with null; missing `query` skipped; null client → null;
  existing TIMESERIES assertions untouched.
- `sourcing-keyword-expansion.test.ts` — dog-token word-start matching (keeps "dog collar led"
  and "puppy teething ring", drops "collar" and "cat tree"; "hot dog costume" is KEPT by this
  guard by design — the token guard buys relevance, not perfection, and the excluded-category
  guard, harvest filters, and Robert's approval are the later nets); drops excluded-category and
  claim-term queries; dedupe vs base (case-insensitive);
  Breakout-first ordering then extracted_value desc; caps (5 kept / 10 total); null-provider
  keyword contributes nothing; base keywords always survive.
- `sourcing-demand-probe.test.ts` — fixture parse: price cents rounding, comma-string reviews,
  skip unusable entries, < 3 usable → null, sampling stops at 10, median/total math; null client → null.
- `sourcing-decision-context.test.ts` — `ReviewsSeen` (page-1 only, first-wins, rated-only avg,
  never-fabricated rating); momentum thirds math incl. < 3 points → null; builder assembles the
  full schema from step artifacts; every null-source combination stays schema-valid.
- `agents-mcp-tools.test.ts` — get_reviews records into ReviewsSeen on page-1 success only
  (page 2 not recorded, error not recorded); absent registry is a no-op.
- `sourcing-submit-winners.test.ts` — step 8b probes ONLY survivors (probe mock not called for
  dropped winners); probe throw → submitted anyway + alert; summary gains profit + est clauses,
  omits null clauses; decisionContext passed to submit; market-skipped run → market/amazon null.
- `proposals-submit.test.ts` (or equivalent) — decisionContext validated + persisted on manual
  AND auto paths; absent stays null.
- `render-proposal.test.ts` — section renders from a valid context (economics table, ESTIMATES
  heading); absent/unparseable context → page identical to today.
- `sourcing-pipeline.test.ts` — Stage 1b wiring: expanded keywords reach harvest; `trends_rising`
  rows persisted; expansion alert fired; null providers → base keywords only, no new alerts beyond
  today's two skips.
- `migrations.test.ts` — enum value + column exist.
- `agents-sourcing-run.test.ts` — armed prompt carries the new pricing sentence (and not the old
  one); unarmed variant unchanged.

Live tier (Robert, after merge + push + Railway deploy — one wave-shaped run):
`pnpm --filter @doge-buddy/ops run-sourcing --max-winners 2 --force` from the Railway shell, then
(a) run page/SQL shows `sourcing_signals` rows with `source = 'trends_rising'` (the RELATED_QUERIES
FIXTURE-ASSUMPTION check — zero rows on a run with SerpApi armed means the shape differs); (b) a
proposal page shows the Decision numbers section with a populated Amazon line (the Amazon
FIXTURE-ASSUMPTION check — `amazon: null` on every winner means the shape differs); (c) the
Telegram summary carries the profit + est clauses; (d) closing `SerpApi requests made` ≤ cap.

## Owner setup

- The L2 SerpApi quota check (LAUNCH-PLAN, binding constraint) now doubles as the
  `SERPAPI_MAX_REQUESTS_PER_RUN` env decision: plan ≥ 750/mo → set 35 for the wave month; ~250/mo
  → leave default 25; 100/mo → set 15 (all on the Railway ops service, no deploy needed).

## Non-goals

Pinterest trends scraper (research runner-up — separate spec if wanted) · EchoTik/TikTok anything
(manual lane stands) · Amazon category-`node` filtering (v1 is plain keyword search; the query is
already dog-scoped) · an agent-visible Amazon tool · outcome feedback loop (sourcing upgrade 3) ·
demand blocks for other proposal types · re-pricing live products (L3 reset supersedes) · a
settings-page knob for expansion counts (constants until the wave says otherwise) · backfilling
decision_context onto existing pending proposals.

## Risks (accepted)

- **Two new FIXTURE-ASSUMPTIONS** (RELATED_QUERIES + Amazon shapes) verified only on the live
  run — both degrade loudly-but-safely (empty expansion / null amazon), both have explicit live
  checks above.
- **Rising queries are seasonal/faddish** — a September rising term may be a Halloween-costume
  wave. The guards + harvest's own US-warehouse/dedupe filters + Robert's per-proposal approval
  (mode = manual through the wave) are the containment; signals rows record provenance for the
  post-wave retro.
- **Amazon review counts are lifetime totals, not velocity** — an old saturated product reads
  "high demand". Hence ESTIMATES labeling everywhere and median-not-max stats; the cross-check is
  a corroborator, never a gate.
- **Summary line growth** — the est clause pushes Telegram lines wider; clause-omission on null
  keeps the common degraded cases short, and `capNotifyBody` already backstops the pathological.
