# Phase 5 pre-work (carried out of Phase 4 completion + 2026-08-24 research)

Constraints and gaps that must land before or during Phase 5 (the sourcing agent — parent:
`2026-08-09-doge-buddy-design.md` §Phase 5, `2026-08-09-doge-buddy-architecture.md` §Sourcing).
The parent docs specify this phase unusually tightly (weekly `sourcing.weekly` cron → CJ trending
harvest into `sourcing_signals` → one Agent SDK run with CJ MCP tools + WebSearch → structured
output of ≤3 `productSet`-ready drafts → `submitProposal` per draft). None of the items below
block starting the design; several ARE the design's decisions to make. Everything schema-side
already exists (`agent_runs`, `agent_run_events`, `agent_sessions`, `sourcing_signals`,
`product_scores` — migration 0000); `submitProposal` is the ready-made output gate.

1. **`ANTHROPIC_API_KEY` → config.** Key is on file and validated (2026-08-24), but nothing in
   `apps/ops` reads it: add an optional `anthropic` block to `config.ts` (the CJ/Telegram
   pattern) and registration-gate the sourcing cron on it (the `shopify.webhook-audit`
   precedent).

2. **`searchProducts` can't express CJ's "New" flag.** The adapter maps `trending?: boolean` →
   `productFlag: 0`; the design's second harvest pass needs `productFlag: 1` (New). Extend the
   `SupplierAdapter.searchProducts` interface (e.g. `flag?: 'trending' | 'new'` superseding the
   boolean) before the harvest lands. CJ flag semantics live-confirmed: 0=Trending, 1=New,
   2=Video, 3=Slow-moving.

3. **`cj.get_reviews` has no adapter method.** The architecture names it as an MCP tool, but
   `SupplierAdapter` has no reviews method (CJ has `GET /product/comments`, quota'd like the
   rest). Decide in brainstorming: add `getProductReviews` to the adapter, or drop the tool from
   the v1 toolset (the agent can judge demand from search + detail alone).

4. **Budget math moved under us.** Specs assume Sonnet 5 intro pricing ($2/$10) which ends
   **2026-08-31**; at list ($3/$15) a 25-turn research run brushes the $0.75 cap. `maxBudgetUsd`
   hard-stops regardless (SDK kills the run with `error_max_budget_usd`), so the risk is
   truncated runs, not overspend. Decide: hold $0.75 (accept occasional truncation — the run is
   weekly and retryable) or set $1.00. Prompt caching inside the run does most of the work
   either way.

5. **CJ points sub-budget is per-run arithmetic, not new machinery.** `CjHttpClient`'s 50k/day
   ledger is in-memory per-process and shared with fulfillment. The harvest is cheap
   (≤10 `listV2` pages × 50 pts = ≤500) and MCP tool calls are 10 pts each; enforcing
   "sourcing ≤ 25k" needs only a per-run allowance counter passed into the harvest + tools
   (`pointsSpentToday()` snapshot before/after for the logged "points < 25k" criterion). No
   persistence, no global changes.

6. **No denylist table — and none needed for v1.** "Recently rejected" dedupe can query
   `proposals` rows (`type='new_listing'`, `status='rejected'`, supplier ids inside `payload`);
   the keyword denylist + category exclusion list fit a settings-keyed jsonb or a constant
   module. Zero migrations holds.

7. **Day-one guards that are Phase 5 blockers (risks §[foundation]):** the hardcoded category
   exclusion list (supplements/CBD/pesticides/medicated/consumables/health-claim products) and
   the claims-scrubber on listing copy must exist before the agent's first run. The automated
   IP screen, CPSC recall poller, and reverse-image checks are **[before-full-auto]** — out of
   Phase 5; the owner's "IP check done" ritual (already in the proposal notification) covers.

8. **Agent SDK constraints, pinned from the installed surface (0.3.241 — pin exact, 0.x moves
   fast; typings beat docs on disagreement):** `query({prompt, options})`; hermetic cron options
   are `settingSources: []`, `permissionMode: 'dontAsk'`, `tools: []` + `allowedTools`
   allowlist (`mcp__sourcing__*`, `WebSearch`, `WebFetch`), `persistSession: false`,
   `maxTurns`, `maxBudgetUsd`; **`options.env` REPLACES the subprocess env — spread
   process.env**; set `MCP_TOOL_TIMEOUT` (default unbounded); each run spawns a ~1 GiB
   subprocess → agent queue concurrency 1; `tool()`/`createSdkMcpServer` are in-process with
   zod-v4 shapes; cost accounting reads the result message's `modelUsage` (the documented
   correct field) + `total_cost_usd`; structured output via
   `outputFormat: {type:'json_schema', schema}` → validated `structured_output`
   (`z.toJSONSchema` bridges from the existing zod payload schema).

9. **Proposals come from PLAIN code, not an agent tool.** The parent design already settles the
   SDK researcher's question: the agent RETURNS structured drafts; step-3 plain code validates
   and calls `submitProposal`. The LLM never holds a side-effecting submit tool — keep it that
   way.

10. **Signals stack, verified 2026-08-24:** CJ trending harvest is free-tier fine. SerpApi
    `google_trends` engine: free tier 250 searches/mo covers the weekly validation leg
    (~18-45/wk) if the key is ring-fenced for sourcing. Google Trends official API is STILL an
    application-gated alpha — file the application now (response times run months); build only
    the SerpApi adapter behind a swappable trends interface. TikTok Creative Center has no
    compliant programmatic path (Research API is academic-only) — the manual paste box stays
    the only TikTok input, as designed.

11. **`/admin/runs` must grow a detail page.** The verification criterion says "inspect the run
    transcript in `/admin/runs`", but the page renders only id/workflow/status/createdAt. Phase
    5 scope: cost + turns columns and a per-run drill-down over `agent_run_events`.
    (`agent_sessions` stays unused — a weekly cron doesn't resume.)

12. **Manual trigger.** "Trigger `sourcing.weekly` manually" needs a path: the house pattern is
    a credential-gated script (`pnpm --filter @doge-buddy/ops run-sourcing`, seed-proposal
    style) — an admin button can come later.

## Questions for the Phase 5 brainstorming session

1. **SerpApi account** (owner): sign up (free tier) and drop `SERPAPI_KEY` into `.env`? And
   file the Google Trends alpha application now (both are checklist items)?
2. **Run budget**: hold `maxBudgetUsd: 0.75` (accept occasional truncated runs at post-intro
   Sonnet pricing) or set 1.00?
3. **Reviews tool**: add `getProductReviews` to the CJ adapter, or ship v1 without it?
4. **Cadence + arming**: confirm weekly Monday cron (what hour, UTC?) and whether the cron is
   armed immediately on merge or the run stays manual-trigger-only until you've approved a few
   (`workflow.sourcing.mode` stays `'manual'` either way — this is about the *cron firing*, not
   auto-approval).
