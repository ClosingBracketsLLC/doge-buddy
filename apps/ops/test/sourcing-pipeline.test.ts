import { agentRunEvents, agentRuns, auditLog, createDb, proposals, sourcingSignals } from '@doge-buddy/db'
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
import { SOURCING_MODEL, type SourcingRunDeps } from '../src/agents/sourcing-run.ts'
import { createSettings } from '../src/settings.ts'
import { HARVEST_KEYWORDS } from '../src/sourcing/harvest.ts'
import { runSourcingPipeline, type SourcingPipelineDeps } from '../src/sourcing/pipeline.ts'
import type { TrendsProvider } from '../src/sourcing/trends.ts'
import type { NotifyOwner } from '../src/notify/notify.ts'

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
  }
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
      trendsFactory: () => stubTrends(),
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
      baseDeps({ adapter, alert, trendsFactory: () => trends, force: true, queryFn: fakeQueryFn([]) }),
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

    const result = await runSourcingPipeline(baseDeps({ adapter, alert, trendsFactory: () => null, force: true, queryFn: fakeQueryFn(winners) }))
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

  // --- (f) FIX C2: fresh trends provider per run ------------------------------------------------
  it('(f) FIX C2: each run constructs a FRESH trends provider from the factory (per-run request budget resets)', async () => {
    // The bug: a single TrendsProvider baked in at boot keeps one closure counter that never
    // resets, so week-over-week it accumulates and permanently trips the SerpApi per-run cap.
    // Proof of the fix: the factory is invoked once per run and hands out a DISTINCT instance each
    // time, so each run gets its own fresh `requestsMade` counter.
    const specs = candidateSpecs()
    const adapter = makeAdapter(specs)
    const providers: TrendsProvider[] = []
    const trendsFactory = vi.fn((): TrendsProvider => {
      const provider: TrendsProvider = {
        key: 'stub',
        fetchInterest: vi.fn(async (keywords: string[]) => keywords.map((keyword) => ({ keyword, score: 80, snapshot: { keyword } }))),
      }
      providers.push(provider)
      return provider
    })

    const first = await runSourcingPipeline(baseDeps({ adapter, trendsFactory, force: true, queryFn: fakeQueryFn([]) }))
    expect(first.outcome).toBe('completed')
    createdRunIds.push(first.runId!)

    const second = await runSourcingPipeline(baseDeps({ adapter, trendsFactory, force: true, queryFn: fakeQueryFn([]) }))
    expect(second.outcome).toBe('completed')
    createdRunIds.push(second.runId!)

    expect(trendsFactory).toHaveBeenCalledTimes(2)
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
    const trendsFactory = () => {
      throw new Error('transient failure in a pre-runner stage')
    }

    await expect(runSourcingPipeline(baseDeps({ adapter, alert, force: true, trendsFactory }))).rejects.toThrow(
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
})
