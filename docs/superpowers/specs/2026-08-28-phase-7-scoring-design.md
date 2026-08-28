# Phase 7 — Scoring subsystem (design)

**Date:** 2026-08-28 · **Status:** approved by Robert (chat); panel pending · **Parent:**
`2026-08-09-doge-buddy-design.md` §(d) Scoring · **Substrate:** Phases 4–6 (proposals + admin +
apply-executor dispatch, `product_scores` table, `score_verdict` enum, `DeprecateProductPayloadSchema`,
`workflow.deprecation.mode` — all already in place).

**Scope (Robert, 2026-08-28):** the scoring + deprecation subsystem only — nightly metrics →
`product_scores`, deterministic verdicts, an **advisory downgrade-only** Sonnet judge, a weekly
digest that creates `deprecate_product` proposals, and the deprecation apply worker (which fills
`run-apply.ts`'s last `unimplemented proposal type` gap). **NOT** stock-driven auto-pause (deferred),
no product-scores admin dashboard, no automatic re-listing or replacement-sourcing.

**Pre-launch reality:** the store has **zero orders** today (2 active seed products: the Pet Hair
Clipper, live 2026-08-25, and the Dog Snuff Pad, live 2026-08-24). So metrics are legitimately
all-zero until real sales flow, and the deterministic rule (`days_live ≥ 21 ∧ units_28d ≤ 1`) will
correctly surface both seed products as deprecate candidates ~3 weeks after they went live —
in **manual** mode, so nothing acts without an owner tap. The subsystem is built now so it is live
and observing from launch day.

## Exit criteria (mock-tier; live-tier is a dry-run, see below)

1. `scoring.nightly` over a seeded catalog (orders / applied-refund proposals / tickets) writes one
   `product_scores` row per active product per UTC day with correct metric columns and the correct
   deterministic verdict; re-running the same day is idempotent (upsert on `(product_id, score_date)`).
2. `scoring.weekly-digest` creates exactly one `deprecate_product` proposal per `deprecate`-verdict
   active product that has **no live** (`pending`/`approved`/`applying`/`applied`) deprecate proposal,
   and sends exactly ONE batched Telegram digest listing them with per-item approve/reject links;
   a week with zero candidates sends no message and creates nothing.
3. The Sonnet judge (stubbed in tests), gated on, can turn a deterministic `deprecate` candidate into
   `spared` — no proposal created, an audit row (`scoring.judge_spared`) written with its reasoning —
   but can NEVER promote a `keep`/`watch` product into a proposal (deterministic rules are the floor).
4. Approving a `deprecate_product` proposal → product Shopify status `DRAFT`, unpublished from every
   publication, local `products.status = 'deprecated'` + `deprecated_at`, CJ webhook unsubscribed;
   **never deleted**; double job delivery → single effect (idempotent/resume-safe); a Shopify/CJ
   failure dead-letters + alerts, never half-applies silently.

**Live-tier (deferred until sales exist):** a manual dry-run of `scoring.nightly` against the Railway
DB (produces the all-zero / two-seed-deprecate outcome, writes `product_scores`, takes NO action —
manual mode). Full live verification of the metric joins waits for the first real paid order (the
`line_items` join is a FIXTURE-ASSUMPTION until then, §1).

## Non-goals

Stock-driven auto-pause (US stock 0 → inventory 0; 0 for N days → replacement flag) — deferred by
owner. No `product_scores` admin page (the `deprecate_product` proposal detail carries the evidence —
YAGNI). No auto re-listing of a deprecated product, no replacement-sourcing trigger, no per-product
revenue precision beyond catalog-price attribution (§1).

## 1. Metrics — `scoring.nightly` cron (`0 3 * * *`)

pg-boss cron, thin handler over a `computeProductScores(db, now)` module. Skips (no-op) under
`killswitch.global` or `workflow.scoring.enabled = false` (new setting, default true). Pure SQL — no
LLM, no proposals, no side effects beyond the `product_scores` upsert. For each **active** product
(`products.status = 'active'`), compute over the trailing windows ending at `now`:

- **`units_sold_7d` / `units_sold_28d`** — `Σ quantity` over `orders` (`is_test = false`, paid:
  `financial_status ILIKE 'paid'`, `paid_at` within the window) whose `raw_payload -> 'line_items'`
  elements have a `variant_id` that matches one of this product's variants. **Join reconciliation
  (FIXTURE-ASSUMPTION until the first real order):** `line_items[].variant_id` is Shopify's **numeric**
  variant id (per `ShopifyOrderPaidPayload`, `order-upsert.ts:18`), while `product_variants` stores
  the **gid** (`gid://shopify/ProductVariant/<n>`); match `(li->>'variant_id')` against the numeric
  tail of `product_variants.shopify_variant_gid`. Implemented via `jsonb_array_elements` + a
  `product_variants → products` join; a unit test pins the extraction against a fixture payload of the
  real webhook shape, and the plan carries a first-real-order verification step.
- **`revenue_28d_cents`** — `Σ quantity × product_variants.price_cents` (our catalog price; the webhook
  line item carries no price, so per-product revenue attributes at listed price — accepted, documented).
- **`refund_count_28d`** — count of `proposals` (`type='refund'`, `status='applied'`, `applied_at` in
  window) whose linked order contains this product (same line-item join via `proposals.order_id`).
- **`ticket_count_28d`** — count of `support_tickets` (`created_at` in window) whose `order_id` links an
  order containing this product.
- **`days_live`** — `floor((now − products.created_at) / 1 day)` (products are created active by the
  apply worker; `created_at` is the go-live proxy).

Upsert one row per `(product_id, score_date = now::date)` — idempotent re-run overwrites the day's row.
The deterministic verdict (§2) is written on the same row. All-active-products in one pass; bounded
(catalog is tens of products, not thousands).

## 2. Deterministic verdict rules → `keep` / `watch` / `deprecate`

Pure function `deterministicVerdict(metrics, thresholds)` over a score row, written into
`product_scores.verdict`. Rules (spec §(d) examples, all settings-tunable, evaluated in order — first
match wins, `deprecate` dominates):

- **`deprecate`** when `days_live ≥ scoring.deprecate_after_days` (default 21) **AND**
  `units_sold_28d ≤ scoring.min_units_28d` (default 1) — a product that has been live long enough to
  get a fair shot and essentially didn't sell.
- **`deprecate`** when `units_sold_28d ≥ scoring.refund_rate_min_units` (default 4) **AND**
  `refund_count_28d * 10000 / units_sold_28d > scoring.max_refund_rate_bps` (default 2500 = 25%) — a
  product selling enough to judge, refunding too often. (The min-units guard avoids a 1-sale-1-refund
  product reading as "100% refund rate".)
- **`watch`** when within a near-miss band of either rule (e.g. `days_live ≥ deprecate_after_days − 7`
  with `units_sold_28d ≤ min_units_28d + 2`, or refund rate in `[max_refund_rate_bps/2,
  max_refund_rate_bps]` with enough units) — surfaced for the judge, not proposed.
- **`keep`** otherwise.

Table-driven; exhaustive unit tests over the boundary rows.

## 3. Sonnet judge — advisory, downgrade-only (`scoring.judge_enabled`, default true)

Runs in the **weekly** job (§4), not nightly — one `claude-sonnet-5` structured-output call over the
batch of that week's `deprecate`-verdict candidates (gated on `scoring.judge_enabled` AND
`ANTHROPIC_API_KEY` present; absent → deterministic-only, no judge). Input per candidate: title,
category, the metric row, days-live. Output (draft-07 structured): per candidate `{ productId,
spare: boolean, reason: string }`.

