# Phase 2 — Hydrogen Storefront: Design

**Date:** 2026-08-17 · **Status:** approved by Robert (brainstorming session) · **Parent:** [2026-08-09-doge-buddy-design.md](2026-08-09-doge-buddy-design.md) §"Storefront v1" and §"Phase 2"

## Goal

Ship the customer-facing store: the Hydrogen skeleton scaffolded into the workspace, restyled to the Doge Buddy brand, with the PDP delivery badge, JSON-LD, the four collections, policy pages, and Oxygen GitHub deploys. Exit: browse → cart → Bogus Gateway checkout (> $1) lands a `test:true` order; Lighthouse pass.

## Decisions made in brainstorming

| Question | Decision |
|---|---|
| Approach | **Restyle the skeleton in place** — keep generated routes, loaders, cart/search/account plumbing stock; our work is tokens, restyled components, and small additions. Not a custom UI layer; not a minimal recolor. |
| Visual tone | **Playful & warm** — cream backgrounds, chunky rounded corners, mascot art in hero/collection tiles/empty states. |
| Display font | **Poppins now, swappable slot.** `--font-display` token points at Poppins 800; FunkyDori becomes a one-token + one-woff2 swap once Robert confirms the license. No font file exists in the repo today. |
| Imagery | **Brand-art compositions** (mascot SVG + flat brand-color shapes). No photography, no AI generation, no stock. |
| Data source | **mock.shop first**; switching to the test store is env-vars only. Store-dependent verification is the phase's final tier, not a blocker. |
| Seeding | **Idempotent seed script** creates metafield definitions, 4 smart collections, ~10 sample products on the test store once credentials exist. |
| Policy copy | **Authored in the repo**, replacing the skeleton's Storefront-API-driven policy routes. Pasted into Shopify Settings → Policies at launch (Phase 7 checklist item). |

## 1. Scaffold & architecture

- New workspace app `apps/storefront`, package name `@doge-buddy/storefront`.
- Scaffold: `npm create @shopify/hydrogen@latest -- --language ts --styling tailwind --markets none` (Hydrogen 2026.4.x line, React Router 7, Tailwind v4). Delete the generated lockfile; adopt into the pnpm workspace; add `pnpm --filter` scripts and CI jobs (typecheck, lint, unit tests, build) alongside existing ones. Pinned Storefront API version: **2026-04** (from `@shopify/hydrogen-react@2026.4.3`'s `SFAPI_VERSION` constant, matched by `@shopify/hydrogen@2026.4.5`'s Customer Account API default — both ship inside `@shopify/hydrogen@2026.4.5`, the dependency pinned by the scaffold).
- **Standalone deployable.** No imports from workspace packages: Oxygen runs workerd (not Node), and the storefront shares nothing at runtime with ops. Seed tooling lives in ops.
- **Data source is env-only.** Unlinked scaffold talks to mock.shop out of the box. Test store = `PUBLIC_STORE_DOMAIN`, `PUBLIC_STOREFRONT_API_TOKEN`, `SESSION_SECRET` (plus whatever else the Hydrogen channel issues), documented in `apps/storefront/.env.example`. No code change to switch.
- Local dev: `shopify hydrogen dev` (MiniOxygen — local runtime matches production).
- Branch: `feat/phase-2-storefront`, stacked on `feat/phase-1-plumbing`.

## 2. Brand system & page designs

**Tokens** (Tailwind v4 `@theme`, components use semantic names only — never hex):

| Token | Value | Use |
|---|---|---|
| `--color-ink` | `#10171a` | text |
| `--color-surface` / tints | cream tints of `#ffe3ae` | page/section backgrounds (full beige reserved for badges/cards) |
| `--color-cta` | `#ff3641` | the single CTA color |
| `--color-accent` | `#ffb327` | highlights |
| `--color-info` | `#145069` | links, informational |
| gold gradient | `#bb6402 → #f6ce18 → #f5f39e` | rare "special" moments only (e.g. sale badge) |

**Type:** self-hosted Poppins woff2, weights 400/500/700/800. `--font-display` = Poppins 800 for now (see decision above). Display font preloaded.

**Look:** cream backgrounds, `rounded-2xl`-family corners, soft shadows, generous spacing. Mascot art in: hero, the four collection tiles (one flat-color composition each), empty cart, no-search-results, and the product-card no-image fallback. Header: color wordmark SVG, nav (4 collections, search, cart). Footer: policy links + trust strip. Favicons wired from `assets/Doge_Buddy_Brand/`.

**Routes** (all restyles of skeleton routes; `account.*` untouched — it is the tracking page):

