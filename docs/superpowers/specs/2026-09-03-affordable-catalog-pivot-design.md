# The affordable-catalog pivot: cheap goods, honest slow shipping, a comfort system — Design

**Status: proposal written 2026-09-03 on Robert's directive** ("I don't want to sell anything over
$100… when someone sees a $20 toy they think 'it's just 20 dollars'… maybe we expand beyond US
suppliers and set up positive customer relation workflows… build a system that comforts &
affirms customers when they buy something that might take 2 weeks"). Needs his sign-off on §2's
honesty correction and §6's blocking verification before any build starts.

**Parents:** `GROWTH-LANES.md` (this reshapes Lane 0 itself) · `2026-09-03-sourcing-decision-support-design.md`
(the gates being changed) · `supplier-trend-research-2026-09-02.md` (the 2025 de-minimis note that
§6 turns into a blocking check).

---

## 1. The data: Robert is right, and the effect is enormous

Live CJ probe, 2026-09-03, same keyword and page size against each warehouse:

| Keyword | US-warehouse median cost | CN-warehouse median cost | Ratio |
|---|---|---|---|
| dog toy | $13.00 | **$1.95** | 6.7× |
| dog collar | $72.64 | **$1.76** | 41× |
| dog bandana | $63.32 | **$2.06** | 31× |
| dog brush | $11.25 | **$1.62** | 7× |

And the shipping penalty is far smaller than assumed. Real CJ quotes, CN → US:
**$4.75–$6.45 freight at 5–11 or 7–14 days** — comparable in price to US-warehouse freight
($5–7), just slower. One lane (YunExpress Ordinary) even quoted 4–7 days.

**What that does to the economics that blocked us all night:**

- **US toy today:** $13.00 cost + ~$6 freight = **$19.00 landed**. To clear the 40% floor it must
  sell for $31.67 — but the Amazon ceiling for dog toys is around $13–17. Impossible. *This is
  precisely why the live catalog has exactly one toy.*
- **CN toy after the pivot:** $1.95 cost + $4.94 freight = **$6.89 landed**. Sell at **$14.99** →
  **54% margin**, comfortably under the Amazon ceiling, and squarely in the impulse price band
  Robert is describing.

The pivot doesn't merely add products — it converts categories that are arithmetically impossible
today into comfortable ones, and it does so at exactly the price points that don't trigger
comparison shopping.

## 2. The one correction: set expectations BEFORE the sale, never explain them away after

Robert's proposed message — *"the product was out of stock at dogebuddy, but we'll order it
straight from the supplier"* — **must not ship, and the honest version works better.**

**It isn't true.** We never hold stock; every order has always been placed with the supplier. The
message invents a stock-out to excuse a delay that was certain at the moment of purchase.

**It's also the legally expensive version.** The FTC Mail, Internet, or Telephone Order Merchandise
Rule requires a reasonable basis for any shipping representation *at the time of the order*, and
when you can't ship within the stated window (or 30 days if none was stated) you must give the
buyer a delay notice with the right to cancel for a full refund. Promising 3–7 days and delivering
14 triggers that obligation on every late order — and it collides head-on with an all-sales-final
policy. Stating 7–14 days upfront triggers none of it.

**And the complaint it's meant to prevent isn't caused by slow shipping.** It's caused by the *gap*
between what the buyer expected and what happened. Close the gap before the sale and the complaint
disappears without any fiction. Buyers who knowingly choose a 14-day item don't file chargebacks;
buyers who thought they'd bought a 3-day item do.

**The honest framing is also better marketing, because it converts the delay into the reason for
the price:**

> **Ships from our overseas partner warehouse — arrives in 7–14 days.**
> That's how this is $16 instead of $32.

Same information, no fiction, and it makes the wait feel like a deliberate trade the customer is
choosing rather than a failure they're absorbing. The 10% coupon then does its real job — a
thank-you for patience, not an apology for a lie.

## 3. Sourcing changes: two origin lanes, a price ceiling, honest windows

| | Today | After |
|---|---|---|
| Harvest | `countryCode: 'US'` hard-coded | both origins; `shipsFrom` recorded per candidate |
| Stock gate | verified US stock ≥ 1 | verified stock ≥ 1 **in the product's own origin warehouse** |
| Freight quote | `fromCountry: 'US'` | quoted from the product's origin |
| Delivery window | agent-proposed, US assumptions | **derived from the chosen freight option's real `minDays`/`maxDays`** — never a promise the data doesn't support |
| Price cap | none | **new knob `sourcing.max_price_cents` (default 10000 = $100)** — Robert's rule, enforced in Stage 6 like every other gate |
| Amazon ceiling | 1.3× | unchanged — CN economics now clear it easily |
| Margin floor | 40% | unchanged (CN products will typically land 50–70%) |

Two lanes, not a replacement: US-warehouse products still list when they clear the gates, and they
keep their fast windows. The store simply stops being restricted to them.

## 4. Storefront honesty pass

Every blanket "3–7 day" promise must go, because it will no longer be true for most of the catalog.
Current occurrences (verified 2026-09-03): `packages/core/src/policies.ts` (shipping policy),
`TrustStrip.tsx`, `TrustBadges.tsx`, `ValueProps.tsx`, `_index.tsx` meta description, plus the
storefront smoke test that asserts the string.

The replacement is **per-product windows, shown early and often** — the infrastructure already
exists (`shipsFrom` / `deliveryMinDays` / `deliveryMaxDays` metafields already drive the delivery
badge and the shipping accordion). What changes:

