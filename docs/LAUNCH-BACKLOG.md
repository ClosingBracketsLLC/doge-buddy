# Launch backlog — what stands between "the plumbing works" and "a shop worth opening"

Audited 2026-08-31 against the REAL store through a local Hydrogen dev server + the Admin API
(read-only). Companion to `OWNER-CHECKLIST.md`'s "Launch runway" (which covers plumbing); this file
is the storefront/catalog work. **P0** = the site is broken or unshoppable without it. **P1** = do
before the official launch. **P2** = after launch. Each item says who does it: **Claude** (code /
scripts, via the house SDD pattern for anything non-trivial) or **Robert** (Shopify admin, decisions).

## What the audit found (facts, not opinions)

- The store has **one collection** (`frontpage`, Online Store only) and **two products** (Dog Snuff
  Pad $29.99, 1 image; Low Noise Pet Hair Clipper $54.99, 3 images), both ACTIVE and published to
  every channel including `doge-buddy` (Hydrogen). Both purchasable ("Add to cart").
- The header's four category links (`/collections/toys-play`, `walks-travel`, `beds-comfort`,
  `grooming-care`) and the hero's "Shop toys" CTA all **404** — those collections were never created
  on this store (the seed's `sample-data.ts` defines them as automated collections keyed on a
  `category:<handle>` tag). `/collections` is an empty page.
- Products carry **no tags, no product type, no SEO title/description**, so even once the automated
  collections exist they would stay empty: the listing worker (`apply-new-listing.ts`) never sets
  `tags`. Product URLs are **`/products/db-proposal-<uuid>`** (the worker uses the proposal id as
  the handle for crash-safe resume).
