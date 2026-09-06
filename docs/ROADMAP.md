# Doge Buddy roadmap — the single ordered through-line

**Written 2026-09-03 (launch day). This is the MASTER index: what happens next, in order, from
tonight to month 3+.** It deliberately holds no detail of its own — each item points at the
document that owns it. When they disagree, the detail doc wins and this one gets corrected.

| Document | Owns |
|---|---|
| `OWNER-CHECKLIST.md` | Robert's action items + credentials; its footer is the session-to-session state pointer |
| `LAUNCH-PLAN.md` | The launch slice (L1–L4): catalog blitz, reset, launch gates |
| `LAUNCH-BACKLOG.md` | Storefront/catalog work items (P0/P1/P2), most now shipped |
| `GROWTH-LANES.md` | Post-launch business strategy: trend lane, POD, wholesale, private-label MRR, outreach |
| `superpowers/specs/` | Per-build designs; `superpowers/plans/` the implementation plans |
| `supplier-trend-research-2026-09-02.md` | Supplier + trend-source evaluations (incl. the Zendrop ruling) |

---

## Phase A — Launch (gated on the CJ wallet, not on a date)

> **Revised 2026-09-03 evening: the storefront is deliberately back behind the Oxygen login wall
> and STAYS there until the CJ wallet is funded (~$150).** The top-up is a bank transfer with a
> verification wait, so launch is Mon–Wed next week, not the weekend. This is the correct call:
> a reachable store that cannot fulfil an order is worse than no store, especially under an
> all-sales-final policy. **Treat the wait as a gift** — it converts a rushed weekend launch into
> a week with time for catalog depth, the mobile/Lighthouse pass, and Phase B builds.

**A1. Catalog blitz [R].** Sourcing runs from Robert's machine on subscription auth until the
catalog is stocked. Command + keyword sets in `LAUNCH-PLAN.md` §L2. Watch each run's closing
CJ-points and SerpApi lines. Every run now enforces the Amazon ceiling, so expect drops — that is
the gate working.

**A2. Reprice + retire [R].** `reprice-all --apply` after each batch: it drops prices to ≤1.3×
Amazon and queues non-competitive products into the nightly deprecation drip
(`catalog.deprecation-drip`, ≥1/night). Re-run it once more to queue the 11 already identified.

**A3. Launch gates [R].** Ordered in `LAUNCH-PLAN.md` §L4. Live status:
**CJ wallet top-up — THE launch gate, bank transfer in flight, everything else waits on it** ·
policies pasted ✅ · About page ✅ · Shopify Payments + bank verification in flight ·
storefront intentionally WALLED until the wallet clears · canary self-purchase blocked on the
wallet · Fold eyeball + Lighthouse fix list pending (do during the wait) · DMARC pending.

**A4. Housekeeping [R].** Dev-DB hygiene SQL (4 known-benign test failures until run) ·
`workflow.deprecation.mode` back to `manual` · cancel Zendrop Plus + remove `ZENDROP_ACCESS_TOKEN`
from `apps/ops/.env` and delete the `.env.bak-*` backups · confirm `fulfillment.margin_floor_bps`
= 4000 saved.

---

## Phase B — Enhancement week (week 1 after launch)

**B1. Keyword intelligence [C] — spec written, ready to build.**
`superpowers/specs/2026-09-03-keyword-intelligence-design.md`. Keywords self-select from measured
performance (surviving listings per candidate harvested), with an `/admin/keywords` page. No
migration needed. This is the build that makes sourcing hands-off, and the blitz is generating its
training data now.

**B2. Supplier outreach agent [C] — needs a spec.** `GROWTH-LANES.md` Lane 5. Highest-leverage
build in the whole roadmap because Lanes 3–4 are gated on having manufacturers to talk to, and
that pipeline has weeks of lead time. Reuses Gmail + the drafting agent + the proposal/approval
flow. **Hard rule: a separate sending domain — never `support@dogebuddy.com`.**

**B3. Trend-lane groundwork [C] — needs a spec.** `GROWTH-LANES.md` Lane 1. Lane flag, inverted
gate (markup floor instead of price ceiling), recorded demand evidence, 7-day kill window, and —
the part that must not be skipped — per-product ad-spend ingestion so CAC is measurable from the
first campaign.

