# Doge Buddy

AI-managed dog supply dropshipping store. Hydrogen storefront + an autonomous
ops service (sourcing, fulfillment, support, scoring agents).

Design docs: `docs/superpowers/specs/`. Current phase: 3 (fulfillment) — built and live-verified
against the CJ sandbox (see `docs/cj-api-notes.md`). Remaining before Phase 4: the Railway deploy
(Phase 0 exit criterion, `docs/deploy-railway.md`) and Hydrogen/Oxygen storefront hosting
(Phase 2 Tier-2). Owner tasks live in `docs/OWNER-CHECKLIST.md`.

## Development

Requires Node >= 22, Docker.

```bash
corepack enable
pnpm install
pnpm db:up                                  # Postgres 17 on :5433
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate
pnpm test
pnpm --filter @doge-buddy/ops dev           # ops on :3001 — its predev hook auto-starts the
                                            # compose Postgres, loads apps/ops/.env, and migrates,
                                            # so it works standalone. (db:up + migrate above are
                                            # still needed before a bare `pnpm test`.)
pnpm --filter @doge-buddy/storefront dev    # storefront on :3000 (mock.shop, no credentials)
```

Layout: `apps/ops` (Fastify + pg-boss + agents) · `apps/storefront` (Hydrogen, built in Phase 2) ·
`packages/core|db|supplier|shopify-admin`.

Note: the storefront's `build`/`dev`/`codegen` scripts pass `--path "$(pwd)"` explicitly. Under
pnpm, `pnpm --filter @doge-buddy/storefront <script>` resolves the Shopify CLI's `INIT_CWD` to
the repo root rather than `apps/storefront`, which breaks the Hydrogen CLI's project-root
detection; the explicit `--path` works around it.

## Manual live-integration scripts

Three manual, credential-gated scripts in `apps/ops` back up the live Shopify/CJ integrations —
none is part of `pnpm test` (no mocked network); all are run by hand. Each reads
`apps/ops/.env` (real environment variables take precedence).

**`verify-live`** — smoke-tests the real Shopify Admin API and CJ Dropshipping API using
whatever credentials are in the environment. Each section (Shopify, CJ) is independent and
prints `SKIPPED (missing ...)` when its vars aren't set; exits 1 only if a section that *was*
attempted failed. Shopify creates a throwaway `DB-VERIFY <timestamp>` DRAFT product and deletes
it again, so it's safe to run against a real store.

```bash
pnpm --filter @doge-buddy/ops verify-live   # credentials come from apps/ops/.env
```

**`replay-webhook`** — one-command proof of the webhook dedup path: signs a sample `orders/paid`
payload and POSTs it twice with the same `x-shopify-webhook-id` to a locally running ops
instance, expecting `duplicate: false` then `duplicate: true`. Needs a second terminal running
ops with a matching `SHOPIFY_WEBHOOK_SECRET`:

```bash
# terminal A (config's Shopify vars are all-or-none, so all four must be set even though
# only SHOPIFY_WEBHOOK_SECRET matters for this proof — the other three can be dummy values)
SHOPIFY_SHOP_DOMAIN=dummy.myshopify.com SHOPIFY_CLIENT_ID=dummy SHOPIFY_CLIENT_SECRET=dummy SHOPIFY_WEBHOOK_SECRET=testsecret DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/ops dev

# terminal B
SHOPIFY_WEBHOOK_SECRET=testsecret pnpm --filter @doge-buddy/ops replay-webhook
```

**`seed-store`** — idempotently seeds the test Shopify store with the dogebuddy metafield
definitions, sample collections, and sample products; safe to rerun (only creates what's
missing). Uses the same `SHOPIFY_*` credentials as `verify-live`.
