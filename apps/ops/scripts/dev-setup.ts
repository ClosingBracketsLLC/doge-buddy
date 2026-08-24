import { runMigrations } from '@doge-buddy/db'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Runs before `dev`/`start` locally: brings up the local Postgres container (docker compose,
 * via the workspace root's `db:up`) and applies migrations, so `pnpm --filter @doge-buddy/ops
 * dev` works standalone instead of throwing on a missing DATABASE_URL / unmigrated schema.
 * Skipped in production (Railway sets DATABASE_URL directly and runs its own migration step) by
 * short-circuiting the docker compose call when the platform's env already provides the URL
 * before `.env` would.
 */

if (loadDotEnv(import.meta.url)) {
  console.log('dev-setup: loaded apps/ops/.env')
}

const url = process.env.DATABASE_URL
if (!url) {
  console.log('dev-setup: DATABASE_URL not set, skipping db:up/migrate')
  process.exit(0)
}

if (url.includes('localhost') || url.includes('127.0.0.1')) {
  const { execFileSync } = await import('node:child_process')
  execFileSync('pnpm', ['-w', 'run', 'db:up'], { stdio: 'inherit' })
}

await runMigrations(url)
console.log('dev-setup: migrations applied')
