import { createDb } from '@doge-buddy/db'
import { CJSupplierAdapter, CjHttpClient, MockSupplierAdapter, type SupplierAdapter } from '@doge-buddy/supplier'
import PgBoss from 'pg-boss'
import { createAlerter } from '../src/alerts.ts'
import { loadConfig } from '../src/config.ts'
import type { SendOpts } from '../src/fulfillment/types.ts'
import { loadDotEnv } from '../src/load-env.ts'
import type { NotifyOwner } from '../src/notify/notify.ts'
import { createTelegramNotifier } from '../src/notify/telegram.ts'
import { createSettings } from '../src/settings.ts'
import { createSerpApiAmazonDemand } from '../src/sourcing/demand-probe.ts'
import { describeSourcingKnobs, parseRunSourcingArgs, resolveSourcingKnobs } from '../src/sourcing/knobs.ts'
import { createSerpApiMarketPrice } from '../src/sourcing/market-price.ts'
import { runSourcingPipeline, type SourcingPipelineDeps, type SourcingProviders } from '../src/sourcing/pipeline.ts'
import { createSerpApiClient } from '../src/sourcing/serpapi.ts'
import { createSerpApiTrends } from '../src/sourcing/trends.ts'
import { DrizzleCjTokenStore } from '../src/stores/cj-token-store.ts'

/**
 * Manual, credential-gated Tier-2 trigger for the `sourcing.weekly` pipeline (spec "Manual
 * trigger" / Task 14) — how a real run gets driven against real keys and a real DB outside the
 * Monday cron, and how `--force` bypasses the same-day circuit breaker for a repeat same-day
 * run. Not part of the automated test suite (no mocked network), same spirit as `seed-proposal.ts`
 * and `verify-live.ts`: bootstrap mirrors `seed-proposal.ts`'s exactly (load `.env`, build
 * db/settings/alert/notify, real Telegram when configured else a console fallback).
 *
 * Catalog-build knobs (spec 2026-08-31 catalog-p0 §5): the flags below override the `sourcing.*`
 * settings for THIS run only — the Monday cron passes none and keeps the settings' defaults. Arg
 * parsing itself is the pure `parseRunSourcingArgs`, unit-tested in `test/sourcing-knobs.test.ts`
 * (it lives in `src/sourcing/knobs.ts` because importing this script would execute it).
 *
 * `pnpm --filter @doge-buddy/ops run-sourcing [--force] [--keywords "a,b,c"] [--max-winners N]
 *   [--budget USD] [--candidates N] [--pages N]`
 */
export { parseRunSourcingArgs } from '../src/sourcing/knobs.ts'

if (loadDotEnv(import.meta.url)) {
  console.log('run-sourcing: loaded apps/ops/.env (existing environment variables take precedence)')
}

const config = loadConfig(process.env)

