# Keyword intelligence: the sourcing pipeline picks its own keywords — Design

**Status: written 2026-09-03 on Robert's ask ("keywords should be something I don't have to touch —
the system researches keywords, ranks keywords") — build approved for tonight.** This is the
parked **sourcing upgrade #3** (outcome feedback loop, `LAUNCH-BACKLOG.md` P1, approved in
principle 2026-09-01) made concrete, merged with the keyword-expansion machinery L1 shipped.

**Parents:** `2026-09-03-sourcing-decision-support-design.md` (Stage 1b rising-query expansion,
the demand probe, decision_context — all reused here) · `2026-09-01-sourcing-market-price-design.md`
(the gate whose drops become this system's *waste* signal) · `2026-08-24-phase-5-sourcing-agent-design.md`
(the harvest whose per-keyword signal rows are the raw data).

**Goal:** every sourcing run chooses its own keywords from measured performance — no
`--keywords` typing, no owner rotation lists — and the owner can *see* why each keyword was
chosen, on one admin page. Keywords that produce listings get used more; keywords that produce
drops, deprecations, or nothing get demoted; mined-out keywords retire; new ones enter from the
rising-query stream the pipeline already harvests.

## Spec-time verifications (2026-09-03, this session)

The full attribution chain **already exists on live tables** — no migration for the analysis:

| Link | Where |
|---|---|
| keyword → candidate | `sourcing_signals(source='cj_trending', keyword, supplier_product_id, created_at)` — harvest writes one row per unique pid per run |
| candidate → proposal | `proposals.payload->'variants'->0->>'supplierProductId'` (the same join `harvest.ts`'s dedupe already uses) |
| proposal → decision | `proposals.status` (`pending`/`approved`/`applied`/`rejected`/`expired`/`failed`) |
| proposal → product | `products.created_from_proposal_id` |
| product → sales | `product_scores.units_sold_28d`, `revenue_28d_cents` (nightly cron already populates) |
| candidate → DROP + reason | `audit_log` where `action LIKE 'alert.sourcing_winner_%'`, `detail->>'supplierProductId'` (verified: `createAlerter` writes `action = 'alert.<kind>'` with the detail object; `submit-winners.ts`'s `drop()` always includes `supplierProductId`) |
| product → retirement | `products.status = 'deprecated'`, `deprecation_queue.reason` |

Join tested against the dev DB 2026-09-03: keyword→candidate aggregation returns sane counts
(e.g. `dog toy` 202 candidates). Live proposal linkage is exercised by the first real run.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Storage | **No new table.** Stats are computed by one SQL query over existing tables per run (and per admin page load) | ~50–300 keywords and low-thousands of signal rows — a materialized table would add staleness and a refresh cron for nothing. Revisit if the query exceeds ~500ms |
| 2 | The unit of merit | **Listings that survive**, not proposals: `survivors = products listed from this keyword that are NOT deprecated`. Revenue supersedes it once sales exist | A keyword that yields 5 proposals which all die at the Amazon gate is a *bad* keyword — tonight's `dog car seat`/`plush bed` lesson. Counting proposals would reward exactly the waste we just spent a night removing |
| 3 | Score shape | `score = 0.6·yield + 0.25·survival + 0.15·revenueRate`, all normalized 0–1, then multiplied by `(1 − exhaustion)`; a keyword with < `MIN_CANDIDATES_FOR_SCORE (25)` harvested candidates scores as **unproven** (goes to the explore pool, never the exploit pool) | Yield (survivors ÷ candidates) is the primary economic signal; survival punishes gate-bait; revenue takes over when real. The exhaustion multiplier is what makes a proven-but-mined-out keyword step aside without being "bad" |
| 4 | Exhaustion | `exhaustion = 1 − freshCandidates/candidates`, where *fresh* = harvested pids not already mapped to a product and not carrying a live/recent `new_listing` proposal (the same two dedupe predicates `runHarvest` applies) | Directly measures "this vein is mined out" using the filters that actually block a re-harvest. At exhaustion ≥ `EXHAUSTED_AT (0.9)` a keyword is retired from exploit regardless of score |
| 5 | Selection | Bandit split per run: **70% exploit** (top scorers, exhaustion < 0.9) / **30% explore**, total = `keywordsPerRun` (default 5, the harvest's historical width), hard-capped at `MAX_OVERRIDE_KEYWORDS (8)` | Exploit compounds what works; explore keeps the pool growing without owner input. 70/30 with ≥1 explore slot guaranteed — a run that never explores can only decay |
| 6 | Explore pool, in priority order | (a) **unused rising queries** — `sourcing_signals(source='trends_rising')` keywords never harvested (L1 already collects these every run and currently discards the surplus); (b) **unused seeds** from a static `KEYWORD_SEEDS` vocabulary in `@doge-buddy/core`; (c) if both are empty, the least-recently-used proven keyword | Free — both sources already exist. Rising queries are live demand signal; the seed list guarantees the bandit always has somewhere to go. NO LLM call in v1 (see Non-goals) |
| 7 | Seeds | ~60 dog-gear terms in `packages/core/src/keywords.ts`, grouped by the four `CATEGORIES` tags, each already passing the `guards.ts` filters | Single-sourced next to `CATEGORIES`, reviewable by Robert in one file, and category-tagged so exploration spreads across the store rather than piling into toys |
| 8 | Ownership of the choice | New setting **`sourcing.keyword_mode`** = `auto` (default) \| `default`. `auto` = the selector; `default` = today's `HARVEST_KEYWORDS`. An explicit `--keywords` override (CLI or dashboard form) **always wins** in both modes | Robert asked for hands-off, so `auto` is the default; `default` is the escape hatch if the selector ever misbehaves, and the override keeps "I saw something on TikTok, source it now" working exactly as today |
| 9 | Visibility | New `/admin/keywords` page: one row per keyword — score, candidates, listed, surviving, dropped-for-price, deprecated, units sold, exhaustion %, last used, and a **chosen this run** marker; sorted by score desc, unproven keywords in a second section | "This should be researchable, this should be testable" — the page IS the research output. Also the fastest way to notice the selector going wrong |
| 10 | Determinism / testability | `loadKeywordStats(db)` (SQL, one query) and `selectKeywords(stats, explorePool, opts)` (pure, seeded RNG injectable) are separate units; the selector is unit-tested with fixtures and never touches the network or clock directly (`now` injected) | Robert's "this should be testable" — the ranking logic is a pure function with table-driven tests; only the loader needs a DB |
| 11 | Cold start | Zero history → every keyword is unproven → the selector returns `HARVEST_KEYWORDS` (5 defaults) plus explore picks. After ~5 runs, real scores take over | Tonight's blitz IS the training corpus; the system must behave sanely before it exists |
| 12 | Where it runs | Stage 0 of `pipeline.ts`, immediately before Stage 1b's expansion: selected keywords are the *base* list that rising-query expansion then appends to | One code path for both the cron and the dashboard button; expansion still adds same-run discoveries on top |

## Architecture

```
packages/core/src/keywords.ts            (new) KEYWORD_SEEDS by category tag + type
apps/ops/src/sourcing/keyword-stats.ts   (new) loadKeywordStats(db) -> KeywordStat[]   [one SQL]
apps/ops/src/sourcing/keyword-select.ts  (new) scoreKeyword(stat) + selectKeywords(...) [pure]
apps/ops/src/sourcing/pipeline.ts        Stage 0: mode 'auto' + no override -> selectKeywords(...)
                                         (alert `sourcing_keywords_selected` with the picks + why)
apps/ops/src/settings.ts                 + 'sourcing.keyword_mode' ('auto' | 'default')
apps/ops/src/http/admin/render-keywords.ts (new) the table renderer
apps/ops/src/http/admin/routes.ts        + GET /admin/keywords
apps/ops/src/http/admin/nav.ts           + nav entry
```

### `KeywordStat` (loader output)

```ts
export interface KeywordStat {
  keyword: string
  candidates: number           // distinct pids ever harvested under this keyword
  freshCandidates: number      // of those, still un-mapped AND without a live/recent proposal
  proposed: number             // distinct pids that became a new_listing proposal
  listed: number               // products created from those proposals
  surviving: number            // listed AND products.status <> 'deprecated'
  droppedForPrice: number      // alert.sourcing_winner_price_above_market | _no_market_price
  deprecated: number           // listed AND now deprecated
  unitsSold28d: number         // summed over its products' newest product_scores row
  revenueCents28d: number
  lastHarvestedAt: Date | null
}
```

### Scoring (pure)

```ts
export const MIN_CANDIDATES_FOR_SCORE = 25
export const EXHAUSTED_AT = 0.9

export interface KeywordScore {
  keyword: string
  proven: boolean              // candidates >= MIN_CANDIDATES_FOR_SCORE
  yieldRate: number            // surviving / candidates            (0..1, scaled by YIELD_FULL=0.10)
  survivalRate: number         // surviving / max(listed, 1)        (1 when nothing listed yet)
  revenueRate: number          // revenueCents28d / candidates      (0..1, scaled by REV_FULL=500c)
  exhaustion: number           // 1 - freshCandidates / max(candidates, 1)
  score: number                // (0.6*yield + 0.25*survival + 0.15*revenue) * (1 - exhaustion)
  reasons: string[]            // human strings for the admin page ("mined out", "gate-bait", …)
}
```

`YIELD_FULL = 0.10` (10 surviving listings per 100 candidates = full marks) and
`REV_FULL = 500` cents of 28-day revenue per candidate are calibration constants with a comment
saying they are guesses to be re-tuned once ~20 keywords have real sales data.

### Selection (pure, seedable)

```ts
export interface SelectKeywordsInput {
  stats: KeywordStat[]
  explorePool: string[]        // unused rising queries first, then unused seeds (caller-ordered)
  count: number                // default 5
  now: Date
  random?: () => number        // injected for tests; defaults to Math.random
}
export interface KeywordSelection {
  keywords: string[]           // >= 1, <= min(count, 8); never empty
  exploit: string[]
  explore: string[]
  why: Array<{ keyword: string; lane: 'exploit' | 'explore'; score?: number; reason: string }>
}
export function selectKeywords(input: SelectKeywordsInput): KeywordSelection
```

Rules, in order: proven + not exhausted, sorted by score desc → take `ceil(0.7*count)` for
exploit; explore takes the remainder (**always ≥ 1**) from `explorePool` head; if exploit is
short (cold start), explore fills the gap; if everything is empty, return `HARVEST_KEYWORDS`.
Deduped case-insensitively, capped at `MAX_OVERRIDE_KEYWORDS`.

### The one SQL

A single query with CTEs (`harvested`, `proposal_pids`, `drops`, `scores`) grouped by keyword —
lives in `keyword-stats.ts` with the join map from §Spec-time verifications as its comment. Fresh
counts reuse `harvest.ts`'s two dedupe predicates verbatim so "fresh" means exactly "would survive
a re-harvest today".

## Error handling

| Failure | Effect |
|---|---|
| Stats query throws | `warning` `keyword_stats_failed`; run falls back to `HARVEST_KEYWORDS` (never blocks a paid run) |
| Selector returns < 1 keyword (impossible by construction, belt anyway) | Falls back to `HARVEST_KEYWORDS` |
| `keyword_mode = 'default'` | Today's behaviour exactly, selector never called |
| Explicit `--keywords` / dashboard keywords | Override wins in both modes; no stats read |
| Admin page query fails | Section renders "stats unavailable"; page still loads (`safeHandle`) |

## Testing

Pure-unit (no DB, no network): `keyword-select.test.ts` — cold start returns defaults; exploit
ordering by score; ≥1 explore slot always; exhausted keywords excluded from exploit but still
listed in `why`; unproven never in exploit; dedupe + 8-cap; seeded RNG determinism.
`keyword-score.test.ts` — yield/survival/revenue normalization, exhaustion multiplier, the
gate-bait case (5 listed, 5 deprecated → survival 0 → low score) and the mined-out case.
DB-tier (dev DB, seeded rows, cleaned up): `keyword-stats.test.ts` — a keyword whose pid became a
proposal → product → sale counts once at each stage; a dropped pid lands in `droppedForPrice`; a
deprecated product moves from `surviving` to `deprecated`; `freshCandidates` excludes mapped pids.
Pipeline: `sourcing-pipeline.test.ts` — `auto` mode calls the selector and harvests its picks;
`default` mode and explicit overrides bypass it; a throwing stats query still runs the pipeline.
Admin: `admin-keywords.test.ts` — page renders rows + the unproven section; auth redirect.

## Non-goals (v1)

An LLM keyword-brainstorm call (the rising-query stream + seeds are free and deterministic; add
only if the explore pool actually starves) · per-category quotas (spread comes from the seed
list's grouping) · cross-run scheduling/cadence · automatic knob tuning (winners/pages stay
owner-set) · retiring seeds from the file automatically · Amazon related-search harvesting as a
third explore source (same SerpApi contract, easy follow-up once v1's pool behaviour is observed).

## Risks (accepted)

- **Attribution is approximate.** A pid harvested under two keywords in different runs credits
  both. Acceptable: the bias is small and self-correcting as volume grows; the alternative
  (first-touch attribution table) is a migration for a rounding error.
- **Calibration constants are guesses** (`YIELD_FULL`, `REV_FULL`, the 0.6/0.25/0.15 weights).
  They are one-line constants with a comment; the admin page makes mis-calibration visible fast.
- **Selected-but-barren keywords are invisible** — a keyword that harvested zero candidates
  writes no signal row and so never appears in stats. Rare (CJ returns something for nearly any
  dog term) and self-correcting via the explore lane.
- **Revenue lags** ~28 days behind listing, so early scores are yield-dominated. Intended.
