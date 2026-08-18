import {test, expect, type Page} from '@playwright/test';

// Local-only smoke suite against mock.shop (see playwright.config.ts).
//
// Selector notes:
// - Product-card links are the most stable selector across the skeleton's
//   markup (`a[href^="/products/"]`) — role-based locators for anonymous
//   "card" links proved ambiguous against nav/header links, so we prefer
//   href-based locators wherever a role-based one isn't already unambiguous
//   (e.g. the "Add to cart" button, which has real accessible text).
// - `PageLayout` always mounts a (normally off-canvas) empty-cart aside
//   *before* `<main>`, and that aside's empty state links to
//   `/collections/toys-play` ("Start shopping"). That collides with any
//   unscoped `a[href^="/collections/"]` / `a[href^="/products/"]` locator,
//   so href-based locators below are scoped to `getByRole('main')` — the
//   route content — to avoid resolving to that hidden element.
// - `TrustStrip` is rendered both on the homepage and in the sitewide
//   footer, so its text locator is likewise scoped to `main`.

function main(page: Page) {
  return page.getByRole('main');
}

/** Clicks "Add to cart" and waits for the cart mutation to round-trip
 * before returning, so a follow-up `page.goto('/cart')` doesn't cancel an
 * in-flight fetcher request (a real browser navigation aborts pending
 * fetches) and land on a stale/empty cart. */
async function addFirstProductToCart(page: Page) {
  await page.goto('/');
  await main(page).locator('a[href^="/products/"]').first().click();
  await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/cart'),
    ),
    page.getByRole('button', {name: /add to cart/i}).click(),
  ]);
}

test('home renders hero and products', async ({page}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', {level: 1, name: /great gear for your best friend/i}),
  ).toBeVisible();
  // Trust strip lives in the footer only (deduped in the redesign).
  await expect(
    page
      .getByRole('contentinfo')
      .getByText('Ships from US warehouses · 3–7 day delivery'),
  ).toBeVisible();
  await expect(main(page).locator('a[href^="/products/"]').first()).toBeVisible();
});

test('collection page lists products', async ({page}) => {
  await page.goto('/collections');
  await main(page).locator('a[href^="/collections/"]').first().click();
  await expect(page).toHaveURL(/\/collections\/[^/]+$/);
  await expect(main(page).locator('a[href^="/products/"]').first()).toBeVisible();
});

test('add to cart updates the cart', async ({page}) => {
  await addFirstProductToCart(page);
  await expect(page.getByRole('link', {name: /cart/i})).toContainText('1');
});

test('cart page shows checkout link', async ({page}) => {
  await addFirstProductToCart(page);
  await page.goto('/cart');
  await expect(page.getByRole('link', {name: /checkout/i})).toHaveAttribute(
    'href',
    /^https?:\/\//,
  );
});
