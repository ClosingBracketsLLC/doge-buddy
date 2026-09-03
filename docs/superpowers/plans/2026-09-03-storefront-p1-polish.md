# Storefront P1 Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Related products on the product page, a home page that routes shoppers (category tiles + value props + New arrivals), the skeleton blog removed everywhere it surfaces, and an About footer link.

**Architecture:** All storefront (Hydrogen / React Router, `apps/storefront`). Related products ride the product route's designated deferred slot through a pure `pickRelated` helper keyed on the four `CATEGORIES` handles from `@doge-buddy/core` (already a dep). Home gains two new pure presentational components and loses a dead critical-path query. Blogs: route files deleted + sitemap restricted via Hydrogen's `types` option (verified present in 2026.4.5) + a 404 guard on the child sitemap route.

**Tech Stack:** Hydrogen 2026.4.5, React Router, Storefront API `#graphql` tagged queries (codegen via `pnpm --filter @doge-buddy/storefront codegen`), vitest + @testing-library/react (existing `__tests__` idiom), Tailwind classes matching the brand primitives.

**Spec:** `docs/superpowers/specs/2026-09-03-storefront-p1-polish-design.md`

## Global Constraints

- Test/typecheck commands: `pnpm --filter @doge-buddy/storefront test` (vitest) and `pnpm --filter @doge-buddy/storefront typecheck` (runs `react-router typegen && tsc --noEmit`). After adding/removing any `#graphql` query, run `pnpm --filter @doge-buddy/storefront codegen` before typecheck.
- Deferred data must NEVER 500 the page: every deferred promise ends in `.catch(...) => null` (the skeleton's own contract, see `loadDeferredData` doc comments).
- An empty/failed related list, or missing data anywhere, renders NOTHING — no headings over empty grids, never a fabricated value (the "New arrivals" retitle exists because "Fan favorites" with zero sales data is a fabricated claim).
- `TrustStrip` is NOT touched (footer + product page reuse it).
- Copy verbatim: home value props = "Ships from US warehouses" · "3–7 day delivery" · "All sales final — see our returns policy" (last one links `/policies/returns`); headings = "Shop by category", "New arrivals", "You might also like"; footer link = "About" → `/pages/about`.
- Component style: follow the existing brand primitives (RibbonHeading, CollectionTile, ProductItem, section + `aria-labelledby` idiom in `_index.tsx`).
- Existing tests keep passing. Tests wrap router-dependent components the way the existing `__tests__` files do (read one first; `ProductItem` uses `useVariantUrl` → needs a router wrapper).
- Ops/db/core packages: untouched (except docs). No live Shopify calls in tests.

---

### Task 1: `pickRelated` helper

**Files:**
- Create: `apps/storefront/app/lib/related.ts`
- Test: `apps/storefront/app/lib/__tests__/related.test.ts` (new dir if `app/lib/__tests__` doesn't exist — check for an existing lib test location first and follow it)

**Interfaces:**
- Consumes: `CATEGORIES` from `@doge-buddy/core`.
- Produces (Task 2 relies on these exact names):

```ts
export const KNOWN_CATEGORY_HANDLES: ReadonlySet<string>
export const RELATED_LIMIT = 4
export function pickRelated<T extends {handle: string}>(
  collections: ReadonlyArray<{handle: string; products: {nodes: T[]}}> | null | undefined,
  currentHandle: string,
): T[]
```

- [ ] **Step 1: Write the failing tests**

```ts
import {describe, expect, it} from 'vitest';
import {pickRelated, KNOWN_CATEGORY_HANDLES, RELATED_LIMIT} from '../related';

const p = (handle: string) => ({handle});

describe('pickRelated', () => {
  it('picks the first CATEGORY collection, drops the current product, caps at RELATED_LIMIT', () => {
    const collections = [
      {handle: 'frontpage', products: {nodes: [p('x1'), p('x2')]}},
      {handle: 'toys-play', products: {nodes: [p('me'), p('a'), p('b'), p('c'), p('d'), p('e')]}},
      {handle: 'beds-comfort', products: {nodes: [p('z')]}},
    ];
    const related = pickRelated(collections, 'me');
    expect(related.map((r) => r.handle)).toEqual(['a', 'b', 'c', 'd']);
    expect(related).toHaveLength(RELATED_LIMIT);
  });

  it('returns [] when the only collections are non-category (frontpage)', () => {
    expect(pickRelated([{handle: 'frontpage', products: {nodes: [p('a')]}}], 'me')).toEqual([]);
  });

  it('returns [] when the category collection holds only the current product', () => {
    expect(pickRelated([{handle: 'grooming-care', products: {nodes: [p('me')]}}], 'me')).toEqual([]);
  });

  it('returns [] on null/undefined/empty input', () => {
    expect(pickRelated(null, 'me')).toEqual([]);
    expect(pickRelated(undefined, 'me')).toEqual([]);
    expect(pickRelated([], 'me')).toEqual([]);
  });

  it('KNOWN_CATEGORY_HANDLES is exactly the four CATEGORIES handles', () => {
    expect([...KNOWN_CATEGORY_HANDLES].sort()).toEqual(['beds-comfort', 'grooming-care', 'toys-play', 'walks-travel']);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/storefront && npx vitest run app/lib/__tests__/related.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `apps/storefront/app/lib/related.ts`:

```ts
import {CATEGORIES} from '@doge-buddy/core';

/** The four category-collection handles (single source: CATEGORIES). Related products come only
 *  from these — never from `frontpage` or other mixed collections. */
export const KNOWN_CATEGORY_HANDLES: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.handle));

