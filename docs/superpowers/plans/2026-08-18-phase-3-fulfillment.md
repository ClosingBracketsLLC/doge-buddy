# Phase 3 — Fulfillment (Money Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orders/paid` → gated automatic supplier purchase (place/confirm/pay) → CJ tracking back into Shopify fulfillments, with reconciliation as truth, a settings-driven kill-switch, and every failure drill proven by a repeatable test.

**Architecture:** Thin jobs, fat pure core: all money decisions in pure functions (`fulfillment/plan.ts`, `fulfillment/transitions.ts`); I/O in resume-aware executors (`fulfillment/run-*.ts`) called by thin pg-boss handlers. Settings read fresh per run (kill-switch seam); one `alert()` choke point; "queue pause" = `fulfillment.paused_for_funds` settings flag (pg-boss has no per-queue pause).

**Tech Stack:** Existing: pg-boss 10, Drizzle + Postgres 17 (test DB `pnpm db:up`, :5433), `@doge-buddy/supplier` (SupplierAdapter + MockSupplierAdapter + CJ), `@doge-buddy/shopify-admin` (16 ops), Fastify webhook receiver, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-phase-3-fulfillment-design.md` (read first; parent: `2026-08-09-doge-buddy-design.md` §(b)).

## Global Constraints

- Branch `feat/phase-3-fulfillment` (exists). Commit per task, conventional commits. TDD for every task with logic (RED evidence before implementation).
- Money is integer cents everywhere. No floats in money math (use `@doge-buddy/core` helpers).
- No real network in tests: unit tests pure; integration tests = MockSupplierAdapter + real pg-boss + the Dockerized test DB (`DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy`, `pnpm db:up` first) + stubbed Shopify client (inject fakes; never `ShopifyAdminClient` in tests).
- Status writes ONLY via `transitions.ts` (`applyTransition`). Jobs never `db.update({status})` directly.
- Every operator-relevant event goes through `alert()` — no bare `console.*` in fulfillment code (pino logger passed in deps).
- Settings read per job run, never cached. Defaults (exact): `killswitch.global` false · `workflow.fulfillment.enabled` true · `fulfillment.paused_for_funds` false · `fulfillment.spend_cap_per_order_cents` 7500 · `fulfillment.wallet_alert_threshold_cents` 2000 · `fulfillment.margin_floor_bps` 6000 · `fulfillment.promised_max_days` 7.
- Queue names (exact): `fulfillment.place-order`, `fulfillment.pay-order`, `fulfillment.sync-tracking`, `fulfillment.reconcile`, `cj.wallet-monitor`. Send options for place/pay/sync: `{ singletonKey, retryLimit: 5, retryBackoff: true, retryDelay: 30 }`.
- `supplier_orders.idempotency_key` = `db-` + digits of the Shopify order gid (e.g. `gid://shopify/Order/123` → `db-123`). Deterministic, ≤32 chars, CJ-safe.
- Variant keying: Shopify line-item variant ids normalize to full gid `gid://shopify/ProductVariant/<id>` before any lookup.
- Storefront untouched. Pre-work #4 (rate-limiter mutex/points ledger) stays out of scope (Phase 5).
- Existing ops test conventions: tests in `apps/ops/test/*.test.ts`; DB-backed tests follow `queue.test.ts`'s setup (real pool against :5433, per-test cleanup).

---

### Task 1: Settings table + typed accessor

**Files:**
- Modify: `packages/db/src/schema.ts` (add `settings` table; extend `supplier_order_status` enum with `awaiting_funds`)
- Create: migration via `pnpm --filter @doge-buddy/db generate` (drizzle-kit; check package scripts), `apps/ops/src/settings.ts`
- Test: `apps/ops/test/settings.test.ts`

**Interfaces:**
- Produces:
  - schema: `settings(key text pk, value jsonb notNull, updatedAt)`
  - `SETTINGS_DEFAULTS` const (exact keys/values from Global Constraints)
  - `createSettings(db) → { get<K extends SettingKey>(key: K): Promise<SettingValue<K>>, set<K>(key: K, value: SettingValue<K>): Promise<void> }` — `get` returns stored value or code default; `set` upserts. Types: `killswitch.global`/`workflow.fulfillment.enabled`/`fulfillment.paused_for_funds` → boolean; the cents/bps/days keys → number.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