**Downgrade-only invariant (the safety floor, mirroring the triage tripwire):** the judge's output is
consumed ONLY to REMOVE candidates from the deprecate set (`spare: true` → the product is spared this
week, audit `scoring.judge_spared` with the reason, NO proposal). It can never add a candidate the
deterministic rules didn't flag, never change a `keep`/`watch` into a proposal, and never
auto-approve — a spared product simply waits for next week's re-score. A hung/failed/invalid judge
call → treat as "spared nobody" (all deterministic candidates proceed) + a warning alert; the judge
can only ever make the system deprecate FEWER products, never more. Cost: one call/week over ≤ catalog
size — pennies. Budget guard: `maxTurns 1`-shaped single structured call, watchdog, cost recorded to
`agent_runs` (workflow `scoring`).

## 4. Weekly digest → `deprecate_product` proposals (`scoring.weekly-digest` cron, `0 14 * * 1`)

Monday 14:00 UTC (after `sourcing.weekly` at 13:00). Thin handler over `runWeeklyDeprecationDigest`.
Skips under `killswitch.global` / `workflow.scoring.enabled = false`. Steps:

1. Candidates = each active product whose **latest** `product_scores` row has `verdict = 'deprecate'`
   AND which has **no live** (`pending`/`approved`/`applying`/`applied`) `deprecate_product` proposal
   (dedup — a product already proposed/decided isn't re-proposed; a `rejected`/`expired` prior lets it
   resurface, which is intended: the owner said "not yet", the product still isn't selling).
2. Optional judge (§3) removes spared candidates.
3. For each survivor: `submitProposal({ type: 'deprecate_product', productId, evidence: { unitsSold28d,
   refundCount28d, ticketCount28d, daysLive, reasoning: <judge reason or the deterministic rule that
   fired> } }, { suppressNotify: true })`. **New `submitProposal` option `suppressNotify?: boolean`**
   (default false) — skips the per-proposal Telegram push (validation, audit, token, manual/auto mode
   all unchanged); the digest owns notification. `workflow.deprecation.mode` (default `manual`) still
   governs pending-vs-auto exactly as today.
4. Send ONE batched Telegram digest: title `N products flagged to deprecate`, body = one line per
   product (title · days-live · units-28d · refund rate · judge/rule reason · `/admin/proposals/<id>`
   approve+reject links), bounded head+tail like the escalation digest (`escalate.ts`
   `BODY_MAX_CHARS`), max-listed cap with an "…and M more" overflow line. Zero survivors → no message,
   no proposals (quiet week). Auto-mode (if the owner ever flips it) → proposals auto-applied, the
   digest becomes an FYI "N products auto-deprecated this week".

## 5. Deprecation apply worker — `applyDeprecateProduct`

Fills the `deprecate_product` slot in `run-apply.ts`'s executor dispatch (the last `unimplemented`
type). Same resume-safe contract as the other executors — called with the row already `applying`;
every step idempotent; re-entry recovers rather than repeats; dead-letter → `failed` + critical alert
(existing `deadLetterApplyProposal`; deprecate is not a support type, so no ticket-escalation branch).