**B4. Post-launch fixes [C].** Lighthouse/mobile fix list from Robert's Fold walk (backlog #13) ·
`treat`/`chew` guard ruling if Robert wants chew toys and treat-dispensers unlocked (still
pending) · predictive search still queries blog articles (dormant) · robots.txt `/blogs/*`
disallow now inert.

---

## Phase C — Trend testing (weeks 2–4)

**C1. Trend lane live [R+C].** 5–10 products on a fixed, losable budget. Measure CAC per product
from day one; kill fast via the deprecation drip. Expect most to fail — that is the model, not a
defect. Creative can be AI-generated but must never depict behaviour a product doesn't have (same
line the claims scrubber holds).

**C2. Print-on-demand merch [R, cheap] — parallel.** `GROWTH-LANES.md` Lane 2. Native Printful/
Printify app; the only engineering is routing POD products *around* our CJ-shaped fulfilment. Low
risk, low urgency — merch sells to fans, and the brand needs traffic first.

**C3. Judge.me reviews [C]** once real orders exist (backlog #15).

---

## Phase D — Wholesale + owned inventory (month 2–3)

**D1. First wholesale/white-label buys [R].** `GROWTH-LANES.md` Lane 3. Aim at products Phases A–C
already proved sell. Requires samples, MOQ cash, and storage.

**D2. Owned-inventory support [C] — the significant build.** Inventory source-of-truth inverts
(Shopify/3PL instead of CJ), `inventory.sync` must leave owned SKUs alone, fulfilment needs a
non-supplier path, margin gates read an entered landed cost. Threaded as a supplier-type dimension
through listing, inventory, and fulfilment.

**D3. Shopify Collective** unlocks automatically at $50k trailing-12-month sales — the cheapest
version of this phase, no adapter to build. Watch for it.

---

## Phase E — Private label + subscription MRR (month 3+)

**E1. Grooming/shampoo private label first [R+C].** Lightest compliance path. **Never a
flea/tick/pest claim** — that makes it an EPA-registered pesticide.

**E2. Subscriptions [C].** Shopify selling plans + recurring-order handling, dunning, pause/skip/
cancel. Backlog #20.

**E3. Supplements — only after compliance groundwork [R].** AAFCO labeling, per-state product
registration, NASC membership, counsel review, and a deliberate exception to the claims scrubber
rather than a bypass. Health claims are the bright line. Dog food proper stays parked behind the
same wall.

---

## Standing decisions (do not re-litigate without new evidence)

- **CJ is the only supplier.** Zendrop probed live 2026-09-03 and ruled out — 98% of its US dog
  catalog is an Amazon reseller, no delivery ETAs, no stock numbers, no variants
  (`supplier-trend-research-2026-09-02.md` §UPDATE). Re-open only if those three change.
- **Supplier count was never the constraint.** Commodity dropship catalogs resell what Amazon sells
  cheaper. The escape is differentiated product (Phases D–E), not another commodity API.
- **The Amazon ceiling binds the commodity lane.** 1.3× Amazon median, enforced in code. The trend
  lane gets its own inverted gate — the ceiling must never be loosened *for the catalog* to make a
  hyped product fit.
- **Deprecation is drip, not purge:** ≥1/night through `catalog.deprecation-drip`, always via a
  normal proposal honoring `workflow.deprecation.mode`.
- **Never dropship ingestibles** without the Phase E compliance work.
- **US and CN are the only viable warehouses, and that is settled.** All 18 CJ warehouse countries
  probed 2026-09-03: only US (median $97.60), CN ($1.45), GB ($15.56) and AU ($21.56) stock dog
  goods at all — the other 14 (DE, FR, ES, IT, CZ, PL, TH, ID, JP, CA, MX, BR, VN, IN) returned
  zero. GB and AU quote **no shipping options to a US customer at all**; they serve their own
  regions. There is no third origin to find.
- **We ship to the US only** (owner ruling 2026-09-03). Selling INTO Canada/UK/EU is the real
  version of "more countries" — it needs no new supplier and would make CJ's GB/AU warehouses
  useful — but it carries EU VAT/IOSS + UK VAT registration, per-destination customs, currency and
  multi-timezone support. **Parked until the US store is earning**; revisit alongside Phase D.
