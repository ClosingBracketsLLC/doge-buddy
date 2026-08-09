# Doge Buddy

AI-managed dog supply dropshipping store. Hydrogen storefront + an autonomous
ops service (sourcing, fulfillment, support, scoring agents).

Design docs: `docs/superpowers/specs/`. Current phase: 0 (foundations).

## Development

Requires Node >= 22, Docker.

```bash
corepack enable
pnpm install
pnpm db:up                                  # Postgres 17 on :5433
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate
pnpm test
pnpm --filter @doge-buddy/ops dev           # ops on :3001 (needs DATABASE_URL)
```

Layout: `apps/ops` (Fastify + pg-boss + agents) · `apps/storefront` (Hydrogen, Phase 2) ·
`packages/core|db|supplier|shopify-admin|gmail`.
