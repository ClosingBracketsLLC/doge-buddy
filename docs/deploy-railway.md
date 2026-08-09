# Deploying `apps/ops` to Railway

Requires: Robert's Railway account. One project, two services (ops + Postgres).

1. Create a Railway project `doge-buddy`.
2. Add a **PostgreSQL** database service. Copy its `DATABASE_URL` (private network URL preferred).
3. Add a service from this GitHub repo:
   - Root directory: `/` (monorepo — build from root so workspace deps resolve)
   - Build command: `corepack enable && pnpm install --frozen-lockfile`
   - Pre-deploy command: `pnpm --filter @doge-buddy/db migrate`
   - Start command: `pnpm --filter @doge-buddy/ops start`
   - Watch paths: `apps/ops/**`, `packages/**`
4. Service variables: `DATABASE_URL` (reference the Postgres service), `PORT=3001`.
   Set a healthcheck path of `/healthz` in service settings.
5. Deploy. Verify:
   - `curl https://<service-url>/healthz` → `{"status":"ok","db":"ok","queue":"ok",...}`
   - Send a demo job from a Railway shell:
     `pnpm --filter @doge-buddy/ops exec tsx -e "import PgBoss from 'pg-boss'; const b=new PgBoss(process.env.DATABASE_URL); await b.start(); await b.send('demo.ping',{note:'deploy-check'}); await b.stop();"`
   - Confirm the row: `SELECT * FROM audit_log WHERE action='demo.ping' ORDER BY created_at DESC LIMIT 1;`
6. Phase-0 exit criterion (design doc): the demo job executes on the deployed instance.