export const RELATED_LIMIT = 4;

/**
 * "You might also like" picker (spec 2026-09-03 storefront-p1 Decision 2): the first collection
 * that is a CATEGORY collection, minus the product being viewed, capped at RELATED_LIMIT. Pure and
 * total: any missing/empty input yields [] — the section renders nothing rather than guessing.
 */
export function pickRelated<T extends {handle: string}>(
  collections: ReadonlyArray<{handle: string; products: {nodes: T[]}}> | null | undefined,
  currentHandle: string,
): T[] {
  const category = collections?.find((c) => KNOWN_CATEGORY_HANDLES.has(c.handle));
  if (!category) return [];
  return category.products.nodes.filter((p) => p.handle !== currentHandle).slice(0, RELATED_LIMIT);
}
```

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/lib/related.ts apps/storefront/app/lib/__tests__/related.test.ts
git commit -m "feat(storefront): pickRelated — category-collection related-products picker"
```

---

### Task 2: Related products on the product page

**Files:**
- Create: `apps/storefront/app/components/product/RelatedProducts.tsx`
- Modify: `apps/storefront/app/routes/products.$handle.tsx` (loadDeferredData ~line 110; component render after `<SupplierReviews>` ~line 186; queries at the bottom)
- Modify: `apps/storefront/app/components/ProductItem.tsx` (prop union gains the new fragment type)
- Test: `apps/storefront/app/components/product/__tests__/related-products.test.tsx`

**Interfaces:**
- Consumes: `pickRelated`, `RELATED_LIMIT` (Task 1); `ProductItem`, `RibbonHeading` (existing).
- Produces: `RelatedProducts({products}: {products: RelatedProductFragment[] | null})` — a PURE presentational component (the route owns Suspense/Await), so tests render it with plain arrays.

- [ ] **Step 1: Write the failing tests** (wrap in a router the way existing `__tests__` files wrap components that link — read `cart-main.test.tsx` or `product-gallery.test.tsx` first and copy the idiom):

```tsx
import {render, screen} from '@testing-library/react';
import {RelatedProducts} from '../RelatedProducts';
// + the router wrapper idiom used by the file you read (ProductItem calls useVariantUrl)

const product = (id: string, title: string) => ({
  id, title, handle: title.toLowerCase(),
  priceRange: {minVariantPrice: {amount: '19.99', currencyCode: 'USD'}},
  featuredImage: null,
});

describe('RelatedProducts', () => {
  it('renders nothing for null', () => {
    expect(renderWithRouter(<RelatedProducts products={null} />).container).toBeEmptyDOMElement();
  });
  it('renders nothing for an empty list (no heading over an empty grid)', () => {
    expect(renderWithRouter(<RelatedProducts products={[]} />).container).toBeEmptyDOMElement();
  });
  it('renders the heading and one card per product', () => {
    renderWithRouter(<RelatedProducts products={[product('1', 'Rope'), product('2', 'Ball')] as never} />);
    expect(screen.getByText('You might also like')).toBeInTheDocument();
    expect(screen.getByText('Rope')).toBeInTheDocument();
    expect(screen.getByText('Ball')).toBeInTheDocument();
  });
});
```

