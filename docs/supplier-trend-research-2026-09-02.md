# Research spike: second supplier + winning-product trend sources (2026-09-02)

Robert's asks (2026-09-02 chat): (a) grow the pool of dropshippable products beyond CJ, (c) reduce
single-supplier risk, and make the sourcing agent "really good at picking winning products"
(TikTok Shop and other trending corners named explicitly). This memo is the spike's output — a
recommendation, not a spec. Full agent research reports with sources are appended below; claims
marked VERIFIED were independently re-checked by the controller session.

## Recommendation (short version)

1. **Second supplier: Zendrop, after the canary.** Its API is real and self-serve — VERIFIED: an
   OAuth2, scope-based MCP server at `app.zendrop.com/mcp/v1` (launched 2026 as "the world's
   first dropshipping MCP server"; docs on support.zendrop.com), US-product tier at $49/mo Pro,
   with a pet vertical. It is the only CJ-alternative found whose API you can get WITHOUT an
   enterprise sales call. Two honest risks: it's an MCP tool-calling layer rather than a
   versioned REST contract (callable deterministically from plain code all the same — MCP is
   JSON-RPC over HTTPS — but stability is unproven), and coverage of freight quotes,
   per-warehouse stock, webhooks, and disputes is undocumented until we hold a token. Runner-up:
   Doba (2002-era SOAP API, closest shape to CJ's, but ~$255/mo Enterprise + a developer
   application + docs links that 404 — needs a sales conversation to even evaluate).
   Everything else (Eprolo, Syncee, Modalyst, HyperSKU, USAdrop, AutoDS, Spocket, Wholesale2B)
   is app-only, support-mediated, or an unpriced partner gate — no self-serve API surface.
   AliExpress has a real official API but fails US-warehouse filtering + 2025 tariff economics.
   Shopify Collective is a different business (curated US brands, retail-ish margins, no adapter
   needed) — a later diversification lane, not API breadth.
   **First step when the time comes:** a $49 one-month Zendrop Pro account + a token-in-hand
   probe of the MCP's actual tool surface against our 19-method `SupplierAdapter` — BEFORE any
   spec. The adapter build itself stays post-canary (one proven money path before two).

2. **Trend sources: triangulate cheap signals; buy nothing yet.** The central finding — there is
   NO clean, accurate, agent-integrable TikTok trend API at any price in 2026. Every TikTok Shop
   analytics platform (Kalodata, FastMoss, EchoTik, Shoplus) runs on estimated, unofficial data
   (their own users report badly-off numbers), APIs are gated behind unpriced enterprise tiers,
   and official TikTok routes (Research API, Creative Center) are commercially closed or
   ToS-prohibited to scrape. So:
   - **Next build (already approved as upgrade #2):** Google Trends rising-related-queries via
     the SerpApi we already pay for.
   - **Add in the same build or right after:** an Amazon demand cross-check via SerpApi's Amazon
     engine — VERIFIED it exists (search + category `node` filtering + sort-by-popularity), but
     NOT the dedicated Movers & Shakers page the research agent hoped for; category-popularity
     in Pet Supplies is still a usable $0-incremental proxy against the same SerpApi quota.
   - **TikTok itself: stay manual for now.** EchoTik's free tier/$9.90 tier as a human
     spot-check dashboard, feeding winners into the existing lane:
     `railway ssh` then `pnpm --filter @doge-buddy/ops run-sourcing --max-winners 2 --force --keywords "<what you saw>"`.
   - **Skip:** Kalodata/FastMoss/Shoplus paid tiers, Reddit's $12k/mo commercial API, Exploding
     Topics/Glimpse enterprise APIs, Amazon SP-API (seller-gated).

3. **Margin note from the same conversation:** supplier cost is not landed cost (freight $4–8
   rides every CJ order); the 60% freight-inclusive floor plus the new 1.3×-market gate make
   $3-cost/$30-price collars legitimate — but the 23 pre-gate live products were priced by the
   agent without the market check. A one-off market-price audit of live products is a candidate
   backlog item (not yet requested).

---

## Appendix A — supplier research (agent report, sources inline)
# Second Supplier Research — doge-buddy (2026-09-02)

Scope: evaluate whether each candidate supplier could plausibly power a second `SupplierAdapter`
implementation alongside CJ Dropshipping's REST API (19-method interface: search w/ US-warehouse
filter, product detail incl. per-variant images/weights, variant stock by warehouse country,
freight quote, place/confirm/pay order, order status, tracking, balance, disputes, webhooks).

Evidence rule: if I could not find real developer docs, I say so explicitly rather than assuming
they exist. Anything not independently confirmed is marked **UNVERIFIED**.

---

## 1. Zendrop

**API access reality:** Zendrop has a genuine programmatic access layer, but it is built as an
**MCP (Model Context Protocol) server**, not a classic REST API for backend integration. Docs:
[Zendrop MCP Developer Documentation](https://support.zendrop.com/en/articles/14461568-zendrop-mcp-developer-documentation).
Endpoint is `POST https://app.zendrop.com/mcp/v1`. Auth is via scoped Access Tokens or OAuth2
(Authorization Code + PKCE). Scopes: `catalog:read`, `orders:read`, `orders:write`, `stores:read`,
`stores:write`, `my_products:write`, `billing:read`. Rate limits: 120 read/min, 30 write/min, 10
fulfillment actions/min. No pricing/tier gate is mentioned in the docs themselves — it reads as
available to any connected store, though it's clearly designed for AI-assistant tool-calling, not
a documented REST surface with OpenAPI/endpoint reference. **This is unusual: it is technically an
HTTP JSON endpoint we could call from our own backend (MCP is just JSON-RPC-ish over HTTP), so a
determined engineer could likely wrap it into our adapter shape** — but there is no conventional
REST reference, no published SDK, and Zendrop could change/restrict this surface at any time since
it's marketed for AI agents, not integrators. Classic `api.zendrop.com` resolves to essentially a
blank/bare page — no separate legacy REST docs found.

**API surface fit:** Catalog search/detail (`get_catalog_product`, `get_catalog_trending_products`)
— yes. Order insights/status — yes (`orders:read`/`orders:write`). Fulfillment/shipping estimates —
mentioned generically ("automate shipping estimates") but no freight-quote endpoint documented.
Per-warehouse stock — not documented. Balance/disputes — not mentioned. Webhooks — not mentioned
(inventory/webhook coverage is UNVERIFIED). Overall: covers catalog + orders reasonably, weak/absent
on freight quoting, per-warehouse stock, balance, and disputes.

**US warehouse reality:** Pro plan ($49/mo) explicitly gates "U.S. products" — implying a real,
paid-tier-gated set of US-warehoused SKUs, size not published (UNVERIFIED count).

**Dog/pet niche depth:** Has a dedicated [pet supplies collection](https://www.zendrop.com/pet-supplies/)
(dog toys, cat accessories, grooming, feeders, beds), but pet is one slice of a general catalog —
no published pet-specific SKU count.

**Commercials:** Free (browse only) / Pro $49/mo ($399/yr) — unlocks automated fulfillment, custom
branding, US products / Plus $79/mo ($549/yr) — adds coaching, private listings, chargeback
management. No separate "API fee" found; MCP access appears bundled.

**Reliability/reputation (2025–2026):** 4.6★ Trustpilot (20k+ reviews), 4.3★ Shopify App Store
(1,100+ reviews) — generally solid, but recurring complaints: dropped/mismatched orders with weak
support, unexpected billing after trials, a documented case of Zendrop unilaterally changing a
"credits cover 100% of order cost" promo into a 10% discount after purchase, missing SKU images,
unclear warehouse designation on some products.

Sources: [Zendrop MCP docs](https://support.zendrop.com/en/articles/14461568-zendrop-mcp-developer-documentation), [Zendrop pricing](https://support.zendrop.com/en/articles/12511531-zendrop-plans-and-pricing-free-standard-and-usage-based), [Zendrop pet supplies](https://www.zendrop.com/pet-supplies/), [dodropshipping Zendrop review 2026](https://dodropshipping.com/zendrop-review/), [alidropship Zendrop scam review](https://alidropship.com/is-zendrop-a-scam/)

---

## 2. Spocket

**API access reality:** Spocket does expose retailer-facing **API credentials via a "Developer
Settings" panel** in-account (API Key + Auth token, base URL + header-based auth for custom
integrations) — this is corroborated by third-party integration guides (Retool, FlutterFlow) that
walk through using Spocket's API key outside of the Shopify/WooCommerce apps. However, **no public
developer-docs portal or endpoint reference was found** — apitracker.io lists Spocket as having
"developer docs, APIs, SDKs, and auth" but the actual reference content wasn't locatable in search.
This sits in a gray zone: real API keys exist and third parties integrate against them, but there's
no self-serve published spec — likely provided ad hoc by Spocket support/account managers.
**UNVERIFIED**: full endpoint coverage, since no doc reference could be found.

**API surface fit:** UNVERIFIED — cannot confirm order placement/payment, freight quotes,
per-warehouse stock, or webhooks are exposed via this API vs. only through the Shopify/WooCommerce
app's own sync. Product data (images, pricing, variants) is confirmed available since that's core
to how the app populates stores.

**US warehouse reality:** Deliberate focus on US/EU suppliers (Spocket's core positioning); catalog
cited at 700,000+ products across 15,000+ subcategories, most with 2–5 business day US/EU domestic
shipping. Whether the catalog/API can filter specifically by "US warehouse" as a query parameter is
UNVERIFIED.

**Dog/pet niche depth:** Has a dedicated pet/dog products vertical and published buyer's guides
(e.g., "Dog Accessories Dropshipping Products and Suppliers"), suggesting real curated depth, though
no catalog-size number specific to pets was found.

**Commercials:** $39.99–$299.99/mo tiers (annual Pro ≈ $24/mo effective); pricier than CJ. Reviews
note per-item pricing can run comparable to or above Amazon retail plus ~$8 shipping on some SKUs —
a margin risk vs. CJ's cost basis.

**Reliability/reputation (2025–2026):** Legitimate, long-running (since 2017) platform, but a
well-documented pattern of billing complaints: charges continuing after cancellation, no
cancellation confirmations, strict no-refund policy, weeks-long copy-paste support on billing
disputes.

Sources: [apitracker.io Spocket](https://apitracker.io/a/spocket-co), [RapidDevelopers Spocket/Retool integration](https://www.rapidevelopers.com/retool-integrations/spocket), [Spocket dog accessories guide](https://www.spocket.co/blogs/dog-accessories-dropshipping-guide-best-products-and-suppliers), [dupple Spocket review 2026](https://dupple.com/tools/spocket), [alidropship Spocket legit review](https://alidropship.com/is-spocket-legit/)

---

## 3. AutoDS

**API access reality:** AutoDS has a real, **partner/approval-gated API program** — access requires
application + "one-time activation fee," subject to AutoDS's review of use case and current API
roadmap; full technical docs (endpoints, auth, rate limits) are handed over only after approval and
payment. Landing page: [autods.com/api](https://www.autods.com/api/). This is NOT self-serve.
Amount of the activation fee is UNVERIFIED (not published).

**API surface fit:** Marketing copy names five API "products": Scraping API (competitor/price
intel), Product Imports API (1-click import w/ description/photo/video), Price & Stock Monitoring
API (hourly supplier scans), Fulfilled-by-AutoDS API (autopilot order fulfillment), Store Management
API (cross-store profit/order tracking). No endpoint-level detail, no confirmation of freight
quoting, per-warehouse stock, disputes, or webhooks — all UNVERIFIED pending the gated docs.

**US warehouse reality:** AutoDS is primarily an automation/aggregation layer over many suppliers
(AliExpress, CJ, Amazon, Walmart, etc.) rather than its own warehouse network — "US warehouse" would
depend on which underlying supplier is selected per listing, not a property of AutoDS itself. This
undercuts its value as a *second, independent* supplier — it's largely a meta-layer over suppliers
we may already touch via CJ.

**Dog/pet niche depth:** Not supplier-specific — pet products would come from whichever underlying
marketplace/supplier is sourced, not from an AutoDS-owned catalog.

**Commercials:** Platform plans ~$26.90–$59.80+/mo depending on tier, plus the API activation fee
(amount unpublished) — stacks on top of whatever underlying supplier fees apply.

**Reliability/reputation (2025–2026):** Mixed. Positive from sellers using pure automation on an
established store; negative from billing practices — BBB complaints re: undisclosed billing,
15% fee on refunds, same-day access cutoff after cancellation while retaining a month's charge.

**Verdict:** Because AutoDS is fundamentally an orchestration/automation layer over other suppliers
rather than an independent inventory source, it does not cleanly satisfy "second supplier for
catalog breadth / reduced single-supplier risk" — it would still ultimately depend on suppliers like
AliExpress/CJ underneath.

Sources: [AutoDS API](https://www.autods.com/api/), [AutoDS API help center](https://help.autods.com/en/articles/12699964-autods-api-feature-automate-product-imports-orders-and-sourcing), [ecommerce-times AutoDS 2026](https://ecommerce-times.com/autods-in-2026-automation-powerhouse-or-overpromised-platform-3/), [alidropship AutoDS scam review](https://alidropship.com/is-autods-a-scam/)

---

## 4. Eprolo

**API access reality:** **No public API docs.** EPROLO's own developer page
([eprolo.com/eprolo-api](https://eprolo.com/eprolo-api/)) instructs you to create an account and
message your assigned Account Support Rep to request API access — documentation is sent manually,
not published. Endpoint coverage, auth scheme, and pricing are all UNVERIFIED. This is a
support-mediated/partner-gated model, not self-serve.

**API surface fit:** UNVERIFIED — page only states the API enables "automated dropshipping
services" with no capability breakdown.

**US warehouse reality:** EPROLO advertises "3PL Warehousing" as a separate service but no
geographic specifics were surfaced; no confirmed US-warehouse SKU count.

**Dog/pet niche depth:** Publishes pet-supplies dropshipping guides/content
([eprolo.com/pet-supplies-dropshipping](https://eprolo.com/pet-supplies-dropshipping/)), suggesting
category interest, but no catalog-size evidence.

**Commercials:** Markets itself as "Forever Free Dropshipping Platform" for the core app; API
pricing UNVERIFIED.

**Reliability/reputation:** No 2025–2026-specific sentiment gathered in this pass (time-boxed).

**Verdict:** Fails the key test — no attainable self-serve API; would require a support
relationship and unknown terms before any integration work could even be scoped.

Sources: [EPROLO API page](https://eprolo.com/eprolo-api/), [EPROLO pet supplies guide](https://eprolo.com/pet-supplies-dropshipping/)

---

## 5. HyperSKU

**API access reality:** **No public API found.** Search turned up only third-party shipment-tracking
integrations (TrackShip pulling HyperSKU tracking data) and a shipping-rate connector module
(JsRates) that appears to scrape/use HyperSKU credentials rather than a documented HyperSKU-owned
API. No developer portal, no docs, no mention of a retailer-facing API in HyperSKU's own materials.
**No public API found.**

**API surface fit:** N/A — no API to evaluate.

**US warehouse reality:** HyperSKU markets "5 to 12 day worldwide delivery" via a global supply
network — framing suggests standard China-ships-worldwide model, not a strong US-warehouse story.
UNVERIFIED beyond that.

**Dog/pet niche depth:** Not assessed — moot given no API path.

**Commercials/Reliability:** Not deeply assessed given the API gate fails immediately.

**Verdict:** Eliminated — Shopify-app-only integration, no adapter path.

Sources: [HyperSKU Shopify App Store](https://apps.shopify.com/hypersku), [TrackShip HyperSKU](https://trackship.com/shipping-provider/hypersku/), [JsRates HyperSKU](https://help.jsrates.com/article/tools-hypersku)

---

## 6. USAdrop

**API access reality:** **No public API found.** USAdrop presents exclusively as a Shopify/app-store
integration ("auto order sync, bulk import, real-time tracking" inside the app), with no developer
docs, API reference, or mention of programmatic access outside the app itself.

**API surface fit:** N/A.

**US warehouse reality:** Claims 18 global warehouses incl. a US option (2–5 day shipping) alongside
China facilities, 1M+ products — a real US-warehouse story on paper, but unverified independently
and irrelevant without an API to call it through.

**Dog/pet niche depth:** Claims "7+ niches" generically; no pet-specific evidence found.

**Verdict:** Eliminated on the same "app-only" grounds as HyperSKU — good marketing on US fulfillment
but no adapter path.

Sources: [USAdrop](https://usadrop.com/), [USAdrop Shopify App Store](https://apps.shopify.com/usadrop)

---

## 7. Doba

**API access reality:** Doba has the **most substantive real API of the group** — a documented
Retailer API (Product, Order, Payment management, Shipping, Basic Information modules) built on
**SOAP/WSDL**, dating back over a decade
([legacy developer portal](https://legacy.doba.com/developer/api_introduction_retailer.php) — this
URL is now unreachable/connection-refused as of this research, suggesting the legacy docs site may
be deprecated or migrated — UNVERIFIED current location). Access requires the **Enterprise plan**
(~$254.99/mo per 2026 pricing pages) plus a separate "Apply to be a developer" application process
— i.e., partner-gated behind a specific high-tier subscription, not self-serve at lower tiers.
Doba is still an active, operating company in 2026 (recently shipped an AI agent feature, "Doba
Pilot," per company announcements) — not defunct, but its API stack (SOAP/WSDL) is dated
architecture that would require more integration effort than a modern REST/JSON supplier.

**API surface fit:** On paper this is the closest match to CJ's 19-method shape — Product, Order,
Payment, Shipping, and Basic Info as five discrete API groups strongly implies coverage of catalog
search, order placement, payment, and shipping/freight. Per-warehouse stock and webhook/tracking
granularity are UNVERIFIED (couldn't access current docs to confirm).

**US warehouse reality:** Doba is a long-standing US dropship aggregator/network; not independently
verified for a specific US-warehouse SKU count in this pass.

**Dog/pet niche depth:** Not independently assessed this pass — UNVERIFIED.

**Commercials:** Enterprise plan ≈ $254.99/mo (one source cites $299.99/mo — figures vary by
promo/timing) is the gate for API/developer access — notably the most expensive entry price of any
candidate here, on top of whatever the actual per-order/product economics are.

**Reliability/reputation:** Not deeply assessed this pass; Doba is one of the oldest names in US
dropshipping (founded 2002), which cuts both ways (proven longevity vs. legacy technical debt).

**Verdict:** Real API, real US-based operator, but (a) expensive gate ($250+/mo just to unlock
developer access), (b) SOAP/WSDL is a heavier integration lift than CJ's REST API, and (c) the
public docs portal appears to be in flux/inaccessible right now, which is itself a risk signal for
committing engineering time.

Sources: [Doba pricing](https://www.doba.com/pricing), [Doba Enterprise & Developer FAQ](https://faq.doba.com/enterprise-developer) (404 on fetch — page moved/removed), [Doba legacy API intro](https://legacy.doba.com/developer/api_introduction_retailer.php) (connection refused on fetch), [Doba 2026 review](https://ecommerce-platforms.com/ecommerce-reviews/doba-review)

---

## 8. Wholesale2B

**API access reality:** Wholesale2B has a **dedicated, named API product** — the "Dropship API"
([wholesale2b.com/dropship-api-plan.html](https://www.wholesale2b.com/dropship-api-plan.html)) —
marketed explicitly for developers wanting to build custom integrations rather than using the
canned Shopify/BigCommerce/WooCommerce apps, with "thorough documentation" referenced on the page
itself and a requirement to install API credentials into your own backend. This reads as the most
self-serve-sounding option of the group, though **actual pricing was not disclosed** on the page (it
mentions "Free Signup" but no visible API-tier cost), and no direct link to a technical
endpoint/reference doc was found in this pass — UNVERIFIED whether genuine OpenAPI-style docs exist
publicly or are handed over post-signup.

**API surface fit:** Claims: catalog access (1.5M+ products / 100+ suppliers), product detail
(images, pricing), real-time inventory, unlimited order processing, and **webhooks for tracking
codes** pushed back to the retailer. This is the only candidate besides Doba where webhooks are
explicitly claimed. Freight/quote and per-warehouse stock granularity UNVERIFIED. Payment-in-API
UNVERIFIED.

**US warehouse reality:** Not independently confirmed — Wholesale2B aggregates from 100+ suppliers,
so "US warehouse" would vary by supplier within its network, similar to the AutoDS caveat.

**Dog/pet niche depth:** Not assessed this pass — UNVERIFIED.

**Commercials:** Pricing UNVERIFIED for the API-specific plan (general Wholesale2B store plans are
historically low-cost, ~$29–$40/mo range, but that figure was not directly re-confirmed here for the
API plan specifically — treat as UNVERIFIED).

**Reliability/reputation:** Not deeply assessed this pass.

**Verdict:** Promising *on paper* as a named, documented API product — but the aggregator-of-100-
suppliers model means catalog/warehouse consistency and product quality are inherently variable
(same structural risk as AutoDS/Wholesale2B-style meta-platforms), and cost/full docs need direct
verification before committing engineering time.

Sources: [Wholesale2B Dropship API plan](https://www.wholesale2b.com/dropship-api-plan.html), [Wholesale2B best dropship API services](https://www.wholesale2b.com/best-dropship-api-services.html)

---

## 9. Syncee

**API access reality:** Syncee's primary integration model is **datafeed-based** (CSV/XML/XLS(X)/
JSON via URL, Google Drive/Docs, Dropbox, or SFTP), with API/SOAP listed as options only reachable
by **contacting Syncee support for personalized setup** — i.e., not a published self-serve REST API.
This is closer to "partner-gated on request" than a real developer portal.

**API surface fit:** UNVERIFIED beyond order/tracking sync, which is described in marketing copy
("automatically synchronizes paid orders... into supplier's Syncee account... automates order and
tracking synchronization") — but that's the supplier-facing side; the retailer-facing programmatic
surface (beyond the app) is unclear.

**US warehouse reality:** Syncee markets US/EU/UK+ supplier coverage prominently (per its Shopify
listing tagline), a positive signal, but catalog size specific to US warehousing UNVERIFIED.

**Dog/pet niche depth:** Not assessed — UNVERIFIED.

**Commercials/Reliability:** Not deeply assessed this pass.

**Verdict:** No real self-serve API — datafeed + support-mediated API/SOAP "on request" does not
meet the bar of "realistically attainable comparable integration."

Sources: [Syncee](https://syncee.com/), [Syncee Shopify App Store listing](https://apps.shopify.com/syncee-1), [Syncee FAQ](https://syncee.com/faq)

---

## 10. Modalyst

**API access reality:** Modalyst (Wix-owned since 2021, reportedly ~4 employees as of 2026 — a
small, likely maintenance-mode team) offers a **"Supplier API"**, but per its own materials this is
aimed at *suppliers* with 5,000+ SKUs who want to push their catalog into Modalyst — i.e., it's a
feed-in API for brands/suppliers joining the marketplace, not a retailer-facing order/fulfillment
API for stores like ours to pull from. For retailers, Modalyst's integration is the Shopify/Wix
one-click sourcing app only. **No retailer-facing public API found.**

**API surface fit:** N/A for our use case (search/order/tracking as a retailer) — the only
documented API direction is supplier-onboarding, the opposite of what we need.

**US warehouse reality:** Modalyst is positioned around "10M dropshipping products, US suppliers, &
AliExpress" — real US-supplier marketing, but access to that catalog is app-only, not API.

**Dog/pet niche depth:** Not assessed — moot given no retailer API.

**Verdict:** Eliminated — small team, no retailer-facing API, essentially in maintenance mode
inside Wix's portfolio (risk of further deprioritization).

Sources: [Modalyst](https://www.modalyst.co/), [Modalyst supplier application](https://support.modalyst.co/en/articles/1005258-what-is-the-application-process-for-becoming-a-supplier), [PitchBook Modalyst profile](https://pitchbook.com/profiles/company/92165-50)

---

## Adjacent option A: Shopify Collective

**Fit:** Native Shopify feature — **no adapter needed at all**, since Collective orders/fulfillment/
payment splitting are handled entirely inside Shopify's own admin and checkout, not via any external
API our `SupplierAdapter` would call. This structurally sidesteps the entire integration question.

**Eligibility:** Retailer must be US-based, selling in USD, with Shopify Payments active and
**≥$50,000 in trailing-12-month sales** — doge-buddy would need to confirm it clears that bar.

**Margin model:** Suppliers set wholesale/cost price; retailer sets resale price; margin is simply
resale − wholesale. Typical observed retailer margins **20–40%** (range cited 20–50% depending on
supplier) — likely **thinner than CJ dropshipping margins**, since Collective suppliers are branded
US companies pricing at real wholesale, not commodity China-manufactured goods at dropship cost.

**Verdict:** Worth pursuing in parallel as a *complementary, zero-engineering* channel for
higher-quality/branded US dog products — but it's not a substitute for "a second CJ-like supplier"
in the adapter sense; it's a different distribution model entirely (curated wholesale marketplace,
not a programmable inventory source).

Sources: [Shopify Collective for retailers](https://help.shopify.com/en/manual/online-sales-channels/shopify-collective/retailers), [Craftybase Shopify Collective guide](https://craftybase.com/blog/shopify-collective-guide), [Cropink Shopify Collective guide](https://cropink.com/shopify-collective)

---

## Adjacent option B: AliExpress Dropshipping API (with US-warehouse filtering)

**API access reality:** A real, official **AliExpress Open Platform API** exists (migrated from the
legacy Taobao Open Platform), including dropshipping-specific product/order endpoints ("Dropshipping
API," product-by-ID lookup, order push/sync, tracking updates). Access requires signing the Open
Platform Agreement and getting your app approved through the Developers Console; once approved you
get an App Key/Secret and a documented rate limit (cited as 5,000 — units UNVERIFIED, likely
calls/day or similar). This is a real, self-serve-ish (application-gated but not enterprise-sales-
gated) API — structurally the most "CJ-like" of anything reviewed outside CJ itself.

**Why it's probably not the answer regardless:**
1. **US warehouse filtering is not a first-class, reliable API feature.** "Ships from United States"
   is a per-listing seller attribute on the consumer-facing site, not a documented, dependable query
   filter in the Open Platform API — UNVERIFIED whether the API even exposes warehouse/ship-from
   country as a structured, filterable field the way CJ's adapter does.
2. **Regulatory shift, 2025:** the US removed the de minimis exemption (May 2025, expanded globally
   by August 2025), so most AliExpress orders shipped to US customers — including ones that
   previously undercut on price — are now subject to formal customs duties, eroding the traditional
   AliExpress cost advantage regardless of API quality.
3. **Product/seller quality control is inherently the open marketplace itself** — no vetting layer
   like CJ or Spocket provide; variance in fulfillment reliability per individual seller is a known,
   long-standing dropshipping pain point.
4. **Anecdotal/industry signal** that Alibaba has tightened dropshipping-specific API access over
   time relative to its general open platform, though no explicit 2025–2026 policy announcement
   restricting individual developers was found (UNVERIFIED either way).

**Verdict:** Technically the most "real API" among alternatives, but the US-warehouse story and
post-2025-tariff economics make it a weak fit for the stated goal (US-warehouse catalog breadth) —
better thought of as "more CJ-like risk, without CJ's US-warehouse curation," not a genuine
risk-diversification move.

Sources: [Zuplo AliExpress API guide](https://zuplo.com/learning-center/aliexpress-api-guide), [Elfsight AliExpress API key guide 2026](https://elfsight.com/blog/how-to-get-and-use-aliexpress-api-key/), [Shopify AliExpress dropshipping guide 2026](https://www.shopify.com/blog/117607173-the-definitive-guide-to-dropshipping-with-aliexpress), [dodropshipping US suppliers on AliExpress](https://dodropshipping.com/how-to-find-us-dropshipping-suppliers-on-aliexpress/)

---

## Ranked shortlist: top 2 for "second CJ-like supplier we could actually integrate"

**#1 — Zendrop (MCP-based programmatic access)**
Real, scoped, HTTP-callable API surface (catalog:read/orders:read/write/stores/billing) exists today,
free of enterprise sales gates, with US-warehouse SKUs available at the $49/mo Pro tier and an
existing pet-products vertical. **Biggest risk:** the API is architected and marketed as an
MCP/AI-agent tool-calling layer, not a stable, versioned REST contract for backend systems — Zendrop
could change scopes/rate limits/availability without the guarantees a "real" developer API implies,
and key gaps (freight quoting, per-warehouse stock, disputes, webhooks) are undocumented, meaning
real engineering discovery work (and possibly a support/partnership conversation) would be needed
before committing to build the adapter.

**#2 — Doba (Retailer API: Product/Order/Payment/Shipping/Basic Info)**
The closest structural match to CJ's 19-method shape and the only candidate besides Wholesale2B
with API-documented webhook/shipping modules, from a long-established (2002-founded), still-active
US operator. **Biggest risk:** the API is legacy SOAP/WSDL (heavier integration lift than JSON/REST),
gated behind the priciest single-tier commitment in this survey (~$250+/mo just for Enterprise/
developer eligibility, separate from per-order economics), and the public developer-docs URLs found
in this research were unreachable/404 — a real signal that the self-serve path may have degraded or
moved, which needs a direct sales conversation with Doba before assuming the integration is even
still offered as described.

**Honorable mention / worth a scoping call, not yet a recommendation:** Wholesale2B — the only other
candidate with an explicitly named, marketed "Dropship API" product with webhook claims, but pricing
and doc depth couldn't be confirmed in open search and need direct verification.

**Not recommended:** AutoDS and Wholesale2B-style aggregators are meta-layers over other suppliers,
not independent inventory sources, undermining the "risk diversification" goal. HyperSKU, USAdrop,
Modalyst, and Syncee have no genuine retailer-facing API (app-only or support-mediated at best).
Eprolo is fully support-gated with zero public technical detail. AliExpress's official API is real
but structurally mismatched to the "US warehouse" requirement and now faces adverse 2025 tariff
economics. Shopify Collective is a good complementary channel but isn't an adapter-shaped
integration at all.


---

## Appendix B — trend-source research (agent report, sources inline)

# Trend / winning-product data sources for a dog-niche sourcing agent (post-Google-Trends)

Research date: 2026-09-02. WEB RESEARCH ONLY. All claims sourced; anything not independently corroborated is marked UNVERIFIED.

---

## 1. TikTok Shop analytics platforms (Kalodata, FastMoss, EchoTik, Shoplus)

### Kalodata
- Pricing: Starter $45.90/mo (~$38.30/mo annual) — 50 searches/day, 100 detail views/day, 10 tracked shops, 90-day history. Professional $99.90–109.99/mo (recent price hike). Enterprise = custom, and **Enterprise tier is where API access lives**. [Creatify](https://creatify.ai/blog/kalodata-pricing-plans-and-what-you-ll-actually-pay-in-2026), [SimpTok](https://simptok.com/how-much-is-kalodata/)
- Access: dashboard-first product; "a dashboard for product and creator trends rather than a raw data API." CSV/creator exports at Professional tier; full API only at Enterprise (quoted). [Creatify](https://creatify.ai/blog/kalodata-pricing-plans-and-what-you-ll-actually-pay-in-2026)
- Data: 200M+ creator profiles, 400M+ video records, up to 500 days history. [Creatify](https://creatify.ai/blog/kalodata-pricing-plans-and-what-you-ll-actually-pay-in-2026)
- Credibility: Kalodata (like all these tools) has **no official TikTok Shop data access** — it estimates sales from public signals/proprietary modeling, not real order/settlement data. TikTok users have called it "completely inaccurate" in spots; practitioners on Reddit note these tools "estimate sales without API access" and recommend TikTok's own Creator Center as ground truth. [WinningHunter](https://winninghunter.com/insights/kalodata-review/), [TikTok discovery thread](https://www.tiktok.com/discover/why-does-kalodata-data-not-match-mine)

### FastMoss
- Pricing: Basic ~$47–49/mo, Pro ~$71/mo, Ultimate ~$90/mo (annual-equivalent). 7-day trial. [SpotSaaS](https://www.spotsaas.com/blog/fastmoss-review-2026-features-pricing-and-tiktok-shop-analytics-guide), [Software Finder](https://softwarefinder.com/marketing-software/fastmoss)
- Access: conflicting reports — one source says no API at all; another says API/custom exports exist for Enterprise, quoted on a call. Treat as **UNVERIFIED / dashboard-only in practice**. [Dashboardly](https://www.dashboardly.io/post/fastmoss-vs-kalodata-the-2025-battle-for-tiktok-shop-analytics-supremacy)
- Credibility: same estimation-based caveat as Kalodata; wins on creator intelligence/UI, Kalodata wins on historical depth. [Trenz.ai](https://www.trenz.ai/resource/kalodata-vs-fastmoss-comparison-guide)

### EchoTik
- Pricing: from **$9.90/mo** — cheapest in the category (~75% less than Kalodata's starter). Strong free tier (no card, no time limit) with real product/creator/shop data. [EchoTik blog](https://www.echotik.live/blog/echotik-vs-shoplus-vs-fastmoss/)
- Features: AI trend detection flagging momentum before peak; shop/live-stream tracking in free tier. [EchoTik blog](https://www.echotik.live/blog/echotik-vs-shoplus-vs-fastmoss/)
- Access: dashboard/browser-extension oriented (Chrome/Firefox); no evidence of a real export/API in results found — UNVERIFIED beyond dashboard.

### Shoplus
- Pricing: $14.90–$49/mo, mid-budget tier. [EchoTik blog](https://www.echotik.live/blog/echotik-vs-shoplus-vs-fastmoss/)
- Positioning: structured dashboard for trending products/sales estimates/category breakdowns — good for "everything about your shop" use case, less of a pure discovery tool. [EchoTik blog](https://www.echotik.live/blog/echotik-vs-shoplus-vs-fastmoss/)

### Pet/dog category coverage (cross-tool signal, via FindNiche)
- FindNiche's 2026 US TikTok pet-supplies trending list shows real category depth: top dog products include CleanFlow™ Pet Bowl, GhostGuard™ Dog Mask, PureFlow™ Pet Fountain (avg. profit margin ~69.77%, low competition); also AI pet cameras, GPS dog collars, joint supplements, LED/rechargeable dog collars (search volume peaks Jan–Feb 2026). Dog products are ~42% of one tracked inventory sample with the highest best-seller rate (11.9%). Top pet-supplies SKU cited: a $24.95 kennel odor eliminator with 2.88K orders/7 days (~$2.68M revenue). [FindNiche](https://findniche.com/tiktok/trending-pet-supplies-products-us), [Accio TikTok Pet Trends 2026](https://www.accio.com/business/tiktok_pet_trends)
- Takeaway: pet/dog is well covered as a category across these platforms — it's a top-tier TikTok Shop vertical, not a niche these tools neglect.

### Verdict on this whole category
All four are estimation-based dashboards, not ground-truth data. None has been confirmed to offer an affordable, general-availability API — API/bulk export is gated behind Enterprise tiers priced on a call (Kalodata) or unclear/absent (FastMoss). For a sourcing **agent** that wants to programmatically ingest signal, none of these plug in cleanly without either (a) paying for an enterprise contract, or (b) building a scraper against a dashboard (ToS risk, see §2). EchoTik at $9.90/mo is the cheapest way to get a human check on TikTok Shop pet trends, but it's a manual/dashboard workflow, not agent-integrable today.

---

## 2. Official / free TikTok routes

- **TikTok Creative Center** (free): "Top Products" leaderboard (Creative Center > Trends > Top Products), filterable by region (US/UK/SEA), category (Beauty, Electronics, Home & Garden, Sports, Fashion — no explicit "Pets" category surfaced in results), and 7-day/30-day windows. Free for advertisers, browser-only. [bir.ch](https://bir.ch/blog/tiktok-creative-center), [Stackmatix](https://www.stackmatix.com/blog/tiktok-creative-center-guide)
- **No usable official API for commercial trend scanning.** TikTok's official Research API is restricted to qualifying academic institutions, ~4-week approval, capped at 1,000 requests/day, and **explicitly prohibits commercial use**. "For any developer, agency, or data team building a product on TikTok data, the official path is effectively closed." [ScrapeBadger](https://scrapebadger.com/blog/tiktok-scraping-apis-in-2026-the-complete-deep-guide)
- This is distinct from the **TikTok Shop Seller API**, which is an operational API for merchants managing their *own* shop (orders, listings, fulfillment) — not a trend/discovery API, and not useful for external market research. Native Seller Center tools show only your own account; third-party platforms are what analyze external/competitor/market signals. [Moras.ai](https://moras.ai/blog/tiktok-shop-toolkit), [KeyAPI](https://www.keyapi.ai/blog/tiktok-shop-api-integration-guide-sellers/)
- **ToS constraint**: third-party scraping of Creative Center (e.g., Apify's Creative Center Scraper) exists and works technically, but sits outside TikTok's terms — treat as a gray-area/manual-only tool, not something to wire into an autonomous agent without legal sign-off. [Apify](https://apify.com/doliz/tiktok-creative-center-scraper/api)

---

## 3. Amazon signals (Movers & Shakers / BSR movement, pet supplies)

- **Amazon Movers & Shakers** (free, on amazon.com/gp/movers-and-shakers) tracks the biggest 24-hour BSR gainers per category, refreshed hourly — but it's a public webpage, not an API. [Amazon](https://www.amazon.com/gp/movers-and-shakers)
- **SerpApi's Amazon Search API** (`engine=amazon`) — **we already pay for SerpApi** — can query Amazon category pages including Best Sellers/Movers & Shakers-style listings and is explicitly pitched for "discovery tools, dropshipping research, and competitive intelligence feeds." This is likely the cheapest integration path since it rides the existing SerpApi contract rather than a new vendor. [SerpApi Amazon Search API](https://serpapi.com/amazon-search-api), [SerpApi blog](https://serpapi.com/blog/product-market-research-using-amazon-search-api/)
- **Keepa API**: €49/mo minimum (no free tier), 20 tokens/minute, ~892,800 tokens/mo on the cheapest plan; 1 token = full data (price history, BSR, reviews, Buy Box history) for 1 ASIN across 6B+ tracked products. Separate from the €29 "Keepa Pro" browser-extension subscription. No pet-specific pricing found — general catalog access. [RevenueGeeks](https://revenuegeeks.com/software/keepa/api), [Keepa API docs](https://keepa.com/api-docs/)
- **Jungle Scout API**: add-on starting ~$49/mo depending on usage tier, delivers Amazon data (search volume, sales estimates, competition) into your own systems; overage/custom pricing on request. Whether non-sellers (i.e., a store not selling on Amazon, just researching it) can access it wasn't confirmed either way — UNVERIFIED. [Demandsage](https://www.demandsage.com/jungle-scout-pricing/)
- **SP-API (official Amazon Selling Partner API)**: requires a professional Amazon seller account or being an authorized third-party developer for a seller. Standard data (orders, inventory, listings, reviews) needs regular approval; PII-adjacent data needs an additional annual-renewal approval. **This is not a general market-research API** — it's built for people who operate an Amazon seller account, which doge-buddy does not. Effectively not viable for this use case. [Amazon SP-API docs](https://developer-docs.amazon.com/sp-api/docs/amazon-seller-data-access)
- **Practical read**: for Amazon signal, the SerpApi Amazon engine (already paid for) is the lowest-friction option since it needs no new contract; Keepa is the credible dedicated option if deeper BSR/price-history time series becomes worth ~$49+/mo; SP-API and Jungle Scout are poor fits (seller-account-gated or unclear non-seller access).

---

## 4. Other trend sources

- **Pinterest Trends / API**: The **official Pinterest API's Trial and Standard tiers are free**, but require a Business account + OAuth + app approval, and only expose *your own* account data — not broad market trend search. Pinterest does not offer a public search endpoint via its official API. [Blotato](https://www.blotato.com/blog/pinterest-api-pricing)
  - Free third-party workaround: **Apify's Pinterest Trends Scraper** — free tier gives unlimited trending lookups and keyword research on up to ~40 seed keywords/run, including real search volume, seasonality, and 52-week history. This is the most promising **free, keyword-expansion-shaped** signal here, directly analogous to what Google Trends rising-queries already does — could be a natural complement (Pinterest skews toward home/lifestyle/pet-owner demographics). [Apify Pinterest Trends Scraper](https://apify.com/automation-lab/pinterest-trends-scraper/api)
- **Exploding Topics**: Business plan (full trends DB, forecasting, 2,000 tracked trends) from $249/mo; the **API is a separate paid add-on** on top of that — $1,000/mo for 1,000 requests, $2,000/mo for 5,000, $4,000/mo for 25,000. This is expensive relative to doge-buddy's likely scale and clearly overkill unless volume of keyword mining is very high. [explodingtopics.com/feature/et-api](https://explodingtopics.com/feature/et-api)
- **Glimpse**: positioned as a Google Trends enhancer (forecasting, search volume, alerts). Tiers: Hobbyist $0, Pro $99/mo (~250 lookups/mo), Expert $299/mo, Enterprise custom. **API access is an Enterprise-only add-on, not included even at $299/mo** — no published price. Given we already pay for SerpApi's `google_trends` engine and are already adding rising-related-queries, Glimpse looks like a partial, pricier duplicate of what's already planned rather than new signal. [meetglimpse.com](https://meetglimpse.com/google-trends-api/), [OutlierKit](https://outlierkit.com/resources/glimpse-pricing/)
- **Reddit API**: Free tier exists but is restrictive; **commercial tier is $12,000/mo for up to 50M calls** (with true cost often higher once overage/retry/engineering time is counted), manual approval taking 2-4 weeks. This is wildly disproportionate to what a sourcing agent would need from r/dogs-style mining. [Techloy](https://www.techloy.com/reddit-api-pricing-in-2026-complete-guide-for-developers-and-businesses/), [companieshistory.com](https://www.companieshistory.com/what-reddit-data-actually-costs-in-2026-beyond-the-sticker-price)
  - Cheaper unofficial path (scraping r/dogs, r/DoggyDNA, etc., via SerpApi's general search engines or a scraper) wasn't priced separately but would carry the same ToS gray-area risk as TikTok scraping — not recommended for an autonomous, always-on agent.
- **SerpApi engines already paid for that add signal beyond google_trends**: SerpApi has 80+ engines including **YouTube search**, **Amazon**, eBay, Walmart, Google Shopping, Google Images, Bing, etc. — all under the same existing contract/credit pool. [ScrapeCreators SERP API comparison](https://scrapecreators.com/blog/serp-api-comparison), [OpenWeb Ninja](https://www.openwebninja.com/blog/best-serp-apis-2026)
  - Note: google_trends queries draw from the **same shared credit pool** as every other SerpApi engine (plans run $25/mo for 1K searches up to $275/mo for 30K searches; unused credits don't roll over) — so adding YouTube-search or Amazon-engine calls competes for the same quota already budgeted for Google Trends. This matters for capacity planning once rising-queries + YouTube + Amazon calls all draw from one plan. [BuildMVPFast](https://www.buildmvpfast.com/tools/api-pricing-estimator/serpapi), [SocialCrawl](https://www.socialcrawl.dev/blog/best-google-trends-apis-2026)

---

## 5. What successful dropshippers actually use (2025–2026 community consensus)

- Practitioner rule of thumb surfacing across sources: **"find on TikTok, validate on Meta, look to Pinterest for what everyone else missed"** — i.e., no single source is trusted alone; cross-referencing across platforms is the norm because a product can look untouched on one platform and be saturated on another. [Minea](https://www.minea.com/dropshipping-winning-products)
- TikTok is treated as the earliest-signal platform for impulse/demonstration products (short-form video rewards visible before/after content), meaning products can go from unknown to saturated within weeks — supporting the urgency of getting *some* TikTok signal into the pipeline, even an imperfect one. [Minea](https://www.minea.com/dropshipping-winning-products)
- Community-favored **tools actually named across 2026 buyer's-guide content**: Sell The Trend (all-in-one + AI "Nexus" finder), AliExpress Dropshipping Center (free), Dropship.io (Shopify + TikTok Shop-specific), Thieve.co, Helium 10 / ZIK Analytics (Amazon-side), and **Dropship Spy** — notable because it explicitly aggregates across TikTok, AliExpress, Google Shopping, Amazon, Reddit, Google Trends, Shopify, and Meta Ad Library in one place, matching the multi-source philosophy above. None of these were confirmed in results to be Kalodata/FastMoss/EchoTik-caliber TikTok-Shop-specific analytics — they're closer to general dropshipping product finders. [ZIK Analytics roundup](https://www.zikanalytics.com/blog/best-dropshipping-product-research-tools/), [dodropshipping.com](https://dodropshipping.com/best-dropshipping-product-research-tools/)
- Testing discipline mentioned: successful sellers test 3–5 items/week across categories and scale only proven winners — i.e., tooling is there to generate a *candidate list*, not to make the final call; validation still happens empirically. [source cluster on winning products 2026](https://www.tradelle.io/blog/12-viral-dropshipping-products-for-february-2025/)
- **No source found claiming any single paid trend tool is the thing "nobody wins without."** The consensus leans toward triangulating cheap/free signals (TikTok discovery + Google/Pinterest Trends + Meta Ad Library) over any one paid subscription — reinforcing that expensive Enterprise-tier APIs (Reddit $12K/mo, Exploding Topics API $1-4K/mo) would be buying more precision than the market itself seems to rely on.

---

## Ranked recommendation: best next 1–2 trend inputs after Google Trends

1. **SerpApi's existing Amazon engine (`engine=amazon`) for Movers & Shakers / Best Sellers in pet supplies — $0 incremental cost (rides the existing SerpApi plan).**
   - Integration path: API call, same auth/contract already in place for `google_trends`; JSON response, straightforward to parse into the sourcing pipeline.
   - Why: zero new vendor relationship, zero new billing, matches the exact "market price + demand corroboration" role SerpApi already plays for the sourcing agent, and Amazon BSR movement is a credible, non-gamed demand signal to cross-check against CJ/TikTok candidates. Caveat: won't be dog-specific by default — needs category-scoped queries (e.g., Pet Supplies best-seller pages).

2. **EchoTik at $9.90/mo (or its free tier) as a human-in-the-loop TikTok Shop check — manual/dashboard, not agent-integrated.**
   - Integration path: manual/dashboard only (no confirmed API/export); use it as a cheap weekly spot-check by a human before greenlighting a TikTok-sourced candidate, not as an automated feed.
   - Why: cheapest way to get real TikTok Shop pet-category signal (top sellers, revenue estimates, creator/video velocity) without committing to Kalodata/FastMoss's $45-100+/mo tiers or their enterprise-gated APIs, and it already flags pet/dog as well-covered. Treat all its numbers as directionally estimated, not ground truth (community consensus: these tools estimate, they don't have real TikTok Shop transaction data).

### What to explicitly skip and why
- **Kalodata / FastMoss / Shoplus paid tiers** — $45-100+/mo dashboards whose API/export access is Enterprise-gated and quoted on a call; not worth committing to before EchoTik (cheaper) or SerpApi-Amazon (free) are exhausted. Revisit only if the agent needs deep creator/video-velocity data EchoTik's free tier doesn't cover.
- **Reddit API commercial tier ($12,000/mo)** — wildly disproportionate to a niche keyword-mining use case; if r/dogs sentiment mining is wanted, do it manually/occasionally rather than building an always-on integration.
- **Exploding Topics API ($1,000-4,000/mo on top of a $249/mo Business plan)** — general cross-industry trend forecasting, not dog/pet-specific, and priced for a scale doge-buddy doesn't need yet.
- **Glimpse** — its API is Enterprise-only/unpriced, and its core value (better Google Trends UX/forecasting) heavily overlaps with the SerpApi `google_trends` engine already being wired in; would be paying twice for a similar signal.
- **Amazon SP-API** — gated behind having a professional Amazon seller account; not applicable since doge-buddy doesn't sell on Amazon.
- **TikTok Creative Center scraping / TikTok Research API** — Research API commercially prohibited by TikTok's own terms; Creative Center scraping is a ToS gray area unsuitable for an always-on autonomous agent (fine as an occasional manual check via the dashboard itself, free).
- **Jungle Scout / Keepa** — credible but Amazon-general-catalog tools with real monthly cost ($49+/mo) and no pet-specific pricing edge over the free/already-paid SerpApi Amazon engine; only worth it if BSR time-series depth becomes a bottleneck.

## Biggest overall finding
Every TikTok Shop "analytics" platform (Kalodata, FastMoss, EchoTik, Shoplus) is built on **estimated, non-official data** — none has real TikTok Shop transaction access, and their own users/Reddit describe the numbers as sometimes "completely inaccurate." Meanwhile, official TikTok trend APIs are commercially closed. So there is no clean, accurate, agent-integrable TikTok trend API at any price in 2026 — the realistic move is triangulation (cheap/free TikTok dashboard spot-checks + Amazon BSR signal we already have access to via SerpApi + Pinterest's free trend scraper) rather than buying a single "TikTok trends" subscription and trusting its numbers.

---

## UPDATE 2026-09-03 — Zendrop PROBED WITH A REAL TOKEN. Verdict: do NOT build the adapter.

Robert bought Zendrop **Plus** ($79/mo) on 2026-09-03 and generated an access token; the
`probe-zendrop` script (`apps/ops/scripts/probe-zendrop.ts`, `--deep` for read-only tool calls)
captured the real MCP surface and catalog shapes. The 2026-09-02 recommendation above
("#1 — Zendrop") is **SUPERSEDED by this section**: the API is real and better than expected, but
the CATALOG behind it does not fit this store.

### What the API actually exposes (38 tools, verified)

Good: `get_catalog_products` (with a real `ships_from` ISO-country filter), `get_catalog_product`,
`get_catalog_shipping_estimate`, `get_order` + `get_tracking_events`, `get_billing_credit_balance`,
a **full dispute suite** (`create_order_issue` / `get_order_issues` / `reply_order_issue` /
`process_order_issue` — stronger than CJ's), `get_order_fulfillment_cost` (two-step cost preview),
and `link_my_product` — which would have let us keep our own listing pipeline (create the Shopify
product our way, then LINK it for fulfilment) instead of Zendrop's import-list flow.
Absent: reviews and webhooks (both degradable — we already poll for CJ).

### Why it fails anyway — the catalog census (the decisive data)

`get_catalog_products keyword="dog" ships_from=US`, 5 pages x 60 = **281 products**:

| Supplier | Products | Note |
|---|---|---|
| **Amazon Products (id 417)** | **276 (98%)** | a reseller of Amazon goods |
| NexoraUSA (id 416) | 5 | furniture-style dog cages, $86+ |

A 19-product US sample across harness/bed/toy/leash/bowl:

- **Landed cost is at or above Amazon retail.** Dog harnesses came back $12.86-$21.05 + $6.99
  freight = **$19.85-$28.04 landed**, against the **$16.98 Amazon median** measured the same night
  by our own gate. Buying from an Amazon reseller to undersell Amazon is arithmetically impossible.
- **1 of 19 shipping options carried a delivery estimate** (`estimated_delivery: null` on the rest).
  The storefront promises 3-7 day delivery on every product page and the freight gate filters
  options by `maxDays` - neither can be honoured from this data.
- **0 of 19 had numeric or tracked stock** (`available: null, tracked: false`). Stage 6 requires
  verified US stock >= 1; the only signal available is an untracked `in_stock` boolean.
- **0 of 19 had more than one catalog variant**, and catalog variants carry no SKU, options, or
  per-variant price - so the v2 multi-variant listing pipeline has nothing to build from, and
  margin cannot be computed per variant at sourcing time.
- `get_stores` returned **zero connected stores**: the entire order path (`fulfill_order` operates
  on orders Zendrop pulled from a connected store) requires connecting our Shopify store, which
  would let Zendrop see and potentially fulfil **CJ-sourced orders too** - a double-shipping hazard
  that would need `update_store_settings` fulfilment-mode discipline plus supplier-aware routing.

### Ruling

**Do not build a `ZendropSupplierAdapter`.** Cancel or downgrade the Plus subscription before it
renews unless it is being kept for its *human* value: Zendrop's private-listing/sourcing-agent
service (the Plus feature) is a manual workflow, not an API surface - nothing in the searchable
catalog is exclusive. Re-open this only if Zendrop later exposes delivery estimates, numeric
per-variant stock, and per-variant catalog pricing.

**What this means for supplier breadth:** the constraint was never the number of vendors - it is
that commodity dropship catalogs (CJ's *and* Zendrop's) resell the same goods Amazon sells cheaper.
The escape is DIFFERENTIATED product, not another commodity API: Shopify Collective (branded US
goods, gated at $50k trailing-12-month sales) remains the strongest lane, with a real private-label
or US-distributor relationship as the alternative. Both are post-launch moves.
