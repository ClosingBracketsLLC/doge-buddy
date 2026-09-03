# Launch plan (written 2026-09-03, Robert's launch call)

Robert's directives (2026-09-03 chat): (1) every proposal carries decision numbers — economics
AND approximate demand signals — before he approves; (2) the catalog will be ENTIRELY re-sourced
through the new pipeline (market gate + fixed scrubber + freight-aware pricing) — all 22
pre-gate products get deprecated once replacements land; (3) target **100 products**; (4) then
launch. This doc is the single ordered list of what remains; the OWNER-CHECKLIST footer points
here. Robert-owned items marked **[R]**, Claude builds marked **[C]**.

## L1 — Sourcing decision-support build [C] — ✅ BUILT 2026-09-03

Spec: `docs/superpowers/specs/2026-09-03-sourcing-decision-support-design.md` · plan:
`docs/superpowers/plans/2026-09-03-sourcing-decision-support.md` · branch
`sourcing-decision-support` (14 tasks, TDD, all task reviews clean; ops 1590/1593 — the 3
failures are the known-benign dev-DB-state trio in the checklist's hygiene item; typecheck
clean). Live check = the **L1 decision-support LIVE CHECK** item in OWNER-CHECKLIST (two
FIXTURE-ASSUMPTIONS to verify: Google RELATED_QUERIES + Amazon organic_results shapes).
Spec-time verification recorded there: CJ's product-DETAIL wire carries no sold/listing counts
(fixtures authoritative), so the demand block uses harvest's `listedNum`, agent-fetched review
page-1 samples (code-recorded), market offer counts, Trends score+momentum, and the Amazon
probe — all labeled ESTIMATES. `SERPAPI_MAX_REQUESTS_PER_RUN` is now an env knob on the ops
service (default 25) — set it from the quota check below.

What was folded in (all pre-approved in principle):
- **Google Trends rising-related-queries** keyword expansion (upgrade #2, approved 2026-09-02)
  + the **Amazon Pet-Supplies demand cross-check** via SerpApi's Amazon engine (approved same
  day; category-popularity sort, not true Movers & Shakers — see
  `docs/supplier-trend-research-2026-09-02.md`).
- **Economics block on every new_listing proposal** (per variant, from numbers Stage 6 already
  computes): our price · live CJ cost · cheapest in-window US freight · landed cost · $ profit
  and margin % · market median (n) and our ×median vs the 1.3 ceiling · live US stock units.
  Stage 6 stashes them into the proposal; `/admin` proposal page renders the table; Telegram
  summary gains the one-line version.
- **Demand-signals block** (labeled ESTIMATES, never "sales"): CJ sold/listing counts if the API
  exposes them (verify `sellQuantity`/`listedNum` on product detail at spec time — cj-api-notes
  rules), market offer count, CJ review count, Trends momentum for the harvest keyword.
- **Pricing guidance prompt tweak** (parked 2026-09-03): price up to the 1.3× ceiling when
  freight demands it; median-anchoring second.

## L2 — The 100-product wave [R runs + approvals, C support]

- **[R] SerpApi quota check FIRST** — the binding constraint. ~20–30 runs × ≤25 requests ≈
  400–600 requests; if the plan is 250/month, bump the tier for the wave month or halve
  `SERPAPI_MAX_REQUESTS_PER_RUN` and accept fewer market lookups per run.
- **[R] `SERPAPI_KEY` confirmed on Railway** (already done if the market clause showed in run
  summaries — it did on 2026-09-03).
