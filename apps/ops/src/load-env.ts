import { readFileSync } from 'node:fs'

/**
 * Minimal, dependency-free `.env` loader used by the dev server entrypoint and the manual ops
 * scripts (verify-live, replay-webhook, seed-store). Reads `apps/ops/.env`, resolved relative to
 * the *calling* module (pass `import.meta.url`) — `src/index.ts` and everything under
 * `scripts/` are both one directory below `apps/ops/`, so `../.env` resolves to the same file
 * either way. Parses simple `KEY=value` lines: blank lines and full-line `#` comments are
 * skipped, surrounding single/double quotes on the value are stripped, and — critically — a var
 * already set in `process.env` (real environment, CI, Railway's platform env, an inline
 * `FOO=bar pnpm ...` prefix) is never overridden by the file. Missing `.env` is not an error
 * (expected in production, where env vars come from the platform instead): callers that need a
 * var still get their normal "missing config" error from `loadConfig`.
 *
 * Returns true if a `.env` file was found and read (regardless of how many vars it set), so
 * callers can log that loading happened without leaking which vars.
 */
export function loadDotEnv(callerUrl: string): boolean {
  const envUrl = new URL('../.env', callerUrl)

  let contents: string
  try {
    contents = readFileSync(envUrl, 'utf8')
  } catch {
    return false
  }

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    if (key === '') continue

    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  return true
}
