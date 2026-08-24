# Phase 5: Sourcing Agent — Design

**Status: approved by Robert (2026-08-24)** — design presented in chat and approved via the
brainstorm decisions; owner setup (Anthropic key → Railway, SerpApi key → `.env`, Google Trends
alpha application filed) completed same day.

**Parents:** `2026-08-09-doge-buddy-design.md` §Phase 5 · `2026-08-09-doge-buddy-architecture.md`
§Sourcing · `2026-08-24-phase-5-prework.md` (carried-items ledger — its constraints bind this
spec). Where the 2026-08-09 docs and `docs/cj-api-notes.md` disagree on CJ wire formats,
**cj-api-notes.md wins** (it is live-verified).

**Goal:** a weekly, budget-capped, fully-guarded agent run that turns CJ trending data + trend
validation into ≤3 ready-to-approve `new_listing` proposals on Robert's phone. The agent
researches; plain code decides, submits, and spends.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Trends source | SerpApi `google_trends` engine (free tier) behind a swappable `TrendsProvider` interface | Official Trends API is application-gated alpha (filed 2026-08-24); SerpApi bridges at $0/mo for our volume (~18–45 searches/wk of 250/mo) |
| 2 | Run budget | `maxBudgetUsd: 2.00` on claude-sonnet-5 | Robert's call. Hard SDK stop (`error_max_budget_usd`); ~$8–9/mo worst case at weekly cadence |
| 3 | Reviews tool | Build `getProductReviews` on the CJ adapter + expose as MCP tool | Robert's call — review text is demand signal worth the adapter work |
| 4 | Cron | `sourcing.weekly`, `0 13 * * 1` (Mondays 13:00 UTC ≈ 9am ET), armed on merge | Every proposal still gates through manual approval; worst case is a rejectable proposal |
| 5 | Proposal emission | Agent returns structured output; **plain code** validates + calls `submitProposal` | The LLM never holds a side-effecting tool. Structured output is data; code is the gate |
| 6 | CJ points | Per-run allowance of **25,000** enforced by an in-run counter passed to harvest + MCP tools | Fulfillment shares the 50k/day in-memory budget and must never starve. No new machinery |
| 7 | Denylist | No new tables: rejected `proposals` rows (90-day window) + a constants module for category/keyword exclusions | Zero-migrations holds — all Phase 5 tables shipped in migration 0000 |
| 8 | Config | Optional `anthropic` + `serpapi` config blocks; cron registration gated on `anthropic`, trends stage gated on `serpapi` | The `shopify.webhook-audit` gating precedent; ops boots fine without either |
| 9 | SDK | `@anthropic-ai/claude-agent-sdk`, **pinned exact** (0.x) | Frequent releases; installed `sdk.d.ts` is authoritative over docs on disagreement |
| 10 | Run cadence guard | Circuit breaker: refuse to start if an `agent_runs` row for `workflow='sourcing.weekly'` already **started today (UTC)**; manual script may pass `--force` | A cron misconfiguration or retry loop can never stack paid runs |

## Architecture — the weekly pipeline

Four stages. Stages 1–2 and 4 are deterministic plain code; stage 3 is the single paid LLM run.

### Stage 1: Harvest (plain code, ≤500 CJ points)

- Two `searchProducts` passes via a new `flag?: 'trending' | 'new'` parameter (supersedes the
  current `trending?: boolean`; maps to `productFlag: 0 | 1` — live-confirmed semantics), ≤10
  pages total across both passes.
- Every fetched summary is appended to `sourcing_signals` (`source: 'cj_trending'`,
  `supplierProductId`, `snapshot` = raw summary, `fetchedAt` now). The table is append-only;
  weekly rows accumulate by design.
- **Dedupe/exclusion filter**, in order: (a) `supplierProductId` already present in
  `supplier_variant_mappings`; (b) `supplierProductId` appears in the payload of any
  `new_listing` proposal rejected in the last 90 days; (c) title matches the category-exclusion
  or keyword-denylist constants (see Guards). Survivors ranked by a plain heuristic (listed
  count, price band consistent with a ≥60% margin at plausible retail) → **top 15 candidates**.

### Stage 2: Trend validation (plain code, ≤10 SerpApi searches)