- **Home:** brand-art hero (headline + CTA) → featured products → trust strip "Ships from US warehouses · 3–7 day delivery".
- **Collections:** index + the four collection pages (see §3).
- **PDP:** adds the beige **delivery badge** from metafields `dogebuddy.ships_from` / `dogebuddy.delivery_min_days` / `dogebuddy.delivery_max_days` (e.g. "Ships from US warehouse · 3–7 days"). Renders **only when all three metafields are present** — mock.shop products omit it; seeded/real products show it.
- **Cart:** restyled; checkout stays hosted via `cart.checkoutUrl` — never custom.
- **Search:** restyled, mascot empty state.
- **Policies:** repo-authored content (see §3).

**Accessibility:** contrast-checked tokens (red-on-cream for large text/CTAs only; body text ink-on-cream), visible focus states throughout.

## 3. Data, seeding & content

**New `shopify-admin` operations** (pinned 2026-07, fixture-tested, same pattern as Phase 1's eleven):

- `metafieldDefinitionCreate` — define the three `dogebuddy.*` metafields with `PUBLIC_READ` storefront access (without which the Storefront API cannot read them).
- `collectionCreate` — smart collections with a single tag rule each:

| Collection | Rule (product tag) |
|---|---|
| Toys & Play | `category:toys-play` |
| Walks & Travel | `category:walks-travel` |
| Beds & Comfort | `category:beds-comfort` |
| Grooming & Care | `category:grooming-care` |

**Seed script** — `pnpm --filter @doge-buddy/ops seed-store`:

- Idempotent: looks up by handle/tag before creating; safe to rerun any time.
- Creates: 3 metafield definitions, 4 smart collections, ~10 sample products (2–3 per category; realistic names/prices; category tag + delivery metafields; titles prefixed **"Sample —"** for easy later cleanup).
- Publishes products to the storefront publication (`publishablePublish`), sets inventory.
- **No product images.** The storefront's no-image fallback card (mascot art) covers them — needed for edge cases anyway; avoids staged-upload machinery. Real images arrive with real products (Phase 5 sourcing).
- Inventory mechanism: sample variants are created untracked (`inventoryItem.tracked: false`) — always purchasable; no `inventorySetQuantities` call needed for samples.

**Policy pages** — copy authored in the repo (versioned, PR-reviewable, renders on mock.shop too), replacing the skeleton's Storefront-API policy routes:

- Shipping (US warehouses, 3–7 days), Returns/Refunds, Privacy (naming CJ Dropshipping, Google Workspace, and Anthropic as processors), Terms.
- Each page carries a "last updated" stamp. Owner checklist gains a Phase 7 item: paste final copy into Shopify Settings → Policies (so hosted-checkout footer links match) and review before launch — these are Shopify Payments prerequisites.

**SEO:** Product JSON-LD on PDPs (name, price, availability); Organization + WebSite JSON-LD at root; per-route titles/descriptions via `getSeoMeta`; skeleton robots + sitemap kept as-is.

## 4. Testing, verification & deployment

**Automated (TDD where there is logic to drive):**

- Vitest + Testing Library: delivery badge (hidden without metafields; correct range formatting), no-image fallback card, JSON-LD builders (pure functions).
- Fixture tests for the two new `shopify-admin` operations.
- Seed-script idempotency logic against a mocked client.
- **Playwright smoke suite** (local script vs mock.shop, not CI-gating — external network): home renders; collection lists products; add-to-cart updates cart; cart shows checkout link.
- CI: storefront typecheck / lint / unit tests / build jobs added to the existing pipeline.

**Verification tiers:**

- **Tier 1 — no credentials (completes the build):** all of the above green; dev server browsable on mock.shop; Lighthouse ≥ 90 on performance / accessibility / best-practices / SEO for home + PDP against a production build.
- **Tier 2 — needs the test store (the phase exit):** env linked; seed script run; badges visible on seeded products; **browse → cart → Bogus Gateway checkout > $1 lands a `test:true` order**; test orders cancelled as we go (anecdotal ~10 test-order cap); **Oxygen deploys** via Hydrogen sales channel + GitHub connection (dev-store deploys are password-protected — acceptable).

**Owner checklist additions (🟡 — nothing blocks the build):** install the Hydrogen sales channel on the test store and connect the GitHub repo (Oxygen); copy the storefront env vars it issues into `apps/storefront/.env`; enable Bogus Gateway. Phase 7 item: paste policy copy into Shopify settings.

## Out of scope (locked by parent design)

Blog, i18n, reviews, wishlists, popups, custom checkout, custom tracking page, apparel. Also out: product photography/AI imagery, FunkyDori purchase (tracked on owner checklist), CI-gated E2E.
