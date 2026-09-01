import {
  collectionCreate,
  listCollections,
  listPublications,
  publishablePublish,
  ShopifyAdminClient,
  ShopifyTokenManager,
} from '@doge-buddy/shopify-admin'
import { seedCollections, type SeedCollectionsOps } from '../src/seed/collections.ts'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Idempotently creates the four category collections (`@doge-buddy/core`'s `CATEGORIES`) against
 * Robert's test Shopify store and publishes every one of them to every publication the store has.
 * Manual, credential-gated — same style as `seed-store.ts`/`verify-live.ts`, not part of the
 * automated test suite. Safe to rerun: existing collections are skipped for creation, but ALL
 * four are always republished (idempotent healing — see `seedCollections`'s docstring).
 */

if (loadDotEnv(import.meta.url)) {
  console.log('seed-collections: loaded apps/ops/.env (existing environment variables take precedence)')
}

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN
const clientId = process.env.SHOPIFY_CLIENT_ID
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

if (!shopDomain || !clientId || !clientSecret) {
  console.error(
    'seed-collections: missing required env vars (SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).',
  )
  console.error('See docs/OWNER-CHECKLIST.md for how to obtain Shopify Admin API credentials.')
  process.exit(1)
}

try {
  const tokenManager = new ShopifyTokenManager({ shopDomain, clientId, clientSecret })
  const client = new ShopifyAdminClient({ shopDomain, tokenManager })

  const ops: SeedCollectionsOps = {
    listCollections: () => listCollections(client),
    collectionCreate: (input) => collectionCreate(client, input),
    listPublications: () => listPublications(client),
    publishablePublish: (collectionId, publicationId) => publishablePublish(client, collectionId, publicationId),
  }

  const result = await seedCollections(ops, console.log)

  console.log(
    `seed-collections: created=${result.created.length} skipped=${result.skipped.length} published=${result.published}`,
  )

  if (result.failures.length > 0) {
    console.error(`seed-collections: ${result.failures.length} failure(s) — rerun to retry (idempotent):`)
    for (const failure of result.failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error('seed-collections: FAILED —', message)
  process.exit(1)
}