- Cadence math: CJ daily points budget 50k, ~25k allowance/run ⇒ ≤2 runs/day; realistic yield
  3–6 listed winners per forced run with `--max-winners 8` ⇒ **100 products ≈ 1.5–2 weeks of
  daily runs**. Keep `workflow.sourcing.mode = manual` so every listing passes Robert with the
  L1 numbers (that's the point of L1 landing first); Telegram approve keeps 100 approvals quick.
- Command per run (from `railway ssh`):
  `pnpm --filter @doge-buddy/ops run-sourcing --max-winners 8 --force --keywords "<rotate: see harvest defaults + Trends output once L1 lands>"`
- **[C] catalog-P0-style follow-through per batch**: collections fill by tag automatically;
  spot-probe listings read-only (variant images, metafields, gallery) as batches land.

## L3 — Catalog reset [R decision CONFIRMED 2026-09-03 + R execution, runbook ready]

**Robert's ruling (2026-09-03 chat): deprecate ALL pre-gate products, no repricing** — the
audit's reprice option is dead. Timing unchanged: run this AFTER enough L2 replacements have
landed (suggested ≥ 30–40 live; keep the store non-empty). Deprecation ≠ deletion: the existing
worker takes each product DRAFT → unpublished → local `deprecated` → safe CJ unsubscribe;
reversible, order history intact. Reference list: `docs/market-price-audit-2026-09-03.md`.

**Runbook (from `railway ssh` into the ops service, then `/app`):**

1. Review the list — expect the 22 pre-gate products; the foldable water bottle (born through
   the live gate 2026-09-03) and every wave listing must NOT appear (the `created_at` cutoff +
   handle guard exclude them):

   ```
   psql "$DATABASE_URL" -c "SELECT id, title, status, created_at::date FROM products WHERE status <> 'deprecated' AND created_at < '2026-09-03T00:00:00Z' AND (handle IS NULL OR handle NOT LIKE 'foldable-portable-dog-water-bottle%') ORDER BY created_at;"
   ```

2. Generate the ready-to-paste command lines (same WHERE clause), then paste the output —
   each line submits ONE `deprecate_product` proposal through `workflow.deprecation.mode`:

   ```
   psql "$DATABASE_URL" -At -c "SELECT 'pnpm --filter @doge-buddy/ops deprecate-product --product ' || id || ' --reason catalog-reset' FROM products WHERE status <> 'deprecated' AND created_at < '2026-09-03T00:00:00Z' AND (handle IS NULL OR handle NOT LIKE 'foldable-portable-dog-water-bottle%') ORDER BY created_at;"
   ```

3. In manual mode (recommended, stays on through launch) that's one Telegram Approve tap per
   product — ~22 taps, idempotent to re-run (an existing live deprecation proposal is skipped,
   never duplicated). If you'd rather one-shot the batch on auto, say so FIRST: the launch plan
   gates any deprecation auto-flip behind the C19 digest FYI build (L4 item 5), which Claude
   will build on request.

## L4 — Launch gates (all pre-existing OWNER-CHECKLIST items, consolidated) [R unless noted]

1. **CJ wallet top-up ~$150** — wallet is at $0 and alerting critical; blocks any real order.
2. **Policies → Shopify Settings** — paste `POLICY_COPY` (legally load-bearing, see checklist).
3. **Business checks** — Shopify Payments, US tax registrations, LLC insurance (recommended).
4. **Canary self-purchase** (C18) — one real order end-to-end: pay CJ, tracking, and close
   Tier-2 #4 (`openCjDispute` on the real supplier order). Watch `fulfillment.margin` alerts.
5. **[C] auto-mode deprecation digest FYI** before flipping deprecation to auto (C19) — only if
   auto is wanted; manual mode needs nothing.
6. **DMARC**: parse aggregate reports, then `p=quarantine` flip (B12).
7. **Mobile + Lighthouse pass** — [R] eyes on the Fold + [C] fix list (backlog #13).
8. **Remove the storefront password wall** (deliberate until now) — the actual launch switch.
9. Backlog P1 items that can ride post-launch if time-boxed: related products (#8), home-page
   category tiles (#9), kill skeleton blog, About page. Judge.me (#15) once real orders exist.

## Standing facts for the next session

Sourcing pipeline is live-proven end-to-end (2026-09-03): market gate, scrubber (word-boundary
fixed), freight-aware pricing, per-variant images (files = deduped union — Shopify LINKS variant
files), content metafields, review pipeline (fail-safe ratings). First v2 listing:
`foldable-portable-dog-water-bottle-…-a6df7732`. Mode is back to `manual`. Deferred decisions
live in `docs/supplier-trend-research-2026-09-02.md` (Zendrop post-canary) and the checklist.