let force: boolean
let overrides: ReturnType<typeof parseRunSourcingArgs>['overrides']
try {
  ;({ force, overrides } = parseRunSourcingArgs(process.argv.slice(2)))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const MAX_ERROR_MESSAGE_LENGTH = 500

// Mirrors seed-proposal.ts's / verify-live.ts's formatError: some underlying errors embed a raw
// response body, which can be an entire HTML error page — truncate so a misconfigured domain
// doesn't flood the terminal.
function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… (truncated)`
    : message
}

if (!config.anthropic) {
  // No API key: the Agent SDK subprocess falls back to the machine's `claude` sign-in — the
  // owner's Claude subscription. That is the intended path for manual runs from Robert's own
  // machine (2026-09-03 blitz: ~20 runs on subscription instead of per-token API billing); on a
  // host with no sign-in (Railway) the first agent call fails loudly instead of silently free.
  // The empty-string override (`ANTHROPIC_API_KEY= pnpm …`) must not reach the subprocess env,
  // where the CLI could read it as a (bad) credential rather than an absence.
  delete process.env.ANTHROPIC_API_KEY
  console.warn(
    'run-sourcing: ANTHROPIC_API_KEY not set — using the local Claude Code sign-in (subscription auth). ' +
      'Note: the SDK cost estimate reads ~$0 on subscription, so --budget is inert; the 30-turn cap is the effective stop-loss.',
  )
}

const { db, pool } = createDb(config.databaseUrl)

// Console-backed logger for createAlerter — scripts don't pull in pino (seed-proposal.ts's own
// convention).
const log = {
  info: (o: unknown, m: string) => console.log(m, o),
  warn: (o: unknown, m: string) => console.warn(m, o),
  error: (o: unknown, m: string) => console.error(m, o),
}
const alert = createAlerter(db, log)
const settings = createSettings(db)

const notify: NotifyOwner = config.telegram
  ? createTelegramNotifier({ ...config.telegram, alert })
  : async (n) => {
      console.log(`[console-notify] ${n.title}`)
      console.log(n.body)
      for (const action of n.actions ?? []) {
        console.log(`  ${action.label}: ${action.url}`)
      }
      return true
    }

// Same adapter-selection logic as index.ts's boot wiring: FULFILLMENT_SUPPLIER=cj requires
// config.cj (loadConfig's zod schema already guarantees this pairing), else the in-memory mock.
let baseAdapter: SupplierAdapter
if (config.fulfillmentSupplier === 'cj') {
  if (!config.cj) {
    console.error('run-sourcing: FAILED — FULFILLMENT_SUPPLIER=cj but CJ_API_KEY/CJ_OPEN_ID are not set')
    process.exit(1)
  }
  baseAdapter = new CJSupplierAdapter({
    client: new CjHttpClient({ apiKey: config.cj.apiKey, tokenStore: new DrizzleCjTokenStore(db) }),
    openId: config.cj.openId,
  })
} else {
  baseAdapter = new MockSupplierAdapter()
}

// --- Telemetry-only counting wrappers -----------------------------------------------------
// `runSourcingPipeline` owns its own PointsAllowance/TrendsProvider internally (Task 14's
// interfaces don't surface them on the return value) — this script constructs `adapter`/`trends`
// itself, so it wraps them here purely to print a tally afterward for the human running this by
// hand. Point costs mirror `agents/mcp-tools.ts`'s `TOOL_POINT_COSTS` (10/call, all four
// read-only CJ methods) and `harvest.ts`'s own `allowance.spend(pagesFetched * 50, 'harvest')`
// (50/page, counted only on a successful `searchProducts` resolution — same as `pagesFetched`).
let cjPointsSpentEstimate = 0
let searchProductsPages = 0
// `Object.create` with the real instance's own prototype + property descriptors (rather than a
// plain `{...baseAdapter, ...}` object literal) so every OTHER method — placeOrder, getBalance,
// etc., never called by this pipeline but still part of the interface — keeps resolving through
// `baseAdapter`'s real prototype chain; a class instance's methods live on its prototype, not as
// its own enumerable properties, so a plain spread would silently drop them. Only the five
// read-only methods the sourcing pipeline actually calls are then shadowed with counting wrappers.
const adapter: SupplierAdapter = Object.create(
  Object.getPrototypeOf(baseAdapter),
  Object.getOwnPropertyDescriptors(baseAdapter),
) as SupplierAdapter
adapter.searchProducts = async (q) => {
  const result = await baseAdapter.searchProducts(q)
  searchProductsPages += 1
  cjPointsSpentEstimate += 50
  return result
}
adapter.getProduct = async (pid) => {
  cjPointsSpentEstimate += 10
  return baseAdapter.getProduct(pid)
}
adapter.getProductReviews = async (pid, q) => {
  cjPointsSpentEstimate += 10
  return baseAdapter.getProductReviews(pid, q)
}
adapter.getVariantStock = async (vid) => {
  cjPointsSpentEstimate += 10
  return baseAdapter.getVariantStock(vid)
}
adapter.quoteShipping = async (q) => {
  cjPointsSpentEstimate += 10
  return baseAdapter.quoteShipping(q)
}

let serpApiRequests = 0
// Factory (FIX C2): fresh client per run so the shared request cap (defaults to 25, env-tunable
// via SERPAPI_MAX_REQUESTS_PER_RUN) resets. This script drives exactly one run; the counting
// fetchFn tallies ALL THREE providers' (trends, market-price, amazon demand) requests for the
// telemetry line.
const providersFactory = (): SourcingProviders => {
  if (!config.serpapi) return { trends: null, marketPrice: null, demand: null }
  const client = createSerpApiClient({
    apiKey: config.serpapi.apiKey,
    maxRequests: config.serpapi.maxRequestsPerRun,
    fetchFn: (...args: Parameters<typeof fetch>) => {
      serpApiRequests += 1
      return fetch(...args)
    },
  })
  return {
    trends: createSerpApiTrends({ client }),
    marketPrice: createSerpApiMarketPrice({ client }),
    demand: createSerpApiAmazonDemand({ client }),
  }
}

let failed = false

// Short-lived PgBoss for `enqueue` (submitProposal's auto-mode path only — the default
// `workflow.sourcing.mode` is manual, but the dep is required either way), mirroring
// seed-proposal.ts's own `send` + `stop` idiom (docs/deploy-railway.md).
const boss = new PgBoss(config.databaseUrl)
boss.on('error', (e) => console.error('[pg-boss]', e))
await boss.start()

try {
  const enqueue = async (name: string, data: object, opts?: SendOpts): Promise<void> => {
    if (opts) {
      await boss.send(name, data, opts)
    } else {
      await boss.send(name, data)
    }
  }

  const deps: SourcingPipelineDeps = {
    db, adapter, settings, alert, enqueue, notify, adminBaseUrl: config.adminBaseUrl, providersFactory, force, overrides,
  }

  // Resolved here purely to PRINT what this run will do before it costs anything; the pipeline
  // resolves the same knobs itself (one settings read each — no shared state to get out of sync).
  console.log(`run-sourcing: knobs — ${describeSourcingKnobs(await resolveSourcingKnobs(settings, overrides))}`)
  console.log(`run-sourcing: starting${force ? ' (--force)' : ''}...`)
  const result = await runSourcingPipeline(deps)

  console.log('run-sourcing: result —', JSON.stringify(result))
  console.log(
    `run-sourcing: CJ points spent (estimate) ~${cjPointsSpentEstimate} (${searchProductsPages} harvest page(s) + tool/verify calls)`,
  )
  console.log(
    `run-sourcing: SerpApi requests made ${serpApiRequests} (trends + market + amazon lookups)${config.serpapi ? '' : ' (SERPAPI_KEY not set — trends, market-price and demand stages skipped)'}`,
  )

  if (result.outcome === 'agent_failed') {
    failed = true
  }
} catch (err) {
  failed = true
  console.error('run-sourcing: FAILED —', formatError(err))
} finally {
  await boss.stop()
  await pool.end()
}

process.exit(failed ? 1 : 0)