- `TrendsProvider` interface: `fetchInterest(keywords: string[]) => Promise<TrendSignal[]>` —
  the SerpApi adapter batches TIMESERIES queries 5 keywords at a time (≤10 requests/run hard
  cap, counted in-run). Results append `sourcing_signals` rows (`source: 'google_trends'`,
  `keyword`, `score`, `snapshot`).
- Best-effort: SerpApi absent from config or failing → alert (`warning`,
  `trends_stage_skipped`) and continue; the agent is told trends data is missing and may use
  WebSearch instead. Google Trends alpha approval later = new adapter behind the same
  interface, zero caller changes.

### Stage 3: The agent run (one `query()`)

Runner at `apps/ops/src/agents/sourcing.ts`, invoked by the thin job adapter.

**Options (from the pinned SDK surface):** model `claude-sonnet-5`; `maxTurns: 25`;
`maxBudgetUsd: 2.00`; `settingSources: []`; `permissionMode: 'dontAsk'`; `tools: []` (strip
built-ins) + `allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch']`;
`persistSession: false`; own `systemPrompt` string (never the claude_code preset); `env` spread
from `process.env` (the option REPLACES the subprocess env); `MCP_TOOL_TIMEOUT=60000` so a hung
CJ call cannot stall the run; `outputFormat: {type: 'json_schema', schema}` bridged from zod via
`z.toJSONSchema`.

**MCP server `sourcing`** (in-process, `createSdkMcpServer`), four read-only tools wrapping the
supplier adapter: `get_product_detail` (10 pts), `get_reviews` (new adapter method, pts cost
recorded in cj-api-notes when live-verified), `get_stock` (10 pts), `quote_freight` (10 pts).
Every handler draws from the run's points allowance (25,000 minus harvest spend); an exhausted
allowance returns `isError: true` with copy telling the agent to conclude with what it has.
Handlers never throw raw errors — failures become error results and the loop continues.

**Prompt content:** the 15 candidates with their CJ + trends signals; store context (the four
`categoryTag` values, pricing convention, the ≥60% margin floor with its formula, shipsFrom
'US', delivery-day expectations); the category-exclusion list verbatim (defense layer 1);
instruction to research demand/competition via tools and return **≤3 winners** in the output
schema — each a complete `new_listing` payload draft plus `rationale` and `marginPct`.

**Lifecycle & persistence:** insert `agent_runs` row (`status: 'running'`, workflow
`sourcing.weekly`, model, triggerRef) before the first SDK message; stream every message to
`agent_run_events` (monotonic `seq`); on the result message record `totalCostUsd`,
`modelUsage`, `numTurns`, `sessionId`, `status: 'succeeded'`; **record cost and flip to
`'failed'`/`'aborted'` in a `finally` path even when the run throws** — a crashed run that
spent money must say so. AbortController watchdog at 15 minutes wall-clock. Agent queue
concurrency 1 (the SDK subprocess is ~1 GiB; Railway has 2 GB).

### Stage 4: Validate & submit (plain code)

Per winner, in order — a failing winner is dropped with an alert; the others proceed:

1. Zod-validate against `NewListingPayloadSchema` (with `imageUrls` tightened to http(s)-only —
   carried item lands here).
2. Category-exclusion re-check on title + tags (defense layer 2 — the model saw the list, code
   enforces it).
3. **Claims scrubber:** title/descriptionHtml scanned against the disallowed-claims list; any
   hit drops the winner (`warning`, `claims_scrubbed`) — scrubbing rewrites nothing, it rejects.
