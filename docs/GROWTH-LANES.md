# Growth lanes — strategy map (written 2026-09-03, Robert's brain-dump)

> **This doc owns POST-LAUNCH strategy** (the why and the economics of each lane). The ordered
> execution sequence lives in `docs/ROADMAP.md` (Phases B–E); the launch slice is
> `docs/LAUNCH-PLAN.md`.

Robert's ask, verbatim in substance: sell **hyped/trending** products that don't fit the
price-competitive model; do **white/private label**; eventually an **MRR private-label lane**
(dog vitamins, shampoo); **automate outreach** for wholesale and white-label deals, dropship or
not; he can **buy and hold inventory**; and explore **print-on-demand / clothing merch**.

This doc sorts those into five lanes, each with its real economics, the software it needs, its
risks, and what must be true before it starts. It ends with a recommended sequence. Nothing here
is committed to a build; it exists so the order of operations is a decision rather than a mood.

---

## Lane 0 — what exists today (the machine everything else reuses)

A live Shopify store (dogebuddy.com, Hydrogen/Oxygen) with an automated pipeline: sourcing agent
→ plain-code gates (US stock, freight-inclusive margin floor, ≤1.3× Amazon/Google market ceiling,
claims scrubber) → owner approval → listing with real variants, images, specs, reviews →
CJ fulfilment (place/pay/track/dispute) → support agent on Gmail → nightly scoring, deprecation
drip, admin control centre. **Every lane below is measured against how much of this it reuses.**

The economics of Lane 0 are: buy commodity goods cheap from CJ, price them ≤1.3× Amazon, keep
≥40% margin, acquire buyers through search/organic. It works, it needs no ad budget, and its
ceiling is set by how many CJ products can actually beat Amazon on price — which, as of 2026-09-03,
is a real constraint (11 of 23 live products failed it and were retired).

---

## Lane 1 — Trend / hype products (impulse traffic)

**What it is.** Sell products where demand is *created* by the ad, not discovered by search.
The buyer sees a demo video, wants the thing, and does not comparison shop. Markups of 3–5×
landed cost are normal because the price is never benchmarked.

**Why it needs its own rules.** Lane 0's price ceiling is the wrong gate here — it would reject
exactly the products this lane wants. But "no ceiling" cannot mean "no discipline": the
$140-stroller failure mode must still be impossible. So the gate inverts:

| | Lane 0 (commodity) | Lane 1 (trend) |
|---|---|---|
| Price rule | ≤ 1.3× Amazon median (ceiling) | ≥ 3× landed cost (**floor** — ad spend must fit inside the margin) |
| Demand evidence | market offer count, Trends, Amazon reviews | a **recorded** social/velocity citation (owner paste or agent web-search finding), stored like a market lookup — never the agent's opinion |
| Margin floor | 40% | higher in practice (CAC comes out of it) |
| Kill window | 28-day scoring | **7-day** — trends die fast; retire via the existing deprecation drip |

**Software needed.** A `lane` flag on listings; the gate branch above; a trend-evidence record
(reuse the `sourcing_signals` + decision-context pattern); a shorter scoring window for
lane-1 products. **Plus the one that actually matters: per-product ad-spend ingestion.** Without
CAC joined to `product_scores`, a product doing $2k/month can be losing money and nothing in the
system can tell. Meta and TikTok both expose ads APIs; this is the largest piece of work in the
lane and it is not optional.

**The math that decides it.** $8 landed gadget: Lane 0 sells it at $16.99 for ~$7 net, no ad cost.
Lane 1 sells it at $34.99 for ~$26 gross — then subtracts CAC. At $15/order that's ~$11 net and a
good business; at $25/order it's ~$1 and a single refund erases ten sales. CAC is a function of
creative quality, and most tested products fail. Budget for 5–10 losers per winner.

**Risks.** Impulse buyers regret purchases more than searchers do — chargebacks cost money even
when the all-sales-final policy is legally sound. CJ's trend-y goods have wider quality variance
than its basics (more disputes, more support load). Creative that overstates what a product does
is both an ad-account ban risk and exactly what the claims scrubber exists to prevent — generated
video may show a product attractively but must never depict behaviour it doesn't have.

**Prerequisites.** A testing budget you are willing to lose; a creative pipeline; ad-spend tracking
built *before* the first campaign, not after.

---