// setup/teardown: mirror queue.test.ts (createDb against TEST_DATABASE_URL, truncate settings between tests)

it('returns the code default when no row exists', async () => {
  const s = createSettings(db)
  expect(await s.get('fulfillment.spend_cap_per_order_cents')).toBe(7500)
  expect(await s.get('killswitch.global')).toBe(false)
})
it('set() upserts and get() returns the stored value', async () => {
  const s = createSettings(db)
  await s.set('killswitch.global', true)
  expect(await s.get('killswitch.global')).toBe(true)
  await s.set('killswitch.global', false)
  expect(await s.get('killswitch.global')).toBe(false)
})
```

- [ ] **Step 2: Run to fail** — `pnpm --filter @doge-buddy/ops test settings` → FAIL (module missing).
- [ ] **Step 3: Implement** — schema table + enum value; run `pnpm --filter @doge-buddy/db generate` (or the repo's migration script — read `packages/db/package.json`) and commit the migration; `settings.ts` with the typed map. Enum note: adding a value = `ALTER TYPE supplier_order_status ADD VALUE 'awaiting_funds'` — verify drizzle generated it; hand-write the migration SQL if the generator can't.
- [ ] **Step 4: Run to pass** — settings tests + `pnpm --filter @doge-buddy/db migrate` against the test DB + full ops suite green.
- [ ] **Step 5: Commit** — `feat(ops): settings table with typed accessor; awaiting_funds status`

---

### Task 2: Alert seam

**Files:**
- Create: `apps/ops/src/alerts.ts` — Test: `apps/ops/test/alerts.test.ts`

**Interfaces:**
- Produces: `type AlertSeverity = 'info' | 'warning' | 'critical'`; `createAlerter(db, log: pino.BaseLogger) → alert(severity: AlertSeverity, kind: string, detail: Record<string, unknown>): Promise<void>` — inserts `audit_log` row `{actor: 'system', action: 'alert.' + kind, entityType: 'alert', detail: {severity, ...detail}}` and calls `log.error({kind, severity, ...detail}, 'alert')` (severity `info` → `log.warn`... no: `info`→`log.info`, `warning`→`log.warn`, `critical`→`log.error`).

- [ ] **Step 1: Failing tests** — DB-backed: alert writes exactly one audit row with action `alert.wallet_low` and detail merged; logger spy called at matching level.
- [ ] **Step 2: RED** → **Step 3: implement (~25 lines)** → **Step 4: GREEN + suite** → **Step 5: Commit** `feat(ops): alert seam (audit_log + pino)`

---

### Task 3: Supplier-order state machine (pure)

**Files:**
- Create: `apps/ops/src/fulfillment/transitions.ts` — Test: `apps/ops/test/fulfillment-transitions.test.ts`

**Interfaces:**
- Produces: `type SupplierOrderStatusDb = 'pending'|'created'|'confirmed'|'paid'|'shipped'|'delivered'|'cancelled'|'failed'|'needs_attention'|'awaiting_funds'`; `canTransition(from, to): boolean`; `applyTransition(db, supplierOrderRowId: string, from: SupplierOrderStatusDb, to: SupplierOrderStatusDb, patch?: Partial<{supplierOrderId, shipmentOrderId, logisticName, productAmountCents, postageAmountCents, totalAmountCents, trackingNumber, lastError, paidAt}>): Promise<void>` — throws `IllegalTransitionError` if `!canTransition`; UPDATE is guarded `WHERE id = ? AND status = from` (optimistic concurrency: 0 rows updated → throw `StaleStatusError`).
- Legal matrix (exhaustive): `pending→{created, needs_attention, failed}` · `created→{confirmed, needs_attention, failed}` · `confirmed→{paid, awaiting_funds, needs_attention, failed}` · `awaiting_funds→{paid, needs_attention, failed}` · `paid→{shipped, needs_attention}` · `shipped→{delivered, needs_attention}` · `needs_attention→{pending, created, confirmed, paid, cancelled}` (operator recovery) · terminal: `delivered`, `cancelled`, `failed`. Same-status self-transition: always false.

- [ ] **Step 1: Failing tests** — table-driven full matrix (every from×to pair asserted against the list above); `applyTransition` happy path persists patch; illegal throws; concurrent-stale throws (`update` after status changed underneath).
- [ ] **Steps 2–4: RED → implement → GREEN.** `canTransition` = lookup in a `Record<Status, Status[]>`.
- [ ] **Step 5: Commit** `feat(ops): supplier-order state machine with guarded transitions`

---

### Task 4: Planner — types + gates 1–3 (pure)

**Files:**
- Create: `apps/ops/src/fulfillment/plan.ts` — Test: `apps/ops/test/fulfillment-plan.test.ts`

**Interfaces:**
- Consumes: `Address`, `WarehouseStock`, `ShippingOption` from `@doge-buddy/supplier`.
- Produces (Task 5 extends the same file; Tasks 8–10 consume):

```ts
export interface FulfillmentInputs {
  order: {
    isTest: boolean
    totalCents: number
    shippingAddress: Address
    lineItems: { variantGid: string; quantity: number }[]
  }
  settings: {
    killswitch: boolean; fulfillmentEnabled: boolean; pausedForFunds: boolean
    spendCapPerOrderCents: number; marginFloorBps: number; promisedMaxDays: number
  }
  mappings: Map<string, { supplierVariantId: string; supplierCostCents: number }> // key: variantGid
  stock: Map<string, WarehouseStock[]> // key: supplierVariantId
  freightOptions: ShippingOption[]
  walletAvailableCents: number
}
export type NeedsAttentionReason =
  | 'unmapped_item' | 'stockout' | 'no_us_stock' | 'no_freight_in_window'
  | 'cap_exceeded' | 'wallet_insufficient' | 'margin_below_floor'
