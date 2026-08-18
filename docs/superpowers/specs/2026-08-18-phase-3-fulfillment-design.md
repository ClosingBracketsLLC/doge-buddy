# Phase 3 — Fulfillment (the money path): Design

**Date:** 2026-08-18 · **Status:** approved by Robert (brainstorming session) · **Parent:** [2026-08-09-doge-buddy-design.md](2026-08-09-doge-buddy-design.md) §(b) Fulfillment, §Key risk mitigations · **Pre-work:** [2026-08-17-phase-3-prework.md](2026-08-17-phase-3-prework.md)

## Goal

`orders/paid` → automatic supplier purchase with hard money gates → CJ tracking flowing back into Shopify fulfillments, with reconciliation pollers as the source of truth, a working kill-switch seam, and every failure drill from the parent design proven by repeatable tests. Zero LLM. Zero real money spent in this phase (mock adapter + env-gated CJ sandbox).

## Decisions made in brainstorming

| Question | Decision |
|---|---|
| Architecture | **Thin jobs, fat pure core**: all decisions in pure functions (`plan.ts` gates, `transitions.ts` state machine); pg-boss jobs are I/O shells. Matches the seed planner/run pattern. |
| FTC delay notices | **Deferred to Phase 7.** Phase 3 lays only the detection hook: reconcile flags overdue-unshipped supplier orders `needs_attention` + alert. |
| Execution sizing | **One spec, one big plan** (~18 tasks, single run) — Robert's call over the split-plan recommendation. |
| Settings | New `settings` table (key text pk, value jsonb, updated_at) + typed accessor with code defaults. Read fresh per job run (no cache) so kill-switch flips bite on the next job. |
| Alerts | One seam: `alert(severity, kind, detail)` → `audit_log` row (action `alert.<kind>`) + pino error. Phase 4 email plugs into this; nothing else changes. |

## 1. Module layout & data flow

```
apps/ops/src/fulfillment/
  plan.ts        # pure: planFulfillment(inputs) → Decision
  transitions.ts # pure: supplier_orders state machine
  run.ts         # I/O: executes a Decision (SupplierAdapter + db), resume-aware
apps/ops/src/jobs/
  fulfillment-place-order.ts, fulfillment-pay-order.ts,
  fulfillment-sync-tracking.ts, fulfillment-reconcile.ts, cj-wallet-monitor.ts
apps/ops/src/settings.ts   # typed accessor over settings table
apps/ops/src/alerts.ts     # alert seam
```

Settings keys (code defaults): `killswitch.global` false · `workflow.fulfillment.enabled` true · `fulfillment.spend_cap_per_order_cents` 7500 · `fulfillment.wallet_alert_threshold_cents` 2000 · `fulfillment.margin_floor_bps` 6000.

Happy path: `orders/paid` (Phase 1 receiver: HMAC, dedup, enqueue-ack — unchanged) → router upserts `orders` row (captures `is_test` from the payload `test` flag) → enqueue `fulfillment.place-order` (`singletonKey` = order gid) → plan/run → `confirmed` → enqueue `fulfillment.pay-order` → CJ ORDER/LOGISTICS webhooks → `fulfillment.sync-tracking` → Shopify `fulfillmentCreate` (notifyCustomer) → tracking on Hydrogen account pages.

## 2. Money chain