## Lane 2 — Print-on-demand merch (brand apparel, dog + human)

**What it is.** Dog-themed tees/hoodies/mugs for humans, plus POD-able dog goods (bandanas,
collar covers). Printful/Printify integrate natively with Shopify — no inventory, no minimums,
they print and ship per order.

**Economics.** Thin but riskless: a $12–14 blank prints and ships at ~$18–22 landed, sells at
$29–35. No cash tied up, no MOQ, no storage.

**Software needed.** Almost none — POD apps own their own fulfilment and inventory. The honest
work is *keeping them out of our automation*: our fulfilment worker, inventory sync, and margin
gates are CJ-shaped, so POD products need a supplier tag that routes them around our pipeline
(the app fulfils them), or they'll generate confusing failures.

**The catch, stated plainly.** Merch sells to *fans*. Doge Buddy has no fans yet — no audience, no
traffic, no brand equity. POD is the easiest lane to build and the hardest to sell into a cold
market. Its real role is (a) a zero-risk experiment, (b) accessory revenue once there's traffic,
(c) brand-building surface. It should never be the growth engine.

**Prerequisites.** Some traffic. A few designs. That's it.

---

## Lane 3 — Wholesale / white label with owned inventory

**What it is.** Buy in quantity at 25–45% of retail (real wholesale, not dropship markup), hold
stock, ship it yourself or via a 3PL. White label = a generic manufacturer's product with your
brand on it; private label = your spec, your formulation, your packaging.

**Why it's the margin unlock.** Dropshipping's structural problem is that every unit carries the
supplier's markup and per-unit freight — that's exactly why CJ goods can't beat Amazon. Buying a
case removes both. This is the lane where a 60–75% gross margin becomes normal instead of
impossible.

**What changes in the business.** Cash converts to inventory (a $2–5k first order is typical for
an MOQ), storage becomes real (garage → 3PL as volume grows), and *you* own returns, damages, and
dead stock. Fulfilment goes from "CJ ships it" to pick/pack/ship or a 3PL integration.

**Software needed (this is the significant one).** Inventory today flows *from* CJ into Shopify —
owned stock inverts that: Shopify (or a 3PL) becomes source of truth, `inventory.sync` must learn
to leave owned SKUs alone, the fulfilment worker needs an owned-inventory path (print a label,
mark fulfilled) instead of a supplier order, and the margin gate reads a landed cost you entered
rather than a live supplier quote. Roughly: a supplier-type dimension threaded through listing,
inventory, and fulfilment.

**Prerequisites.** Suppliers to talk to (see Lane 5), samples in hand, cash for MOQs, a place to
put boxes, and — importantly — *evidence of demand first*. The right first white-label products
are ones Lane 0 or Lane 1 already proved sell.

---

## Lane 4 — Private-label consumables + subscription MRR (the destination)

**What it is.** Your own brand of the things dogs consume on a cycle — shampoo, wipes, dental
chews, poop bags, and eventually supplements — sold on subscription. Recurring revenue, predictable
cash, and the only lane here that builds an asset rather than a series of transactions.

**Why it's the best business and the last one to build.** MRR compounds: a customer acquired once
pays for months. It's also the lane with real compliance weight and real inventory, so it must
follow Lane 3, not precede it.

**Regulatory reality — the part that must not be improvised.** Confirm all of this with counsel
before spending on inventory:

- **Shampoo / grooming (lightest).** Animal cosmetics carry a much lighter burden than ingestibles.
  **But the moment a product makes a pest claim — flea, tick, repellent — it becomes a pesticide
  requiring EPA registration**, which is a serious, expensive process. (This is precisely why
  `flea` and `tick` are already on the sourcing exclusion list.) Plain cleaning/conditioning
  shampoo without pest or medical claims is the safe entry point.
- **Supplements / "vitamins" (heaviest).** Pet supplements are *not* a protected legal category the
  way human dietary supplements are — depending on ingredients and claims, FDA can treat them as
  animal foods or as unapproved new animal drugs. Labeling follows AAFCO model regulations, and
  **many states require per-product registration** before sale. The industry's de-facto legitimacy
  layer is **NASC membership and audit**. Any health or disease claim is the bright line: "supports
  joint health" is a claim, and claims are what turn a supplement into a drug in the eyes of a
  regulator. Our claims scrubber already bans this language for good reason — it would need a
  deliberate, counsel-reviewed exception for a compliant private-label product, not a bypass.