(`renderWithRouter` = whatever helper/idiom the existing tests use; if none exists, `createRoutesStub` from react-router per its testing docs.)

- [ ] **Step 2: Run to verify fail** — `cd apps/storefront && npx vitest run app/components/product/__tests__/related-products.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`RelatedProducts.tsx`:

```tsx
import type {RelatedProductFragment} from 'storefrontapi.generated';
import {ProductItem} from '~/components/ProductItem';
import {RibbonHeading} from '~/components/brand/RibbonHeading';

/** "You might also like" (spec Decision 3): pure presentational — the route resolves the deferred
 *  list; null (failed/absent) and [] both render NOTHING. */
export function RelatedProducts({products}: {products: RelatedProductFragment[] | null}) {
  if (!products || products.length === 0) return null;
  return (
    <section className="mt-12" aria-labelledby="related-products">
      <div id="related-products">
        <RibbonHeading>You might also like</RibbonHeading>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {products.map((product) => (
          <ProductItem key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}
```

`products.$handle.tsx` — replace the empty `loadDeferredData` body:

```ts
function loadDeferredData({context, params}: Route.LoaderArgs) {
  // Related products (spec 2026-09-03 storefront-p1 Decision 2): deferred, never blocks TTFB,
  // never 500s — a failed query or an uncategorized product resolves to null and the section
  // renders nothing.
  const relatedProducts = params.handle
    ? context.storefront
        .query(RELATED_PRODUCTS_QUERY, {variables: {handle: params.handle}})
        .then((result) => pickRelated(result.product?.collections?.nodes, params.handle!))
        .catch((error: Error) => {
          console.error(error);
          return null;
        })
    : Promise.resolve(null);

  return {relatedProducts};
}
```

Component: destructure `relatedProducts` from `useLoaderData`, render after `<SupplierReviews … />`:

```tsx
<Suspense fallback={null}>
  <Await resolve={relatedProducts}>
    {(related) => <RelatedProducts products={related} />}
  </Await>
</Suspense>
```

(add the `Suspense`/`Await` imports the file may not have yet).

Query, at the bottom with the others:

```ts
const RELATED_PRODUCTS_QUERY = `#graphql
  fragment RelatedProduct on Product {
    id
    title
    handle
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    featuredImage {
      id
      url
      altText
      width
      height
    }
  }
  query RelatedProducts($handle: String!, $country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    product(handle: $handle) {
      collections(first: 5) {
        nodes {
          handle
          products(first: 8) {
            nodes {
              ...RelatedProduct
            }
          }
        }
      }
    }
  }
` as const;
```

`ProductItem.tsx`: add `RelatedProductFragment` to the imported generated types and to the `product` prop union.

Then run `pnpm --filter @doge-buddy/storefront codegen` (generates `RelatedProductFragment`; without it typecheck fails on the import).

- [ ] **Step 4: Run to verify pass** — the new test file + `npx vitest run app/components/product` (whole dir, no regressions) + `pnpm --filter @doge-buddy/storefront typecheck`. Expected: PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/product/RelatedProducts.tsx apps/storefront/app/components/product/__tests__/related-products.test.tsx apps/storefront/app/routes/products.\$handle.tsx apps/storefront/app/components/ProductItem.tsx apps/storefront/storefrontapi.generated.d.ts
git commit -m "feat(storefront): You might also like — category-collection related products, deferred"
```

---

### Task 3: Home page — value props, category tiles, New arrivals, dead-query cleanup

**Files:**
- Create: `apps/storefront/app/components/brand/ValueProps.tsx`
- Create: `apps/storefront/app/components/brand/CategoryTiles.tsx`
- Modify: `apps/storefront/app/routes/_index.tsx`
- Test: `apps/storefront/app/components/__tests__/home-sections.test.tsx`

**Interfaces:**
- Consumes: `CATEGORIES` (`@doge-buddy/core`), `CollectionTile`, `RibbonHeading` (existing).
- Produces: `ValueProps()` and `CategoryTiles()` — zero-prop presentational components.

- [ ] **Step 1: Write the failing tests**

```tsx
import {render, screen} from '@testing-library/react';
import {ValueProps} from '../brand/ValueProps';
import {CategoryTiles} from '../brand/CategoryTiles';
// router wrapper idiom as in Task 2 (CollectionTile and the policy link render <Link>)

describe('ValueProps', () => {
  it('renders the three value props with the returns-policy link', () => {
    renderWithRouter(<ValueProps />);
    expect(screen.getByText('Ships from US warehouses')).toBeInTheDocument();
    expect(screen.getByText('3–7 day delivery')).toBeInTheDocument();
    expect(screen.getByRole('link', {name: /returns policy/i})).toHaveAttribute('href', '/policies/returns');
  });
});

describe('CategoryTiles', () => {
  it('renders one tile per category, linking its collection', () => {
    renderWithRouter(<CategoryTiles />);
    expect(screen.getByText('Shop by category')).toBeInTheDocument();
    for (const [handle, title] of [
      ['toys-play', 'Toys & Play'],
      ['walks-travel', 'Walks & Travel'],
      ['beds-comfort', 'Beds & Comfort'],
      ['grooming-care', 'Grooming & Care'],
    ]) {
      expect(screen.getByRole('link', {name: new RegExp(title!)})).toHaveAttribute('href', `/collections/${handle}`);
    }
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd apps/storefront && npx vitest run app/components/__tests__/home-sections.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`ValueProps.tsx`:

```tsx
import {Link} from 'react-router';

/** Home value-props strip (spec Decision 5). The all-sales-final item LINKS to the policy rather
 *  than paraphrasing it — policy copy is legally load-bearing and single-sourced in POLICY_COPY. */
export function ValueProps() {
  const item = 'rounded-2xl bg-badge px-3 py-2 text-center text-sm font-medium text-ink';
  return (
    <ul className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
      <li className={item}>Ships from US warehouses</li>
      <li className={item}>3–7 day delivery</li>
      <li className={item}>
        All sales final —{' '}
        <Link to="/policies/returns" className="underline transition-colors hover:text-accent">
          see our returns policy
        </Link>
      </li>
    </ul>
  );
}
```

`CategoryTiles.tsx`:

```tsx
import {CATEGORIES} from '@doge-buddy/core';
import {CollectionTile} from '~/components/brand/CollectionTile';
import {RibbonHeading} from '~/components/brand/RibbonHeading';

/** Home "Shop by category" grid (spec Decision 4): static — handles/titles compile in from
 *  CATEGORIES and CollectionTile carries its own art, so this needs no query at all. */
export function CategoryTiles() {
  return (
    <section className="mt-12" aria-labelledby="shop-by-category">
      <div id="shop-by-category">
        <RibbonHeading>Shop by category</RibbonHeading>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {CATEGORIES.map((c) => (
          <CollectionTile key={c.handle} handle={c.handle} title={c.title} />
        ))}
      </div>
    </section>
  );
}
```

`_index.tsx`:
1. FIRST verify the dead code is dead: `grep -rn "isShopLinked\|featuredCollection" apps/storefront/app` — if either has a consumer outside this route's own loader/return, KEEP it and note the deviation in your report. Spec-time grep says both are dead.
2. If dead: delete `loadCriticalData` and `FEATURED_COLLECTION_QUERY` entirely; the loader becomes:

```ts
export async function loader(args: Route.LoaderArgs) {
  // All home data is deferred (spec Decision 7) — the old critical-path FEATURED_COLLECTION_QUERY
  // was never rendered and is gone.
  return loadDeferredData(args);
}
```

3. Render: `<Hero />` then `<ValueProps />` then `<CategoryTiles />` then the products section.
4. In `RecommendedProducts`: heading text → `New arrivals`, `aria-labelledby`/id → `new-arrivals`; consider renaming the component/prop symbols to `NewArrivals`/`NEW_ARRIVALS_QUERY` for honesty (do it — small file, single call site).
5. Query: `first: 4` → `first: 8`, and `sortKey: UPDATED_AT` → `sortKey: CREATED_AT` (spec risk note: CREATED_AT is a valid Storefront API `ProductSortKeys` value; verify in the generated types/docs — if it isn't available in this API version, keep UPDATED_AT and say so in your report).
6. Run `pnpm --filter @doge-buddy/storefront codegen` (query changed).

- [ ] **Step 4: Run to verify pass** — new tests + `npx vitest run app/components` + `pnpm --filter @doge-buddy/storefront typecheck`. Expected: PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/brand/ValueProps.tsx apps/storefront/app/components/brand/CategoryTiles.tsx apps/storefront/app/components/__tests__/home-sections.test.tsx apps/storefront/app/routes/_index.tsx apps/storefront/storefrontapi.generated.d.ts
git commit -m "feat(storefront): home — value props, category tiles, New arrivals; drop dead featured-collection query"
```

---

### Task 4: Remove the skeleton blog

**Files:**
- Delete: `apps/storefront/app/routes/blogs._index.tsx`, `apps/storefront/app/routes/blogs.$blogHandle._index.tsx`, `apps/storefront/app/routes/blogs.$blogHandle.$articleHandle.tsx`
- Modify: `apps/storefront/app/routes/[sitemap.xml].tsx`, `apps/storefront/app/routes/sitemap.$type.$page[.xml].tsx`
- Test: `apps/storefront/app/routes/__tests__/sitemap-types.test.ts` (new; if routes have no `__tests__` dir, create it — or follow wherever existing route-adjacent tests live)

**Interfaces:** none produced.

- [ ] **Step 1: Write the failing test** — the child-route guard is the testable unit:

```ts
import {describe, expect, it} from 'vitest';
import {assertSitemapTypeEnabled} from '../sitemap.$type.$page[.xml]';

describe('sitemap type guard', () => {
  it.each(['blogs', 'articles', 'metaObjects'])('404s %s', (type) => {
    expect(() => assertSitemapTypeEnabled(type)).toThrowError(expect.objectContaining({status: 404}));
  });
  it.each(['products', 'collections', 'pages'])('allows %s', (type) => {
    expect(() => assertSitemapTypeEnabled(type)).not.toThrow();
  });
});
```

(Throwing a `Response` — assert via try/catch on `instanceof Response` + `.status === 404` if `toThrowError(objectContaining)` doesn't match a thrown Response; write whichever assertion actually verifies status 404.)

- [ ] **Step 2: Run to verify fail** — `cd apps/storefront && npx vitest run app/routes/__tests__/sitemap-types.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`sitemap.$type.$page[.xml].tsx` — export the guard and call it first in the loader:

```ts
const ENABLED_SITEMAP_TYPES = ['products', 'collections', 'pages'] as const;

/** Blog removal (spec Decision 8): the index no longer advertises blogs/articles, and this guard
 *  keeps a directly-requested /sitemap/blogs/1.xml from serving URLs that 404. metaObjects are
 *  excluded too — the store defines none. */
export function assertSitemapTypeEnabled(type: string | undefined): void {
  if (!type || !(ENABLED_SITEMAP_TYPES as readonly string[]).includes(type)) {
    throw new Response('Not found', {status: 404});
  }
}
```

…and in the loader, before `getSitemap`: `assertSitemapTypeEnabled(params.type);`

`[sitemap.xml].tsx`: `getSitemapIndex({storefront, request, types: ['products', 'collections', 'pages']})` (the `types` option is confirmed in Hydrogen 2026.4.5's `SitemapIndexOptions`).

Delete the three blog route files. Then `pnpm --filter @doge-buddy/storefront typecheck` (typegen drops the stale route types; any lingering import of the deleted routes surfaces here — there should be none).

- [ ] **Step 4: Run to verify pass** — the new test + FULL storefront suite (`pnpm --filter @doge-buddy/storefront test`) + typecheck. Expected: PASS/clean; no other test referenced blogs.

- [ ] **Step 5: Commit**

```bash
git add -A apps/storefront/app/routes apps/storefront/app/routes/__tests__/sitemap-types.test.ts
git commit -m "feat(storefront): remove skeleton blog — routes deleted, sitemap restricted to products/collections/pages"
```

---

### Task 5: Footer About link

**Files:**
- Modify: `apps/storefront/app/components/Footer.tsx` (POLICY_LINKS array ~line 12)
- Test: `apps/storefront/app/components/__tests__/footer-links.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import {render, screen} from '@testing-library/react';
import {Footer} from '../Footer';
// router wrapper idiom as before; Footer ignores its props — pass minimal dummies:
// <Footer footer={Promise.resolve(null)} header={{} as never} publicStoreDomain="" />

describe('Footer', () => {
  it('links About to /pages/about alongside the policy links', () => {
    renderWithRouter(<Footer footer={Promise.resolve(null)} header={{} as never} publicStoreDomain="" />);
    expect(screen.getByRole('link', {name: 'About'})).toHaveAttribute('href', '/pages/about');
    expect(screen.getByRole('link', {name: 'Returns'})).toHaveAttribute('href', '/policies/returns');
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd apps/storefront && npx vitest run app/components/__tests__/footer-links.test.tsx` → FAIL (no About link).

- [ ] **Step 3: Implement** — in `Footer.tsx`, rename `POLICY_LINKS` → `FOOTER_LINKS` (update the loop + comment; the comment about dead links until routes arrive should now say: `/pages/about` 404s until the About page is created in Shopify admin — owner item in OWNER-CHECKLIST), and make the array:

```ts
const FOOTER_LINKS: Array<{to: string; title: string}> = [
  {to: '/pages/about', title: 'About'},
  {to: '/policies/shipping', title: 'Shipping'},
  {to: '/policies/returns', title: 'Returns'},
  {to: '/policies/privacy', title: 'Privacy'},
  {to: '/policies/terms', title: 'Terms'},
  {to: '/contact', title: 'Contact'},
];
```

- [ ] **Step 4: Run to verify pass** — the new test + `npx vitest run app/components` + typecheck. Expected: PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/app/components/Footer.tsx apps/storefront/app/components/__tests__/footer-links.test.tsx
git commit -m "feat(storefront): footer About link (/pages/about — page is an owner item)"
```

---

### Task 6: Full verification + docs

**Files:**
- Modify: `docs/LAUNCH-BACKLOG.md` (#8, #9, #10 → BUILT notes; #11's [C] half done; #14 → verified already-built pointer)
- Modify: `docs/OWNER-CHECKLIST.md` (new ⚪ owner item: create the About page; note in the footer pointer)

- [ ] **Step 1: Full storefront suite + typecheck** — `pnpm --filter @doge-buddy/storefront test` and `pnpm --filter @doge-buddy/storefront typecheck`; also `pnpm -r typecheck` (nothing else changed, belt only). Expected: green/clean.

- [ ] **Step 2: Docs** —
  - LAUNCH-BACKLOG: mark #8/#9/#10 "**BUILT 2026-09-03** (branch `storefront-p1-polish`, spec `2026-09-03-storefront-p1-polish-design.md`)" with one-line what-shipped each; #11: "[C] footer link BUILT 2026-09-03 — page itself remains Robert's"; #14: "**Verified already BUILT** in catalog-p0 (`seoTitle`/`seoDescription` at listing + backfill) — no work was needed (2026-09-03)."
  - OWNER-CHECKLIST: add `- [ ] ⚪ **Create the About page** (Shopify admin → Online Store → Pages → title "About", handle `about` — a few honest paragraphs; natural home for the LLC's legal name). The footer already links `/pages/about` and 404s until this exists.` Place near the other Phase-7 owner items.

- [ ] **Step 3: Commit**

```bash
git add docs/LAUNCH-BACKLOG.md docs/OWNER-CHECKLIST.md
git commit -m "docs: storefront P1 polish built — backlog #8/#9/#10/#11C/#14 statuses + About page owner item"
```

---

## Self-Review Notes

- **Spec coverage:** Decision 1–3 → Tasks 1–2; 4–7 → Task 3; 8 → Task 4; 9 → Task 5; 10 → per-task tests; spec-time verification of #14 → Task 6 docs. Error-handling table: deferred `.catch → null` (T2), frontpage-only → [] (T1 test), dead About link documented (T5/T6).
- **Type consistency:** `pickRelated`/`KNOWN_CATEGORY_HANDLES`/`RELATED_LIMIT` names match across T1/T2; `RelatedProductFragment` generated by T2's codegen before typecheck; `assertSitemapTypeEnabled` defined and tested in the same task.
- **Ordering:** Tasks independent except T2 after T1. T3–T5 touch disjoint files.
