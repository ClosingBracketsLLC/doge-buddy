# Phase 2 — Hydrogen Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/storefront` — the Hydrogen skeleton restyled to the Doge Buddy brand with delivery badge, JSON-LD, four collections, policy pages — plus the shopify-admin operations and seed script that populate the test store.

**Architecture:** Restyle-in-place: the official Hydrogen skeleton's routes/loaders/cart plumbing stay stock; our work is Tailwind v4 `@theme` tokens, restyled components, and small additions. The storefront is a standalone deployable (Oxygen/workerd — imports **no** workspace packages). Seed tooling lives in ops and uses `@doge-buddy/shopify-admin`.

**Tech Stack:** Hydrogen 2026.4.x (React Router 7, TS), Tailwind v4, Vitest + Testing Library (jsdom), Playwright (local smoke only), pnpm workspace, existing `ShopifyAdminClient` (Admin GraphQL 2026-07).

**Spec:** `docs/superpowers/specs/2026-08-17-phase-2-storefront-design.md` (read it first; parent design: `2026-08-09-doge-buddy-design.md` §"Storefront v1").

## Global Constraints

- Branch: `feat/phase-2-storefront` (already exists, stacked on `feat/phase-1-plumbing`). Commit per task, conventional-commits style.
- pnpm via corepack; run everything with `pnpm --filter <pkg>`. Root `pnpm typecheck` / `pnpm test` fan out recursively — new packages join automatically via their own `typecheck`/`test` scripts.
- **Skeleton paths below are the expected 2026.4 skeleton layout.** If the generated skeleton names a file differently (e.g. `products.$handle.tsx` vs `products_.$handle.tsx`), adapt the path, never the behavior. Do not restructure skeleton code beyond what a task states.
- Components use semantic Tailwind tokens only — **never raw hex** outside `app/styles/app.css` (formerly tailwind.css — whichever css entry the skeleton generated).
- `apps/storefront` must not import from any `@doge-buddy/*` package (workerd runtime).
- Storefront copy constants: trust strip is exactly `Ships from US warehouses · 3–7 day delivery`; delivery badge format `Ships from {ships_from} · {min}–{max} days`.
- Metafields: namespace `dogebuddy`, keys `ships_from` (single_line_text_field), `delivery_min_days`, `delivery_max_days` (number_integer), owner PRODUCT, storefront access `PUBLIC_READ`.
- Collection handles/tags (exact): `toys-play`/`category:toys-play` "Toys & Play", `walks-travel`/`category:walks-travel` "Walks & Travel", `beds-comfort`/`category:beds-comfort` "Beds & Comfort", `grooming-care`/`category:grooming-care` "Grooming & Care".
- After editing any storefront GraphQL query, run `pnpm --filter @doge-buddy/storefront codegen` so generated types stay in sync.
- TDD for anything with logic (badge, fallback card, JSON-LD builders, seed planner, admin operations). Styling-only steps are verified by typecheck + dev-server eyeball, not unit tests.

---

### Task 1: Scaffold Hydrogen app + workspace adoption

**Files:**
- Create: `apps/storefront/**` (generated), `apps/storefront/.env.example`
- Modify: `apps/storefront/package.json`, `.github/workflows/ci.yml`, `docs/superpowers/specs/2026-08-17-phase-2-storefront-design.md` (record Storefront API version)

**Interfaces:**
- Produces: workspace package `@doge-buddy/storefront` with scripts `dev`, `build`, `typecheck`, `codegen`; dev server on `http://localhost:3000` against mock.shop. Every later storefront task builds on this.

- [ ] **Step 1: Scaffold.** From repo root:

```bash
npm create @shopify/hydrogen@latest -- --path apps/storefront --language ts --styling tailwind --markets none --routes --mock-shop --no-install-deps --no-git
```

If the CLI prompts anyway, answer to match those flags (TypeScript, Tailwind, no markets, scaffold routes, mock.shop data, skip install/git).

- [ ] **Step 2: Adopt into the pnpm workspace.** Delete `apps/storefront/package-lock.json` and `apps/storefront/node_modules` if present. In `apps/storefront/package.json` set `"name": "@doge-buddy/storefront"`, `"private": true`. Confirm `pnpm-workspace.yaml` already globs `apps/*` (it does — ops lives there). Run `pnpm install` at root.

- [ ] **Step 3: Verify scripts.** Ensure package.json has `dev`, `build`, `typecheck`, `codegen` scripts (skeleton provides them; add `"typecheck": "tsc --noEmit"` if missing). Run:

```bash
pnpm --filter @doge-buddy/storefront typecheck && pnpm --filter @doge-buddy/storefront build
```

Expected: both pass. Then `pnpm typecheck` at root — all packages still pass.

- [ ] **Step 4: Dev-server sanity check** (headless): `pnpm --filter @doge-buddy/storefront dev &`, then `curl -sf http://localhost:3000 | grep -qi "cart"` (any skeleton chrome proves SSR against mock.shop). Kill the server after.

- [ ] **Step 5: `.env.example`.** Create `apps/storefront/.env.example`:

```bash
# Default (no .env): mock.shop demo data — full local dev, no credentials.
# To link the test store, copy this to .env and fill in (values come from the
# Hydrogen sales channel after Robert connects it — see docs/OWNER-CHECKLIST.md):
# SESSION_SECRET=any-long-random-string
# PUBLIC_STORE_DOMAIN=<store>.myshopify.com
# PUBLIC_STOREFRONT_API_TOKEN=<from Hydrogen channel>
```

