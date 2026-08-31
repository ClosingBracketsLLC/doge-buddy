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

1. **Create + publish the four category collections** — *Claude* (script), ~1 task. Extend
   `seed-store` (or a new `seed-collections` script) so it creates the 4 automated collections from
   `sample-data.ts` (rule `tag equals category:<handle>`) AND publishes each to the `doge-buddy`
   publication + Online Store (today the seed publishes products only), with a collection image and a
   one-line description each. Idempotent; run against the real store. Fixes the nav, the hero CTA,
   and `/collections` in one go.
2. **Tag products at listing time** — *Claude*, small. `apply-new-listing.ts` sets
   `tags: ['category:<categoryTag>']` and `productType` from the proposal; backfill the 2 live products
   (one-off script or Robert in admin: Products → product → Tags). Without this, #1's collections are
   empty.
3. **Human product URLs** — *Claude*, small but touches the resume path. Handle = slugified title
   (+ a short suffix on collision) instead of `db-proposal-<uuid>`; the worker's crash-resume looks the
   product up by the handle it computed, so the slug must be derived deterministically from the
   payload (title + proposal-id suffix is the safe form, e.g. `low-noise-pet-hair-clipper-d28b3cb8`).
   Backfill the 2 live products (Shopify keeps a redirect from the old handle for the Online Store;
   Hydrogen doesn't need one pre-launch).
4. **Catalog depth — decision for Robert.** Two products across four categories is not a store. A
   sensible opening bar is 4–6 products per category (16–24 total). Today's supply is the weekly
   sourcing run (~2 proposals/run, ~$0.60/run, owner-approved). Options, cheapest first:
   (a) run `run-sourcing` by hand several times this week, one category keyword each (Claude drives,
   Robert taps Approve on the phone); (b) raise the per-run proposal count (a setting + prompt change);
   (c) hand-pick CJ products and let Claude seed them through the same proposal path. Pick one; (a)
   needs nothing built.
5. **Inventory policy — decision for Robert.** Both variants show quantity 0/-1 (untracked) and still
   sell. That's fine for dropshipping IF we're comfortable selling on CJ's stock without a local
   count; the CJ stock sync exists in the DB (`last_known_stock`) but is not pushed to Shopify
   inventory. Decide: leave untracked (simplest, current behaviour) or have the listing worker set a
   tracked quantity from CJ stock and re-sync (Claude, medium).

## P1 — before the official launch

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

Week 1: #1 → #2 → #3 (all Claude, one branch) while Robert runs sourcing for #4 and decides #5.
Week 2: #6 → #7 → #8 → #9 → #10 → #14 (one branch), #11 + #12 (Robert). Then #13, then launch day.
