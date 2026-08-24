import { agentRunEvents, agentRuns, createDb } from '@doge-buddy/db'
import { asc, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { PointsAllowance } from '../src/agents/points.ts'
import { createUsageAccumulator } from '../src/agents/pricing.ts'
import { createSourcingMcpServer } from '../src/agents/mcp-tools.ts'
import {
  SOURCING_MAX_BUDGET_USD,
  SOURCING_MAX_TURNS,
  SOURCING_MODEL,
  SOURCING_WATCHDOG_MS,
  runSourcingAgent,
  type SourcingRunDeps,
} from '../src/agents/sourcing-run.ts'
import {
  SOURCING_OUTPUT_JSON_SCHEMA,
  SourcingOutputSchema,
} from '../src/agents/output-schema.ts'
import type { HarvestCandidate } from '../src/sourcing/harvest.ts'
import type { TrendSignal } from '../src/sourcing/trends.ts'
import type { ShippingOption, SupplierAdapter, SupplierProductDetail, SupplierProductReview, WarehouseStock } from '@doge-buddy/supplier'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0

function stubAdapter(): Pick<SupplierAdapter, 'getProduct' | 'getProductReviews' | 'getVariantStock' | 'quoteShipping'> {
  return {
    getProduct: vi.fn(async (): Promise<SupplierProductDetail> => ({
      supplierProductId: 'p1', title: 'W', imageUrls: ['https://x/y.png'],
      variants: [{ supplierVariantId: 'v1', priceCents: 1000 }],
    })),
    getProductReviews: vi.fn(async (): Promise<SupplierProductReview[]> => []),
    getVariantStock: vi.fn(async (): Promise<WarehouseStock[]> => [{ countryCode: 'US', quantity: 10, verified: true }]),
    quoteShipping: vi.fn(async (): Promise<ShippingOption[]> => [{ name: 'Std', priceCents: 499, minDays: 5, maxDays: 10 }]),
  }
}

function mcpServer() {
  return createSourcingMcpServer({ adapter: stubAdapter(), allowance: new PointsAllowance() })
}

function candidates(): HarvestCandidate[] {
  return [{ supplierProductId: 'cjp-1', title: 'Dog Toy', categoryName: 'Toys', sellPriceCents: 2999, listedNum: 120, imageUrl: 'https://x/y.png' }]
}
function trendSignals(): TrendSignal[] {
  return [{ keyword: 'dog toy', score: 75, snapshot: {} }]
}

function validWinner() {
  return {
    payload: {
      type: 'new_listing', title: 'Dog Snuffle Mat', descriptionHtml: '<p>Great enrichment toy.</p>',
      categoryTag: 'toys', imageUrls: ['https://cf.cjdropshipping.com/x.png'], shipsFrom: 'US',
      deliveryMinDays: 3, deliveryMaxDays: 7,
      variants: [{ sku: `SKU-${crypto.randomUUID()}`, priceCents: 2999, supplierCostCents: 1414, supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjv-1' }],
    },
    rationale: 'Strong demand, healthy freight-inclusive margin.',
    marginPct: 62.5,
    freightEstimateCents: 499,
  }
}

describe('runSourcingAgent (fake SDK stream)', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  const createdRunIds: string[] = []
  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, createdRunIds))
      await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds))
      createdRunIds.length = 0
    }
  })

  async function claimRow(tag: string): Promise<string> {
    uid += 1
    const [row] = await db
      .insert(agentRuns)
      .values({ workflow: `sourcing-run-test-${Date.now()}-${uid}`, model: SOURCING_MODEL, status: 'running', triggerRef: tag })
      .returning({ id: agentRuns.id })
    createdRunIds.push(row!.id)
    return row!.id
  }

  function deps(queryFn: SourcingRunDeps['queryFn']): SourcingRunDeps & { alert: ReturnType<typeof vi.fn> } {
    return { db, alert: vi.fn().mockResolvedValue(undefined), mcpServer: mcpServer(), queryFn }
  }

  it('constants match the spec Global Constraints', () => {
    expect(SOURCING_MODEL).toBe('claude-sonnet-5')
    expect(SOURCING_MAX_TURNS).toBe(25)
    expect(SOURCING_MAX_BUDGET_USD).toBe(2.0)
    expect(SOURCING_WATCHDOG_MS).toBe(15 * 60 * 1000)
  })

  it('success stream: persists events 0..3, row succeeded with authoritative cost, output parsed, and passes the exact options', async () => {
    const runId = await claimRow('success')
    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 800, output_tokens: 300 } } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 1.23, modelUsage: { 'claude-sonnet-5': { costUSD: 1.23 } }, num_turns: 4, session_id: 's1', structured_output: { winners: [validWinner()] } }
    }
    const d = deps((args) => { captured = args.options; return stream() })

    const result = await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })

    expect(result.status).toBe('succeeded')
    expect(result.costUsd).toBe(1.23)
    expect(result.costEstimated).toBe(false)
    expect(result.output?.winners.length).toBe(1)

    const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(asc(agentRunEvents.seq))
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3])

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('succeeded')
    expect(Number(row!.totalCostUsd)).toBe(1.23)
    expect(row!.numTurns).toBe(4)
    expect(row!.sessionId).toBe('s1')
    expect(row!.finishedAt).not.toBeNull()

    // Options the runner passed to query()
    expect(captured!.tools).toEqual(['WebSearch', 'WebFetch'])
    expect(captured!.allowedTools).toContain('mcp__sourcing__*')
    expect(captured!.settingSources).toEqual([])
    expect(captured!.maxBudgetUsd).toBe(2)
    expect(captured!.model).toBe('claude-sonnet-5')
    expect(captured!.permissionMode).toBe('dontAsk')
    expect(captured!.persistSession).toBe(false)
    expect((captured!.mcpServers as Record<string, unknown>).sourcing).toBeDefined()
    expect((captured!.env as Record<string, string>).MCP_TOOL_TIMEOUT).toBe('60000')
    expect((captured!.outputFormat as { type: string }).type).toBe('json_schema')
  })

  it('thrown stream: row failed with the accumulator estimate, modelUsage.estimated, alert fired, resolves without throwing', async () => {
    const runId = await claimRow('thrown')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } }
      throw new Error('stream blew up')
    }
    const d = deps(() => stream())

    const result = await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })

    const acc = createUsageAccumulator()
    acc.add({ message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } })
    const expectedCost = acc.tally().estimatedCostUsd

    expect(result.status).toBe('failed')
    expect(result.costEstimated).toBe(true)
    expect(result.costUsd).toBeCloseTo(expectedCost, 10)
    expect(result.output).toBeNull()

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('failed')
    expect(Number(row!.totalCostUsd)).toBeCloseTo(expectedCost, 10)
    expect((row!.modelUsage as { estimated?: boolean }).estimated).toBe(true)
    expect(row!.finishedAt).not.toBeNull()

    expect(d.alert).toHaveBeenCalledWith('critical', 'sourcing_run_failed', expect.objectContaining({ runId }))
  })

  it('budget truncation: result error_max_budget_usd → row aborted, authoritative cost, no output', async () => {
    const runId = await claimRow('budget')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 500, output_tokens: 200 } } }
      yield { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 2.01, modelUsage: { 'claude-sonnet-5': { costUSD: 2.01 } }, num_turns: 12, session_id: 's3' }
    }
    const d = deps(() => stream())

    const result = await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })

    expect(result.status).toBe('aborted')
    expect(result.output).toBeNull()
    expect(result.costUsd).toBe(2.01)
    expect(result.costEstimated).toBe(false)

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('aborted')
    expect(Number(row!.totalCostUsd)).toBe(2.01)
  })

  it('invalid structured output: result success but schema-invalid → row failed (NOT succeeded), sourcing_output_invalid alert', async () => {
    const runId = await claimRow('invalid')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 50 } } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.5, modelUsage: { 'claude-sonnet-5': { costUSD: 0.5 } }, num_turns: 2, session_id: 's4', structured_output: { winners: [{ bogus: true }] } }
    }
    const d = deps(() => stream())

    const result = await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })

    expect(result.status).toBe('failed')
    expect(result.output).toBeNull()

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('failed')
    expect(Number(row!.totalCostUsd)).toBe(0.5)

    expect(d.alert).toHaveBeenCalledWith('critical', 'sourcing_output_invalid', expect.objectContaining({ runId }))
  })

  it('every-5-events branch: an intermediate streaming estimate lands on the row mid-run, then the terminal authoritative cost overwrites it', async () => {
    const runId = await claimRow('every5')
    let intermediateCost: string | null | undefined
    // init + 5 assistant + result = 7 messages. The `seq % 5 === 0` intermediate cost-persist fires
    // after the 5th message (seq reaches 5). Because the runner awaits its DB writes before pulling
    // the next stream value, reading the row between yielding the 5th and 6th message observes
    // exactly that intermediate write.
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 's5' } // seq 0
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } } // seq 1
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } } // seq 2
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } } // seq 3
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } } // seq 4 -> triggers intermediate update
      const [mid] = await db.select({ c: agentRuns.totalCostUsd }).from(agentRuns).where(eq(agentRuns.id, runId))
      intermediateCost = mid?.c
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } } // seq 5
      yield { type: 'result', subtype: 'success', total_cost_usd: 9.99, modelUsage: {}, num_turns: 6, session_id: 's5', structured_output: { winners: [validWinner()] } } // seq 6
    }
    const d = deps(() => stream())

    const result = await runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })

    // The intermediate write is the accumulator estimate over the 4 assistant messages processed
    // before seq hit 5.
    const acc = createUsageAccumulator()
    for (let i = 0; i < 4; i += 1) acc.add({ message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } })
    const expectedIntermediate = acc.tally().estimatedCostUsd

    expect(expectedIntermediate).toBeGreaterThan(0)
    expect(intermediateCost).not.toBeNull()
    expect(intermediateCost).not.toBeUndefined()
    expect(Number(intermediateCost)).toBeCloseTo(expectedIntermediate, 10)

    // The terminal authoritative update overwrote the intermediate estimate with the result cost.
    expect(result.status).toBe('succeeded')
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(Number(row!.totalCostUsd)).toBe(9.99)
  })

  it('watchdog: a hanging run is aborted after SOURCING_WATCHDOG_MS -> abortController fires, row aborted, cost estimated', async () => {
    const runId = await claimRow('watchdog')
    let capturedAc: AbortController | undefined
    // A stream that yields nothing and hangs until its abort signal fires — the runner's watchdog
    // AbortController. No events are written during the hang, so the only async work under fake
    // timers is the watchdog timer itself.
    const queryFn: SourcingRunDeps['queryFn'] = (args) => {
      const ac = args.options.abortController as AbortController
      capturedAc = ac
      async function* gen(): AsyncGenerator<Record<string, unknown>> {
        await new Promise<void>((resolve) => {
          if (ac.signal.aborted) resolve()
          else ac.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        // Stream ends after the abort — no result message ever arrived.
      }
      return gen()
    }
    const d = deps(queryFn)

    vi.useFakeTimers()
    try {
      const runPromise = runSourcingAgent(d, { runId, candidates: candidates(), trendSignals: trendSignals() })
      // Advance past the watchdog deadline: fires the setTimeout that calls abortController.abort().
      await vi.advanceTimersByTimeAsync(SOURCING_WATCHDOG_MS + 1)
      const result = await runPromise

      expect(capturedAc?.signal.aborted).toBe(true)
      expect(result.status).toBe('aborted')
      expect(result.costEstimated).toBe(true)
    } finally {
      vi.useRealTimers()
    }

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('aborted')
    expect(row!.finishedAt).not.toBeNull()
    expect(d.alert).toHaveBeenCalledWith('critical', 'sourcing_run_failed', expect.objectContaining({ runId }))
  })
})

describe('output-schema', () => {
  it('SOURCING_OUTPUT_JSON_SCHEMA is a JSON Schema object', () => {
    expect((SOURCING_OUTPUT_JSON_SCHEMA as { type?: string }).type).toBe('object')
  })

  it('rejects more than 3 winners', () => {
    const w = validWinner()
    const parsed = SourcingOutputSchema.safeParse({ winners: [w, w, w, w] })
    expect(parsed.success).toBe(false)
  })

  it('parses a valid single-winner output', () => {
    const parsed = SourcingOutputSchema.safeParse({ winners: [validWinner()], notes: 'ok' })
    expect(parsed.success).toBe(true)
  })
})
