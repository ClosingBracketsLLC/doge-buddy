#!/usr/bin/env bash
# Fails if the Drizzle schema has changes not captured in a committed migration.
set -euo pipefail
pnpm --filter @doge-buddy/db generate
if [ -n "$(git status --porcelain packages/db/migrations)" ]; then
  echo "ERROR: schema drift — 'drizzle-kit generate' produced uncommitted migration changes:" >&2
  git status --porcelain packages/db/migrations >&2
  git checkout -- packages/db/migrations 2>/dev/null || true
  git clean -fd packages/db/migrations >/dev/null 2>&1 || true
  exit 1
fi
echo "migrations in sync with schema"