export type Decision =
  | { kind: 'skip_test' }
  | { kind: 'requeue'; reason: 'killswitch' | 'fulfillment_disabled' | 'paused_for_funds'; delaySeconds: number }
  | { kind: 'needs_attention'; reason: NeedsAttentionReason; detail: string }
  | { kind: 'proceed'; logisticName: string; freightCents: number; supplierItemsCents: number
      projectedTotalCents: number
      items: { supplierVariantId: string; quantity: number }[] }
export function planFulfillment(inputs: FulfillmentInputs): Decision
```

- [ ] **Step 1: Failing tests (gates 1–3).** Build a `baseInputs()` helper producing a passing input, then override per case:

```ts
it('gate 1: is_test wins over everything', () => {
  expect(planFulfillment({...baseInputs(), order: {...baseInputs().order, isTest: true}}))
    .toEqual({kind: 'skip_test'})
})
it.each([
  ['killswitch', {killswitch: true}],
  ['fulfillment_disabled', {fulfillmentEnabled: false}],
  ['paused_for_funds', {pausedForFunds: false ? {} : {pausedForFunds: true}}], // pausedForFunds: true
])('gate 2: %s → requeue with 300s delay', (reason, patch) => {
  const d = planFulfillment(withSettings(patch))
  expect(d).toEqual({kind: 'requeue', reason, delaySeconds: 300})
})
it('gate 3: any unmapped line item → needs_attention naming the variant', () => {
  const d = planFulfillment(withoutMappingFor('gid://shopify/ProductVariant/2'))
  expect(d).toMatchObject({kind: 'needs_attention', reason: 'unmapped_item'})
  expect((d as any).detail).toContain('gid://shopify/ProductVariant/2')
})
```

(Write the helpers concretely in the test file; fix the `it.each` third row to a plain `it` — shown here compressed.)
- [ ] **Steps 2–4: RED → implement gates 1–3 → GREEN.**
- [ ] **Step 5: Commit** `feat(ops): fulfillment planner — test/killswitch/mapping gates`

---

### Task 5: Planner — gates 4–6 (pure)

**Files:** Modify `apps/ops/src/fulfillment/plan.ts`; extend `apps/ops/test/fulfillment-plan.test.ts`

**Interfaces:** Consumes/extends Task 4's. Gate semantics (exact):
- Gate 4 per item: stock entries with `countryCode === 'US'` and `quantity >= needed` (sum needed per supplierVariantId across line items). No US entry at all → `no_us_stock`; US entry but insufficient → `stockout`.
- Gate 5: eligible options = `freightOptions.filter(o => o.maxDays <= settings.promisedMaxDays)`; pick min `priceCents` (tie → first); none → `no_freight_in_window`.
- Gate 6 (on the chosen option): `supplierItemsCents = Σ mapping.supplierCostCents × quantity`; `projectedTotalCents = supplierItemsCents + freightCents`. Checks in order: `projectedTotalCents > spendCapPerOrderCents` → `cap_exceeded`; `> walletAvailableCents` → `wallet_insufficient`; margin `((order.totalCents − projectedTotalCents) × 10000) / order.totalCents < marginFloorBps` (integer math, floor) → `margin_below_floor` (the price-drift trap).

- [ ] **Step 1: Failing tests** — one focused test per reason + boundary cases: projected exactly == cap passes; margin exactly == floor passes; freight `maxDays === promisedMaxDays` eligible; cheaper-but-too-slow option ignored. Happy path asserts full `proceed` payload (logisticName, all three cents fields, items list).
- [ ] **Steps 2–4: RED → implement → GREEN** (planner stays pure; no Date/now/IO).
- [ ] **Step 5: Commit** `feat(ops): fulfillment planner — stock/freight/money gates`

---

### Task 6: shopify-admin — `ordersUpdatedSince` + `webhookSubscriptionDelete` (TDD, house style)

**Files:** Modify `packages/shopify-admin/src/operations.ts`, `test/operations.test.ts` (house pattern: module-level `#graphql`, typed Data interface, `assertNoUserErrors`, `makeClient`/`gql` helpers). Also: dedupe the `UserErrorEntry` interface into one exported type (pre-work #8 item) — export from `errors.ts` and reuse.

