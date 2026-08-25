# Phase 5 — Live Tier-2 findings & remaining work (2026-08-25)

**Read this first if you are resuming Phase 5.** Phase 5 (sourcing agent) is merged to `main` and
**proven working end-to-end against Railway**, but the first live runs surfaced real issues. Three
are fixed (committed, unpushed); two remain (diagnosed precisely, fix validated, not yet
implemented). This doc is the complete state so the next session can finish without re-deriving
anything.

## Status in one line

The pipeline runs for real (config → claim → harvest → agent research with CJ tools → all 8
Stage-4 guards → cost accounting → failure handling, all proven live). It has **not yet produced
a submitted proposal**, because the harvest feeds the agent global-trending gadgets instead of dog
products. Fix that (below) and a real proposal should reach the owner's phone.

## What the live runs proved works

Four `run-sourcing --force` runs against the Railway DB (real CJ / Anthropic / SerpApi):
- Config load, atomic run-claim, `agent_runs` + `agent_run_events` persistence.
- Real CJ harvest (10 pages, ~500 points/run), append-only `sourcing_signals`.
- The agent doing genuine multi-tool research — run #3 was **25 turns, $0.66, ~23 CJ tool calls**
  (`get_product_detail` / `get_stock` / `quote_freight`).
- Every Stage-4 guard firing correctly (the claims scrubber caught "therapeutic" and dropped a
  winner; the agent correctly refused to list non-dog products).
- Cost accounting (authoritative on success), the `agent_failed` path recording + alerting.
- Telegram notify path wired to the Railway admin URL (works because runs targeted Railway's DB).

## Fixes committed this session (LOCAL, UNPUSHED — see push note)

1. **`558434a`** — output schema must be **draft-07**, not zod's default draft-2020-12. The SDK
   subprocess validator (ajv) ships draft-07 only and rejected 2020-12 with "no schema with key or
   ref https://json-schema.org/draft/2020-12/schema". `z.toJSONSchema(schema, { target: 'draft-7' })`.
   Regression test pins it. **This was the blocker that made the agent fail to start.** Mocked-SDK
   unit tests never exercised the real `outputFormat` validation — only a live run could catch it.
2. **`c011a81`** — system/task prompt now forces tool research before output. The agent had been
   calling `StructuredOutput` on turn 1 with zero winners and zero tool calls.
3. **`6a422ad`** — emphatic claims-avoidance in the prompt (no disallowed term in title,
   description, OR rationale; re-read before output), after run #3's winner was dropped for
   "therapeutic".

## Remaining work (diagnosed + validated; NOT yet implemented)

### 1. Harvest must filter to dog products (the reason no proposal has flowed) — HIGH PRIORITY

`apps/ops/src/sourcing/harvest.ts` calls `searchProducts({ flag: 'trending' })` and
`{ flag: 'new' }` with **no keyword/category**, so it pulls CJ's *global* trending feed — mostly
non-dog gadgets (run #4's agent correctly rejected a "Water Drop Bluetooth Anti-Lost Object
Finder"). Live-probed the fix 2026-08-25:
- `searchProducts({ keyword: 'dog' })` → real dog supplies (leashes, harnesses, combs, beds, the
  snuff pad).
- `searchProducts({ keyword: 'dog', flag: 'trending' })` → dog-*themed* items but mixes in decor
  (wood dog sculptures, car pendants) — worse than plain keyword.
**Fix direction:** replace the two global flag-passes with keyword passes over dog/pet terms mapped
to the store's category tags (toys/walks/beds/grooming) — e.g. `['dog toy', 'dog leash', 'dog bed',
'dog grooming', 'dog']` — no `flag`, ranked by `listedCount`. Record the matching keyword on each
`sourcing_signals` row (`keyword` is currently written `null`). Keep the dedupe/ranking/signals
structure intact; update `sourcing-harvest.test.ts`. The CJ adapter already supports `keyword`
(maps to `keyWord`) — no adapter change needed.

### 2. Trends stage 400s on full product titles — MEDIUM (non-blocking; degrades gracefully)

`apps/ops/src/sourcing/pipeline.ts` passes `candidates.map(c => c.title)` to `fetchInterest`. CJ
titles are long/messy; Google Trends returns HTTP 400 (all 3 requests failed every run). Probed:
`q=dog bowl` works, a full title does not.
**Fix direction:** pass short keywords, not titles. Cleanest once harvest fix #1 lands: pass the
distinct harvest keywords (already short, valid dog terms) to `fetchInterest`, and map trend scores
back to candidates by keyword. Non-blocking — the agent still has WebSearch + CJ signals — but it
wastes 3 SerpApi credits/run and gives zero trend signal until fixed.

## The exact command for a live Tier-2 run

Runs the LOCAL code against the Railway DB so proposals land where the deployed admin serves them
and Telegram buttons work on the phone. Costs ~$0.05–$2 Anthropic + ~500–730 CJ points + up to 10
SerpApi credits per run.

```
DATABASE_URL='<railway postgres url>' \
ADMIN_BASE_URL='https://doge-buddyops-production.up.railway.app' \
FULFILLMENT_SUPPLIER=cj \
pnpm --filter @doge-buddy/ops run-sourcing --force
```

- The Railway Postgres public URL is in the deploy chat log (still un-rotated as of 2026-08-25).
- `--force` bypasses the same-day circuit breaker for repeat runs.
- `FULFILLMENT_SUPPLIER=cj` is REQUIRED — without it the script uses the mock adapter (no real CJ).
- Inline env vars override `apps/ops/.env` ("existing environment variables take precedence").

## Gotchas found (also in memory)

- **`apps/ops/.env` has `ADMIN_BASE_URL=doge-buddyops-production.up.railway.app` with NO scheme** —
  `loadConfig` rejects it ("must be a valid http(s) URL"), which crashes any script that loads full
  config (this is why the owner's first plain `run-sourcing` did nothing). Either add `https://`
  in `.env` or override inline (the command above does). Owner should fix `.env`.
- A plain LOCAL run (local DB) cannot put working buttons on the phone — the proposal must live in
  the DB the deployed Railway admin serves. Hence targeting the Railway DB above.
- tsx scratchpad scripts hit the top-level-await-in-CJS error → wrap in an async IIFE; and
  `loadDotEnv(import.meta.url)` only finds `.env` from inside `apps/ops/**`, so from the scratchpad
  export the env vars instead.

## Push note

`main` is 3 commits ahead of origin: the three fixes above (`558434a`, `c011a81`, `6a422ad`) are
UNPUSHED. Railway builds from origin, so its deployed code + the armed Monday cron still have the
schema bug until these (and the coming harvest/trends fixes) are pushed. **Push before relying on
the cron.**

## Spend so far

~$1.30 Anthropic across 4 diagnostic runs; ~2,300 CJ points; ~12 SerpApi credits (of 250/mo free).
Well within budget; noted for awareness.