- Product page renders: one image (the selected variant's — no gallery), title, price, delivery
  badge, add-to-cart, description. No highlights/specs, no shipping-and-returns block, no related
  products, no reviews. Home: hero + "Fan favorites" (the 2 products) only — no category tiles.
- Working as expected: search (regular + predictive), cart, 404s, policies pages (+ `/contact`),
  titles/meta descriptions/favicon, robots.txt, sitemap. `/blogs` exists from the skeleton with an
  empty "News" blog. `/account` redirects to login (Customer Account API).

## P0 — unshoppable without these

1. **Create + publish the four category collections** — *Claude* (script), ~1 task. **BUILT
   2026-08-31 (branch `catalog-p0`, code+tests green; live tier pending).** `pnpm --filter
   @doge-buddy/ops seed-collections` creates the 4 collections from the new `CATEGORIES` source of
   truth (`packages/core/src/catalog.ts`) with a `TAGGED_WITH category:<tag>` rule (the live
   2026-07 schema's actual rule shape — the seed's old `ruleSet` form doesn't exist on this API
   version, which is why the store never had collections) and publishes every one to every
   publication, every run (idempotent healing, not just create-if-missing). Owner runs it — see
   `OWNER-CHECKLIST.md` runway B14(b).
2. **Tag products at listing time** — *Claude*, small. **BUILT 2026-08-31.** The listing worker
   (`apply-new-listing.ts`) now sets `tags: ['category:<tag>']`, `productType`, and `seo` from
   `CATEGORIES` in the same `productSet` call. The 2 live products are repaired by
   `backfill-listings`, not a separate one-off script (see #3 below — same tool does both).
3. **Human product URLs** — *Claude*, small but touches the resume path. **BUILT 2026-08-31.**
   Handle = `slugify(title) + '-' + <first 8 hex of the proposal id>` (deterministic, so
   crash-resume by handle still works; the suffix makes collisions practically impossible). The 2
   live products are repaired by the new `backfill-listings` script (`productUpdate` with
   `redirectNewHandle: true`, so the old `db-proposal-<uuid>` handle 301s on the Online Store —
   more conservative than the "no redirect needed" original plan, decided 2026-08-31 review since
   it costs nothing and the old handle may already be indexed/bookmarked). Decision taken: a
   product with any variant whose CJ stock read fails during backfill counts as `partial`, not
   `updated`, and NEVER has its inventory zeroed (the untracked/selling state is left alone and
   `inventory.sync` heals it later) — a failed read must never make a live product look
   out-of-stock.
4. **Catalog depth — decision for Robert.** **Decision taken 2026-08-31: option (a) plus knobs.**
   Rather than raising the per-run cap globally, `run-sourcing` gained CLI overrides
   (`--keywords`, `--max-winners`, `--budget`, `--candidates`, `--pages`) and matching settings
   (`sourcing.max_winners|candidate_target|max_pages|max_budget_cents`), so the Monday cron stays
   at today's conservative defaults while a manual "build week" (four ~10-minutes-apart runs,
   `--max-winners 8` each, `workflow.sourcing.mode = auto`) can reach ≥40 products fast. Runbook is
   in `OWNER-CHECKLIST.md` runway B14(g). Robert runs it; nothing further to decide.
5. **Inventory policy — decision for Robert.** **Decision taken 2026-08-31: tracked, from CJ's
   stock.** The listing worker now sets `inventoryItem.tracked: true` with a quantity equal to the
   **largest single US-warehouse entry** from `adapter.getVariantStock` (not the cross-warehouse
   sum — `fulfillment/plan.ts` needs one warehouse able to cover the whole order). A failed stock
   read at listing time never blocks the listing (quantity falls back to 0, healed within a minute
   by a post-listing `inventory.sync` job and every 6 h after that by the cron). The 2 live
   products get tracked quantities via `backfill-listings`.

## P1

- [ ] **Sourcing agent upgrades (brainstormed 2026-09-01; all three approved on the recommended
  options — Google Shopping via SerpApi for (1), Google Trends rising related queries for (2),
  advisory performance brief + harvest keyword ordering for (3)).** **(1) BUILT 2026-09-01 (branch `sourcing-market-price`)** — live check pending (one `run-sourcing --max-winners 2`: SerpApi requests ≤ 25, a proposal summary carrying `market $… median ×…`, a `market_price` row in `sourcing_signals` with offerCount ≥ 5). (2) is next to spec.
  Three specs, in this order: (1) competitor-price tool for the agent (Amazon / Google Shopping
  lookup on the top candidates, rule "price ≤ 1.3× market" enforced in Stage 6, not just advised);
  (2) a demand-signal harvest source beyond CJ keyword search (Amazon movers-and-shakers / Google
  Shopping trends per category feeding candidate discovery; also confirm `SERPAPI` is configured on
  Railway — the trends stage degrades silently without it); (3) an outcome feedback loop —
  `product_scores` (units, refunds) biasing the next harvest's keywords/price bands. Today the agent
  is Sonnet 5 + 4 read-only CJ MCP tools + web search; discovery is keyword-only.

- [ ] **Supplier delisting → automatic deprecation proposal.** CJ answers `Variant has been removed
  from shelves` on `getVariantStock` for a delisted variant (seen live 2026-08-31 on the Snuff
  Pad). Today that is just a failed read every 6 h (and a `listing_stock_read_failed` warning);
  `inventory.sync` should recognise that specific error, push quantity 0 (so the storefront says
  Sold out at once), and submit a `deprecate_product` proposal (the manual `deprecate-product`
  script does this by hand meanwhile).
 — before the official launch

6. **Product page: image gallery** — *Claude*, small. Render all `media` (thumbnails + main), not just
   the variant image; the Clipper already has 3 images. Pair with the sourcing agent pulling ≥3 CJ
   images per proposal (the Snuff Pad has 1).
7. **Product page: structured content** — *Claude* (template) + *sourcing agent* (content), medium.
   Highlights (3–5 bullets), a specs block (size/material/weight from CJ data), "What's in the box",
   a **Shipping & returns** accordion sourced from `POLICY_COPY` (no new copy to maintain), the
   TrustStrip near the price, a quantity selector. The agent's `descriptionHtml` should be generated
   in that structure (metafields for bullets/specs, or structured HTML the template parses).
8. **Related products** — *Claude*, small. "You might also like" from the same collection (the
   template already has the hook comment).
9. **Home page** — *Claude*, small. Category tiles under the hero (reuse `CollectionTile` from
   `/collections`), a value-props strip (US warehouses · 3–7 days · all-sales-final honesty), "New
   arrivals" once the catalog exists. Needs #1's collection images.
10. **Kill the skeleton blog** — *Claude*, tiny. Remove `/blogs*` routes (empty "News" blog) or hide
    them from nav/sitemap; add back only when there's content.
11. **About page + footer link** — *Robert* (Shopify → Online Store → Pages → "About", a few honest
    paragraphs) + *Claude* (footer link). Cheap trust; also the natural home for the LLC's legal name.
12. **Customer Account API on the production domain** — *Robert*, before C14. The login flow works on
    the preview host; the Customer Account app's redirect URIs must include `https://dogebuddy.com`
    (Hydrogen channel → Customer Account API settings) or "Sign in" breaks on the real domain.
13. **Mobile + Lighthouse pass** — *Robert* (eyes, on the preview URL: nav drawer, product page,
    cart, checkout hand-off) + *Claude* (fix list). Do after #6–#9 land, once, before launch.
14. **SEO fields at listing time** — *Claude*, tiny. Set `seo.title`/`seo.description` from the
    proposal (today Hydrogen falls back to title + description, which is acceptable but generic).

## P2 — after launch

15. Reviews (Judge.me or Shopify Product Reviews) once real orders exist.
16. Compare-at pricing from CJ MSRP in the sourcing agent (shows a "was" price).
17. Collection-page filters/sort (price, availability) once collections have >12 products.
18. Analytics check: `PUBLIC_STOREFRONT_ID` present, Shopify analytics events (`ProductView`,
    cart, checkout) visible in the admin after the first real session; a privacy/consent banner only
    if you sell outside the US.
19. Email capture (newsletter) — deliberately absent today (bot-flood history); revisit with the same
    Turnstile-gated pattern as `/contact` if wanted.

## Suggested order

**Week 1 status (2026-08-31): #1–#5 BUILT on branch `catalog-p0` — code + tests green, live tier
pending (see `OWNER-CHECKLIST.md` runway B14).** Once B14 runs and the build-week block lands
≥40 products, next up is Week 2 below.

Week 1: #1 → #2 → #3 (all Claude, one branch) while Robert runs sourcing for #4 and decides #5.
Week 2: #6 → #7 → #8 → #9 → #10 → #14 (one branch), #11 + #12 (Robert). Then #13, then launch day.