- Product cards in collections and search gain the window (today it appears only on the PDP) —
  the buyer should know before the click, not after.
- The PDP badge becomes a **date range**, not a duration: "Arrives Sep 18–25" beats "7–14 days".
- Cart and checkout restate the longest window in the cart.
- Site-wide copy shifts from "3–7 day delivery" to something true of every product, e.g.
  "Free US shipping · every item shows its delivery window".
- `POLICY_COPY`'s shipping section is rewritten: per-product windows, the honest origin
  explanation, and the FTC-aligned promise that if an order runs past its window the customer is
  told and may cancel for a refund. (That last sentence is a *policy change* and needs Robert's
  explicit approval — it is a narrow, deliberate exception to all-sales-final, and it is the law.)

## 5. The comfort system — post-purchase lifecycle

Trigger: order paid. Exit: delivered + 3 days, or cancelled/refunded. Voice: plain, warm, specific;
never apologetic about a window we disclosed, always concrete about dates.

| # | When | Job | Subject | Core content |
|---|---|---|---|---|
| 1 | Immediately on order | Kill the "did it work?" anxiety and re-anchor the date | `Order #1042 confirmed — arriving Sep 18–25` | Restate the window as dates, explain the origin honestly ("ships from our partner warehouse — it's why this was $16"), say exactly what happens next and when tracking arrives. No CTA beyond "reply if anything's off". |
| 2 | Tracking assigned (~2–4 days) | Convert waiting into progress | `It's on the way — here's your tracking` | Tracking link, restated arrival dates, and a pre-empt: "the first scans can take a few days to appear — that's normal." |
| 3 | ~Day 7 if not delivered | **The WISMO killer** | `Quick update on order #1042` | Current tracking status in one line, dates unchanged, nothing needed from them. This is the email that prevents the support ticket. |
| 4 | Tracking stalls past the window | The legally-required and decent thing | `Your order is running late — your choice` | Honest status, the new estimate, and a real choice: keep waiting, or cancel for a full refund. Never buried. |
| 5 | Delivered scan | Land the relationship, earn the next order | `It's there! Here's 10% off your next one` | Thank them for the patience, the unique 10% code, an easy path to say something went wrong, and a review ask. |

**Coupon economics.** On a $16.99 sale at ~55% margin (~$9.35 contribution), a 10% code costs about
$1.70 — and only if they order again. It buys repeat purchase and complaint suppression at a price
the CN margins comfortably absorb. Cap it (e.g. 90-day expiry, single use, excluded from stacking).

**Implementation, cheapest path first.** Emails 1 and 2 are already sent by Shopify (order
confirmation, shipping confirmation) — customise those Liquid templates rather than building new
senders; it's free, deliverable, and needs no infrastructure. Emails 3–5 need our own trigger and
sender: a `customer.lifecycle` cron reading order + tracking state, sending through the existing
Gmail integration (the same machinery the support agent already uses), with each send recorded so
nothing double-fires. Unique discount codes come from Shopify's `discountCodeBasicCreate`.

## 6. BLOCKING verification before a single CN product lists

**Do CJ's CN→US freight quotes include US import duties (DDP), or will the customer be billed on
delivery (DDU)?** The US removed the de-minimis exemption in 2025 (noted in the supplier research
memo), so low-value China→US parcels are no longer automatically duty-free. If a customer who paid
$16.99 receives a customs bill, that is a chargeback, a support crisis, and a review disaster —
and it would be entirely our fault for not checking.

CJ's CJPacket lines are generally sold as delivered-duty-paid, but **"generally" is not a basis for
launching a catalog.** The check: place the canary order through a CN-warehouse product and confirm
(a) CJ's charge matches the quote, (b) nothing is collected on delivery, and (c) CJ's own
documentation states DDP for the chosen line. Until that is confirmed live, no CN product goes on
sale. If it turns out to be DDU, the pivot still works but the duty must be priced into landed cost
and disclosed — a different design.

## 7. Other risks, accepted with mitigations

- **Chargeback exposure rises with transit time.** Mitigated by upfront disclosure, tracking,
  email 3, and email 4's cancel option. The disclosure is also the evidence in a dispute.
- **Quality variance is higher on $2 goods.** The damaged/defective path in `POLICY_COPY` gets
  exercised more; support volume rises. Budget for it — and let the scoring judge retire
  high-refund products faster than it does today.
- **Support load from WISMO.** Emails 3 and 4 exist specifically to absorb it; measure ticket rate
  per order before and after.
- **Brand perception.** A store of $60 mediocre items reads worse than a store of $16 fun ones —
  Robert's own reaction to the current catalog is the evidence. The pivot improves this.

## 8. Sequence

1. **Duty/DDP verification (§6)** — blocking, and it rides the canary order we already owe.
2. **Storefront honesty pass (§4)** — small, independent, and it must land *before* any CN product
   is purchasable.
3. **Sourcing lanes + `$100` cap (§3)** — the gate work.
4. **Comfort system (§5)** — Shopify template edits first (free), then the lifecycle cron.
5. **Then run CN sourcing** and let the catalog fill at $10–30 instead of $60–150.

## Non-goals

Abandoning US-warehouse products (they stay, with their faster windows) · air-freight upgrades ·
warehousing our own stock (that's `GROWTH-LANES.md` Lane 3) · changing the Amazon ceiling or the
margin floor · SMS notifications (email first; SMS only if WISMO persists).