Steps (each idempotent):
1. Load the `products` row by `payload.productId`. Missing → hard fail (job retries then dead-letters).
   Already `deprecated` → recover straight to `applied` (audit `proposal.apply_skipped`, no Shopify
   calls — the resume/double-delivery path).
2. **Shopify status → DRAFT:** `productSet({ id: shopifyProductGid, status: 'DRAFT' })` (idempotent —
   setting DRAFT on a DRAFT product is a no-op).
3. **Unpublish from every publication:** new op **`publishableUnpublish(productGid, publicationId)`**
   (mirror of the existing `publishablePublish`) over `listPublications()`; each call best-effort —
   Online Store failure throws (required, like publish); others alert-and-continue. Unpublishing an
   already-unpublished product is a Shopify no-op.
4. **Local state:** `products.status = 'deprecated'`, `deprecated_at = now()` (guarded update).
5. **CJ unsubscribe:** new adapter method **`unsubscribeProductWebhook(supplierProductId)`** (CJ +
   Mock) over the product's distinct supplier product ids — best-effort (alert on failure, never
   block the deprecation that already landed), symmetric to the apply-time `subscribeProductWebhook`.
6. Transition `applying → applied` + audit `proposal.applied` (`{ productGid, action: 'deprecated' }`).

**Never deletes** — the Shopify product, its URL, and SEO stay; only status + publication change, so a
future owner can re-activate by hand.

