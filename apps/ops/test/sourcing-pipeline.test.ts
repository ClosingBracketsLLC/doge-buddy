import { agentRunEvents, agentRuns, auditLog, createDb, proposals, settings as settingsTable, sourcingSignals } from '@doge-buddy/db'
import type {
  ShippingOption,
  SupplierAdapter,
  SupplierOrderStatus,
  SupplierProductDetail,
  SupplierProductReview,
  SupplierProductSummary,
  SupplierWebhookEvent,
  WarehouseStock,
} from '@doge-buddy/supplier'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SOURCING_MAX_BUDGET_USD, SOURCING_MODEL, type SourcingRunDeps } from '../src/agents/sourcing-run.ts'
import { sourcingWeeklyHandler } from '../src/jobs/sourcing-weekly.ts'
import { createSettings } from '../src/settings.ts'
import { HARVEST_KEYWORDS } from '../src/sourcing/harvest.ts'
import { MarketLookups, type MarketOffer } from '../src/sourcing/market-price.ts'
import { persistMarketLookups, runSourcingPipeline, type SourcingPipelineDeps, type SourcingProviders } from '../src/sourcing/pipeline.ts'
import { ReviewsSeen } from '../src/sourcing/decision-context.ts'
import type { DemandProbeProvider } from '../src/sourcing/demand-probe.ts'
import { validateAndSubmitWinners } from '../src/sourcing/submit-winners.ts'
import type { RisingQuery, TrendsProvider } from '../src/sourcing/trends.ts'
import type { NotifyOwner } from '../src/notify/notify.ts'

// Task 9 test (4): wraps the REAL implementation so every other test's behavior is unchanged,
// but lets that test inspect the deps `runSourcingPipeline` actually passed to Stage 6.
vi.mock('../src/sourcing/submit-winners.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sourcing/submit-winners.ts')>()
  return { ...actual, validateAndSubmitWinners: vi.fn(actual.validateAndSubmitWinners) }
})

type Db = ReturnType<typeof createDb>['db']

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `pipe-${Date.now()}-${uidCounter}`
}

interface ProductSpec {
  pid: string
  title: string
  categoryName: string
  sellPriceCents: number
  listedNum: number
  liveCostCents: number
}

/** Full SupplierAdapter fake: `searchProducts` (first harvest keyword's page 1 only, everything
 * else ends the pass immediately), `getProduct`/`getVariantStock`/`quoteShipping`/
 * `getProductReviews` wired to `specs`; every other method throws (never called by the pipeline). */
function makeAdapter(specs: ProductSpec[]): SupplierAdapter {
  const byPid = new Map(specs.map((s) => [s.pid, s]))
  const notImplemented = (): never => {
    throw new Error('not implemented in sourcing-pipeline test adapter')
  }
  return {
    key: 'mock',
    async searchProducts(q): Promise<SupplierProductSummary[]> {
      if (q.keyword === HARVEST_KEYWORDS[0] && q.page === 1) {
        return specs.map((s) => ({
          supplierProductId: s.pid,
          title: s.title,
          categoryName: s.categoryName,
          sellPriceCents: s.sellPriceCents,
          listedCount: s.listedNum,
        }))
      }
      return []
    },
    async getProduct(pid): Promise<SupplierProductDetail> {
      const s = byPid.get(pid)
      if (!s) throw new Error(`sourcing-pipeline test adapter: unknown product ${pid}`)
      return {
        supplierProductId: pid,
        title: s.title,
        imageUrls: [],
        variants: [{ supplierVariantId: `${pid}-v1`, priceCents: s.liveCostCents }],
      }
    },
    async getProductReviews(): Promise<SupplierProductReview[]> {
      return []
    },
    async getVariantStock(): Promise<WarehouseStock[]> {
      return [{ countryCode: 'US', quantity: 25, verified: true }]
    },
    async quoteShipping(): Promise<ShippingOption[]> {
      return [{ name: 'Standard', priceCents: 500, minDays: 3, maxDays: 7 }]
    },
    placeOrder: notImplemented,
    confirmOrder: notImplemented,
    payOrder: notImplemented,
    async getOrderStatus(): Promise<SupplierOrderStatus> {
      return notImplemented()
    },
    async getTracking() {
      return notImplemented()
    },
    getBalance: notImplemented,
    getDisputeOptions: notImplemented,
    openDispute: notImplemented,
    getDispute: notImplemented,
    verifyWebhook: () => true,
    parseWebhook(): SupplierWebhookEvent {
      return notImplemented()
    },
    async subscribeProductWebhook() {},
    async unsubscribeProductWebhook() {},
  }
}

