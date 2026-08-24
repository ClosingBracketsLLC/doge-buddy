# Deploying `apps/ops` to Railway

Requires: Robert's Railway account. One project, two services (ops + Postgres).

1. Create a Railway project `doge-buddy`.
2. Add a **PostgreSQL** database service. Copy its `DATABASE_URL` (private network URL preferred).
3. Add a service from this GitHub repo:
   - Root directory: `/` (monorepo — build from root so workspace deps resolve)
   - Build command: `corepack enable && pnpm install --frozen-lockfile --prod=false` (Railway builders set `NODE_ENV=production`, which makes pnpm skip devDependencies by default; `--prod=false` keeps devDependencies like `tsx`, which run the migrate/start commands, installed under that `NODE_ENV=production`)
   - Pre-deploy command: `pnpm --filter @doge-buddy/db migrate`
   - Start command: `pnpm --filter @doge-buddy/ops start`
   - Watch paths: `apps/ops/**`, `packages/**`
4. Service variables. Set a healthcheck path of `/healthz` in service settings.

   Required to boot:
   - `DATABASE_URL` — reference the Postgres service
   - `PORT=3001`

   Required for webhooks to verify (copy the values from your local `apps/ops/.env` — the same
   credentials work; `SHOPIFY_SHOP_DOMAIN` must be the `*.myshopify.com` domain, never the custom
   domain, which 301-redirects the token exchange and breaks it):
   - `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`
     (the webhook secret is the same string as the client secret) — `loadConfig` requires all four
     together or none, so a partial set fails startup.
   - `CJ_API_KEY`, `CJ_OPEN_ID` — also required together. `CJ_OPEN_ID` is the HMAC key CJ signs
     its webhooks with, so CJ webhook verification silently rejects everything without it.

   Also set:
   - `ADMIN_BASE_URL=https://<service-url>` — the Shopify webhook-audit cron **disables itself**
     without this (it logs `shopify webhook-audit cron disabled: ADMIN_BASE_URL not set`).
   - `FULFILLMENT_SUPPLIER` — leave unset/`mock` until you deliberately want the deployed instance
     placing real CJ orders. `cj` requires the CJ vars above and spends real wallet money; the app
     logs a loud warning at boot either way, stating which adapter is live.
5. Deploy. Verify:
   - `curl https://<service-url>/healthz` → `{"status":"ok","db":"ok","queue":"ok",...}`
   - Send a demo job from a Railway shell:
     `pnpm --filter @doge-buddy/ops exec tsx -e "import PgBoss from 'pg-boss'; const b=new PgBoss(process.env.DATABASE_URL); await b.start(); await b.send('demo.ping',{note:'deploy-check'}); await b.stop();"`
   - Confirm the row: `SELECT * FROM audit_log WHERE action='demo.ping' ORDER BY created_at DESC LIMIT 1;`
6. Phase-0 exit criterion (design doc): the demo job executes on the deployed instance.
7. Once the public URL exists, point the webhooks at it — this is what the deploy unblocks:
   - Shopify: `https://<service-url>/webhooks/shopify`
   - CJ: `https://<service-url>/webhooks/cj` (CJ callback settings are per-type: product, stock,
     order, logistic — `GET /setting/get` shows the current registrations)

   CJ's webhook signature scheme is still **unverified** — `verifyWebhook` assumes
   `base64(hmacSHA256(openId, rawBody))` under one of `cj-signature` / `x-cj-signature` /
   `signature`, none of which has been confirmed against a real delivery (see
   `docs/cj-api-notes.md`). The first real CJ webhook is what settles it; if verification rejects
   it, log the raw headers and compare before changing the scheme.