## 6. New surfaces / config

- **Shopify-admin:** `publishableUnpublish(client, productGid, publicationId)` (GraphQL
  `publishableUnpublish`, mirror of `publishablePublish`; fixture-tested; FIXTURE-ASSUMPTION until a
  real deprecation run).
- **SupplierAdapter:** `unsubscribeProductWebhook(supplierProductId): Promise<void>` on the interface,
  CJ client (CJ `webhook/product/unsubscribe` — verify wire shape in `cj-api-notes.md`; FIXTURE-
  ASSUMPTION), and MockSupplier.
- **`submitProposal`** gains `opts?: { suppressNotify?: boolean }`.
- **Settings:** `workflow.scoring.enabled` (bool, default true — the scoring-crons kill lever);
  `scoring.judge_enabled` (bool, default true); `scoring.deprecate_after_days` (21),
  `scoring.min_units_28d` (1), `scoring.max_refund_rate_bps` (2500), `scoring.refund_rate_min_units`
  (4). `workflow.deprecation.mode` (manual) already exists.
- **Admin:** `/admin/proposals/:id` renders a `deprecate_product` detail — product title/link, the
  evidence block (units 7d/28d, revenue, refund count + rate, ticket count, days-live) and the
  judge/rule reasoning, with the standard approve/reject forms (no edit form — deprecate has no
  editable payload). `/admin` health gains a "scoring: last run <ts>, N products scored" row.
- **Constants:** `SCORING_MODEL='claude-sonnet-5'`, `SCORING_JUDGE_MAX_BUDGET_USD=0.25`,
  `SCORING_WATCHDOG_MS=120_000`.

## 7. Testing

- **TDD throughout; both house review layers (per-task adversarial gates + final whole-branch
  multi-lens Workflow) — non-optional** (the final layer caught 9 cross-cutting bugs on 6B).
- **Unit:** metric SQL against a seeded catalog (multi-product orders, the numeric-`variant_id`↔gid
  join, window boundaries, test-order exclusion, unmapped line items ignored); `deterministicVerdict`
  boundary table (each rule's on/off edges, the refund-rate min-units guard, near-miss `watch` band);
  judge output schema draft-7 (no `$ref`), downgrade-only consumption (a `spare:false` never adds, an
  unknown productId ignored, a judge failure spares nobody); digest candidate selection (dedup vs live
  proposals, resurface-after-reject, zero-candidate quiet path); digest body bounding.
- **Apply-executor tests:** DRAFT + unpublish-all + local deprecated + CJ unsubscribe on approve;
  already-deprecated recovery (no Shopify calls); double delivery → single effect; Online-Store
  unpublish failure → dead-letter + alert, product NOT locally marked deprecated (no half-apply);
  never-deletes assertion.
- **Contract:** `publishableUnpublish` fixture; CJ `unsubscribeProductWebhook` fixture.
- **E2E (local DB, mock Shopify + mock supplier + stubbed judge):** seed a catalog where one product
  crosses the deprecate threshold and one is a near-miss `watch` → nightly writes correct scores →
  weekly creates exactly one proposal + one digest (judge spares nobody) → approve → product
  deprecated end-to-end; a second run of both crons is a no-op (idempotent scores, deduped proposal).
- **Live dry-run (deferred):** run `scoring.nightly` once against the Railway DB, confirm it writes
  `product_scores` for the two seed products and takes no action.

## Panel

(Adversarial spec review pending — lenses: metrics-correctness/SQL, judge-safety & downgrade-only
invariant, apply-worker idempotency/never-delete, cron/ops & dedup, scope/consistency vs the parent
spec. Findings dispositioned into the sections above; this line replaced with the summary.)
