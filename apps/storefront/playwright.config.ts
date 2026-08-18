import {defineConfig, devices} from '@playwright/test';

/**
 * Local-only Playwright smoke suite against mock.shop.
 *
 * This suite is NOT wired into CI: it depends on live network access to
 * mock.shop (the demo Shopify store used when no PUBLIC_STORE_DOMAIN is
 * configured — see apps/storefront/.env.example), which CI runners don't
 * have. Run it locally with `pnpm --filter @doge-buddy/storefront smoke`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']},
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