**Interfaces:**
- Produces:
  - `ordersUpdatedSince(client, sinceIso: string): Promise<{ id: string; name: string; test: boolean; displayFinancialStatus: string; email?: string; updatedAt: string }[]>` — query `orders(first: 100, query: $query, sortKey: UPDATED_AT)` with `$query = "updated_at:>='<sinceIso>'"`; nodes `{ id name test displayFinancialStatus email updatedAt }`. (Full payload for placement comes from the stored `orders.raw_payload`; reconcile only needs identity + status.)
  - `webhookSubscriptionDelete(client, id: string): Promise<void>` — mutation `webhookSubscriptionDelete(id: $id) { userErrors { field message } }`.
- [ ] Steps: failing tests (happy + userErrors for the mutation; query-string assertion for the query) → RED → implement → GREEN (41→45 tests) → Commit `feat(shopify-admin): ordersUpdatedSince query, webhookSubscriptionDelete; dedupe UserErrorEntry`

---

### Task 7: CJ auth-retry (pre-work #3) + `confirmOrder` test (pre-work #2)

**Files:** Modify `packages/supplier/src/adapters/cj/http.ts` (+ `errors.ts` if needed); extend `packages/supplier/test/` (follow existing cj http/adapter test files' fixture pattern).

**Interfaces:** Consumes existing `CjHttpClient` + token store. Produces: on CJ auth-failure response (the error code the existing client already maps to its auth error — read `errors.ts` for the exact code) the client invalidates the token store and retries the request once; second failure propagates. `confirmOrder` gets a direct unit test asserting method, URL path, and body shape against the recorded fixture pattern.

- [ ] Steps: failing tests (auth-fail-then-success → one retry, token store invalidated exactly once; auth-fail-twice → throws; confirmOrder request-shape test) → RED → implement retry-once in the client's request path → GREEN → Commit `fix(supplier): CJ auth-failure invalidate-and-retry; confirmOrder coverage`

---

### Task 8: Webhook router — per-job isolation + `orders/paid` → order upsert + enqueue

**Files:** Rewrite `apps/ops/src/jobs/webhook-process.ts`; Create `apps/ops/src/fulfillment/order-upsert.ts`; Test `apps/ops/test/webhook-router.test.ts` (DB-backed)

**Interfaces:**
- Consumes: `webhookEvents`/`orders` tables; enqueue fn.
- Produces (shared type, exported from `webhook-process.ts` or a small `apps/ops/src/fulfillment/types.ts`): `type SendOpts = {singletonKey?: string; retryLimit?: number; retryBackoff?: boolean; retryDelay?: number; startAfter?: number}`; the existing `WebhookDeps['enqueue']` signature extends to `(name: string, data: object, opts?: SendOpts) => Promise<void>`, threaded through to `boss.send`. Tasks 9–15 consume `SendOpts`.
- Produces:
  - `upsertOrderFromPaidPayload(db, payload): Promise<{orderRowId: string; orderGid: string; isTest: boolean}>` — maps the REST webhook payload (`admin_graphql_api_id`, `test`, `total_price`, `email`, `shipping_address`, `line_items[].variant_id/quantity`, `order_number`) into `orders` (upsert on `shopify_order_gid`; store `raw_payload`).
  - `webhookProcessHandler(deps, source)` — per-job try/catch (one poison job → its own `job.done` failure/retry, batch unaffected; audit row per job); routing: `shopify` + topic `orders/paid` → upsert + enqueue `fulfillment.place-order` `{orderGid}` with `singletonKey: orderGid` + retry opts; `cj` topics stubbed until Task 12 (still mark processed + audit `webhook.ignored`).
- [ ] Steps: failing tests (poison-first-job → second job still processed + first retried; `orders/paid` creates order row with `is_test` true/false from payload and enqueues exactly once with singletonKey; duplicate delivery of same event id was already deduped upstream — replay the same payload as a NEW event id → upsert not duplicate row, enqueue again is singleton-deduped by pg-boss, assert via spy) → RED → implement → GREEN → Commit `feat(ops): webhook router with per-job isolation; orders/paid → place-order enqueue`

---

### Task 9: `run-place-order.ts` — resume-aware executor

**Files:** Create `apps/ops/src/fulfillment/run-place-order.ts`; Test `apps/ops/test/fulfillment-place-order.test.ts` (DB-backed + MockSupplierAdapter)

**Interfaces:**
- Consumes: planner (T4/5), transitions (T3), settings (T1), alerter (T2), `SupplierAdapter`.
- Produces:

```ts
export interface PlaceOrderDeps {
  db: Db; adapter: SupplierAdapter
  settings: ReturnType<typeof createSettings>
  alert: ReturnType<typeof createAlerter>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
}
export async function executePlaceOrder(deps: PlaceOrderDeps, orderGid: string): Promise<void>
```

Behavior (exact):
1. Load order row by gid (missing → throw, job retries). `is_test` → audit `fulfillment.skipped_test`, return (also asserted in planner — double guard).
2. Load-or-create `supplier_orders` row (`supplier: adapter.key`, status `pending`, `idempotency_key` per Global Constraints). **Resume switch on current status:** `confirmed|awaiting_funds|paid|…` → enqueue pay if `confirmed`, else return (idempotent re-entry); `created` → skip to confirm step; `needs_attention|failed|cancelled` → return (operator owns it); `pending` → full path.
3. Gather inputs (mappings join `supplier_variant_mappings` + `product_variants.supplier_cost_cents` by variant gid; `adapter.getVariantStock` per distinct supplier variant; `adapter.quoteShipping` US→order country; `adapter.getBalance()`; settings). Call `planFulfillment`.
4. Decision dispatch: `skip_test` → audit; `requeue` → re-enqueue self with `startAfter: delaySeconds`, audit; `needs_attention` → transition + `lastError = reason: detail` + alert('warning', 'fulfillment_needs_attention', …); `proceed` → `adapter.placeOrder({idempotencyKey, shippingAddress, items, logisticName, fromCountry: 'US'})` → `applyTransition(pending→created, patch: amounts + supplierOrderId + shipmentOrderId + logisticName)` → **re-check `result.totalAmountCents ≤ spendCap`** (violation → transition `created→needs_attention` + alert; no confirm) → `adapter.confirmOrder` → `created→confirmed` → enqueue `fulfillment.pay-order` `{supplierOrderRowId}` singletonKey=rowId.
- [ ] Steps: failing tests (is_test order → return before ANY adapter call (spies on all adapter methods) with `fulfillment.skipped_test` audit — the shell-layer half of the double guard; happy path end-state `confirmed` + pay enqueued + amounts persisted; resume-from-`created` calls confirm only — no second placeOrder (spy); crash-sim: run once to `created` then rerun full → mock's idempotent placeOrder returns same order, exactly one order in mock's internal store; post-create cap violation → `needs_attention`, confirm never called; needs_attention decision persists reason + alerts) → RED → implement → GREEN → Commit `feat(ops): place-order executor (resume-aware, cap re-check)`

---

### Task 10: Job shells + queue wiring + adapter selection

**Files:** Create `apps/ops/src/jobs/fulfillment-place-order.ts`, `fulfillment-pay-order.ts` (shell only; executor lands T11); Modify `apps/ops/src/queue.ts`, `apps/ops/src/index.ts`, `apps/ops/src/config.ts`, `apps/ops/src/http/webhooks.ts` (enqueue opts threading), `.env.example`
- Test: `apps/ops/test/queue-fulfillment.test.ts`

**Interfaces:**
- Produces: `startQueue(connectionString, deps: FulfillmentQueueDeps)` — extended signature carrying `{adapter, settings, alert, shopify?: StubbableShopifyOps}`; queues created + workers registered for the five queue names; config gains `FULFILLMENT_SUPPLIER` env (`'mock' | 'cj'`, default `'mock'`; `'cj'` requires CJ config present else startup error). Index wires MockSupplierAdapter or the CJ adapter accordingly.
- [ ] Steps: failing test (a sent `fulfillment.place-order` job reaches a spy executor through the real boss — extend `queue.test.ts` demo-ping pattern; singletonKey dedupe asserted: two sends same key while active → one execution) → RED → implement wiring → GREEN → Commit `feat(ops): fulfillment queues wired; FULFILLMENT_SUPPLIER selection`

---

### Task 11: `run-pay-order.ts` + pause-for-funds

**Files:** Create `apps/ops/src/fulfillment/run-pay-order.ts`; fill `apps/ops/src/jobs/fulfillment-pay-order.ts`; Test `apps/ops/test/fulfillment-pay-order.test.ts`

**Interfaces:**
- Produces: `executePayOrder(deps: PlaceOrderDeps, supplierOrderRowId: string): Promise<void>`:
1. Load row; status must be `confirmed` or `awaiting_funds` (anything else → audit + return).
2. Settings recheck: killswitch/disabled/paused → re-enqueue self `startAfter: 300`.
3. `adapter.payOrder(shipmentOrderId)` → `paid: true` → transition → `paid` + `paidAt`; `failureReason === 'insufficient_balance'` → transition `confirmed→awaiting_funds` (no-op if already there) + `settings.set('fulfillment.paused_for_funds', true)` + alert('critical', 'wallet_empty', {supplierOrderRowId}); other failure → throw (bounded retries; final failure → pg-boss `failed` → dead-letter audit hook: on 5th attempt transition to `needs_attention` + alert inside a catch).
- [ ] Steps: failing tests (success → paid+paidAt; insufficient balance → awaiting_funds + paused flag true + critical alert; paused settings → requeued not paid (spy); non-balance failure throws) → RED → implement → GREEN → Commit `feat(ops): pay-order executor with pause-for-funds seam`

---

### Task 12: CJ webhook routing (ORDER/LOGISTICS)

**Files:** Modify `apps/ops/src/jobs/webhook-process.ts`; Create `apps/ops/src/fulfillment/cj-status-map.ts`; Test extend `apps/ops/test/webhook-router.test.ts`

**Interfaces:**
- Consumes: `SupplierWebhookEvent` (`cjAdapter.parseWebhook` output stored in `webhook_events.payload` by the Phase 1 receiver — verify actual stored shape in `http/webhooks.ts` and adapt), transitions.
- Produces: `mapCjStatus(value: SupplierOrderStatusValue): SupplierOrderStatusDb | null` (pure: `shipped→shipped`, `delivered→delivered`, `cancelled→cancelled`; everything else `null` = ignore); router cases: `cj` + type `order` → look up `supplier_orders` by `supplierOrderId`, mapped status non-null and `canTransition` → apply, else audit `webhook.ignored` (hints, not truth); `cj` + type `logistics` → persist `trackingNumber`/`logisticName` (direct field update — not a status change) → enqueue `fulfillment.sync-tracking` `{supplierOrderRowId}` singletonKey=rowId.
  > **[2026-08-23]** Superseded post-review: ignore-on-illegal let CJ-cancelled-on-active-row sit stuck; `resolveCjTransition` now parks those `needs_attention` with a `supplier_cancelled` alert (commit e6dd08e). Applies to Task 14 sweep 3 as well.
- [ ] Steps: failing tests (ORDER shipped moves paid→shipped; backwards ORDER status ignored + audited; LOGISTICS persists tracking + enqueues sync; unknown supplierOrderId → audit ignored, no throw) → RED → implement → GREEN → Commit `feat(ops): CJ ORDER/LOGISTICS webhook routing`

---

### Task 13: `run-sync-tracking.ts`

**Files:** Create `apps/ops/src/fulfillment/run-sync-tracking.ts`, `apps/ops/src/jobs/fulfillment-sync-tracking.ts`; Test `apps/ops/test/fulfillment-sync-tracking.test.ts`

**Interfaces:**
- Consumes: injected `shopifyOps: { orderFulfillmentOrders(orderGid): Promise<{id, status}[]>, fulfillmentCreate(args): Promise<{fulfillmentId}>, fulfillmentTrackingInfoUpdate(gid, tracking): Promise<void> }` — the deps struct wraps the real `@doge-buddy/shopify-admin` functions in index.ts; tests inject fakes.
- Produces: `executeSyncTracking(deps, supplierOrderRowId)`:
skip+audit if order `is_test` or no `tracking_number`; no `shopify_fulfillment_gid` → `orderFulfillmentOrders` (first OPEN/IN_PROGRESS node) → `fulfillmentCreate({fulfillmentOrderId, trackingNumber, trackingCompany: logisticName, notifyCustomer: true})` → persist gid + `tracking_synced_to_shopify_at`; gid present and tracking unchanged → no-op; changed → `fulfillmentTrackingInfoUpdate`.
- [ ] Steps: failing tests (create path persists gid+timestamp; duplicate run no-ops — zero shopify calls (spies); changed tracking → update called, not create; is_test skips) → RED → implement + wire shell/queue → GREEN → Commit `feat(ops): tracking sync to Shopify fulfillments`

---

### Task 14: `run-reconcile.ts` — four sweeps + hourly cron

**Files:** Create `apps/ops/src/fulfillment/run-reconcile.ts`, `apps/ops/src/jobs/fulfillment-reconcile.ts`; Modify `apps/ops/src/index.ts` (registerCron `0 * * * *`); Test `apps/ops/test/fulfillment-reconcile.test.ts`

**Interfaces:**
- Consumes: `ordersUpdatedSince` via injected `shopifyOps` (extend T13's struct), adapter (`getOrderStatus`, `getTracking`), transitions, alert, enqueue, `now: () => Date` injected for clock control.
- Produces: `executeReconcile(deps): Promise<{orphaned: number; strandedWebhooks: number; driftFixed: number; overdue: number}>` implementing the spec's four sweeps exactly:
1. `ordersUpdatedSince(now − 2h)` → paid (`displayFinancialStatus === 'PAID'`), `test === false`, no `supplier_orders` row → ensure `orders` row exists (from stored payload if present; else create minimal row from the reconcile fields and alert `reconcile_thin_order` — placement will fail to map and park as needs_attention, which is correct) → enqueue place-order.
2. `webhook_events.processed_at IS NULL AND received_at < now − 15min` → re-enqueue their process job, audit.
3. Rows in `created|confirmed|paid|shipped` older than 10 min: `adapter.getOrderStatus` → `mapCjStatus` → legal transition → apply; `adapter.getTracking` → new/changed tracking → persist + enqueue sync-tracking.
4. Rows not `shipped+` where `orders.paid_at < now − promisedMaxDays days` → transition to `needs_attention` (if legal) + alert('warning', 'order_overdue', …).
- [ ] Steps: failing tests (one per sweep with clock injection; sweep 1 skips test orders and already-handled orders) → RED → implement → GREEN → Commit `feat(ops): hourly reconcile (orphans, stranded webhooks, drift, overdue)`

---

### Task 15: `cj.wallet-monitor` (4h cron)

**Files:** Create `apps/ops/src/jobs/cj-wallet-monitor.ts`; Modify `apps/ops/src/index.ts` (registerCron `0 */4 * * *`); Test `apps/ops/test/wallet-monitor.test.ts`

**Interfaces:**
- Produces: `executeWalletMonitor(deps): Promise<void>` — `adapter.getBalance()`; `availableCents < wallet_alert_threshold_cents` → alert('critical', 'wallet_low', {availableCents}). If `fulfillment.paused_for_funds` is true: sum `totalAmountCents` of `awaiting_funds` rows; balance covers the sum → `settings.set('fulfillment.paused_for_funds', false)` + re-enqueue each row to `fulfillment.pay-order` + alert('info', 'wallet_recovered', …).
- [ ] Steps: failing tests (low balance alerts; paused + recovered balance → flag cleared + N pay jobs enqueued; paused + still short → stays paused, no enqueue) → RED → implement → GREEN → Commit `feat(ops): wallet monitor with auto-resume`

---

### Task 16: Webhook-audit stale-subscription pruning (pre-work #5)

**Files:** Modify `apps/ops/src/jobs/shopify-webhook-audit.ts`; extend its existing test file.

**Interfaces:** Consumes `listWebhookSubscriptions` + new `webhookSubscriptionDelete` (T6). Produces: audit job now deletes subscriptions whose topic is one we manage but whose `callbackUrl` ≠ the configured public URL (leave unknown topics alone), after creating missing ones. Audit-log each deletion.
- [ ] Steps: failing test (wrong-URL managed-topic sub → deleted + audited; foreign topic untouched) → RED → implement → GREEN → Commit `fix(ops): webhook audit prunes stale wrong-URL subscriptions`

---

### Task 17: Integration E2E — happy path + drills A

**Files:** Create `apps/ops/test/fulfillment-e2e.test.ts` (real pg-boss + test DB + MockSupplierAdapter + fake shopifyOps; extend `queue.test.ts` bootstrap into a shared helper `apps/ops/test/helpers/fulfillment-harness.ts` if repetition demands — keep it one file if under ~150 lines)

Covers (each its own test, seeded mappings/variants/settings per test):
1. **Happy path:** inject `orders/paid` payload through `upsertOrderFromPaidPayload` + real queue → wait until supplier order `paid` → replay CJ LOGISTICS webhook → `sync-tracking` ran → fake fulfillmentCreate called once, gid persisted.
2. **Duplicate `orders/paid`** (new event id, same order) → still exactly one `supplier_orders` row, one mock order.
3. **Cap exceeded** (settings cap 100) → `needs_attention`, mock adapter's placeOrder never called (spy), zero spend.
4. **Kill-switch mid-flight:** killswitch on → job requeues (status stays `pending`); flip off → next run completes to `confirmed`+pay enqueued.
- [ ] Steps: write tests (RED against any regression) → make green (wiring fixes only — logic already landed) → Commit `test(ops): fulfillment E2E happy path + gate drills`

---

### Task 18: Drills B + mock fault injection + cleanups + docs

**Files:** Modify `packages/supplier/src/adapters/mock/mock-adapter.ts` (`MockAdapterOptions` gains `failPlaceOrderTimes?: number` (throw retryable error N times then succeed — the 429-storm sim) — keep existing options untouched); extend `apps/ops/test/fulfillment-e2e.test.ts`; `packages/core` (`centsToUsd`), supplier cleanups; Modify `docs/OWNER-CHECKLIST.md`, `apps/ops/.env.example`

Covers:
1. **Crash mid-create:** run `executePlaceOrder` with an adapter whose `confirmOrder` throws once → row parked `created`; rerun → resumes (no second placeOrder — mock store still has one order), reaches `confirmed`.
2. **Wallet-empty pause/resume:** `failPayInsufficientBalance: true` → `awaiting_funds` + paused flag; flip mock balance + run wallet monitor → auto-resume → `paid`.
3. **429 storm:** `failPlaceOrderTimes: 3` with pg-boss retries → eventual `confirmed`, exactly one mock order, ≥3 attempts recorded.
4. **Webhook outage:** no webhook at all; seed a paid Shopify order into the fake `ordersUpdatedSince` → reconcile places it.
5. **Cleanups (pre-work #8):** `centsToUsd` in core (+tests, symmetry with `usdToCents`); `mapCjDisputeStatus` table test; mock adapter unknown-id strictness (getters throw `MockNotFoundError` on unknown ids); `usdToCents(1.0049)` doc note.
6. **Docs:** OWNER-CHECKLIST — mark the Phase 3 state: new 🟡 item "CJ key → re-record order/list fixtures (pre-work #7) then `CJ_CONTRACT=1` full-pipeline sandbox run"; `.env.example` gains `FULFILLMENT_SUPPLIER=mock`.
- [ ] Steps: tests → green → cleanups w/ tests → docs → full workspace suite (`pnpm typecheck && pnpm test`) green → Commit `test(ops): failure drills; feat(core): centsToUsd; docs: Phase 3 checklist`

---

**Tier 2 (parked on CJ key — not in this plan's execution):** re-record `order/list` fixtures, `CJ_CONTRACT=1` sandbox pipeline run. Tracked on the owner checklist.
> **[2026-08-23]** Done — 9/9 live contract cases pass; see `docs/cj-api-notes.md`.