function stubTrends(): TrendsProvider {
  return {
    key: 'stub',
    fetchInterest: vi.fn(async (keywords: string[]) => keywords.map((keyword) => ({ keyword, score: 80, snapshot: { keyword } }))),
    fetchRisingQueries: vi.fn(async () => []),
  }
}

function rq(query: string, extractedValue: number): RisingQuery {
  return { query, value: `+${extractedValue}%`, extractedValue }
}

/** Trends stub whose `fetchRisingQueries` returns `rising` for the FIRST keyword it's asked about
 *  (Stage 1b calls it once per base keyword, in order) and `[]` for every other keyword. */
function stubTrendsWithRising(rising: RisingQuery[]): TrendsProvider {
  let first = true
  return {
    key: 'stub',
    fetchInterest: vi.fn(async (keywords: string[]) => keywords.map((keyword) => ({ keyword, score: 80, snapshot: { keyword } }))),
    fetchRisingQueries: vi.fn(async () => {
      if (first) {
        first = false
        return rising
      }
      return []
    }),
  }
}

/** Wraps a real `Db` so an insert into `sourcingSignals` whose rows carry `source: 'trends_rising'`
 *  throws — every other insert (harvest's `cj_trending`, the day-claim, proposals, ...) passes
 *  straight through to the real db. Used to prove Stage 1b's persist failure is caught and never
 *  costs the run its expanded keywords. */
function withFailingTrendsRisingInsert(realDb: Db): Db {
  return new Proxy(realDb as object, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === sourcingSignals) {
            return {
              values: async (rows: unknown) => {
                if (Array.isArray(rows) && rows.some((r) => (r as { source?: string }).source === 'trends_rising')) {
                  throw new Error('sourcing-pipeline test: poisoned trends_rising insert')
                }
                return (realDb.insert(table as typeof sourcingSignals) as unknown as { values: (v: unknown) => Promise<unknown> }).values(rows)
              },
            }
          }
          return (realDb.insert as (t: unknown) => unknown)(table)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Db
}

/** Winner payload that clears every Stage 4 gate against the matching ProductSpec: live cost
 * `liveCostCents`, freight 500c (from the adapter above), price 5000c -> margin
 * floor((5000 - liveCostCents - 500) * 10000 / 5000) which must clear the 6000bps default floor. */
function winnerFor(spec: ProductSpec, priceCents = 5000) {
  return {
    payload: {
      type: 'new_listing' as const,
      title: `Cozy ${spec.title}`,
      descriptionHtml: '<p>A well-loved pick for happy pups.</p>',
      categoryTag: 'toys' as const,
      imageUrls: ['https://cf.cjdropshipping.com/x.png'],
      shipsFrom: 'US' as const,
      deliveryMinDays: 3,
      deliveryMaxDays: 7,
      variants: [
        {
          sku: `SKU-${spec.pid}`,
          priceCents,
          supplierCostCents: spec.liveCostCents, // claimed == live: well within COST_TOLERANCE_BPS
          supplier: 'cj' as const,
          supplierProductId: spec.pid,
          supplierVariantId: `${spec.pid}-v1`,
        },
      ],
      highlights: ['Durable rope core', 'Machine washable', 'Non-slip grip'],
      specs: [{ label: 'Material', value: 'Cotton' }],
    },
    rationale: 'Strong search interest and a healthy freight-inclusive margin.',
    marginPct: 55,
    freightEstimateCents: 500,
  }
}

function fakeQueryFn(winners: ReturnType<typeof winnerFor>[]): SourcingRunDeps['queryFn'] {
  return () => {
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      yield { type: 'assistant', message: { model: SOURCING_MODEL, usage: { input_tokens: 500, output_tokens: 200 } } }
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.42,
        modelUsage: { [SOURCING_MODEL]: { costUSD: 0.42 } },
        num_turns: 2,
        session_id: 's1',
        structured_output: { winners },
      }
    }
    return stream()
  }
}

function failingQueryFn(): SourcingRunDeps['queryFn'] {
  return () => {
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: SOURCING_MODEL, usage: { input_tokens: 100, output_tokens: 50 } } }
      throw new Error('sourcing-pipeline test: fake SDK stream blew up')
    }
    return stream()
  }
}

const noopNotify: NotifyOwner = vi.fn(async () => true)
const noopEnqueue: SourcingPipelineDeps['enqueue'] = vi.fn(async () => {})

