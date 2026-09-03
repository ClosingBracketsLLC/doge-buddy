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

## L2 — The 100-product BLITZ [R runs + approvals, C support] — RESCHEDULED 2026-09-03

**Robert's call (2026-09-03 chat): 100 products by END OF DAY 2026-09-03, launch THIS WEEKEND
(2026-09-05/06), next week = enhancements + marketing prep.** Prereqs done: SerpApi Starter
(1,000 searches/mo), env cap set, main pushed + deployed, L1 live check passed.

- **Cadence (revised for the blitz):** the old "≤2 runs/day" used the 25k per-run STOP-LOSS as if
  it were typical spend; real runs print ~1.5–3k CJ points each, so 15–25 serial runs fit inside
  CJ's ~50k/day API quota. SerpApi: ~25–35 requests/run × ~20 runs ≈ 500–700 of the 1,000/mo.
  Watch both printed closing lines per run; if points estimates trend high or CJ 429s rove
  (backoff absorbs bursts), space runs out.
- Per-run command (from `railway ssh`, `/app`), widened knobs for maximum yield per run:
  `pnpm --filter @doge-buddy/ops run-sourcing --max-winners 8 --candidates 40 --pages 20 --budget 4 --force --keywords "<rotate>"`
  Rotate keyword sets across runs (expansion auto-adds rising queries on top). Yield decays as
  the harvest dedupe exhausts CJ's US-warehouse dog catalog — `no_candidates` short-circuits or
  near-zero submissions mean a keyword set is spent, not that something broke. If yield plateaus
  well short of 100, launch with what listed — the number is a target, not a gate.
- **Approvals:** `workflow.sourcing.mode = manual` (default) = one Telegram Approve per listing
  with the L1 decision numbers — the gate Robert asked L1 for. For raw speed he MAY flip the
  setting to `auto` on `/admin/settings` for the blitz (numbers become FYI on the proposal page)
  and back to `manual` after — his call, made knowingly.
- **[C] follow-through**: collections fill by tag automatically; Claude spot-probes listings
  read-only (variant images, metafields, gallery) as batches land.

## L3 — Catalog reset [R decision CONFIRMED 2026-09-03 + R execution, runbook ready]

**Robert's ruling (2026-09-03 chat): deprecate ALL pre-gate products, no repricing** — the
audit's reprice option is dead. Timing under the blitz schedule: run this TONIGHT or Friday
morning, as soon as the blitz has landed ≥ 30–40 live replacements (keep the store non-empty).
Deprecation ≠ deletion: the existing
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

## L4 — Launch gates, WEEKEND SCHEDULE (launch target 2026-09-05/06) [R unless noted]

**Thursday 09-03 (blitz day), alongside the runs:**
1. **CJ wallet top-up ~$150** — wallet is at $0 and alerting critical; blocks the canary AND any
   real order. Do it today so the canary can go in Friday.
2. **Policies → Shopify Settings** — paste `POLICY_COPY` (legally load-bearing; a no-refund
   policy is only enforceable when conspicuously posted — this is NOT optional before the wall
   drops).
3. **Business checks** — Shopify Payments live, US tax registrations in Shopify Tax, LLC
   insurance (recommended). Payments especially: no launch without a working checkout.
4. **About page** (checklist item — footer already links it).

**Friday 09-04:**
5. **L3 catalog reset** (runbook above) if not done Thursday night.
6. **Canary self-purchase** (C18) — place the real order end-to-end: pay CJ, watch
   `fulfillment.margin` alerts. HONEST CAVEAT: delivery takes 3–7 days, so a weekend launch means
   launching while the canary is still in transit — order placement/payment/tracking-start are
   verified before the wall drops; delivery + the `openCjDispute` close (Tier-2 #4) complete
   NEXT week. Acceptable risk, decided knowingly, or slip launch a few days — Robert's call.
7. **[R] Fold eyeball + [C] Lighthouse fix list** (backlog #13) — Robert walks the store on the
   Fold with the full catalog, tells Claude what looks off; Claude ships the fix list same day.
8. **Store-transfer re-verifications** (checklist item): confirm app installs/API credentials,
   custom domain, and Shopify Payments all live on the MERCHANT account before the wall drops.

**Weekend 09-05/06 — launch:**
9. **Remove the storefront password wall** — the actual launch switch.
10. **DMARC** (B12) and Judge.me (#15) ride post-launch; the auto-mode deprecation digest (C19)
    only if deprecation auto is ever wanted. Storefront P1 (#8/#9/#10/#11C) shipped 2026-09-03.

**Next week:** enhancements + marketing campaign prep (Robert's directive 2026-09-03).

## Standing facts for the next session

Sourcing pipeline is live-proven end-to-end (2026-09-03): market gate, scrubber (word-boundary
fixed), freight-aware pricing, per-variant images (files = deduped union — Shopify LINKS variant
files), content metafields, review pipeline (fail-safe ratings). First v2 listing:
`foldable-portable-dog-water-bottle-…-a6df7732`. Mode is back to `manual`. Deferred decisions
live in `docs/supplier-trend-research-2026-09-02.md` (Zendrop post-canary) and the checklist.