**State machine** (pure, sole writer of status): `pending → created → confirmed → paid → shipped → delivered`; `needs_attention`/`failed` reachable from active states; `awaiting_funds` parked between `confirmed`/`paid`. Illegal transitions rejected. (Schema note: the existing `supplier_order_status` enum lacks `awaiting_funds` — one ALTER TYPE migration adds it; the enum's unused `cancelled` value stays for Phase 6 refunds.)

**`fulfillment.place-order`** (singletonKey = order gid; ≤5 retries, exponential backoff): create-or-load `supplier_orders` row `pending` with deterministic `idempotency_key` from the Shopify order id **before any API call**; resume from current status on retry (crash-safe: adapter `placeOrder` is idempotent on the key — layer 1; CJ rejects duplicate `orderNumber` — layer 2). Planner gates in order, cheapest exit first:

1. `is_test` → terminal skip, audit-logged (hard rule: Bogus orders never reach the adapter).
2. Kill-switch / `workflow.fulfillment.enabled` off → re-queue with delay (not failed).
3. Line-item mapping via `supplier_variant_mappings`; unmapped → `needs_attention`.
4. US stock re-verify (`getVariantStock`); stockout / non-US → `needs_attention`. Never CN fallback.
5. Freight (`quoteShipping` from US): cheapest option fitting the promised 3–7-day window; none → `needs_attention`.
6. Money gates: projected total ≤ spend cap AND wallet balance covers it AND margin ≥ floor vs `supplier_cost_cents` captured at listing time; violation → `needs_attention` + alert (price-drift case).

Then `placeOrder` → `created` → **re-check actual quoted total vs cap** → `confirmOrder` → `confirmed` → enqueue pay.

**`fulfillment.pay-order`** (separate job = the kill-switch seam): re-read settings, then `payOrder`. CJ error **1600100** → status `awaiting_funds` + alert + **pause fulfillment queues** (pg-boss pause; no retry-spam). Other failures: bounded retries → `needs_attention`. Payment success → `paid` (+ `paid_at`).

## 3. CJ webhooks in, tracking out

**Router** (replaces the Phase 1 placeholder in `webhook-process.ts`): per-job isolation — each job gets its own try/catch, `processed_at`, and audit row; one poison job retries alone (pre-work #6). Routes:
- `shopify:orders/paid` → upsert order → enqueue place-order.
- `cj:ORDER` → map CJ status through the transition table; unknown/backwards → audit + ignore (webhooks are hints; reconcile is truth).
- `cj:LOGISTICS` → persist `tracking_number`/`logistic_name` → enqueue sync-tracking.

**`fulfillment.sync-tracking`** (singletonKey = supplier_order id): skip if `is_test` or no tracking. Query the order's `fulfillmentOrders`; no `shopify_fulfillment_gid` → `fulfillmentCreate` (trackingInfo, `notifyCustomer: true`), store gid + `tracking_synced_to_shopify_at`; gid exists and tracking changed → `fulfillmentTrackingInfoUpdate`. State-checked before every call ⇒ duplicate webhooks are no-ops. No custom tracking page.

## 4. Safety nets

**`fulfillment.reconcile`** (hourly cron), four sweeps:
1. Paid-but-orphaned: Shopify `orders(query: "updated_at:>=<now − 2h>")` (2× the cron interval as overlap; cheap at this scale) → paid non-test order with no `supplier_orders` row → upsert + enqueue place-order.
2. Stranded webhooks (pre-work #1): `webhook_events.processed_at IS NULL` older than 15 min → re-enqueue.
3. Status drift: active supplier orders → CJ `getOrderDetailBatch` → apply missed transitions; new tracking → enqueue sync-tracking.
4. Overdue hook (Phase 7 seam): past promised window, not shipped → `needs_attention` + alert.

**`cj.wallet-monitor`** (4h cron): `getBalance` < threshold → alert (top-up is manual — #1 full-auto risk). If queues are paused from 1600100 and balance now covers parked orders → un-pause, re-enqueue `awaiting_funds` orders.

**Hardening:** CJ client auth-failure → invalidate token + retry once (pre-work #3, mirrors Shopify client). Daily webhook-audit also prunes stale wrong-URL subscriptions (pre-work #5). `confirmOrder` unit test (pre-work #2). Pre-work #8 cleanups fold into whichever tasks touch those files. Token refresh: `cj-token-store` refresh-on-use + hourly reconcile traffic suffices — no new cron. Pre-work #4 (rate-limiter mutex, persisted points ledger) stays deferred to Phase 5 as scoped.

## 5. Testing & exit criteria

**Unit (pure, exhaustive):** table-driven `planFulfillment` suite covering every gate and reason; full legal/illegal transition matrix; `confirmOrder` operation test.

**Integration (mock adapter + real pg-boss + Dockerized test DB, extending Phase 0's queue-test pattern):** happy-path E2E (replayed webhook → placed → confirmed → paid → CJ webhook replay → tracking synced to stubbed Shopify client), then each failure drill as a repeatable test:
duplicate `orders/paid` → exactly one supplier order · crash mid-create + retry → no duplicate · kill-switch mid-flight → park, flip back → complete · cap-exceeded → `needs_attention`, zero spend · wallet-empty 1600100 → pause + `awaiting_funds`, restore → auto-resume · 429 storm (mock fault injection) → backoff, no double-spend · webhook outage → reconcile places the order.

**Guards:** `is_test` hard-skip asserted at planner AND job shell.

**Exit Tier 1 (no credentials — completes the phase):** everything above green in CI.
**Exit Tier 2 (parked on Robert's CJ key):** re-record `order/list` fixtures (pre-work #7), then `CJ_CONTRACT=1` sandbox harness runs the full pipeline against CJ sandbox.

## Out of scope

Customer delay notices (Phase 7 — hook only), refunds/disputes (Phase 6 support agent), proposals/admin UI (Phase 4), email transport (Phase 4/6), rate-limiter mutex + persisted points ledger (Phase 5), apparel (future).
