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
| 10 | Run cadence guard | **Atomic day-claim** circuit breaker: the FIRST act of the pipeline handler — before any spend — is to check-and-insert the run's `agent_runs` row inside one transaction holding `pg_advisory_xact_lock` keyed on the workflow name; an existing row **started today (UTC)** refuses the run as a clean no-op (info alert, never a throw). `--force` (manual script) bypasses the check but still inserts its row first | Check-then-act with the row landing later would be a TOCTOU race — cron + manual overlap could stack paid runs. Advisory lock because migration 0000 has no unique index to lean on (Decision 7) |
| 11 | Job semantics | `sourcing.weekly` registers with `retryLimit: 0` and `expireInSeconds: 3600`; `registerCron` gains an options parameter to express both | pg-boss defaults are retryLimit 2 and a 15-minute expiry — shorter than the run itself (15-min watchdog + harvest/trends), so defaults would expire-and-redeliver legitimate runs and retry pre-breaker failures with fresh SerpApi/points counters. A failed weekly run alerts and waits for the manual script; the breaker is the retry policy |

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
  `new_listing` proposal that is **pending, approved, or failed (any age — in-flight or
  awaiting the owner)**, or **rejected/expired within the last 90 days**; (c) the CJ summary's
  `title` or `categoryName` matches the category-exclusion or keyword-denylist constants (see
  Guards — these are layer 1's exact match surfaces). Survivors ranked by a plain heuristic
  (listed count, price band consistent with the margin floor at plausible retail) → **top 15
  candidates**. The candidate set (the 15 `supplierProductId`s) is retained for the run — Stage
  4's membership check keys off it.
- **Zero/low-candidate short-circuit:** fewer than 3 survivors → skip Stages 2–4 entirely,
  alert (`warning`, `sourcing_run_skipped_no_candidates`), and flip the run's `agent_runs` row
  (already claimed at handler entry, Decision 10) to `'aborted'` with `totalCostUsd` 0 — the
  week fails loudly and spends nothing.

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
`maxBudgetUsd: 2.00` (a **stop-loss**, not a ≤ guarantee — the run halts once spend crosses it,
so the final figure lands at or a fraction over $2.00); `settingSources: []`;
`permissionMode: 'dontAsk'`; **`tools: ['WebSearch', 'WebFetch']`** — the availability layer:
this is the base built-in set (`tools: []` would strip WebSearch/WebFetch and `allowedTools`
CANNOT restore availability; MCP tools come from `mcpServers` and are unaffected) — plus
`allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch']` so everything available is
pre-approved under `dontAsk`; `persistSession: false`; own `systemPrompt` string (never the
claude_code preset); `env` spread from `process.env` (the option REPLACES the subprocess env);
`MCP_TOOL_TIMEOUT=60000` so a hung CJ call cannot stall the run;
`outputFormat: {type: 'json_schema', schema}` bridged from zod via `z.toJSONSchema`.

**MCP server `sourcing`** (in-process, `createSdkMcpServer`), four read-only tools wrapping the
supplier adapter: `get_product_detail` (10 pts), `get_reviews` (new adapter method, pts cost
recorded in cj-api-notes when live-verified), `get_stock` (10 pts), `quote_freight` (10 pts).
Every handler draws from the run's points allowance (25,000 minus harvest spend); an exhausted
allowance returns `isError: true` with copy telling the agent to conclude with what it has.
Handlers never throw raw errors — failures become error results and the loop continues.

**Prompt content:** the 15 candidates with their CJ + trends signals; store context (the four
`categoryTag` values, pricing convention, the margin floor **with the freight-inclusive
formula Stage 4 enforces** (see 4.7 — the prompt and the code state the same arithmetic),
shipsFrom 'US', delivery-day expectations); the category-exclusion list AND the
disallowed-claims list, both verbatim (the prompt is the middle layer of both guards — code
enforces the same lists on either side); instruction to research demand/competition via tools,
pick winners ONLY from the 15 candidates, and return **≤3 winners** in the output schema —
each a complete `new_listing` payload draft plus `rationale`, `marginPct`, and
`freightEstimateCents` (from its `quote_freight` calls).

**Lifecycle & persistence:** the run's `agent_runs` row already exists — claimed atomically at
handler entry (Decision 10) with `status: 'running'`, workflow `sourcing.weekly`, model,
triggerRef. Stream every message to `agent_run_events` (monotonic `seq`), and **accumulate a
running cost estimate as messages stream**: each assistant message carries per-model `usage`;
the runner tallies tokens and computes an estimated USD figure from a small pricing-constants
module, persisting the tally onto the row as it grows. On the result message, its
`total_cost_usd`/`modelUsage`/`num_turns`/`session_id` overwrite the estimate (the result
message is the only authoritative cost source) and status flips to `'succeeded'`. When the run
throws or is aborted, the `finally` path records the **accumulated estimate** (a lower bound —
there is no result message to read) with `modelUsage.estimated: true` so the admin page renders
it honestly, and flips status to `'failed'`/`'aborted'`. **Orphan sweep:** at ops boot and in
the hourly reconcile cron, any `agent_runs` row still `'running'` with `startedAt` older than
the watchdog + 5-minute margin flips to `'aborted'` with a `warning` alert
(`agent_run_orphaned`) — this is how a process death mid-run (which skips every `finally`)
gets recorded, and how a wedged same-day circuit breaker self-heals. AbortController watchdog
at 15 minutes wall-clock (inside the 60-minute job expiry, Decision 11). Agent queue
concurrency 1 (the SDK subprocess is ~1 GiB; Railway has 2 GB).

### Stage 4: Validate & submit (plain code)

Nothing the agent wrote is trusted: not its arithmetic, not its supplier data, not its HTML,
not even its choice of product. Per winner, in order — a failing winner is dropped with an
alert (`warning`, kind named per step); the others proceed. A `submitProposal` throw for one
winner likewise alerts and continues with the rest:

1. **Candidate-set membership:** the winner's `supplierProductId` must be one of the run's 15
   harvested candidates — this single check transitively re-applies the dedupe filter, the
   90-day denylist, and the harvest-side exclusions to everything submittable, so agent output
   cannot resurrect a rejected or already-listed product.
2. Zod-validate against `NewListingPayloadSchema` (with `imageUrls` tightened to http(s)-only —
   carried item lands here).
3. **descriptionHtml allowlist check:** agent-authored HTML later renders in the storefront, so
   it validates against a hardcoded tag/attribute allowlist (`p, br, ul, ol, li, strong, em,
   h2, h3`; no `script/style/iframe/object/embed/svg/form`, no `on*` attributes, no
   `javascript:`/`data:` URLs) — reject on violation, never rewrite (the house scrubber
   stance).
4. Category-exclusion re-check on the agent-authored `title` + `descriptionHtml` text content
   + the harvested `categoryName` for that `supplierProductId` (layer 3's exact match
   surfaces; the payload has no tags field).
5. **Claims scrubber** over every owner-facing string the pipeline emits: `title`,
   `descriptionHtml` text, and `rationale`; any hit drops the winner (`claims_scrubbed`) —
   rejects, never rewrites. The proposal `summary` is composed by plain code from the
   already-scrubbed title + the code-computed margin, never from free agent text.
6. **Ground-truth re-verification against CJ** (~20–30 pts/winner from the same allowance):
   re-fetch `getProduct(supplierProductId)` and `getVariantStock` — every `supplierVariantId`
   must exist under that product, live variant cost must match the payload's
   `supplierCostCents` within a small tolerance (else drop — the live figure is the one
   fulfillment will actually pay), and verified US stock must exist.
7. **Freight-inclusive margin re-check**, mirroring the live fulfillment gate in `plan.ts`:
   re-quote freight via `quoteShipping` (10 pts/winner), then for every variant require
   `floor((priceCents − supplierCostCents − freightCents) × 10_000 / priceCents) ≥`
   **`fulfillment.margin_floor_bps`** (the same settings key the order-time gate reads,
   default 6000) — integer bps math, floored, never rounded.
8. `submitProposal(deps, {type: 'new_listing', …, sourceWorkflow: 'sourcing.weekly',
   agentRunId})` → manual mode → Telegram + admin, exactly the proven Phase 4 path.

## Guards (day-one, before the first run)

- **Category exclusions** (constants module, hardcoded): supplements, CBD/hemp, flea & tick,
  medicated/pharmaceutical, consumables/treats/food, and health-claim products (e.g.
  "calming"). Three layers with explicit match surfaces: harvest (stage 1c — CJ `title` +
  `categoryName`), the prompt (list verbatim), submit (stage 4.4 — agent `title` +
  `descriptionHtml` text + harvested `categoryName`).
- **Claims scrubber** (constants + matcher): therapeutic/medical claim phrases ("treats",
  "cures", "anxiety relief", "vet approved" without substantiation, etc.). Same three-layer
  treatment: the list rides in the prompt verbatim, and stage 4.5 enforces it over every
  owner-facing string (title, description text, rationale). Untrusted CJ product data flows
  through the agent into listing copy — the scrubber + allowlist + human approval are the
  stated containment for that, not an accident: a prompt-injected or hallucinated winner still
  has to survive membership (4.1), schema (4.2), HTML allowlist (4.3), exclusions (4.4), claims
  (4.5), live re-verification (4.6), the code-side margin floor (4.7), and Robert's thumb.
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
- **Queue plumbing:** `registerCron` gains an options parameter (queue create + schedule
  options) so `sourcing.weekly` can pin `retryLimit: 0` / `expireInSeconds: 3600` (Decision
  11); existing cron registrations keep their current behavior.
- **Admin:** `/admin/runs` list gains cost/turns/finished columns (estimated cost rendered as
  such); new `/admin/runs/:id` detail page rendering `agent_run_events` (all content through
  `esc`; `safeHandle`-wrapped like every admin route). The proposal detail page renders the
  (already allowlist-validated) `descriptionHtml` so the approver sees what will actually go
  live — today it is never displayed anywhere before approval.
- **Manual trigger:** `apps/ops/scripts/run-sourcing.ts` (`pnpm --filter @doge-buddy/ops
  run-sourcing`, `--force` to bypass the daily circuit breaker) — runs the full pipeline
  against the configured DB/keys; how Tier 2 gets driven.
- **Carried Phase 4 rulings landing here:** `submitProposal` auto-path enqueue guard (try/catch
  + `apply_enqueue_failed` critical alert, mirroring the action-route handling — the proposal
  stays approved, never silently stranded). CJ product-webhook subscription: a new
  `subscribeProductWebhook(supplierProductId)` on `SupplierAdapter` (mock parity; the wire
  endpoint/shape is NOT yet in cj-api-notes — it gets discovered live during Tier 2 and
  recorded there, reconciled against `/webhook/set` semantics in case product webhooks turn
  out account-level rather than per-product, in which case the adapter method becomes a no-op
  and the spec note says so). The supplier adapter threads into the apply job's deps via
  `index.ts`/`queue.ts`; the call sits AFTER the `applying → applied` transition,
  best-effort — a crash between transition and subscribe loses the subscription and that is
  the accepted cost (alert-and-continue on failure; a resumed/retried apply that finds the row
  already `applied` does not re-subscribe).

## Failure posture

Every stage fails safe: harvest/trends failures alert and degrade (skip stage or run with
partial signals); an agent-run failure or budget/turn truncation records the run as
failed/aborted **with the accumulated cost estimate** (the streaming tally — authoritative
cost exists only on a result message), alerts (`critical`, `sourcing_run_failed`), and
produces zero proposals; a single bad winner drops alone, including on a `submitProposal`
throw; a process death mid-run is caught by the orphan sweep. Nothing in this phase can spend
Shopify/CJ money — the only spends are Anthropic tokens (stop-loss at $2.00/run) and CJ
points (≤25k/run allowance). The proposal gate (`workflow.sourcing.mode = 'manual'`) is
untouched.

## Exit criteria

**Tier 1 (mocked, in the suite):** full monorepo suite green with new coverage for: harvest
dedupe/exclusion matrix (including the pending/approved/failed exclusion), the low-candidate
short-circuit, trends batching + skip path, points-allowance exhaustion, runner lifecycle
against a scripted fake SDK stream (success / thrown / budget-truncation — cost or estimate
recorded in all three, and the fake asserts the runner passed
`tools: ['WebSearch','WebFetch']`), the atomic day-claim breaker (two concurrent starters →
exactly one row proceeds; refusal is a clean no-op), the orphan sweep, structured-output
validation + every Stage 4 rejection path (non-candidate winner, fabricated
`supplierCostCents`, unknown `supplierVariantId`, HTML-allowlist violation, category,
claims, freight-inclusive margin below `fulfillment.margin_floor_bps`), admin runs pages +
proposal description rendering, config gating (no key → no cron, loud log), enqueue-guard and
`imageUrls` regressions, adapter `flag` + `getProductReviews` + `subscribeProductWebhook`
(mock parity; CJ contract cases added to the live harness).

**Tier 2 (live):** one `run-sourcing --force` against real keys completes: `agent_runs` row
with real `totalCostUsd` ≈ ≤ $2 (stop-loss semantics), transcript inspectable at
`/admin/runs/:id` showing at least one WebSearch/WebFetch tool_use resolving, CJ points spent
< 25k, SerpApi usage ≤ 10 requests, and 1–3 genuine proposals arriving on Robert's phone with
working approve/reject. (Approving one through to an ACTIVE product re-proves the Phase 4
apply path with agent-sourced data, including the new webhook/product/subscribe call — whose
live wire shape gets recorded in cj-api-notes at that moment.)

## Out of scope

- `workflow.sourcing.mode = 'auto'` (the mode key + guarded enqueue exist; flipping it is an
  owner action for a later phase, after proposal quality is proven).
- Automated IP screen, CPSC recall poller, reverse-image checks (`[before-full-auto]`).
- Google Trends alpha adapter (until approval lands; interface is ready).
- Processing CJ STOCK/PRODUCT webhook events (shapes unverified — only the subscribe call
  ships; event handling is Phase 6's product-lifecycle loop, alongside `product_scores`).
- Any storefront work; the support agent (Phase 6); TikTok automation (no compliant API — the
  manual paste box remains the only TikTok input).