- **Dog food proper** — AAFCO labeling plus state registrations, plus a real quality/recall
  liability. Already parked as backlog #20 for exactly this reason.

**Software needed.** Shopify subscriptions (selling plans + a subscription app), which brings
recurring-order handling, failed-payment dunning, pause/skip/cancel flows, and churn measurement.
Our order pipeline handles one-off orders today; recurring orders are a new shape. Plus everything
from Lane 3, since these are owned-inventory goods.

**Prerequisites.** Lane 3 operating. A contract manufacturer. Counsel review. Demand evidence —
ideally you've already sold someone else's shampoo profitably before making your own.

---

## Lane 5 — Supplier outreach automation (the cross-cutting unlock)

**What it is.** An agent that finds candidate manufacturers and wholesalers (Alibaba, Global
Sources, Thomasnet, Faire, trade directories, and the "contact us" pages of brands you like),
drafts a tailored outreach email per target, tracks replies, and surfaces qualified conversations
for you to take over.

**Why it's the highest-leverage software build in this whole document.** Lanes 3 and 4 are gated on
one thing: having suppliers to talk to. That's a research-and-correspondence problem, which is
precisely what this codebase already does well — we have a Gmail integration, an agent that drafts
replies against guidance, a proposal/approval flow so nothing sends without your say-so, and
ticket threading to track conversations. Outreach is the *same machine* pointed outward: research
agent finds targets → drafts a message → you approve → it sends → replies land as threads → the
agent drafts follow-ups. Most of the parts exist.

**The one hard rule.** **Do not send cold outreach from `support@dogebuddy.com` or the main
domain.** Customer-support deliverability is a real asset we've already invested in (SPF/DKIM/DMARC
work, a Gmail reputation being built, a known issue where Outlook drops first-contact mail).
Cold B2B outreach at volume is exactly how a domain's reputation gets burned — and if support mail
starts landing in spam, real customers go unanswered. Use a **separate domain** (e.g.
`dogebuddy-sourcing.com` or a subdomain with its own authentication) with its own warm-up. This
is non-negotiable and it's cheap to do right.

**Also honest:** cold outreach converts in the low single digits, most manufacturer replies are
brokers, and MOQ/sample negotiation is genuinely a human skill. The agent's job is volume and
follow-up discipline, not closing.

---

## Recommended sequence

**This weekend — finish Lane 0.** Launch. It's built, it's live, it costs nothing to run. Do not
start a second lane while the first one is unproven; everything below gets better with real sales
data underneath it.

**Week 1 after launch — Lane 5 (outreach agent) + Lane 1 groundwork.** The outreach agent is
software we're good at and it starts a pipeline whose lead time is measured in weeks, so it should
start *first* even though it pays off last. In parallel, build Lane 1's gate + ad-spend ingestion,
because that's what makes trend testing measurable.

**Weeks 2–4 — Lane 1 live, small budget.** Test 5–10 trend products with a fixed, losable budget.
Measure CAC per product from day one. Kill fast. Expect most to fail — that's the model working,
not a defect.

**Weeks 2–6 (parallel, cheap) — Lane 2 (POD).** A handful of designs, native app, no automation
work. Zero risk, and it gives the brand a face while traffic builds.

**Month 2–3 — Lane 3 (wholesale/white label).** Aim the first buys at products Lanes 0/1 already
proved sell. This is where the inventory software work happens.

**Month 3+ — Lane 4 (private label + MRR).** Shampoo and non-ingestible grooming first (light
compliance), subscriptions on top. Supplements only after NASC/state-registration groundwork and
counsel review — and only if the first private-label products are already selling.

**Milestone to watch:** Shopify Collective unlocks at $50k trailing-12-month sales — curated US
brands at real wholesale, with no adapter to build. It's the cheapest version of Lane 3 and it
arrives automatically if Lanes 0/1 work.

## What not to do

Don't run three lanes at once before any of them is profitable — attention is the scarcest input.
Don't buy inventory for a product that hasn't sold for someone else first. Don't put supplements
on the site before the compliance work is done; the downside is regulatory, not just financial.
Don't send cold outreach from the support domain. And don't let the trend lane's looser price gate
leak into the commodity catalog — the whole point of lanes is that each keeps its own discipline.
