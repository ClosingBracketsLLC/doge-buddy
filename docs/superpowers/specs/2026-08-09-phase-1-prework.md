# Phase 1 pre-work (carried out of the Phase 0 final review)

Items the Phase 0 whole-branch review triaged as fine-to-defer but scheduled for early Phase 1. None block the Phase 0 merge.

1. **Queue liveness → health design.** `/healthz` now reports `status: 'degraded'` when the queue is stopped (HTTP 200), but `boss.on('error')` still doesn't feed health state. Decide deliberately how queue failures surface (degrade vs 503 vs supervisor probe) when the real job topology lands.
2. **FK indexes.** No non-unique indexes on FK columns yet; `agent_run_events.run_id` and `support_messages.ticket_id` will hurt first. Add in the first Phase 1 migration.
3. **Singleton guards.** `cj_auth` / `gmail_sync_state` have `id integer PK default 1` but no `CHECK (id = 1)` — a stray second row would fork token/sync state.
4. **`agent_run_events` uniqueness.** Add UNIQUE(`run_id`, `seq`) so transcript persistence is self-checking (doubles as the run_id FK index).
5. **core ↔ db enum linkage.** `PROPOSAL_TYPES`/`SUPPLIER_KEYS` const arrays in `@doge-buddy/core` duplicate the pgEnum value lists in `@doge-buddy/db` with no compile-time link. Have db import the arrays (`pgEnum('proposal_type', PROPOSAL_TYPES)`) or add a cross-package equality test.
6. **zod deprecations.** Swap `z.string().url()`/`.uuid()` → top-level `z.url()`/`z.uuid()` before any zod major bump.
7. **Logging unification.** `queue.ts` uses `console.error` while the server uses pino; make the Fastify logger env-aware (silence in tests) when ops grows a logger module.
8. **Pool consolidation.** Ops currently opens two pg pools (+pg-boss's own); consolidate via a shared pool if worker count grows.
9. **Migration-test hygiene.** `migration_test_*` databases accumulate locally (CI is ephemeral); add an `afterAll` `DROP DATABASE … WITH (FORCE)` when convenient.
10. **`product_scores` columns.** Design doc says 7d+28d for units/revenue/refunds/tickets; implementation carries 7d only for units. Recorded so Phase 7 (scoring) makes the call deliberately.

## Recorded convention exception

`agent_runs.total_cost_usd` is `numeric` **USD** (not integer cents): it mirrors the Claude Agent SDK's `total_cost_usd` telemetry field (sub-cent precision, non-financial — "never reconcile finances from it" per the design doc). The integer-cents `_cents` convention governs commerce money; this column's `_usd` suffix marks the exception.