4. **Margin re-check in code** (the model's arithmetic is not trusted):
   `(priceCents − supplierCostCents) / priceCents ≥ 0.60` for every variant.
5. `submitProposal(deps, {type: 'new_listing', …, sourceWorkflow: 'sourcing.weekly',
   agentRunId})` → manual mode → Telegram + admin, exactly the proven Phase 4 path.

## Guards (day-one, before the first run)

- **Category exclusions** (constants module, hardcoded): supplements, CBD/hemp, flea & tick,
  medicated/pharmaceutical, consumables/treats/food, and health-claim products (e.g.
  "calming"). Applied at harvest (stage 1c), in the prompt, and at submit (stage 4.2).
- **Claims scrubber** (constants + matcher): therapeutic/medical claim phrases ("treats",
  "cures", "anxiety relief", "vet approved" without substantiation, etc.).
- **Out of Phase 5** (risks-doc `[before-full-auto]` tier — the owner's "IP check done" ritual
  in the proposal notification covers meanwhile): automated IP screen, CPSC recall poller,
  reverse-image copyright checks.

## Supporting work

- **Adapter:** `searchProducts` `flag` param; new `getProductReviews(supplierProductId, page?)`
  (CJ `GET /product/comments`) — mock adapter parity, contract-test coverage in the live
  harness, wire truths recorded in `docs/cj-api-notes.md`.
- **Config:** `ANTHROPIC_API_KEY` and `SERPAPI_KEY` optional in `EnvSchema` →
  `config.anthropic?` / `config.serpapi?` blocks (superRefine pattern); loud boot log lines for
  both (the fulfillment-supplier precedent).
- **Admin:** `/admin/runs` list gains cost/turns/finished columns; new `/admin/runs/:id` detail
  page rendering `agent_run_events` (all content through `esc`; `safeHandle`-wrapped like every
  admin route).
- **Manual trigger:** `apps/ops/scripts/run-sourcing.ts` (`pnpm --filter @doge-buddy/ops
  run-sourcing`, `--force` to bypass the daily circuit breaker) — runs the full pipeline
  against the configured DB/keys; how Tier 2 gets driven.
- **Carried Phase 4 rulings landing here:** `submitProposal` auto-path enqueue guard (try/catch
  + `apply_enqueue_failed` critical alert, mirroring the action-route handling — the proposal
  stays approved, never silently stranded); CJ `webhook/product/subscribe` called best-effort
  after a successful `new_listing` apply (alert-and-continue on failure; wire shape is in
  cj-api-notes §Still-unverified — verify live during Tier 2 and record).

## Failure posture

Every stage fails safe: harvest/trends failures alert and degrade (skip stage or run with
partial signals); an agent-run failure or budget/turn truncation records the run as
failed/aborted **with cost**, alerts (`critical`, `sourcing_run_failed`), and produces zero
proposals; a single bad winner drops alone. Nothing in this phase can spend Shopify/CJ money —
the only spends are Anthropic tokens (≤$2.00 hard cap/run) and CJ points (≤25k/run allowance).
The proposal gate (`workflow.sourcing.mode = 'manual'`) is untouched.

## Exit criteria

**Tier 1 (mocked, in the suite):** full monorepo suite green with new coverage for: harvest
dedupe/exclusion matrix, trends batching + skip path, points-allowance exhaustion, runner
lifecycle against a scripted fake SDK stream (success / thrown / budget-truncation — cost
recorded in all three), structured-output validation + margin/claims rejection paths, admin
runs pages, config gating (no key → no cron, loud log), circuit breaker, enqueue-guard and
`imageUrls` regressions, adapter `flag` + `getProductReviews` (mock parity; CJ contract cases
added to the live harness).

**Tier 2 (live):** one `run-sourcing --force` against real keys completes: `agent_runs` row
with real `totalCostUsd ≤ 2.00`, transcript inspectable at `/admin/runs/:id`, CJ points spent
< 25k, SerpApi usage ≤ 10 requests, and 1–3 genuine proposals arriving on Robert's phone with
working approve/reject. (Approving one through to an ACTIVE product re-proves the Phase 4
apply path with agent-sourced data, including the new webhook/product/subscribe call.)

## Out of scope

- `workflow.sourcing.mode = 'auto'` (the mode key + guarded enqueue exist; flipping it is an
  owner action for a later phase, after proposal quality is proven).
- Automated IP screen, CPSC recall poller, reverse-image checks (`[before-full-auto]`).
- Google Trends alpha adapter (until approval lands; interface is ready).
- Processing CJ STOCK/PRODUCT webhook events (shapes unverified — only the subscribe call
  ships; event handling is Phase 6's product-lifecycle loop, alongside `product_scores`).
- Any storefront work; the support agent (Phase 6); TikTok automation (no compliant API — the
  manual paste box remains the only TikTok input).
