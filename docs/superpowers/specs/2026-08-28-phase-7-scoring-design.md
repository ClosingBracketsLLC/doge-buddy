# Phase 7 — Scoring subsystem (design)

**Date:** 2026-08-28 · **Status:** approved by Robert (chat); hardened by the 5-lens adversarial
panel (32 findings folded in — see §Panel) · **Parent:** `2026-08-09-doge-buddy-design.md` §(d)
Scoring · **Substrate:** Phases 4–6 (proposals + admin + apply-executor dispatch, `product_scores`
table, `score_verdict` enum, `DeprecateProductPayloadSchema`, `workflow.deprecation.mode` — all in
place).

**Scope (Robert, 2026-08-28):** the scoring + deprecation subsystem only — nightly metrics →
`product_scores`, deterministic verdicts, an **advisory downgrade-only** Sonnet judge, a weekly
digest that creates `deprecate_product` proposals, and the deprecation apply worker (which fills
`run-apply.ts`'s last `unimplemented proposal type` gap). **NOT** stock-driven auto-pause (deferred),
no product-scores admin dashboard, no automatic re-listing or replacement-sourcing.

**Pre-launch reality (load-bearing):** the store has **zero orders** today (2 active seed products:
Pet Hair Clipper, live 2026-08-25; Dog Snuff Pad, live 2026-08-24). Metrics are legitimately all-zero
until real sales flow. **The weekly digest is therefore gated on the store having ≥1 real (non-test)
paid order, ever** (§4) — pre-revenue, the nightly job still writes `product_scores` for observability
but the digest stays silent and the judge never fires, so the owner is not asked every Monday to
deprecate his entire pre-launch catalog. The subsystem is built now so it is live and observing from
launch day; it only starts *proposing* once there is real sales data to propose against.

**Notify channel:** the parent §(d) says "weekly digest *email*", but the system has no owner-email
path — every owner notification in the codebase is Telegram (`notify.ts`, `escalate.ts`). This spec
uses Telegram throughout; "email" in the parent is superseded (a stale wording carried from Phase 0).

## Exit criteria (mock-tier; live-tier is a deferred dry-run)

1. `scoring.nightly` over a seeded catalog (orders / applied-refund proposals / tickets) writes one
   `product_scores` row per active product per UTC day with correct metric columns and the correct
   deterministic verdict; re-running the same UTC day is idempotent (upsert on
   `(product_id, score_date)`); one malformed/thin order row does not abort the batch.
2. With the store past its first real paid order, `scoring.weekly-digest` creates exactly one
   `deprecate_product` proposal per `deprecate`-verdict active product with no live proposal and no
   active cooldown, and sends exactly ONE batched Telegram digest listing them; the create+notify pair
   is **re-runnable** — a failed send leaves the proposals un-notified and the next run re-lists them
   (nothing is silently lost). Pre-revenue, and a zero-candidate week, send nothing and create nothing.
3. The Sonnet judge (stubbed in tests), gated on, can turn a deterministic `deprecate` candidate into
   `spared` (audit `scoring.judge_spared` + reason, no proposal) — but NEVER promotes a `keep`/`watch`
   into a proposal, and after `SCORING_MAX_CONSECUTIVE_SPARES` spares the product is proposed anyway.
4. Approving a `deprecate_product` proposal → product Shopify status `DRAFT`, unpublished from every
   publication (all alert-and-continue, none stranding), local `products.status = 'deprecated'` +
   `deprecated_at`, CJ webhook unsubscribed only when safe (§5); **never deleted**; double delivery /
   crash-mid-apply → single consistent effect (idempotent re-run of every step); a hard Shopify failure
   dead-letters + alerts and leaves Shopify and local state **consistent** (no offline-but-"active"
   half-apply).

**Live-tier (deferred until sales exist):** a manual dry-run of `scoring.nightly` against the Railway
DB (writes `product_scores` for the two seed products, no digest — pre-revenue — takes no action). The
`line_items` metric join and the CJ `unsubscribe` wire shape are FIXTURE-ASSUMPTIONs verified on,
respectively, the first real paid order and the first real deprecation.

## Non-goals

Stock-driven auto-pause — deferred by owner. No `product_scores` admin page (the `deprecate_product`
proposal detail carries the payload's evidence; the score row is observability-only). No auto
re-listing, no replacement-sourcing, no per-product revenue precision beyond catalog-price attribution.

## 1. Metrics — `scoring.nightly` cron (`0 3 * * *`)

pg-boss cron **registered unconditionally** (no LLM here — must run regardless of `ANTHROPIC_API_KEY`;
do NOT copy `sourcing.weekly`'s key gate), thin handler over `computeProductScores(db, now)`. Skips
(no-op) under `killswitch.global` or `workflow.scoring.enabled = false` (new setting, default true).
Pure SQL — no LLM, no proposals, no side effects beyond the `product_scores` upsert. `now` is passed in
(injectable clock); **all date math is UTC**: `score_date = now.toISOString().slice(0,10)` bound as a
parameter (never `now()::date`, which follows the DB session TZ and can duplicate-row a UTC day), and
window bounds computed in UTC. For each **active** product (`products.status = 'active'`):

- **`units_sold_7d` / `units_sold_28d`** — `Σ quantity` over `orders` where `is_test = false` AND
  `paid_at` within the UTC window, whose `raw_payload -> 'line_items'` elements map to this product's
  variants. **No `financial_status` predicate** — that column is never populated (`upsertOrderFromPaidPayload`
  and reconcile write everything BUT it); a paid-webhook order's very existence plus `paid_at` non-null
  is the paid signal. **Join (FIXTURE-ASSUMPTION until first real order):** `line_items[].variant_id`
  is Shopify's **numeric** id (`ShopifyOrderPaidPayload`, `order-upsert.ts:18`), `product_variants`
  stores the **gid**; match `(li->>'variant_id')` against the numeric tail of `shopify_variant_gid`.
  **Guarded expansion:** `jsonb_array_elements(CASE WHEN jsonb_typeof(raw_payload->'line_items')='array' THEN
  raw_payload->'line_items' ELSE '[]'::jsonb END) li ON true` — the guard must wrap the function ARGUMENT,
  not sit in an `ON` filter: PG17 evaluates the set-returning `jsonb_array_elements` BEFORE the `ON`
  clause, so `ON jsonb_typeof='array'` still throws on an object-shaped `line_items` (reproduced live)
  and aborts the nightly batch. The CASE form makes a NULL/thin/malformed payload skip instead.
- **`revenue_28d_cents`** — `Σ quantity × product_variants.price_cents` (catalog price; the line item
  carries no price). Coarse on multi-product orders and does not net out refunds — observability only,
  never a verdict input.
- **`refund_count_28d`** — count of DISTINCT `orders` containing this product that have an `applied`
  `refund` proposal whose order's `paid_at` is **also** in the window (numerator and the §2 denominator
  share the same clock and both count ORDERS, not units/proposals — see §2). Coarse on multi-product
  orders (an order-level refund attributes to every product in the order); documented, acceptable v1.
- **`ticket_count_28d`** — `support_tickets` (`created_at` in window) whose `order_id` links an order
  containing this product.
- **`days_live`** — `floor((now − products.created_at)/1 day)` UTC (products are created active by the
  apply worker; `created_at` is the go-live proxy).

Upsert one row per `(product_id, score_date)`; the deterministic verdict (§2) is written on the same
row. `product_scores.score` (numeric) is intentionally left NULL — the design is categorical, not a
numeric score; the column is a vestige of an abandoned approach. Bounded single pass (catalog is tens
of products).

## 2. Deterministic verdict → `keep` / `watch` / `deprecate`

Pure `deterministicVerdict(metrics, thresholds)` written into `product_scores.verdict`. **Data-quality
guard first:** if the product has ANY variant with a NULL `shopify_variant_gid` (nullable column; the
apply upsert can leave it null), its unit metrics are untrustworthy (they'd read zero) — force verdict
`watch` and emit a warning alert, so an un-backfilled gid can never masquerade as "didn't sell" and
false-deprecate a product that actually sold. Otherwise (rules in order, first match, `deprecate`
dominates; all settings-tunable):

- **`deprecate`** when `days_live ≥ scoring.deprecate_after_days` (21) AND
  `units_sold_28d ≤ scoring.min_units_28d` (1).
- **`deprecate`** when `orders_28d ≥ scoring.refund_rate_min_orders` (4) AND
  `refund_count_28d * 10000 / orders_28d > scoring.max_refund_rate_bps` (2500 = 25%). Refund rate is
  **refunded-orders over orders** (both order-counts, same window) — never proposals-over-units, which
  would exceed 100% and mis-fire (`orders_28d` = distinct in-window paid orders containing the product,
  computed alongside the unit metrics).
- **`watch`** on a near-miss band of either rule (`days_live ≥ deprecate_after_days − 7` with
  `units_28d ≤ min_units_28d + 2`; or refund rate in `[max_refund_rate_bps/2, max_refund_rate_bps]`
  with enough orders) — surfaced for the judge context, never itself proposed.
- **`keep`** otherwise.

Table-driven; exhaustive boundary tests incl. the null-gid guard.

## 3. Sonnet judge — advisory, downgrade-only

Runs in the **weekly** job (§4), only when that job is past the pre-revenue gate (so it never
adjudicates all-zero pre-launch rows). One `claude-sonnet-5` structured-output call over that week's
`deprecate`-verdict candidate batch, gated on `scoring.judge_enabled` (default true) AND
`ANTHROPIC_API_KEY` present (absent → deterministic-only, log the degraded mode). Input per candidate:
title, category, the metric row, days-live — **treated as untrusted data** (titles originate from the
sourcing agent / CJ and are attacker-adjacent). Output (draft-07 structured), keyed by the **internal
`products.id` UUID** (the exact value that goes to `submitProposal`'s `payload.productId`, presented to
the model verbatim): `{ productId, spare: boolean, reason: string }`.

**Downgrade-only invariant (the safety floor, mirroring the triage tripwire):** the output is consumed
ONLY to REMOVE candidates (`spare: true` → spared this week, audit `scoring.judge_spared` + reason, no
proposal). It can never add a candidate the deterministic rules didn't flag, never turn `keep`/`watch`
into a proposal, never auto-approve. An unknown/duplicate/mismatched-id spare is ignored (fails safe →
more deprecations). Prompt injection via a title can only push the judge toward MORE sparing (fewer
deprecations) — contained by the invariant + the spare bound below.

**Spare bound (ratchet — the judge cannot walk the floor back forever):** a genuinely-dead product's
metrics don't change, so an optimistic judge would spare it every week indefinitely, defeating the
subsystem. Track consecutive `scoring.judge_spared` audit rows per product since its last non-spare
state; after `SCORING_MAX_CONSECUTIVE_SPARES` (default 3) the product is proposed **regardless** of the
judge, with reasoning noting "judge spared N weeks running — deciding manually".

**Failure direction is mode-aware:** a hung/failed/invalid judge call → warning alert, then in
**manual** mode fail-open (all deterministic candidates proceed to *pending* proposals; the owner
reviews) — but in **auto** mode a broken judge must NOT auto-deprecate un-vetted products, so the batch
is **deferred to next week** (no proposals created this run) rather than auto-applied. Cost: one call/
week over ≤ catalog size — pennies; recorded to `agent_runs` (workflow `scoring`), single structured
call, watchdog `SCORING_WATCHDOG_MS`, budget `SCORING_JUDGE_MAX_BUDGET_USD`. **This downgrade-only
shape is a deliberate tightening of the parent's open-direction "optional judgment call."**

## 4. Weekly digest → `deprecate_product` proposals (`scoring.weekly-digest` cron, `0 14 * * 1`)

Monday 14:00 UTC (after `sourcing.weekly` 13:00). **Registered unconditionally** (degrades to
deterministic-only without the key — never gate the whole pipeline on `ANTHROPIC_API_KEY`). Thin
handler over `runWeeklyDeprecationDigest`; wraps its body in `pg_advisory_xact_lock('scoring-digest')`
(the `lifecycle.ts` pattern) so a manual re-run / deploy overlap can't double-create — the dedup below
is otherwise a check-then-act. Skips under `killswitch.global` / `workflow.scoring.enabled = false`.

**Pre-revenue gate (first line):** if the store has **zero** non-test paid orders ever
(`SELECT 1 FROM orders WHERE is_test=false AND paid_at IS NOT NULL LIMIT 1`), return immediately —
no scoring proposals until there is real sales data. This is what keeps the pre-launch catalog from
being proposed for deprecation every Monday.

Steps:
1. **Freshness guard:** require each product's latest `product_scores` row to be for *today's*
   `score_date` (the nightly ran); if the freshest score is stale (nightly skipped/crashed), skip the
   digest with a warning alert rather than proposing off frozen data.
2. **Candidates** = active products whose today's score `verdict = 'deprecate'`, MINUS: products with a
   live (`pending`/`approved`/`applying`/`applied`) `deprecate_product` proposal (dedup); products in
   **cooldown** — a `rejected` deprecate proposal within `scoring.reject_cooldown_days` (default 30:
   the owner said "not yet", don't nag weekly) OR a `failed`/dead-lettered deprecate proposal within
   `scoring.fail_cooldown_days` (default 7: don't re-queue a proposal the apply can't complete — after
   `scoring.max_fail_attempts` (3) total failed attempts for a product, emit ONE distinct
   `scoring.deprecation_stuck` critical alert and stop re-proposing it instead of storming weekly).
3. **Judge** (§3) removes spared candidates (respecting the spare bound).
4. **Create** proposals for survivors: `submitProposal(deps, { type: 'deprecate_product', summary:
   'Deprecate: ' + title, sourceWorkflow: 'scoring', productId, payload: { type: 'deprecate_product',
   productId, evidence: { unitsSold28d, refundCount28d, ticketCount28d, daysLive, reasoning } } },
   { suppressNotify: true })`. **New `submitProposal` opts `{ suppressNotify?: boolean }`** (default
   false; verified additive — doesn't break the ~5 callers or the `submit` injection seam) — skips the
   per-proposal Telegram push AND the token mint (no orphaned hash); validation, audit, and
   manual/auto mode unchanged. `evidence` matches `DeprecateProductPayloadSchema.evidence` exactly
   (unitsSold28d/refundCount28d/ticketCount28d/daysLive/reasoning — no units_7d, no revenue; §6 renders
   only these).
5. **Notify — re-runnable, escalate.ts-style (this is the recovery fix):** the digest does NOT list
   "this run's survivors"; it lists ALL `pending` `deprecate_product` proposals with no
   `scoring.deprecation_notified` audit row (so a proposal whose prior digest send failed is re-listed
   next run). Build ONE Telegram message: title `N products flagged to deprecate`; one line per product
   (title · days-live · units-28d · refund rate · reason **truncated to `REASON_MAX_CHARS`** · a
   session-authed `/admin/proposals/<id>` link — deprecate approvals are a deliberate log-in step, not
   one-tap tokenized links, since suppressNotify mints no token). Overall body bounded head+tail like
   the escalation digest, listed-cap + "…and M more" overflow; per-line reason pre-truncated so a
   verbose LLM reason can't push later items' links off the cap. Send, and ONLY on `notify()===true`
   write a `scoring.deprecation_notified` audit row per listed proposal. Zero un-notified pendings → no
   message. If the judge spared anyone this week, append a short "judge spared K products (reasons)"
   footer so a full-spare week is not silent. Auto-mode → proposals auto-apply; the digest is an FYI
   "N auto-deprecated / K spared this week".

## 5. Deprecation apply worker — `applyDeprecateProduct`

Fills the `deprecate_product` slot in `run-apply.ts`'s executor dispatch (the last `unimplemented`
type). Same resume-safe shell contract as the other executors — called with the proposal already
`applying`; the shell's own `applying`/`applied` guard is the idempotency boundary (NOT
`products.status`, which is uncoupled from this proposal and can be set by an admin). Every step below
is a Shopify/DB no-op when already done, so re-entry simply re-runs them; dead-letter → `failed` +
critical alert (existing `deadLetterApplyProposal`; deprecate is not a support type — no
ticket-escalation branch). **No `products.status='deprecated'` fast-path** — re-runs execute the
idempotent steps rather than trusting the shared flag.

Steps (each idempotent; on any re-entry all re-run):
1. Load `products` by `payload.productId`. Missing → throw (retry → dead-letter).
2. **Shopify status → DRAFT** (`productSet({ id: shopifyProductGid, status: 'DRAFT' })`) — already
   removes the product from every channel/storefront; idempotent.
3. **Unpublish from every publication** — new op `publishableUnpublish(productGid, publicationId)` over
   `listPublications()`, **every call alert-and-continue (none required/throwing)**. DRAFT already hid
   the product, so a failed unpublish adds no exposure and must NOT dead-letter the job mid-way and
   strand step 4 (the copy-paste of publish's "Online Store throws" rule is backwards for unpublish).
4. **Local state** — `UPDATE products SET status='deprecated', deprecated_at = COALESCE(deprecated_at,
   now()) WHERE id = $productId` (unconditional on id → idempotent; deprecation is the intended
   terminal). Re-read; **require `status='deprecated'` before proceeding** — if not, throw (retry/
   dead-letter) rather than marking the proposal applied over a no-op.
5. **CJ unsubscribe — only when safe.** CJ product-webhook scope is unverified (`cj-api-notes.md`
   §Still unverified: possibly account-level via `/webhook/set`, not per-product). A blind unsubscribe
   could tear down the webhook every *other* active product depends on. So: for each of the product's
   distinct `supplierProductId`s, unsubscribe ONLY if no OTHER active product shares that
   `supplierProductId`; treat CJ "not subscribed / not found" as success (no alert — subscribe was
   best-effort at apply, may never have registered). Until the wire shape is verified this stays a
   best-effort, last-user-only call (alert only on a genuinely unexpected CJ error; never blocks the
   deprecation that already landed). `unsubscribeProductWebhook` on the adapter + CJ client + Mock (Mock
   no-ops for ids it never recorded).
6. Transition `applying → applied` + audit `proposal.applied` (`{ productGid, action: 'deprecated' }`).

**Never deletes** — Shopify product, URL, SEO stay; only status + publication change.

## 6. New surfaces / config

- **Shopify-admin:** `publishableUnpublish(client, productGid, publicationId)` (GraphQL
  `publishableUnpublish`, mirror of `publishablePublish`; fixture-tested; FIXTURE-ASSUMPTION until a
  real run).
- **SupplierAdapter:** `unsubscribeProductWebhook(supplierProductId): Promise<void>` (interface + CJ
  client + Mock; CJ "not found" → success; Mock no-op for unknown ids).
- **`submitProposal`** gains 3rd param `opts?: { suppressNotify?: boolean }`.
- **Settings:** `workflow.scoring.enabled` (bool, default true — scoring-crons kill lever);
  `scoring.judge_enabled` (bool, default true); numbers: `scoring.deprecate_after_days` (21),
  `scoring.min_units_28d` (1), `scoring.max_refund_rate_bps` (2500), `scoring.refund_rate_min_orders`
  (4), `scoring.reject_cooldown_days` (30), `scoring.fail_cooldown_days` (7), `scoring.max_fail_attempts`
  (3). `workflow.deprecation.mode` (manual) already exists. (New boolean keys join the settings type's
  `BooleanSettingKey` union; numbers are the default numeric branch.)
- **Admin:** `render-proposal.ts` gets a `deprecate_product` early-return in `renderDecisionForms`
  (approve/reject only, mirroring the refund branch — the generic branch it hits today wrongly exposes
  an editable raw-JSON textarea). The detail renders product title/link + the evidence block
  (units_28d, refund count + **derived** rate, ticket count, days-live) + reasoning. `/admin` health
  gains "scoring: last run `<score_date/ts>`, N products scored" (surfaces a frozen nightly).
- **Constants:** `SCORING_MODEL='claude-sonnet-5'`, `SCORING_JUDGE_MAX_BUDGET_USD=0.25`,
  `SCORING_WATCHDOG_MS=120_000`, `SCORING_MAX_CONSECUTIVE_SPARES=3`, `REASON_MAX_CHARS=200`.

## 7. Testing

- **TDD throughout; both house review layers (per-task adversarial gates + final whole-branch
  multi-lens Workflow) — non-optional** (the final layer caught 9 cross-cutting bugs on 6B).
- **Unit:** metric SQL (numeric-`variant_id`↔gid join incl. NULL-gid product forced to `watch`;
  no-`financial_status` paid counting; window/UTC boundaries + same-day two-timezone idempotency;
  test-order exclusion; unmapped line items ignored; a thin/NULL and a malformed-`line_items` order in
  the batch → run still completes; refund rate as refunded-orders/orders same-clock);
  `deterministicVerdict` boundary table (each rule edge, refund-rate min-orders guard, near-miss watch,
  null-gid guard); judge output schema draft-7 + downgrade-only consumption (spare removes; `spare:false`
  never adds; unknown/mismatched id ignored; failure spares nobody in manual, defers in auto; spare
  bound forces a proposal after K); digest (pre-revenue gate silences; freshness guard skips on stale
  score; dedup vs live proposals; reject/fail cooldown; re-runnable notify via the `deprecation_notified`
  audit marker — a failed send re-lists next run; per-line reason truncation; body bounding; spared
  footer; single-caller advisory lock).
- **Apply-executor:** DRAFT + unpublish-all(alert-and-continue) + local deprecated + safe CJ unsubscribe
  on approve; crash/re-entry at each step boundary → single consistent effect (re-run idempotent, NOT a
  products.status fast-path); Online-Store unpublish failure does NOT strand (local flag still commits,
  Shopify DRAFT + local deprecated consistent); guarded local update 0-rows → throw not silent-applied;
  CJ unsubscribe skipped when another active product shares the supplierProductId; never-deletes
  assertion.
- **Contract:** `publishableUnpublish` fixture; CJ `unsubscribeProductWebhook` fixture (incl. not-found→ok).
- **E2E (local DB, mock Shopify + mock supplier + stubbed judge):** seed ≥1 real paid order + a catalog
  where one product crosses deprecate and one is near-miss `watch` → nightly writes correct scores →
  weekly (past the pre-revenue gate) creates one proposal + one digest → simulate a failed send, assert
  re-run re-lists it, then succeed and assert the `deprecation_notified` marker → approve → product
  deprecated end-to-end → a second run of both crons is a no-op (idempotent scores, deduped proposal).
- **Live dry-run (deferred):** `scoring.nightly` once against Railway (writes scores for the two seed
  products; digest silent pre-revenue; no action).

## Panel (adversarial spec review, 2026-08-28)

5 lenses (metrics-SQL, judge-safety, apply-idempotency, cron/ops-dedup, scope/consistency), 32 findings,
all dispositioned above. Design-changing ones: the never-written `financial_status` column (every real
sale would read zero and false-deprecate — dropped the predicate); DRAFT-first + required Online-Store
unpublish stranding a product offline-but-locally-"active" (all unpublish now alert-and-continue); the
silent-digest-failure (proposals created then a failed send loses them forever — now a re-runnable,
`deprecation_notified`-stamped notify); the pre-launch whole-catalog-every-Monday trap (pre-revenue
gate); the judge spare-with-no-bound (a ratchet after K spares); mode-aware judge-failure (fail-open
manual / defer auto); the refund-rate unit/population/attribution mismatch (refunded-orders/orders,
same clock); NULL-gid false-deprecate (forced `watch`); unguarded `jsonb_array_elements` aborting the
batch; UTC `score_date`; the freshness guard; failed-proposal re-propose storm (cooldowns + a stuck
alert); CJ unsubscribe possibly account-level (last-active-user-only + not-found-ok); no-`products.status`
recovery fast-path; unconditional cron registration; the evidence-schema render mismatch; the
`renderDecisionForms` editable-textarea change; and the parent's stale "email" wording.
