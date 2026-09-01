# Catalog P0 — categories that work, products that land in them, CJ stock as Shopify inventory, catalog-build knobs

**Date:** 2026-08-31 · **Status:** approved in chat (Robert, 2026-08-31), building · **Parent:**
`docs/LAUNCH-BACKLOG.md` P0 items 1–5 · **Owner goal:** ≥40 products on the store by Friday
2026-09-04, every one in a working nav category, never overselling CJ's US stock.

## Facts this design rests on (audited 2026-08-31 against the real store)

- Store has one collection (`frontpage`) and two ACTIVE products; the header's four category links
  404 because the collections were never created. Products carry no tags, no `productType`, no SEO
  fields; handles are `db-proposal-<uuid>` (the listing worker's crash-safe resume key); variants are
  `inventoryItem.tracked = false` (sell regardless of stock; the fulfillment planner's live CJ stock
  check is the only oversell net — an order that can't be fulfilled goes `needs_attention`).
- The proposal schema pins the category to a closed enum `CATEGORY_TAGS = ['toys','walks','beds',
  'grooming']` (`packages/core/src/proposals.ts`), zod-validated on submit — the agent cannot invent
  categories. The seed's `sample-data.ts` predates that enum and keys collections on
  `category:toys-play`-style tags (never used on this store).
- Sourcing: `HARVEST_KEYWORDS = ['dog toy','dog leash','dog bed','dog grooming','dog']`, ≤10 CJ pages,
  15 candidates, agent budget $2, structured output `winners.max(3)`, prompt says "up to THREE".
  `run-sourcing [--force]` is the manual entry point; `workflow.sourcing.mode` manual → each winner is
  an owner-approved proposal.
- Shopify ops already exist for `collectionCreate` (rule `TAG EQUALS <condition>`), `listCollections`,
  `listPublications`, `publishablePublish`, `productSet`, `productVariantsByProductId`,
  `inventorySetQuantities` (requires `@idempotent` on the mutation field — already handled). The
  supplier adapter exposes `getVariantStock(supplierVariantId) → WarehouseStock[] {countryCode,
  quantity, verified}`. `product_variants.shopify_inventory_item_gid` exists in the schema and is never
  written.

## Exit criteria (live, on the real store)

1. `/collections/toys-play`, `walks-travel`, `beds-comfort`, `grooming-care` render (200) with the
   right products; `/collections` shows four tiles; the hero's "Shop toys" lands somewhere real.
2. Both existing products appear in exactly one category each, have a human URL
   (`/products/<slug>-<8 hex>`), a `productType`, and SEO title/description; the old
   `db-proposal-…` URLs are gone (pre-launch, no redirect needed).
3. A newly listed product (from a real sourcing run) arrives tagged, typed, slugged, with a tracked
   Shopify quantity equal to CJ's US stock at listing time.
4. `inventory.sync` runs every 6 h and after every listing; setting a variant's CJ stock to 0 (or a
   CJ stock-out) shows "Sold out" on the storefront within one cycle; the sync never drives a
   quantity below 0 and never touches products it doesn't own.
5. A catalog-build run (`run-sourcing --keywords "dog chew toy,dog puzzle toy" --max-winners 8
   --budget 5`) can return up to 8 winners in one run; the Monday cron's defaults are unchanged.

## Non-goals

Product-page content (highlights/specs/gallery — backlog P1), collection images/descriptions beyond a
one-liner (Robert uploads images in admin), a fifth category, migrating away from the `Title`-only
option model, real-time CJ stock webhooks (polling every 6 h is the design; CJ's STOCK webhook stays
stubbed), redirects from the old handles.

## 1. Category model (one source of truth)

`packages/core/src/catalog.ts` (new) exports the single mapping the storefront nav, the seed, the
listing worker and the sourcing prompt all read:

```ts
export const CATEGORIES = [
  { tag: 'toys',     handle: 'toys-play',     title: 'Toys & Play',     productType: 'Dog Toys',      blurb: 'Tug, chew, fetch, puzzle — gear that keeps the tail going.' },
  { tag: 'walks',    handle: 'walks-travel',  title: 'Walks & Travel',  productType: 'Dog Walking',   blurb: 'Leashes, harnesses, bowls and carriers for the road.' },
  { tag: 'beds',     handle: 'beds-comfort',  title: 'Beds & Comfort',  productType: 'Dog Beds',      blurb: 'Beds, blankets and calming spots for the off hours.' },
  { tag: 'grooming', handle: 'grooming-care', title: 'Grooming & Care', productType: 'Dog Grooming',  blurb: 'Brushes, clippers and care tools for at-home upkeep.' },
] as const
export function categoryByTag(tag: CategoryTag): (typeof CATEGORIES)[number]
export const categoryTagValue = (tag: CategoryTag) => `category:${tag}`   // the Shopify product tag
```

`CATEGORY_TAGS` stays where it is; `CATEGORIES[i].tag` is typed against it so the two can't drift.
The storefront's `Header.tsx` `NAV_ITEMS` and `Hero.tsx` CTA derive from `CATEGORIES` (handle/title)
instead of their hardcoded copies. `apps/ops/src/seed/sample-data.ts` rewrites its `COLLECTIONS` from
`CATEGORIES` and its sample products' `categoryTag` to enum values.

## 2. Collections on the store

A new credential-gated script `pnpm --filter @doge-buddy/ops seed-collections` (`apps/ops/scripts/
seed-collections.ts` → `src/seed/collections.ts`): for each `CATEGORIES` entry, `collectionCreate` if `listCollections` lacks the handle (2026-07 shape, live-verified 2026-08-31: `collection: CollectionCreateInput` with a `sources[].source.inclusion.conditions[].productTag { relation: TAGGED_WITH, values: ['category:<tag>'] }` rule — the `ruleSet` form the seed used before does not exist on this API version, which is why the store never got its collections; `descriptionHtml` = blurb),
then `publishablePublish` the collection to EVERY publication from `listPublications` (Online Store,
Shop, POS, `doge-buddy`) — publishing is idempotent, so a rerun heals a half-published collection.
Prints created/skipped/published counts; a failure on one collection is logged and the run continues
(the seed's own convention). No images (owner uploads in admin: Products → Collections → the
collection → Image) — the storefront tile falls back to the mascot placeholder meanwhile.

Also fixes `runSeed` so its collection step publishes the same way (today it publishes products only).

## 3. Listing worker (`apply-new-listing.ts`) — what a product is born with

- **Handle** = `slugify(title)` (lower-case, ASCII, `-` separators, ≤ 60 chars, trimmed of dashes) +
  `-` + first 8 hex of the proposal id. Deterministic from the payload, so the crash-resume lookup
  `findProductByHandle(handle)` still works; the suffix makes collisions impossible and keeps the id
  discoverable. `proposalHandle()` in `apply-shared.ts` gains the title argument; every caller
  (listing worker, its tests, the seed-proposal script if it prints URLs) is updated.
- **Tags** `['category:<tag>']`, **productType** from `CATEGORIES`, **seo** `{ title: <title>
  (≤70), description: first 155 chars of the plain-text description }` — all in the same
  `productSet` call (all three are `ProductSetInput` fields; verify by live introspection on the
  first credential-gated run, the house rule).
- **Inventory**: `inventoryItem: { tracked: true }` and `inventoryQuantities: [{ locationId,
  name: 'available', quantity: <CJ US stock> }]` per variant, where the quantity is
  `adapter.getVariantStock(supplierVariantId)` summed over `countryCode === 'US'` entries (0 if the
  call fails — a listing never blocks on a stock read; the sync fixes it within 6 h and the
  post-listing sync below fixes it within a minute). `locationId` comes from a new
  `primaryLocationId(client)` op (`locations(first:1, query:"active:true")`), memoized per process.
  `productSet`'s selection is extended to return each variant's `inventoryItem { id }`, persisted in
  `product_variants.shopify_inventory_item_gid` (the existing unused column) — `productVariantsByProductId`
  returns it too, for the resume path. After the local rows land, the worker enqueues one
  `inventory.sync` job for that product (singletonKey = product id) so the quantity is exact even
  when the listing-time read failed.
- `supplier_variant_mappings.last_known_stock` / `stock_checked_at` are written at listing time and by
  every sync (today they're never written).

**Backfill** for the two live products: `pnpm --filter @doge-buddy/ops backfill-listings` — for every
`products` row with an active Shopify gid: `productUpdate` handle/tags/productType/seo from the local
row + category, then the inventory part (tracked + quantity from CJ + inventory item gid). Idempotent.
Run once against the real store; the same script is the repair tool if a future listing half-applies.

## 4. `inventory.sync` job

`apps/ops/src/jobs/inventory-sync.ts`. Cron `0 */6 * * *` (registered like `cj.wallet-monitor`) AND
on-demand via `enqueue('inventory.sync', { productId? })` (queue policy `stately`, singletonKey =
productId or `'all'`). One cycle: select every `product_variants` row joined to an ACTIVE product with
a `supplier_variant_mappings` row and a non-null `shopify_inventory_item_gid`; for each (bounded: 200
variants/cycle, alert if more) call `adapter.getVariantStock`, sum US quantity, clamp ≥ 0; if it
differs from `last_known_stock`, `inventorySetQuantities({ name:'available', reason:'correction', quantities:[{ inventoryItemId, locationId, quantity }] }, idempotencyKey)` (2026-07 has no `ignoreCompareQuantity`; the optional per-entry `changeFromQuantity` CAS is omitted on purpose)
(key = `inv-<variantId>-<yyyymmddhh>`), then update `last_known_stock`/`stock_checked_at`. Per-variant
errors are logged + counted, never abort the cycle; ≥ 25% failures in a cycle → one warning alert
`inventory_sync_degraded`. Variants whose product isn't active, or with no inventory item gid, are
skipped (the backfill fixes the latter). A CJ points budget guard mirrors the sourcing agent's
(`points.ts`): stop the cycle at the cap and alert. Audit `inventory.synced {updated, unchanged,
failed}` per cycle.

Why polling, not CJ's STOCK webhook: the webhook's shape is a fixture-assumption never seen live
(`webhook-process.ts` stubs it); 6-hourly polling of ≤ 40–60 variants is a handful of CJ calls and is
the same mechanism the fulfillment planner already trusts.

## 5. Catalog-build knobs (sourcing)

Settings (numbers, defaults = today's behaviour): `sourcing.max_winners` (3), `sourcing.candidate_target`
(15), `sourcing.max_pages` (10), `sourcing.max_budget_cents` (200). The output schema becomes a
factory `sourcingOutputSchema(maxWinners)`; the prompt states the live number; `runHarvest` reads
`candidateTarget`/`maxPages` from its deps; the agent runner's `maxBudgetUsd` from the setting. CLI
overrides on `run-sourcing`: `--keywords "a,b,c"` (replaces `HARVEST_KEYWORDS` for that run only, ≤ 8
keywords), `--max-winners N`, `--budget USD`, `--candidates N`, `--pages N` — overrides beat settings,
settings beat constants; the Monday cron never sees overrides. Winners still pass Stage 4
unchanged (US stock, margin floor). The agent prompt gains one line: the category must be one of the
four `CATEGORIES` and the winner's `categoryTag` should match the keyword's intent when obvious.

**Auto mode for the build week (owner action, ruled 2026-08-31):** Robert sets
`workflow.sourcing.mode = auto` on `/admin/settings` before the runs and back to `manual` after.
In auto mode `submitProposal` approves and enqueues the apply directly (existing behaviour); the
Telegram notify is skipped. Nothing in code changes for this.

## 6. Storefront

`Header.tsx`/`Hero.tsx` read `CATEGORIES` (P0.1); `/collections` index already renders tiles from the
Storefront API. No other storefront change in this spec (P1 covers the product page).

## 7. Testing

- core: `CATEGORIES` ↔ `CATEGORY_TAGS` consistency; `slugify` cases (unicode, punctuation, length,
  trailing dash).
- ops: seed-collections plan (create vs skip vs publish-only) with a fake Shopify ops object;
  listing worker: productSet input carries tags/type/seo/tracked quantity/location, handle is the
  slug form, inventory item gid persisted, post-listing sync enqueued, stock-read failure → quantity
  0 + still listed; backfill script's per-product update input; inventory-sync: quantity math (US-only
  sum, clamp), unchanged → no Shopify call, changed → one call with the right ids, per-variant failure
  isolation, degraded alert threshold, points cap; sourcing knobs: settings/CLI precedence, schema
  factory cap, prompt text, harvest reads deps; storefront: nav/hero derive from `CATEGORIES`.
- Live tier (Robert + Claude): run `seed-collections` → exit criterion 1; run `backfill-listings` →
  criterion 2; one real sourcing run with `--max-winners 2` in manual mode → criterion 3; force a
  sync → criterion 4; then the build runs in auto mode.

## 8. Owner items (→ OWNER-CHECKLIST)

Flip `workflow.sourcing.mode` to `auto` for the build (and back after); upload one image per
collection in admin; the per-category keyword lists for the build runs are in the plan; expect
~$30–40 Anthropic + CJ points over the week.