- [ ] **Step 6: CI + spec version note.** In `.github/workflows/ci.yml` add after the `pnpm test` line: `- run: pnpm --filter @doge-buddy/storefront build`, and if the skeleton generated a `lint` script, also `- run: pnpm --filter @doge-buddy/storefront lint` (the rest of the repo has no lint convention — don't invent one; wire only what the skeleton ships). In the spec's §1, replace "Record the scaffold's pinned Storefront API version…" with the actual version (find it in the generated code, e.g. `grep -r "2026-" apps/storefront/app --include="*.ts" -l` or the `@shopify/hydrogen` const).

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat(storefront): scaffold Hydrogen skeleton into workspace (mock.shop)"
```

---

### Task 2: Brand tokens, fonts, favicons

**Files:**
- Create: `apps/storefront/app/assets/fonts/*.woff2`, `apps/storefront/app/assets/mascot.svg`, `apps/storefront/app/assets/wordmark.svg`, `apps/storefront/public/favicon.*`
- Modify: `apps/storefront/app/styles/app.css` (or the skeleton's CSS entry), `apps/storefront/app/root.tsx`, `apps/storefront/package.json`

**Interfaces:**
- Produces: Tailwind utilities from `@theme` tokens — `bg-surface`, `bg-surface-raised`, `text-ink`, `bg-cta`, `text-cta`, `bg-accent`, `text-info`, `bg-badge`, `font-display`, `font-sans` — plus asset imports `~/assets/mascot.svg`, `~/assets/wordmark.svg`. All later styling tasks consume these names exactly.

- [ ] **Step 1: Fonts.** `pnpm --filter @doge-buddy/storefront add @fontsource/poppins`, then copy the latin woff2 for weights 400/500/700/800:

```bash
mkdir -p apps/storefront/app/assets/fonts
for w in 400 500 700 800; do cp node_modules/.pnpm/@fontsource+poppins*/node_modules/@fontsource/poppins/files/poppins-latin-$w-normal.woff2 apps/storefront/app/assets/fonts/; done
```

(Adjust the glob to wherever pnpm placed the package; commit the four files.) Remove `@fontsource/poppins` from dependencies afterwards — the files are vendored: `pnpm --filter @doge-buddy/storefront remove @fontsource/poppins`.

- [ ] **Step 2: Tokens + @font-face.** In the skeleton's CSS entry, add (keeping the skeleton's `@import "tailwindcss"` and existing layers):

```css
@font-face { font-family: 'Poppins'; font-weight: 400; font-display: swap; src: url('../assets/fonts/poppins-latin-400-normal.woff2') format('woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 500; font-display: swap; src: url('../assets/fonts/poppins-latin-500-normal.woff2') format('woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 700; font-display: swap; src: url('../assets/fonts/poppins-latin-700-normal.woff2') format('woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 800; font-display: swap; src: url('../assets/fonts/poppins-latin-800-normal.woff2') format('woff2'); }

@theme {
  --color-ink: #10171a;
  --color-surface: #fff8ec;         /* cream tint of brand beige */
  --color-surface-raised: #fffdf7;  /* cards on cream */
  --color-badge: #ffe3ae;           /* full brand beige — badges/cards only */
  --color-cta: #ff3641;
  --color-accent: #ffb327;
  --color-info: #145069;
  --font-sans: 'Poppins', system-ui, sans-serif;
  --font-display: 'Poppins', system-ui, sans-serif; /* FunkyDori swap point */
}
```

The only raw hex in the app lives here.

- [ ] **Step 3: Brand assets.** Copy `assets/Doge_Buddy_Brand/logo_dogebuddy_color.svg` → `apps/storefront/app/assets/mascot.svg` and `logo_text_dogebuddy_color.svg` → `app/assets/wordmark.svg`. Copy `favicon.svg`, `favicon.ico`, `favicon_256px.png` → `apps/storefront/public/`.

- [ ] **Step 4: Root wiring.** In `app/root.tsx`: set `<html>`/`<body>` base classes `bg-surface text-ink font-sans`; replace the skeleton favicon link with `/favicon.svg` (+ ico fallback); add a preload link for the display weight:

```tsx
import poppins800 from '~/assets/fonts/poppins-latin-800-normal.woff2';
// in links(): {rel: 'preload', href: poppins800, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous'}
```

- [ ] **Step 5: Verify + commit.** `pnpm --filter @doge-buddy/storefront typecheck && pnpm --filter @doge-buddy/storefront build`, dev-server eyeball (cream background, Poppins renders, favicon in tab).

```bash
git add -A && git commit -m "feat(storefront): brand tokens, self-hosted Poppins, favicons"
```

---

### Task 3: Brand primitives — TrustStrip, EmptyState, ProductCardImage (TDD)

**Files:**
- Create: `apps/storefront/app/components/brand/TrustStrip.tsx`, `EmptyState.tsx`, `ProductCardImage.tsx`; `apps/storefront/app/components/brand/__tests__/brand.test.tsx`; `apps/storefront/vitest.config.ts`
- Modify: `apps/storefront/package.json`

**Interfaces:**
- Produces (exact signatures — later tasks import from `~/components/brand/…`):
  - `TrustStrip(): JSX` — no props, fixed copy from Global Constraints.
  - `EmptyState({title, message, cta}: {title: string; message: string; cta?: {to: string; label: string}}): JSX` — mascot art + text + optional Link.
  - `ProductCardImage({image, title}: {image?: {url: string; altText?: string | null} | null; title: string}): JSX` — `<Image>`/`<img>` when image exists, mascot-on-accent placeholder when not.

- [ ] **Step 1: Test infra.** `pnpm --filter @doge-buddy/storefront add -D vitest jsdom @testing-library/react @testing-library/jest-dom`. Create `vitest.config.ts` (environment `jsdom`, globals true, include `app/**/*.test.{ts,tsx}`; add a `test: "vitest run"` script). React Router component imports (`Link`) need a router in tests — wrap render in `createMemoryRouter`/`RouterProvider` or stub `Link` via `vi.mock('react-router', …)`; pick one and use it consistently.

- [ ] **Step 2: Failing tests.**

```tsx
import {render, screen} from '@testing-library/react';
import {TrustStrip} from '../TrustStrip';
import {EmptyState} from '../EmptyState';
import {ProductCardImage} from '../ProductCardImage';

it('trust strip carries the exact promise copy', () => {
  render(<TrustStrip />);
  expect(screen.getByText('Ships from US warehouses · 3–7 day delivery')).toBeInTheDocument();
});

it('empty state shows title, message, optional CTA', () => {
  render(<EmptyState title="Nothing here" message="Try a search." cta={{to: '/collections/toys-play', label: 'Shop toys'}} />);
  expect(screen.getByText('Nothing here')).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Shop toys'})).toHaveAttribute('href', '/collections/toys-play');
});

it('product card falls back to mascot art when no image', () => {
  render(<ProductCardImage image={null} title="Sample — Rope Toy" />);
  expect(screen.getByRole('img', {name: /doge buddy mascot/i})).toBeInTheDocument();
});

it('product card uses the product image when present', () => {
  render(<ProductCardImage image={{url: 'https://cdn.shopify.com/x.jpg', altText: 'Rope toy'}} title="Sample — Rope Toy" />);
  expect(screen.getByRole('img', {name: 'Rope toy'})).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to fail.** `pnpm --filter @doge-buddy/storefront test` → FAIL (modules don't exist).

- [ ] **Step 4: Implement minimally.** TrustStrip: `<p className="bg-badge text-ink text-center text-sm font-medium py-2 rounded-2xl">…copy…</p>`. EmptyState: mascot `<img src={mascot} alt="" aria-hidden>` + heading + message + optional `<Link className="bg-cta text-white rounded-2xl px-5 py-2 font-bold">`. ProductCardImage: image branch renders `<img src alt={altText ?? title}>` in `rounded-2xl overflow-hidden`; fallback branch `bg-accent/20` panel with `<img src={mascot} alt="Doge Buddy mascot placeholder">`.

- [ ] **Step 5: Run to pass, commit.** Tests green; root `pnpm test` still green.

```bash
git add -A && git commit -m "feat(storefront): brand primitives (trust strip, empty state, image fallback) with tests"
```

---

### Task 4: Header + Footer restyle

**Files:**
- Modify: `apps/storefront/app/components/Header.tsx`, `Footer.tsx` (skeleton names; adapt if different), `app/root.tsx` if nav data is loaded there

**Interfaces:**
- Consumes: `wordmark.svg`, tokens, `TrustStrip`.
- Produces: header nav hardcoded to the four collection paths `/collections/toys-play|walks-travel|beds-comfort|grooming-care` (+ skeleton search & cart toggles); footer with `/policies/*` links + TrustStrip. Later tasks rely on these exact paths existing in nav.

- [ ] **Step 1: Header.** Replace skeleton logo/shop-name with `<img src={wordmark} alt="Doge Buddy" className="h-8">`. Replace the menu-driven nav items with the four collection links (keep the skeleton's mobile-menu/aside mechanics intact — swap the items, not the machinery). Keep search toggle and cart badge; restyle with tokens (`bg-surface-raised`, `text-ink`, hover `text-cta`, `rounded-2xl` hit areas).

- [ ] **Step 2: Footer.** Replace skeleton footer menu with: policy links (`/policies/shipping`, `/policies/returns`, `/policies/privacy`, `/policies/terms` — routes arrive in Task 10; dead links are fine until then), `<TrustStrip />`, and a `© Doge Buddy` line. `bg-ink text-surface` footer, links hover `text-accent`.

- [ ] **Step 3: Verify + commit.** Typecheck + dev-server eyeball (desktop + narrow viewport for the mobile menu).

```bash
git add -A && git commit -m "feat(storefront): branded header and footer with collection nav"
```

---

### Task 5: Home page — hero, featured products, trust strip

**Files:**
- Modify: `apps/storefront/app/routes/_index.tsx`
- Create: `apps/storefront/app/components/brand/Hero.tsx`

**Interfaces:**
- Consumes: `mascot.svg`, tokens, `TrustStrip`, `ProductCardImage`, skeleton `_index` loader data (recommended/featured products query — keep the skeleton's loader; restyle presentation only).

- [ ] **Step 1: Hero component.** Brand-art composition, no photography:

```tsx
import mascot from '~/assets/mascot.svg';
import {Link} from 'react-router';

export function Hero() {
  return (
    <section className="bg-surface-raised rounded-2xl px-6 py-12 md:flex items-center gap-8 shadow-sm">
      <div className="max-w-xl">
        <h1 className="font-display font-extrabold text-4xl md:text-5xl text-ink">
          Great gear for your best friend
        </h1>
        <p className="mt-4 text-lg text-info">
          Toys, walks, beds, and grooming — picked for happy dogs, shipped fast from US warehouses.
        </p>
        <Link to="/collections/toys-play" className="mt-6 inline-block bg-cta text-white font-bold rounded-2xl px-8 py-3 hover:opacity-90">
          Shop toys
        </Link>
      </div>
      <div className="mt-8 md:mt-0 shrink-0">
        <div className="bg-accent/30 rounded-full p-8">
          <img src={mascot} alt="" aria-hidden className="w-48 h-48 md:w-64 md:h-64" />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Home route.** In `_index.tsx`, keep the loader; render `<Hero />` → skeleton's featured/recommended product grid restyled (`ProductCardImage` for thumbnails, `bg-surface-raised rounded-2xl` cards, price in `font-bold`) → `<TrustStrip />` at the bottom. Update the route's `meta` title to `Doge Buddy — Great gear for your best friend`.

- [ ] **Step 3: Verify + commit.** Typecheck; dev server: hero, products from mock.shop, trust strip.

```bash
git add -A && git commit -m "feat(storefront): branded home page with hero and featured products"
```

---

### Task 6: Collections index + collection pages

**Files:**
- Modify: `apps/storefront/app/routes/collections._index.tsx`, `collections.$handle.tsx`
- Create: `apps/storefront/app/components/brand/CollectionTile.tsx`

**Interfaces:**
- Consumes: `mascot.svg`, tokens, `ProductCardImage`.
- Produces: `CollectionTile({handle, title}: {handle: string; title: string}): JSX` — flat-color composition per category (no collection images needed).

- [ ] **Step 1: CollectionTile.** Map handle → accent treatment (all token-based): `toys-play` `bg-accent/30`, `walks-travel` `bg-info/15`, `beds-comfort` `bg-badge`, `grooming-care` `bg-cta/10`; unknown handles get `bg-surface-raised`. Tile = `<Link to={`/collections/${handle}`}>` wrapping mascot art small + `font-display font-bold text-xl` title, `rounded-2xl p-6 hover:shadow-md`.

- [ ] **Step 2: Collections index.** Restyle the skeleton grid to `CollectionTile`s (mock.shop collections will show with fallback treatment; the four real handles light up on the test store — both fine).

- [ ] **Step 3: Collection page.** Restyle product grid with `ProductCardImage` cards; collection title in `font-display font-extrabold text-3xl`; keep skeleton pagination as-is.

- [ ] **Step 4: Verify + commit.** Typecheck; dev-server eyeball both routes.

```bash
git add -A && git commit -m "feat(storefront): collection tiles and branded collection pages"
```

---

### Task 7: PDP — metafields query + DeliveryBadge (TDD)

**Files:**
- Create: `apps/storefront/app/components/brand/DeliveryBadge.tsx`, `__tests__/delivery-badge.test.tsx`
- Modify: `apps/storefront/app/routes/products.$handle.tsx` (route + its GraphQL fragment)

**Interfaces:**
- Produces: `DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}): JSX | null` — metafield `value`s arrive as strings; renders `null` unless **all three** are present.

- [ ] **Step 1: Failing tests.**

```tsx
import {render, screen} from '@testing-library/react';
import {DeliveryBadge} from '../DeliveryBadge';

it.each([
  [null, '3', '7'], ['US warehouse', null, '7'], ['US warehouse', '3', null], [null, null, null],
])('renders nothing when any metafield is missing (%s, %s, %s)', (s, min, max) => {
  const {container} = render(<DeliveryBadge shipsFrom={s} minDays={min} maxDays={max} />);
  expect(container).toBeEmptyDOMElement();
});

it('renders the badge with the exact format when all present', () => {
  render(<DeliveryBadge shipsFrom="US warehouse" minDays="3" maxDays="7" />);
  expect(screen.getByText('Ships from US warehouse · 3–7 days')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to fail.** `pnpm --filter @doge-buddy/storefront test` → FAIL.

- [ ] **Step 3: Implement.**

```tsx
export function DeliveryBadge({shipsFrom, minDays, maxDays}: {shipsFrom?: string | null; minDays?: string | null; maxDays?: string | null}) {
  if (!shipsFrom || !minDays || !maxDays) return null;
  return (
    <p className="bg-badge text-ink rounded-2xl px-4 py-2 text-sm font-medium inline-block">
      Ships from {shipsFrom} · {minDays}–{maxDays} days
    </p>
  );
}
```

- [ ] **Step 4: Run to pass.**

- [ ] **Step 5: Wire the PDP.** In the product route's GraphQL product fragment add:

```graphql
shipsFrom: metafield(namespace: "dogebuddy", key: "ships_from") { value }
deliveryMinDays: metafield(namespace: "dogebuddy", key: "delivery_min_days") { value }
deliveryMaxDays: metafield(namespace: "dogebuddy", key: "delivery_max_days") { value }
```

Run `pnpm --filter @doge-buddy/storefront codegen`. Render `<DeliveryBadge shipsFrom={product.shipsFrom?.value} minDays={product.deliveryMinDays?.value} maxDays={product.deliveryMaxDays?.value} />` under the price. Restyle PDP chrome with tokens (title `font-display font-extrabold`, add-to-cart button `bg-cta text-white rounded-2xl font-bold`); keep variant/option logic stock.

- [ ] **Step 6: Verify + commit.** Tests green; typecheck; mock.shop PDP shows **no** badge (metafields absent — expected per spec).

```bash
git add -A && git commit -m "feat(storefront): PDP delivery badge from dogebuddy metafields"
```

---

### Task 8: Cart + search restyle with empty states

**Files:**
- Modify: skeleton cart components (`app/components/Cart*.tsx`) and `app/routes/cart.tsx`, search route/components (`app/routes/search.tsx`)

**Interfaces:**
- Consumes: `EmptyState`, `ProductCardImage`, tokens. Checkout stays `cart.checkoutUrl` — untouched.

- [ ] **Step 1: Cart.** Line items restyled (thumbnail via `ProductCardImage`, `rounded-2xl` rows); checkout button `bg-cta text-white font-bold rounded-2xl w-full py-3` (same `checkoutUrl` target). Empty cart renders `<EmptyState title="Your cart is empty" message="Your buddy deserves something new." cta={{to: '/collections/toys-play', label: 'Start shopping'}} />`.

- [ ] **Step 2: Search.** Restyle results grid with `ProductCardImage` cards; no-results renders `<EmptyState title="No treats found" message="Try a different search — or browse the collections." />`.

- [ ] **Step 3: Verify + commit.** Typecheck; dev server: add/remove item, empty-cart state, search hit + miss.

```bash
git add -A && git commit -m "feat(storefront): branded cart and search with mascot empty states"
```

---

### Task 9: SEO — JSON-LD builders (TDD) + meta wiring

**Files:**
- Create: `apps/storefront/app/lib/seo.ts`, `apps/storefront/app/lib/__tests__/seo.test.ts`
- Modify: `app/root.tsx`, `app/routes/products.$handle.tsx`

**Interfaces:**
- Produces (pure functions returning plain objects):
  - `productJsonLd(p: {name: string; description: string; url: string; imageUrl?: string; price: string; currencyCode: string; available: boolean}): object`
  - `organizationJsonLd(o: {name: string; url: string; logoUrl: string}): object`
  - `webSiteJsonLd(w: {name: string; url: string}): object`

- [ ] **Step 1: Failing tests.**

```ts
import {productJsonLd, organizationJsonLd, webSiteJsonLd} from '../seo';

it('builds Product JSON-LD with offer', () => {
  const ld = productJsonLd({name: 'Rope Toy', description: 'Tug fun', url: 'https://x/p/rope', imageUrl: 'https://x/i.jpg', price: '12.99', currencyCode: 'USD', available: true}) as any;
  expect(ld['@type']).toBe('Product');
  expect(ld.offers).toMatchObject({'@type': 'Offer', price: '12.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock'});
});

it('marks unavailable products OutOfStock and omits missing image', () => {
  const ld = productJsonLd({name: 'X', description: '', url: 'https://x', price: '1.00', currencyCode: 'USD', available: false}) as any;
  expect(ld.offers.availability).toBe('https://schema.org/OutOfStock');
  expect('image' in ld).toBe(false);
});

it('builds Organization and WebSite JSON-LD', () => {
  expect((organizationJsonLd({name: 'Doge Buddy', url: 'https://x', logoUrl: 'https://x/l.svg'}) as any)['@type']).toBe('Organization');
  expect((webSiteJsonLd({name: 'Doge Buddy', url: 'https://x'}) as any)['@type']).toBe('WebSite');
});
```

- [ ] **Step 2: Run to fail.** → FAIL. **Step 3: Implement** — each builder returns `{'@context': 'https://schema.org', '@type': …, …}`; spread `imageUrl` conditionally. **Step 4: Run to pass.**

- [ ] **Step 5: Wire.** Root route meta gains Organization + WebSite JSON-LD (site URL from the `request.url` origin in the loader; logo URL is the origin + `/favicon_256px.png`, copied to `public/` in Task 2). PDP meta gains `productJsonLd` from loader data (`selectedVariant` price/availability). Use the skeleton's meta pattern — `getSeoMeta` from `@shopify/hydrogen` if already imported, else a `{'script:ld+json': …}` meta descriptor. Give every route a real `<title>`/description while there (home from Task 5; collections `"{title} — Doge Buddy"`; PDP `"{product.title} — Doge Buddy"`).

- [ ] **Step 6: Verify + commit.** Tests green; `curl -s localhost:3000 | grep 'ld+json'` shows Organization; a PDP shows Product.

```bash
git add -A && git commit -m "feat(storefront): Product/Organization/WebSite JSON-LD and route meta"
```

---

### Task 10: Policy pages (repo-authored copy)

**Files:**
- Create: `apps/storefront/app/content/policies.tsx`
- Modify: `apps/storefront/app/routes/policies._index.tsx`, `policies.$handle.tsx` (replace Storefront-API-driven versions)

**Interfaces:**
- Produces: `POLICIES: {handle: 'shipping' | 'returns' | 'privacy' | 'terms'; title: string; updated: string; Body: () => JSX}[]` from `~/content/policies`.

- [ ] **Step 1: Content module.** `POLICIES` with `updated: '2026-08-17'` and this copy (verbatim; light JSX formatting — h2s + paragraphs + lists):

**Shipping:** All orders ship from US warehouses. Standard delivery arrives in 3–7 business days after your order is processed (processing up to 1 business day). Tracking is emailed as soon as your order ships, and also appears in your account's order history. We currently ship within the United States only. If your order hasn't arrived within the promised window, contact us and we'll make it right — replacement or full refund.

**Returns:** 30-day returns. If you or your dog aren't happy with an item, contact us within 30 days of delivery for a prepaid return label — refunds go to the original payment method within 5–10 business days of the returned item arriving. Items should be unused where possible, but if your dog took a test chew, talk to us anyway. Damaged or wrong items: full refund or replacement, photos appreciated, no return needed for damaged goods.

**Privacy:** We collect what a store needs to work — your order details, shipping address, and email. Payment is processed by Shopify; we never see your card number. To run the store we share data with service providers acting on our behalf: Shopify (storefront and payments), CJ Dropshipping (order fulfillment and shipping — they receive your name and shipping address), Google Workspace (support email), and Anthropic (AI assistance for product curation and support drafting; support messages may be processed to draft replies). We don't sell your data. Email support to access or delete your data. (Close with: contact address placeholder pending domain decision — use `support@ (email address coming soon — see contact page)` wording for now; final address lands with the Phase 6 domain.)

**Terms:** Standard short-form terms: US customers only; prices in USD; we may cancel and fully refund orders we can't fulfill; disputes governed by the laws of the state of the LLC's registration; policies above are part of these terms.

Each page footer: `Last updated {updated} · This policy will be finalized before launch.`

- [ ] **Step 2: Routes.** `policies._index.tsx`: list of links from `POLICIES` (drop the skeleton's shop-policy query and loader). `policies.$handle.tsx`: look up by handle, 404 via `throw new Response('Not Found', {status: 404})` for unknown handles; render `Body` in `prose`-like token styling (`max-w-2xl`, headings `font-display font-bold`). Remove now-unused policy GraphQL fragments; run codegen.

- [ ] **Step 3: Verify + commit.** Typecheck; all four pages render; footer links from Task 4 now resolve; unknown handle 404s.

```bash
git add -A && git commit -m "feat(storefront): repo-authored policy pages (shipping, returns, privacy, terms)"
```

---

### Task 11: shopify-admin — seed operations (TDD)

**Files:**
- Modify: `packages/shopify-admin/src/operations.ts`, `packages/shopify-admin/src/index.ts` (export new ops), `packages/shopify-admin/test/operations.test.ts`

**Interfaces:**
- Consumes: existing `ShopifyAdminClient`, `assertNoUserErrors` (see `operations.ts` for the house pattern — follow it exactly).
- Produces (exact signatures; Task 12 imports these from `@doge-buddy/shopify-admin`):
  - `metafieldDefinitionCreate(client, def: {name: string; namespace: string; key: string; type: string; ownerType: 'PRODUCT'}): Promise<{id: string}>` — always sends `access: {storefront: 'PUBLIC_READ'}`.
  - `listMetafieldDefinitions(client, namespace: string): Promise<{id: string; key: string}[]>` (ownerType PRODUCT, first 250).
  - `collectionCreate(client, input: {title: string; handle: string; tagCondition: string}): Promise<{id: string}>` — smart collection, single rule `{column: 'TAG', relation: 'EQUALS', condition: tagCondition}`, `appliedDisjunctively: false`.
  - `listCollections(client): Promise<{id: string; handle: string}[]>` (first 250).
  - `findProductByHandle(client, handle: string): Promise<{id: string} | null>` — `products(first: 1, query: $query)` with `query = "handle:'<handle>'"`.

- [ ] **Step 1: Failing tests** in `operations.test.ts`, using the file's existing `makeClient`/`gql`/`lastGraphqlCall` helpers. One happy-path + one userErrors test per mutation; happy-path per query; plus: metafieldDefinitionCreate asserts `variables.definition.access` equals `{storefront: 'PUBLIC_READ'}`; collectionCreate asserts the ruleSet shape; findProductByHandle asserts the query-string variable and returns `null` for empty nodes.

```ts
describe('metafieldDefinitionCreate', () => {
  it('creates with PUBLIC_READ storefront access', async () => {
    const {client, calls} = makeClient(() =>
      gql({metafieldDefinitionCreate: {createdDefinition: {id: 'gid://shopify/MetafieldDefinition/1'}, userErrors: []}}))
    const result = await metafieldDefinitionCreate(client, {name: 'Ships from', namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', ownerType: 'PRODUCT'})
    expect(result).toEqual({id: 'gid://shopify/MetafieldDefinition/1'})
    const {variables} = lastGraphqlCall(calls)
    expect((variables as any).definition.access).toEqual({storefront: 'PUBLIC_READ'})
  })
  it('throws ShopifyUserError on userErrors', async () => { /* mirror existing productSet error test */ })
})
```

(Write the remaining describes in the same style — `collectionCreate`, `listCollections`, `listMetafieldDefinitions`, `findProductByHandle`.)

- [ ] **Step 2: Run to fail.** `pnpm --filter @doge-buddy/shopify-admin test` → FAIL.

- [ ] **Step 3: Implement** in `operations.ts`, house style (module-level `#graphql` docs, typed Data interfaces, `assertNoUserErrors`). Mutations:

```graphql
mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message }
  }
}
mutation CollectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id }
    userErrors { field message }
  }
}
```

Queries: `collections(first: 250) { nodes { id handle } }`; `metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: $namespace) { nodes { id key } }`; `products(first: 1, query: $query) { nodes { id } }`. Export all five from `index.ts`.

- [ ] **Step 4: Run to pass.** Package tests green; root `pnpm typecheck` green.

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "feat(shopify-admin): seed operations (metafield defs, smart collections, lookups)"
```

---

### Task 12: Seed data, planner (TDD), and CLI script

**Files:**
- Create: `apps/ops/src/seed/sample-data.ts`, `apps/ops/src/seed/plan.ts`, `apps/ops/src/seed/run.ts`, `apps/ops/test/seed-plan.test.ts`, `apps/ops/scripts/seed-store.ts`
- Modify: `apps/ops/package.json` (script `"seed-store": "tsx scripts/seed-store.ts"`)

**Interfaces:**
- Consumes: Task 11 operations + existing `productSet`, `listPublications`, `publishablePublish`, `ShopifyAdminClient`/`ShopifyTokenManager` construction and env loading exactly as `apps/ops/scripts/verify-live.ts` does (read it first — mirror its client setup and `lib/load-env.ts` usage).
- Produces:
  - `sample-data.ts`: `METAFIELD_DEFINITIONS` (the 3 from Global Constraints, with display names "Ships from" / "Delivery min days" / "Delivery max days"), `COLLECTIONS` (4: title/handle/tagCondition), `SAMPLE_PRODUCTS: SampleProduct[]` where `SampleProduct = {title: string; handle: string; categoryTag: string; price: string}` — 10 products, titles prefixed `Sample — `, handles prefixed `sample-`, tags `[categoryTag, 'sample']`, all with ships_from `US warehouse`, min 3, max 7 (constants, not per-product).
  - `plan.ts`: `planSeed(state: {definitionKeys: string[]; collectionHandles: string[]; productHandles: string[]}): {definitions: typeof METAFIELD_DEFINITIONS; collections: typeof COLLECTIONS; products: SampleProduct[]}` — pure; returns only what's missing.
  - `run.ts`: `runSeed(client: ShopifyAdminClient, log?: (line: string) => void): Promise<{created: {definitions: number; collections: number; products: number}; skipped: {definitions: number; collections: number; products: number}}>`.

**Sample products** (title / handle / tag / price): Tug-of-War Rope Toy `sample-tug-of-war-rope-toy` toys-play $12.99 · Squeaky Plush Fox `sample-squeaky-plush-fox` toys-play $14.99 · Treat Puzzle Ball `sample-treat-puzzle-ball` toys-play $16.99 · No-Pull Harness `sample-no-pull-harness` walks-travel $24.99 · Reflective Leash `sample-reflective-leash` walks-travel $18.99 · Collapsible Travel Bowl `sample-collapsible-travel-bowl` walks-travel $9.99 · Donut Calming Bed `sample-donut-calming-bed` beds-comfort $39.99 · Cozy Fleece Blanket `sample-cozy-fleece-blanket` beds-comfort $19.99 · Self-Cleaning Slicker Brush `sample-self-cleaning-slicker-brush` grooming-care $15.99 · Nail Grinder Kit `sample-nail-grinder-kit` grooming-care $22.99. (Tags shown bare — store as `category:<tag>`.)

- [ ] **Step 1: Failing planner tests** (`seed-plan.test.ts`):

```ts
import {planSeed} from '../src/seed/plan.ts'
import {METAFIELD_DEFINITIONS, COLLECTIONS, SAMPLE_PRODUCTS} from '../src/seed/sample-data.ts'

it('plans everything on an empty store', () => {
  const plan = planSeed({definitionKeys: [], collectionHandles: [], productHandles: []})
  expect(plan.definitions).toHaveLength(3)
  expect(plan.collections).toHaveLength(4)
  expect(plan.products).toHaveLength(10)
})

it('plans nothing when everything exists (idempotent rerun)', () => {
  const plan = planSeed({
    definitionKeys: METAFIELD_DEFINITIONS.map((d) => d.key),
    collectionHandles: COLLECTIONS.map((c) => c.handle),
    productHandles: SAMPLE_PRODUCTS.map((p) => p.handle),
  })
  expect(plan).toEqual({definitions: [], collections: [], products: []})
})

it('plans only the missing subset', () => {
  const plan = planSeed({definitionKeys: ['ships_from'], collectionHandles: ['toys-play'], productHandles: SAMPLE_PRODUCTS.slice(1).map((p) => p.handle)})
  expect(plan.definitions.map((d) => d.key).sort()).toEqual(['delivery_max_days', 'delivery_min_days'])
  expect(plan.collections).toHaveLength(3)
  expect(plan.products.map((p) => p.handle)).toEqual([SAMPLE_PRODUCTS[0].handle])
})
```

- [ ] **Step 2: Run to fail** (`pnpm --filter @doge-buddy/ops test`), **Step 3: implement** `sample-data.ts` + `plan.ts` (pure filters), **Step 4: run to pass.**

- [ ] **Step 5: `run.ts`.** Gather state: `listMetafieldDefinitions(client, 'dogebuddy')`, `listCollections(client)`, and per-sample `findProductByHandle` (10 sequential calls — fine). `planSeed`, then execute: definitions → collections → products. Product creation via `productSet` with `status: 'ACTIVE'`, tags, the three metafields inline (`metafields: [{namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', value: 'US warehouse'}, …]`), one default variant with `price` and `inventoryItem: {tracked: false}` (untracked ⇒ always purchasable — sample-data inventory mechanism; mirror `verify-live.ts`'s productSet input shape for options/variants). After each product: `publishablePublish(client, productId, pub.id)` for **every** publication from `listPublications` (publication naming varies by store; broad publish is harmless for samples and guarantees the Hydrogen channel gets them). Log each create/skip via `log`.

- [ ] **Step 6: CLI entry** `scripts/seed-store.ts`: mirror `verify-live.ts` env-loading + client construction; require the Shopify env trio (exit 1 with a pointer to `docs/OWNER-CHECKLIST.md` if missing); `runSeed(client, console.log)`; print the created/skipped summary; exit non-zero on any thrown error. Add the `seed-store` script to `apps/ops/package.json`.

- [ ] **Step 7: Full check + commit.** `pnpm --filter @doge-buddy/ops test && pnpm typecheck` green. (Live execution happens in Task 14/Tier 2 — not now.)

```bash
git add -A && git commit -m "feat(ops): idempotent seed-store script (metafield defs, collections, sample products)"
```

---

### Task 13: Playwright smoke suite (local, mock.shop)

**Files:**
- Create: `apps/storefront/e2e/smoke.spec.ts`, `apps/storefront/playwright.config.ts`
- Modify: `apps/storefront/package.json` (script `"smoke": "playwright test"`), `.gitignore` if needed (`playwright-report`, `test-results`)

**Interfaces:**
- Consumes: dev server + mock.shop. NOT wired into CI (external network — per spec).

- [ ] **Step 1: Install.** `pnpm --filter @doge-buddy/storefront add -D @playwright/test && pnpm --filter @doge-buddy/storefront exec playwright install chromium`

- [ ] **Step 2: Config.** `playwright.config.ts`: `testDir: './e2e'`, chromium only, `webServer: {command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 60_000}`, `use: {baseURL: 'http://localhost:3000'}`. Exclude `e2e/` from vitest's include glob (vitest.config.ts from Task 3) so `pnpm test` doesn't pick Playwright specs up.

- [ ] **Step 3: Tests.**

```ts
import {test, expect} from '@playwright/test';

test('home renders hero and products', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: /great gear/i})).toBeVisible();
  await expect(page.getByText('Ships from US warehouses · 3–7 day delivery')).toBeVisible();
});

test('collection page lists products', async ({page}) => {
  await page.goto('/collections');
  await page.getByRole('link').filter({has: page.getByRole('heading')}).first().click();
  await expect(page).toHaveURL(/collections\//);
  await expect(page.getByRole('link', {name: /.+/}).first()).toBeVisible();
});

test('add to cart updates the cart', async ({page}) => {
  await page.goto('/');
  await page.getByRole('link', {name: /sample|hoodie|snowboard|.+/i}).filter({hasNot: page.getByRole('navigation')}).first().click(); // first product card
  await page.getByRole('button', {name: /add to cart/i}).click();
  await expect(page.getByRole('link', {name: /cart/i})).toContainText(/1/);
});

test('cart page shows checkout link', async ({page}) => {
  await page.goto('/');
  await page.locator('a[href^="/products/"]').first().click();
  await page.getByRole('button', {name: /add to cart/i}).click();
  await page.goto('/cart');
  await expect(page.getByRole('link', {name: /checkout/i})).toHaveAttribute('href', /checkout/i);
});
```

Selector caveat: the exact product-card locator depends on skeleton markup — prefer `page.locator('a[href^="/products/"]').first()` (as in the last test) everywhere; adjust the first two tests to it if role-based locators prove brittle.

- [ ] **Step 4: Run + commit.** `pnpm --filter @doge-buddy/storefront smoke` → 4 passed.

```bash
git add -A && git commit -m "test(storefront): local Playwright smoke suite against mock.shop"
```

---

### Task 14: Tier-1 verification, Lighthouse, docs

**Files:**
- Modify: `docs/OWNER-CHECKLIST.md`, `docs/superpowers/specs/2026-08-17-phase-2-storefront-design.md` (inventory-mechanism note), `README.md` (dev quickstart line for the storefront)

- [ ] **Step 1: Full suite.** `pnpm typecheck && pnpm test && pnpm --filter @doge-buddy/storefront build && pnpm --filter @doge-buddy/storefront smoke` — all green. Fix anything that isn't before proceeding.

- [ ] **Step 2: Lighthouse (Tier-1 gate).** Serve the production build (`pnpm --filter @doge-buddy/storefront exec shopify hydrogen preview` — falls back to `dev` if preview is unavailable, but prefer the production build), then:

```bash
npx lighthouse http://localhost:3000 --preset=desktop --output=json --output-path=/tmp/lh-home.json --chrome-flags="--headless=new"
npx lighthouse "http://localhost:3000/products/$(curl -s http://localhost:3000 | grep -o 'products/[a-z0-9-]*' | head -1 | cut -d/ -f2)" --preset=desktop --output=json --output-path=/tmp/lh-pdp.json --chrome-flags="--headless=new"
```

Gate: performance, accessibility, best-practices, SEO all **≥ 0.90** on both runs (`jq '.categories | map_values(.score)' /tmp/lh-*.json`). Below threshold → fix (images sizes, contrast, preload) and re-run; do not proceed with a failing category.

- [ ] **Step 3: Owner checklist.** In `docs/OWNER-CHECKLIST.md` "Phase 1–3 window", add a 🟡 item **"Hydrogen channel + Oxygen for the test store"**: install the Hydrogen sales channel on the test store, create a storefront named `doge-buddy`, connect the GitHub repo `ClosingBracketsLLC/doge-buddy` for Oxygen auto-deploys (dev-store deploys are password-protected — expected), copy the storefront env vars it issues into `apps/storefront/.env` (see `.env.example`), and enable **Bogus Gateway** (test store → Settings → Payments → third-party → Bogus). *Blocks:* 🔴 Tier-2 verification of Phase 2 (real-store browse, Bogus checkout, Oxygen deploy) — Tier-1/mock.shop build proceeds without it. Add to "Later phases": ⚪ Phase 7 — paste `apps/storefront/app/content/policies.tsx` copy into Shopify Settings → Policies and review/finalize before launch. Update the "last updated" footer line.

- [ ] **Step 4: Spec + README touch-ups.** Spec §3: after the seed-script bullet list, append one line: "Inventory mechanism: sample variants are created untracked (`inventoryItem.tracked: false`) — always purchasable; no `inventorySetQuantities` call needed for samples." README dev section: add `pnpm --filter @doge-buddy/storefront dev` (mock.shop, no credentials) alongside existing quickstart lines.

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "docs: Phase 2 Tier-1 verification notes, owner checklist storefront items"
```

**Tier 2 (deferred until Robert's credentials/channel exist — not part of this plan's execution):** link `.env` → `pnpm --filter @doge-buddy/ops seed-store` → badges visible on seeded PDPs → Bogus checkout > $1 lands `test:true` order (cancel test orders as you go) → Oxygen deploy live. Tracked on the owner checklist.
