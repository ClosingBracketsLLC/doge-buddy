#!/usr/bin/env bash
# Fails if the Drizzle schema has changes not captured in a committed migration.
set -euo pipefail
pnpm --filter @doge-buddy/db generate
drift_status=$(git status --porcelain packages/db/migrations)
if [ -n "$drift_status" ]; then
  echo "ERROR: schema drift — 'drizzle-kit generate' produced uncommitted migration changes:" >&2
  echo "$drift_status" >&2
  cleanup_ok=1
  git checkout -- packages/db/migrations || cleanup_ok=0
  git clean -fd packages/db/migrations >/dev/null || cleanup_ok=0
  if [ "$cleanup_ok" -eq 0 ]; then
    echo "WARNING: cleanup failed — migrations dir may be dirty" >&2
  fi
  exit 1
fi
echo "migrations in sync with schema"
