# Storefront P1 polish: related products + home page + blog removal + About link — Design

**Status: written 2026-09-03 under Robert's "continue work" directive; scope is LAUNCH-BACKLOG's
pre-approved Week-2 remainder (#8, #9, #10, #11's [C] half — #6/#7 shipped in product-page-v2,
#14 verified already built).** Robert reviews this doc; the build proceeds on the backlog's
standing approval unless he objects.

**Parents:** `docs/LAUNCH-BACKLOG.md` P1 items 8–11 + 14 · `2026-09-01-product-page-v2-design.md`
(the product page this extends; its content components and test idioms bind the style here) ·
`2026-08-17-phase-2-storefront-design.md` (brand primitives: RibbonHeading, CollectionTile,
TrustStrip).

**Goal:** when the L2 wave fills the catalog, the store already looks like a shop — products
cross-link inside their category, the home page routes shoppers into the four categories and
shows what's new, the skeleton blog is gone, and the footer points at an About page. These are
the last [C] builds gating the L4 mobile/Lighthouse pass (backlog #13 runs "after #6–#9 land").

## Spec-time verifications (2026-09-03, this session)

- **#14 (SEO fields at listing time) is ALREADY BUILT** — catalog-p0 shipped `seoTitle()` /
  `seoDescription()` in `packages/core` and the listing worker sets `seo:` in its `productSet`
  (`apply-new-listing.ts:142`); the backfill repaired the pre-gate products. No work; the backlog
  item gets checked off with a pointer here.
- `@doge-buddy/core` is already a storefront dependency (`workspace:*`, used by Hero,
  ShippingReturnsAccordion, ProductSpecs) — `CATEGORIES` imports directly into routes/components.
- `CollectionTile` (`components/brand/CollectionTile.tsx`) takes only `{handle, title}` and
  carries its own per-handle art assets — the backlog's "needs #1's collection images" concern is
  moot; the home grid needs NO query and no Shopify collection images.
- The product route's `loadDeferredData` is the skeleton's designated slot for recommendations
  (its own comment names them); it currently returns `{}`.
- The home loader queries `FEATURED_COLLECTION_QUERY` (critical path!) and returns
  `featuredCollection` + `isShopLinked`; **neither is rendered by the component**. Grep confirms
  `featuredCollection` has no consumer. (`isShopLinked` must be re-checked at implementation —
  if a layout/notice consumer exists outside this route's component, keep it.)
- Header and Footer contain no blog links; the only blog surfaces are the three `blogs.*` routes
  and whatever the sitemap emits.

## Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Related-products source | The product's own CATEGORY collection (first product-collection whose handle is one of the four `CATEGORIES` handles), NOT Shopify's `productRecommendations` | The recommendation API needs behavioral data a pre-launch store lacks; same-collection is deterministic, matches the backlog's wording, and the category collections are tag-fed by the listing worker so membership is guaranteed |
| 2 | Related-products mechanics | ONE deferred query in `loadDeferredData`: `product(handle) { collections(first: 5) { nodes { handle products(first: 8) { nodes { ...ProductItemFields } } } } }`; a PURE exported helper `pickRelated(collections, currentHandle)` filters to the category collection, drops the current product, returns ≤ 4 | Deferred = never blocks TTFB, `.catch → null` = never 500s (the skeleton's own contract for this slot). The helper is unit-testable without a router. `first: 5` collections is enough — the store has 4 category collections + frontpage |
| 3 | Related-products render | `<RelatedProducts>` section after `<SupplierReviews>`: `RibbonHeading` "You might also like" + the same 2/4-col `ProductItem` grid as home, inside `Suspense/Await`; empty list or null response → render NOTHING (no heading, no empty grid) | Mirrors the home page idiom exactly; an empty section is worse than none while the catalog is thin |
| 4 | Home: category tiles | Static section under the hero: `RibbonHeading` "Shop by category" + a 2-col (4-col md) grid of `CollectionTile`, mapped from `CATEGORIES` (`@doge-buddy/core`) — handle + title only, zero data fetching | The tiles' art and routes are already local; a query would add latency to fetch strings we compile in. The header nav and `/collections` already hardcode the same four handles |
| 5 | Home: value props | New tiny `ValueProps` component (brand dir) rendered directly under the hero: three items — "Ships from US warehouses", "3–7 day delivery", "All sales final — see our returns policy" (the last linking `/policies/returns`) | The backlog names exactly these three. `TrustStrip` stays untouched (footer + product page reuse it); a variant prop on it for one placement is premature abstraction. The all-sales-final line LINKS to the policy rather than paraphrasing it — policy copy is legally load-bearing and single-sourced in `POLICY_COPY` |
| 6 | Home: "New arrivals" | Retitle the existing "Fan favorites" section to **"New arrivals"** and raise the query to `first: 8` | The query is `products(sortKey: UPDATED_AT, reverse: true)` — it IS new arrivals. "Fan favorites" with zero sales history is a fabricated claim, and this store's standing rule is never to fabricate (same stance as ratings). 8 fills two rows once the wave lands; with < 8 products the grid renders what exists |
| 7 | Home: dead query cleanup | Delete `FEATURED_COLLECTION_QUERY` + `featuredCollection` from the home loader; keep `isShopLinked` ONLY if implementation finds a real consumer (spec-time grep suggests it is also dead — if dead, drop it and the env read) | It runs on the CRITICAL path of every home load and nothing renders it — targeted cleanup of code this change is already touching, per the house working-in-existing-code rule |
| 8 | Blog removal | DELETE the three `blogs.*` route files; sitemap: pass the supported `types` restriction to `getSitemapIndex`/`getSitemap` if the installed Hydrogen version accepts one, else 404 `blogs`/`articles` in `sitemap.$type.$page` before calling `getSitemap` | Backlog #10 ("remove or hide; add back only when there's content"). Deleting routes makes `/blogs*` a plain 404 via the catch-all — honest and reversible from git. The sitemap must not advertise URLs that 404 |
| 9 | Footer About link | Add `{to: '/pages/about', title: 'About'}` to the footer's hardcoded links array (rename `POLICY_LINKS` → `FOOTER_LINKS` for honesty); Robert creates the page (Shopify admin → Pages → "About", handle `about`) — new OWNER-CHECKLIST item | `pages.$handle.tsx` already renders Shopify pages. A briefly-dead footer link is the same accepted pattern the policy links used pre-Task-10 (the existing comment documents it) |
| 10 | Testing tier | Component/unit tests only (vitest, the storefront's existing `__tests__` idiom): `pickRelated` (pure), `RelatedProducts` render/omit, home tiles + ValueProps + "New arrivals" heading, footer link, sitemap type restriction; blog-route deletion is proven by the routes' absence + typecheck. The full visual/mobile pass stays backlog #13 (Robert on the Fold + Lighthouse, after this lands) | Matches product-page-v2's test tiering; no live Shopify calls in tests |

## Architecture — what changes where

```
apps/storefront/app/
  routes/products.$handle.tsx     loadDeferredData: + RELATED_PRODUCTS_QUERY (deferred, .catch→null)
                                  component: + <RelatedProducts related={...}> after <SupplierReviews>
  components/product/RelatedProducts.tsx   (new) Suspense/Await section; renders nothing when ≤ 0
  lib/related.ts                  (new) pickRelated(collections, currentHandle): ProductItemFields[]
                                  KNOWN_CATEGORY_HANDLES derived from CATEGORIES (@doge-buddy/core)
  routes/_index.tsx               + <ValueProps/> + <CategoryTiles/> under <Hero/>;
                                  "Fan favorites"→"New arrivals", first: 4→8;
                                  − FEATURED_COLLECTION_QUERY (+ featuredCollection, and
                                    isShopLinked if confirmed dead)
  components/brand/ValueProps.tsx (new) three-item strip, returns-policy link
  components/brand/CategoryTiles.tsx (new) CATEGORIES → CollectionTile grid (pure presentational)
  routes/blogs._index.tsx         DELETED
  routes/blogs.$blogHandle._index.tsx           DELETED
  routes/blogs.$blogHandle.$articleHandle.tsx   DELETED
  routes/[sitemap.xml].tsx + routes/sitemap.$type.$page[.xml].tsx
                                  types restricted to products/collections/pages (mechanism per
                                  Decision 8 — implementer verifies the installed Hydrogen API)
  components/Footer.tsx           POLICY_LINKS→FOOTER_LINKS + About entry
docs/LAUNCH-BACKLOG.md            #8/#9/#10/#14 statuses; #11's [C] half
docs/OWNER-CHECKLIST.md           + "Create the About page" owner item; footer pointer update
```

`RELATED_PRODUCTS_QUERY` reuses the exact field shape `ProductItem` consumes (id, title, handle,
priceRange.minVariantPrice, featuredImage) — one shared fragment with the home query if that is
cheap, duplicated verbatim if sharing forces a refactor (YAGNI; the fields are five lines).

## Error handling

| Failure | Effect |
|---|---|
| Related query fails / cap / product in no category collection | Deferred `.catch → null` / helper returns [] → section absent; page unaffected |
| Product's only collection is `frontpage` | Helper filters on the four category handles → [] → section absent (never "related" from a mixed bag) |
| < 8 products exist for New arrivals | Grid renders what exists (unchanged skeleton behavior) |
| `/pages/about` not yet created | Footer link 404s until Robert creates it — accepted, checklist item carries the instruction |
| `/blogs*` requested post-removal | Catch-all `$.tsx` 404 (already styled) |

## Non-goals

Shopify `productRecommendations` (revisit post-launch with real data) · collection images in
Shopify (tiles use local art) · a CMS/blog replacement · About page CONTENT (Robert's, in admin)
· collection-page filters (#17, P2) · Judge.me (#15, P2) · touching TrustStrip · any change to
the listing worker (#14 already done).

## Risks (accepted)

- **"New arrivals" ordering is UPDATED_AT, not CREATED_AT** — an inventory-sync touch can bump an
  old product's position. Acceptable pre-launch (syncs touch everything roughly equally);
  flip to `CREATED_AT` at implementation if the Storefront API sort key exists there (implementer
  checks — products sortKey supports CREATED_AT; if so, prefer it).
- **Footer About link dead until Robert acts** — documented, precedent exists.
- **Sitemap `types` API varies by Hydrogen version** — Decision 8 names the fallback; either way
  no blog URLs are advertised.