describe('runSourcingPipeline', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  // `sourcing.weekly` is a fixed, hardcoded workflow name in pipeline.ts (per spec, not a test
  // param) — a leftover 'running'/'succeeded' row from a previous (non-reset) run of THIS file
  // would wedge test (b)'s "first call claims cleanly" assumption. Purge before anything runs.
  // Scoped by `workflow = 'sourcing.weekly'` rather than by this file's own row ids (which don't
  // exist yet at this point) — safe because that literal workflow name is written ONLY by
  // `runSourcingPipeline` (and, in production, the real `sourcing.weekly` cron), so no other test
  // file's rows can ever match this filter; it is this file's own namespace, not a shared column
  // value another suite could collide on.
  beforeAll(async () => {
    const stale = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.workflow, 'sourcing.weekly'))
    const staleIds = stale.map((r) => r.id)
    if (staleIds.length > 0) {
      await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, staleIds))
      await db.delete(proposals).where(inArray(proposals.agentRunId, staleIds))
      await db.delete(auditLog).where(and(eq(auditLog.entityType, 'agent_run'), inArray(auditLog.entityId, staleIds)))
      await db.delete(agentRuns).where(inArray(agentRuns.id, staleIds))
    }
    // Deterministic settings regardless of what other test files in this shared DB left behind.
    const s = createSettings(db)
    await s.set('workflow.sourcing.mode', 'manual')
    await s.set('fulfillment.margin_floor_bps', 6000)
  })

  const createdRunIds: string[] = []
  // Every test's ProductSpec pids (harvest writes a `cj_trending` sourcing_signals row per fetched
  // summary) and titles (the trends stub writes a `google_trends` row per keyword, keyed by
  // title — `candidateSpecs()` below pushes both as it builds each test's fixtures).
  const createdPids: string[] = []
  const createdKeywords: string[] = []
  // Stage 1b's `trends_rising` rows are keyed by the EXPANDED keyword (e.g. 'dog water bottle'),
  // never a harvest keyword or a candidate pid, so they need their own tracking list.
  const createdRisingKeywords: string[] = []
  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, createdRunIds))
      await db.delete(proposals).where(inArray(proposals.agentRunId, createdRunIds))
      await db.delete(auditLog).where(and(eq(auditLog.entityType, 'agent_run'), inArray(auditLog.entityId, createdRunIds)))
      await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds))
      createdRunIds.length = 0
    }
    if (createdPids.length > 0) {
      await db.delete(sourcingSignals).where(inArray(sourcingSignals.supplierProductId, createdPids))
      createdPids.length = 0
    }
    if (createdKeywords.length > 0) {
      // The stub trends provider's `snapshot: { keyword }` rows have no supplierProductId, so
      // they can't be swept by the pid delete above. Scoped to THIS file's own known keywords
      // (`source = 'google_trends' AND keyword IN (...)`) rather than every `google_trends` row
      // in the shared test DB — a source-wide delete would race any other test file that writes
      // that source (see commit d51d95c's dirty-DB-rerun fix for the same class of bug in the
      // fulfillment suite).
      await db
        .delete(sourcingSignals)
        .where(and(eq(sourcingSignals.source, 'google_trends'), inArray(sourcingSignals.keyword, createdKeywords)))
      createdKeywords.length = 0
    }
    if (createdRisingKeywords.length > 0) {
      await db
        .delete(sourcingSignals)
        .where(and(eq(sourcingSignals.source, 'trends_rising'), inArray(sourcingSignals.keyword, createdRisingKeywords)))
      createdRisingKeywords.length = 0
    }
  })

  function baseDeps(overrides: Partial<SourcingPipelineDeps> = {}): SourcingPipelineDeps {
    return {
      db,
      adapter: makeAdapter([]),
      settings: createSettings(db),
      alert: vi.fn(async () => {}),
      enqueue: noopEnqueue,
      notify: noopNotify,
      adminBaseUrl: 'http://localhost:3001',
      providersFactory: () => ({ trends: stubTrends(), marketPrice: null, demand: null }),
      ...overrides,
    }
  }

  /** Three harvestable candidates (>= MIN_CANDIDATES), fresh pids per call. Registers the pids
   * AND the serving harvest keyword (harvest's `cj_trending` rows key on the former; the trends
   * stage's `google_trends` rows key on the latter, per the distinct candidate keywords passed to
   * `fetchInterest` in pipeline.ts) for `sourcing_signals` cleanup so callers don't have to
   * remember to. */
  function candidateSpecs(): ProductSpec[] {
    const specs: ProductSpec[] = [
      { pid: uid(), title: 'Rope Pull Toy', categoryName: 'Toys', sellPriceCents: 2999, listedNum: 500, liveCostCents: 1000 },
      { pid: uid(), title: 'Plush Squeaker Toy', categoryName: 'Toys', sellPriceCents: 1999, listedNum: 400, liveCostCents: 900 },
      { pid: uid(), title: 'Interactive Puzzle Toy', categoryName: 'Toys', sellPriceCents: 2499, listedNum: 300, liveCostCents: 950 },
    ]
    createdPids.push(...specs.map((s) => s.pid))
    createdKeywords.push(HARVEST_KEYWORDS[0])
    return specs
  }

  // --- (b) FIRST in file order: exercises the same-day breaker on a guaranteed-clean slate ------
  it('(b) second call same day without force is refused — no second run row, no throw', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const winners = [winnerFor(specs[0]!), winnerFor(specs[1]!)]
    const alert = vi.fn(async () => {})

    const first = await runSourcingPipeline(
      baseDeps({ adapter, alert, queryFn: fakeQueryFn(winners) }), // no `force` — real cron path
    )
    expect(first.outcome).toBe('completed')
    expect(first.runId).not.toBeNull()
    createdRunIds.push(first.runId!)

    await expect(
      runSourcingPipeline(baseDeps({ adapter, alert })), // still no force
    ).resolves.toEqual({ runId: null, outcome: 'refused', submitted: 0 })

    expect(alert).toHaveBeenCalledWith('info', 'sourcing_run_refused', expect.objectContaining({ existingRunId: first.runId }))

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, 'sourcing.weekly'))
    expect(rows).toHaveLength(1)

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sourcing.run_refused'), eq(auditLog.entityId, first.runId!)))
    expect(auditRows.length).toBeGreaterThanOrEqual(1)
  })

  // --- (a) full happy path -----------------------------------------------------------------------
  it('(a) full happy path: 2 proposals pending, run succeeded, sourcing.run_completed audit row', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const winners = [winnerFor(specs[0]!), winnerFor(specs[1]!)]
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(baseDeps({ adapter, alert, force: true, queryFn: fakeQueryFn(winners) }))
    expect(result.outcome).toBe('completed')
    expect(result.submitted).toBe(2)
    expect(result.runId).not.toBeNull()
    createdRunIds.push(result.runId!)

    const pending = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.agentRunId, result.runId!), eq(proposals.status, 'pending')))
    expect(pending).toHaveLength(2)
    for (const p of pending) {
      expect(p.type).toBe('new_listing')
      expect(p.sourceWorkflow).toBe('sourcing.weekly')
    }

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, result.runId!))
    expect(runRow!.status).toBe('succeeded')

    const [completedAudit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sourcing.run_completed'), eq(auditLog.entityId, result.runId!)))
    expect(completedAudit).toBeDefined()
    expect(completedAudit!.entityType).toBe('agent_run')
    expect(completedAudit!.detail).toEqual({ submitted: 2, dropped: 0 })
  })

  // --- (c) empty harvest ---------------------------------------------------------------------
  it('(c) empty harvest short-circuits: no_candidates, row aborted with totalCostUsd 0', async () => {
    const adapter = makeAdapter([])
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(baseDeps({ adapter, alert, force: true }))
    expect(result.outcome).toBe('no_candidates')
    expect(result.submitted).toBe(0)
    expect(result.runId).not.toBeNull()
    createdRunIds.push(result.runId!)

    expect(alert).toHaveBeenCalledWith('warning', 'sourcing_run_skipped_no_candidates', expect.objectContaining({ found: 0 }))

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, result.runId!))
    expect(runRow!.status).toBe('aborted')
    expect(runRow!.totalCostUsd).toBe('0')

    const proposalRows = await db.select().from(proposals).where(eq(proposals.agentRunId, result.runId!))
    expect(proposalRows).toHaveLength(0)
  })

  // --- (d2) trends queries keywords, not titles ------------------------------------------------
  it('(d2) trends stage queries the distinct harvest keywords, never product titles (full CJ titles 400 on SerpApi)', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const trends = stubTrends()
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(
      baseDeps({ adapter, alert, providersFactory: () => ({ trends, marketPrice: null, demand: null }), force: true, queryFn: fakeQueryFn([]) }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    // All three candidates come from the same keyword pass, so the distinct-keyword list is
    // exactly one entry — deduped, and never the three titles.
    expect(trends.fetchInterest).toHaveBeenCalledTimes(1)
    expect(trends.fetchInterest).toHaveBeenCalledWith([HARVEST_KEYWORDS[0]])
  })

  // --- (d) trends null -------------------------------------------------------------------------
  it('(d) trends null: agent still runs to completion, trends_stage_skipped alert fires', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const winners = [winnerFor(specs[0]!)]
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(
      baseDeps({ adapter, alert, providersFactory: () => ({ trends: null, marketPrice: null, demand: null }), force: true, queryFn: fakeQueryFn(winners) }),
    )
    expect(result.outcome).toBe('completed')
    expect(result.submitted).toBe(1)
    createdRunIds.push(result.runId!)

    expect(alert).toHaveBeenCalledWith('warning', 'trends_stage_skipped', {})

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, result.runId!))
    expect(runRow!.status).toBe('succeeded')
  })

  // --- (e) agent failure -----------------------------------------------------------------------
  it('(e) agent run failure: outcome agent_failed, zero proposals submitted', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(baseDeps({ adapter, alert, force: true, queryFn: failingQueryFn() }))
    expect(result.outcome).toBe('agent_failed')
    expect(result.submitted).toBe(0)
    expect(result.runId).not.toBeNull()
    createdRunIds.push(result.runId!)

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, result.runId!))
    expect(runRow!.status).toBe('failed')

    const proposalRows = await db.select().from(proposals).where(eq(proposals.agentRunId, result.runId!))
    expect(proposalRows).toHaveLength(0)
  })

  // --- market-price gate wiring -----------------------------------------------------------------
  it('no market provider: market_price_stage_skipped warning fires, winners submit without a lookup', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const winners = [winnerFor(specs[0]!)] // no marketLookupId set — nothing requires one this run
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn(winners),
        providersFactory: () => ({ trends: stubTrends(), marketPrice: null, demand: null }),
      }),
    )
    expect(result.outcome).toBe('completed')
    expect(result.submitted).toBe(1)
    createdRunIds.push(result.runId!)

    expect(alert).toHaveBeenCalledWith('warning', 'market_price_stage_skipped', expect.anything())
  })

  it('market provider present: a winner without a lookup is dropped end-to-end (armed wiring proof)', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    // The fake stream below makes no tool calls, so the run-scoped MarketLookups registry stays
    // empty — this winner has no marketLookupId, proving the gate actually reads the registry.
    const winners = [winnerFor(specs[0]!)]
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn(winners),
        providersFactory: () => ({ trends: stubTrends(), marketPrice: { key: 'stub', fetchOffers: async () => [] }, demand: null }),
      }),
    )
    expect(result.outcome).toBe('completed')
    expect(result.submitted).toBe(0)
    createdRunIds.push(result.runId!)

    expect(alert).toHaveBeenCalledWith('warning', 'sourcing_winner_no_market_price', expect.anything())
    expect(alert).not.toHaveBeenCalledWith('warning', 'market_price_stage_skipped', expect.anything())
  })

  it('persistMarketLookups writes market_price sourcing_signals rows and never throws', async () => {
    const pidA = uid()
    const pidB = uid()
    createdPids.push(pidA, pidB)

    const fiveOffers: MarketOffer[] = [1000, 1200, 1400, 1600, 1800].map((priceCents, i) => ({
      title: `Offer ${i}`,
      priceCents,
      merchant: 'Some Store',
      url: `https://example.com/offer-${i}`,
    }))

    const reg = new MarketLookups()
    const conclusive = reg.record({ supplierProductId: pidA, query: 'dog bed', offers: fiveOffers })
    const inconclusive = reg.record({ supplierProductId: pidB, query: 'weird thing', offers: [] })
    expect(conclusive.medianCents).not.toBeNull()
    expect(inconclusive.medianCents).toBeNull()

    const alert = vi.fn(async () => {})
    await persistMarketLookups(db, alert, reg.all())

    const rows = await db
      .select()
      .from(sourcingSignals)
      .where(and(eq(sourcingSignals.source, 'market_price'), inArray(sourcingSignals.supplierProductId, [pidA, pidB])))
    expect(rows).toHaveLength(2)
    expect(alert).not.toHaveBeenCalled()

    const conclusiveRow = rows.find((r) => r.supplierProductId === pidA)!
    expect(conclusiveRow.keyword).toBe('dog bed')
    expect(conclusiveRow.score).toBe(String(conclusive.medianCents))
    expect((conclusiveRow.snapshot as { offerCount: number }).offerCount).toBe(5)

    const inconclusiveRow = rows.find((r) => r.supplierProductId === pidB)!
    expect(inconclusiveRow.keyword).toBe('weird thing')
    expect(inconclusiveRow.score).toBeNull()

    // A second call against a poisoned db must never throw — it warns and moves on (spec §7).
    const poisonedDb = {
      insert: () => ({
        values: async () => {
          throw new Error('sourcing-pipeline test: poisoned insert')
        },
      }),
    } as unknown as typeof db
    const poisonedAlert = vi.fn(async () => {})
    await expect(persistMarketLookups(poisonedDb, poisonedAlert, reg.all())).resolves.toBeUndefined()
    expect(poisonedAlert).toHaveBeenCalledWith('warning', 'market_price_persist_failed', expect.anything())
  })

  // --- (f) FIX C2: fresh trends provider per run ------------------------------------------------
  it('(f) FIX C2: each run constructs a FRESH trends provider from the factory (per-run request budget resets)', async () => {
    // The bug: a single TrendsProvider baked in at boot keeps one closure counter that never
    // resets, so week-over-week it accumulates and permanently trips the SerpApi per-run cap.
    // Proof of the fix: the factory is invoked once per run and hands out a DISTINCT instance each
    // time, so each run gets its own fresh `requestsMade` counter.
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const providers: TrendsProvider[] = []
    const providersFactory = vi.fn((): SourcingProviders => {
      const provider: TrendsProvider = {
        key: 'stub',
        fetchInterest: vi.fn(async (keywords: string[]) => keywords.map((keyword) => ({ keyword, score: 80, snapshot: { keyword } }))),
        fetchRisingQueries: vi.fn(async () => []),
      }
      providers.push(provider)
      return { trends: provider, marketPrice: null, demand: null }
    })

    const first = await runSourcingPipeline(baseDeps({ adapter, providersFactory, force: true, queryFn: fakeQueryFn([]) }))
    expect(first.outcome).toBe('completed')
    createdRunIds.push(first.runId!)

    const second = await runSourcingPipeline(baseDeps({ adapter, providersFactory, force: true, queryFn: fakeQueryFn([]) }))
    expect(second.outcome).toBe('completed')
    createdRunIds.push(second.runId!)

    expect(providersFactory).toHaveBeenCalledTimes(2)
    expect(providers).toHaveLength(2)
    expect(providers[0]).not.toBe(providers[1]) // distinct instance => fresh per-run request budget
  })

  // --- (g) FIX C1/C4b: a pre-runner throw never leaves the claimed row stuck 'running' ----------
  it('(g) FIX C1/C4b: a stage-before-runner throw flips the claimed row to a terminal status, not stuck running', async () => {
    // A stage between the day-claim and the agent runner throws (here the trends stage; the same
    // belt covers a harvest db.insert throwing on a transient DB error, or a SIGTERM-driven throw).
    // The runner's own try/finally (Task 12) only covers throws INSIDE the runner — without this
    // belt the claimed 'running' row would sit wedged for up to ~7 days with no orphan alert.
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const alert = vi.fn(async () => {})
    const providersFactory = (): SourcingProviders => {
      throw new Error('transient failure in a pre-runner stage')
    }

    await expect(runSourcingPipeline(baseDeps({ adapter, alert, force: true, providersFactory }))).rejects.toThrow(
      'transient failure in a pre-runner stage',
    )

    // The claim created exactly one sourcing.weekly row; the belt must have flipped it OFF 'running'
    // to a terminal 'failed' with finishedAt before the error propagated to the job's catch.
    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, 'sourcing.weekly'))
    createdRunIds.push(...rows.map((r) => r.id))
    expect(rows.filter((r) => r.status === 'running')).toHaveLength(0)
    const failed = rows.filter((r) => r.status === 'failed')
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed.every((r) => r.finishedAt !== null)).toBe(true)
  })

  // --- Task 9: Stage 1b keyword expansion + Stage 6 provider/registry threading -----------------

  it('Stage 1b: expanded keywords reach harvest, trends_rising rows persist, expansion alert fires', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const searchSpy = vi.fn(adapter.searchProducts.bind(adapter))
    adapter.searchProducts = searchSpy as unknown as SupplierAdapter['searchProducts']
    const trends = stubTrendsWithRising([rq('dog water bottle', 120)])
    const alert = vi.fn(async () => {})
    createdRisingKeywords.push('dog water bottle')

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn([]),
        providersFactory: () => ({ trends, marketPrice: null, demand: null }),
      }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    // harvest received the expanded keyword list.
    const searchedKeywords = new Set(searchSpy.mock.calls.map(([q]) => (q as { keyword?: string }).keyword))
    expect(searchedKeywords.has('dog water bottle')).toBe(true)

    // the trends_rising signal persisted with the expansion's own shape.
    const rows = await db
      .select()
      .from(sourcingSignals)
      .where(and(eq(sourcingSignals.source, 'trends_rising'), eq(sourcingSignals.keyword, 'dog water bottle')))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.score).toBe('120')
    expect(rows[0]!.snapshot).toEqual({ baseKeyword: HARVEST_KEYWORDS[0], value: '+120%', extractedValue: 120 })

    expect(alert).toHaveBeenCalledWith('info', 'sourcing_keywords_expanded', { added: ['dog water bottle'], dropped: 0 })
  })

  it('Stage 1b: null providers -> base keywords only, no expansion alert, both existing skip alerts unchanged', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const searchSpy = vi.fn(adapter.searchProducts.bind(adapter))
    adapter.searchProducts = searchSpy as unknown as SupplierAdapter['searchProducts']
    const alert = vi.fn(async () => {})

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn([]),
        providersFactory: () => ({ trends: null, marketPrice: null, demand: null }),
      }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    // No expansion happened: harvest saw exactly the base HARVEST_KEYWORDS, nothing more.
    const searchedKeywords = new Set(searchSpy.mock.calls.map(([q]) => (q as { keyword?: string }).keyword))
    expect([...searchedKeywords].sort()).toEqual([...HARVEST_KEYWORDS].sort())

    expect(alert).not.toHaveBeenCalledWith('info', 'sourcing_keywords_expanded', expect.anything())
    expect(alert).toHaveBeenCalledWith('warning', 'trends_stage_skipped', {})
    expect(alert).toHaveBeenCalledWith('warning', 'market_price_stage_skipped', expect.anything())
  })

  it('Stage 1b: a trends_rising persist failure warns and the run continues with expanded keywords', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const searchSpy = vi.fn(adapter.searchProducts.bind(adapter))
    adapter.searchProducts = searchSpy as unknown as SupplierAdapter['searchProducts']
    const trends = stubTrendsWithRising([rq('dog water bottle', 120)])
    const alert = vi.fn(async () => {})
    const poisonedDb = withFailingTrendsRisingInsert(db)

    const result = await runSourcingPipeline(
      baseDeps({
        db: poisonedDb,
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn([]),
        providersFactory: () => ({ trends, marketPrice: null, demand: null }),
      }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    expect(alert).toHaveBeenCalledWith('warning', 'keyword_expansion_persist_failed', expect.objectContaining({ error: expect.any(String) }))
    // The alert fires anyway, and the run still keeps the expanded keywords for harvest — a
    // persist failure must never cost the run its expanded keywords.
    expect(alert).toHaveBeenCalledWith('info', 'sourcing_keywords_expanded', { added: ['dog water bottle'], dropped: 0 })

    const searchedKeywords = new Set(searchSpy.mock.calls.map(([q]) => (q as { keyword?: string }).keyword))
    expect(searchedKeywords.has('dog water bottle')).toBe(true)

    // Nothing persisted — the insert was poisoned.
    const rows = await db
      .select()
      .from(sourcingSignals)
      .where(and(eq(sourcingSignals.source, 'trends_rising'), eq(sourcingSignals.keyword, 'dog water bottle')))
    expect(rows).toHaveLength(0)
  })

  it('Stage 6 receives demandProbe, reviewsSeen, and trendSignalsByKeyword', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const winners = [winnerFor(specs[0]!)]
    const alert = vi.fn(async () => {})
    const demand: DemandProbeProvider = { key: 'stub_demand', probe: vi.fn(async () => null) }

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        alert,
        force: true,
        queryFn: fakeQueryFn(winners),
        providersFactory: () => ({ trends: stubTrends(), marketPrice: null, demand }),
      }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    expect(validateAndSubmitWinners).toHaveBeenCalledWith(
      expect.objectContaining({
        demandProbe: demand,
        reviewsSeen: expect.any(ReviewsSeen),
        trendSignalsByKeyword: expect.any(Map),
      }),
      expect.anything(),
    )
  })

  // --- (h)-(j) catalog-build knobs (spec 2026-08-31 catalog-p0 §5) ---------------------------

  /** Adapter whose keyword pass NEVER runs dry: every page of `keyword` returns the same specs
   * (deduped by pid inside the harvest), so the only thing that can end the harvest loop is the
   * page cap — which is exactly what the maxPages knob is asserted on below. */
  function makeEveryPageAdapter(specs: ProductSpec[], keyword: string): SupplierAdapter {
    const adapter = makeAdapter(specs)
    adapter.searchProducts = vi.fn(async (q: { keyword?: string }): Promise<SupplierProductSummary[]> =>
      q.keyword === keyword
        ? specs.map((s) => ({
            supplierProductId: s.pid,
            title: s.title,
            categoryName: s.categoryName,
            sellPriceCents: s.sellPriceCents,
            listedCount: s.listedNum,
          }))
        : [],
    ) as SupplierAdapter['searchProducts']
    return adapter
  }

  /** queryFn that records the prompt + options the runner passed, then streams `winners`. */
  function capturingQueryFn(winners: ReturnType<typeof winnerFor>[]): {
    queryFn: SourcingRunDeps['queryFn']
    seen: { prompt?: string; options?: Record<string, unknown> }
  } {
    const seen: { prompt?: string; options?: Record<string, unknown> } = {}
    const inner = fakeQueryFn(winners)
    return {
      seen,
      queryFn: (args) => {
        seen.prompt = args.prompt
        seen.options = args.options
        return inner!(args)
      },
    }
  }

  it('(h) CLI overrides thread through the whole run: keywords, maxPages, candidateTarget, maxWinners, budget', async () => {
    // A FOURTH candidate so `candidateTarget: 3` (the knob's floor) visibly drops one.
    const extra: ProductSpec = { pid: uid(), title: 'Chew Ring Toy', categoryName: 'Toys', sellPriceCents: 1599, listedNum: 250, liveCostCents: 800 }
    createdPids.push(extra.pid)
    const specs = [...candidateSpecs(), extra]
    createdKeywords.push('dog snuffle mat')
    const adapter = makeEveryPageAdapter(specs, 'dog snuffle mat')
    const { queryFn, seen } = capturingQueryFn([winnerFor(specs[0]!)])

    const result = await runSourcingPipeline(
      baseDeps({
        adapter,
        force: true,
        queryFn,
        overrides: { keywords: ['dog snuffle mat'], maxPages: 2, candidateTarget: 3, maxWinners: 8, maxBudgetUsd: 6.5 },
      }),
    )
    expect(result.outcome).toBe('completed')
    createdRunIds.push(result.runId!)

    // keywords: only the override keyword was ever searched.
    const calls = (adapter.searchProducts as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([q]) => q as { keyword?: string })
    expect(new Set(calls.map((q) => q.keyword))).toEqual(new Set(['dog snuffle mat']))
    // maxPages: the never-dry pass stopped at exactly 2 pages.
    expect(calls).toHaveLength(2)
    // candidateTarget: only 3 of the 4 harvested candidates reached the agent prompt.
    const inPrompt = specs.filter((sp) => seen.prompt!.includes(sp.pid))
    expect(inPrompt).toHaveLength(3)
    // maxWinners + budget.
    expect(seen.prompt).toContain('up to 8 winners')
    expect(seen.options!.maxBudgetUsd).toBe(6.5)
    expect(((seen.options!.outputFormat as { schema: { properties: { winners: { maxItems: number } } } }).schema).properties.winners.maxItems).toBe(8)
  })

  it('(i) settings drive the knobs when no override is given (max_budget_cents is cents)', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const { queryFn, seen } = capturingQueryFn([])
    const s = createSettings(db)
    await s.set('sourcing.max_winners', 6)
    await s.set('sourcing.max_budget_cents', 450)

    try {
      const result = await runSourcingPipeline(baseDeps({ adapter, force: true, queryFn }))
      expect(result.outcome).toBe('completed')
      createdRunIds.push(result.runId!)

      expect(seen.prompt).toContain('up to 6 winners')
      expect(seen.options!.maxBudgetUsd).toBe(4.5)
    } finally {
      await db
        .delete(settingsTable)
        .where(inArray(settingsTable.key, ['sourcing.max_winners', 'sourcing.max_budget_cents']))
    }
  })

  it('(i2) an out-of-range SETTING fails the run loudly, before the day is claimed', async () => {
    const adapter = makeAdapter(candidateSpecs())
    const s = createSettings(db)
    await s.set('sourcing.max_winners', 99)

    try {
      await expect(runSourcingPipeline(baseDeps({ adapter, force: true }))).rejects.toThrow(/sourcing\.max_winners/)
      // Nothing was claimed: a knob mistake must not burn the day's run slot.
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, 'sourcing.weekly'))
      createdRunIds.push(...rows.map((r) => r.id))
      expect(rows).toHaveLength(0)
    } finally {
      await db.delete(settingsTable).where(eq(settingsTable.key, 'sourcing.max_winners'))
    }
  })

  it('(j) the weekly cron path passes NO overrides — constants stay in force', async () => {
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const searchSpy = vi.fn(adapter.searchProducts.bind(adapter))
    adapter.searchProducts = searchSpy
    const { queryFn, seen } = capturingQueryFn([])
    const deps = baseDeps({ adapter, force: true, queryFn })
    expect(deps.overrides).toBeUndefined()

    await sourcingWeeklyHandler(deps)()

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.workflow, 'sourcing.weekly'))
    createdRunIds.push(...rows.map((r) => r.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('succeeded')

    // The cron harvests the constant keyword list, and the agent gets the constant caps.
    const queried = new Set(searchSpy.mock.calls.map(([q]) => q.keyword))
    expect([...queried].sort()).toEqual([...HARVEST_KEYWORDS].sort())
    expect(seen.prompt).toContain('up to 3 winners')
    expect(seen.options!.maxBudgetUsd).toBe(SOURCING_MAX_BUDGET_USD)
  })
})
