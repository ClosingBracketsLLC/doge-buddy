import { agentRunEvents, agentRuns, createDb } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentQuery, type HarnessConfig, type QueryFn } from '../src/agents/run-harness.ts'
import { runSourcingAgent, type SourcingRunDeps } from '../src/agents/sourcing-run.ts'
import type { HarvestCandidate } from '../src/sourcing/harvest.ts'
import type { TrendSignal } from '../src/sourcing/trends.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0

/** Trivial pass-through parser: the harness only cares about the success/issues discriminant. */
function passthrough(raw: unknown): { success: true; data: { ok: unknown } } | { success: false; issues: unknown } {
  if (raw !== null && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
    return { success: true, data: { ok: (raw as Record<string, unknown>).ok } }
  }
  return { success: false, issues: [{ code: 'bad' }] }
}

function baseConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    model: 'claude-sonnet-5',
    maxTurns: 5,
    maxBudgetUsd: 1,
    watchdogMs: 60_000,
    systemPrompt: 'test system prompt',
    outputJsonSchema: { type: 'object' },
    tools: [],
    allowedTools: ['mcp__support__*'],
    mcpServers: {},
    persistSession: true,
    alertKinds: { invalidOutput: 'test_output_invalid', runFailed: 'test_run_failed' },
    ...overrides,
  }
}

describe('runAgentQuery (harness-only surface)', () => {
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
      .values({ workflow: `run-harness-test-${Date.now()}-${uid}`, model: 'claude-sonnet-5', status: 'running', triggerRef: tag })
      .returning({ id: agentRuns.id })
    createdRunIds.push(row!.id)
    return row!.id
  }

  function deps(queryFn: QueryFn): { db: typeof db; alert: ReturnType<typeof vi.fn>; queryFn: QueryFn } {
    return { db, alert: vi.fn().mockResolvedValue(undefined), queryFn }
  }

  // --- sawMirrorError ---------------------------------------------------------------------------

  it('sawMirrorError: true when a system/mirror_error message streams (and the run still succeeds)', async () => {
    const runId = await claimRow('mirror-error')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-mirror' }
      yield { type: 'system', subtype: 'mirror_error', error: 'session mirror failed' }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.02, modelUsage: {}, num_turns: 2, session_id: 'sess-mirror', structured_output: { ok: 1 } }
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('succeeded')
    expect(result.sawMirrorError).toBe(true)
    expect(result.failedBeforeFirstAssistant).toBe(false)
    expect(result.sessionId).toBe('sess-mirror')
  })

  it('sawMirrorError: false when no mirror_error message streams', async () => {
    const runId = await claimRow('no-mirror-error')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-clean' }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } } }
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.02, modelUsage: {}, num_turns: 2, session_id: 'sess-clean', structured_output: { ok: 1 } }
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.sawMirrorError).toBe(false)
  })

  // --- failedBeforeFirstAssistant ---------------------------------------------------------------

  it('failedBeforeFirstAssistant: true when the stream throws before any assistant message', async () => {
    const runId = await claimRow('throw-before-assistant')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-x' }
      throw new Error('subprocess died on boot')
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('failed')
    expect(result.failedBeforeFirstAssistant).toBe(true)
    expect(result.costEstimated).toBe(true)
    // No result message ever arrived, so there is no authoritative session id.
    expect(result.sessionId).toBeNull()
    expect(d.alert).toHaveBeenCalledWith('critical', 'test_run_failed', expect.objectContaining({ runId }))
  })

  it('failedBeforeFirstAssistant: false when the stream throws AFTER an assistant message', async () => {
    const runId = await claimRow('throw-after-assistant')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 50 } } }
      throw new Error('stream blew up mid-run')
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('failed')
    expect(result.failedBeforeFirstAssistant).toBe(false)
  })

  it('failedBeforeFirstAssistant: false on success even when no assistant message streamed', async () => {
    const runId = await claimRow('success-no-assistant')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 'sess-y', structured_output: { ok: 2 } }
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('succeeded')
    expect(result.failedBeforeFirstAssistant).toBe(false)
    expect(result.output).toEqual({ ok: 2 })
  })

  it('failedBeforeFirstAssistant: false on an authoritative error result (the subprocess did run)', async () => {
    const runId = await claimRow('authoritative-error')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.7, modelUsage: {}, num_turns: 5, session_id: 'sess-z' }
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('aborted')
    expect(result.failedBeforeFirstAssistant).toBe(false)
    expect(result.sessionId).toBe('sess-z')
  })

  // --- invalid output routes through cfg.alertKinds ----------------------------------------------

  it('schema-invalid structured_output fires cfg.alertKinds.invalidOutput and fails the run', async () => {
    const runId = await claimRow('invalid-output')
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.03, modelUsage: {}, num_turns: 1, session_id: 'sess-i', structured_output: { nope: true } }
    }
    const d = deps(() => stream())

    const result = await runAgentQuery(d, runId, 'hello', baseConfig(), passthrough)

    expect(result.status).toBe('failed')
    expect(result.output).toBeNull()
    expect(d.alert).toHaveBeenCalledWith('critical', 'test_output_invalid', { runId, issues: [{ code: 'bad' }] })

    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
    expect(row!.status).toBe('failed')
  })

  // --- options assembly ---------------------------------------------------------------------------

  it('options: sessionStore forces persistSession true and adds sessionStoreFlush batched; resume passes through', async () => {
    const runId = await claimRow('options-session')
    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 'sess-o', structured_output: { ok: 3 } }
    }
    const sessionStore = { append: vi.fn(), load: vi.fn(), listSubkeys: vi.fn() }
    const d = deps((args) => {
      captured = args.options
      return stream()
    })

    await runAgentQuery(
      d,
      runId,
      'hello',
      // persistSession:false is deliberately overridden by the sessionStore rule.
      baseConfig({ persistSession: false, sessionStore, resume: 'sess-prev', envExtra: { SUPPORT_FLAG: '1' } }),
      passthrough,
    )

    expect(captured!.persistSession).toBe(true)
    expect(captured!.sessionStore).toBe(sessionStore)
    expect(captured!.sessionStoreFlush).toBe('batched')
    expect(captured!.resume).toBe('sess-prev')
    const env = captured!.env as Record<string, string>
    expect(env.MCP_TOOL_TIMEOUT).toBe('60000')
    expect(env.SUPPORT_FLAG).toBe('1')
    // `env` REPLACES the subprocess env — process.env must be spread through it.
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.PATH).toBeTruthy()
  })

  it('options: no sessionStore/resume keys at all when cfg omits them (undefined values would still be keys)', async () => {
    const runId = await claimRow('options-bare')
    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 'sess-b', structured_output: { ok: 4 } }
    }
    const d = deps((args) => {
      captured = args.options
      return stream()
    })

    await runAgentQuery(d, runId, 'hello', baseConfig({ persistSession: false }), passthrough)

    expect(Object.keys(captured!)).not.toContain('sessionStore')
    expect(Object.keys(captured!)).not.toContain('sessionStoreFlush')
    expect(Object.keys(captured!)).not.toContain('resume')
    expect(captured!.persistSession).toBe(false)
  })

  it('envExtra wins over the harness default MCP_TOOL_TIMEOUT', async () => {
    const runId = await claimRow('options-envextra')
    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 'sess-e', structured_output: { ok: 5 } }
    }
    const d = deps((args) => {
      captured = args.options
      return stream()
    })

    await runAgentQuery(d, runId, 'hello', baseConfig({ envExtra: { MCP_TOOL_TIMEOUT: '120000' } }), passthrough)

    expect((captured!.env as Record<string, string>).MCP_TOOL_TIMEOUT).toBe('120000')
  })
})

// -------------------------------------------------------------------------------------------------
// Regression guard for the Task 7 refactor: sourcing's observable options object must not gain a
// single new key from the extraction. `agents-sourcing-run.test.ts` asserts individual option VALUES
// but never the key SET, so an accidental `resume: undefined` / `sessionStoreFlush` leaking into
// sourcing's options would slip past it. This pins the exact key list sourcing passed before the
// harness existed.
// -------------------------------------------------------------------------------------------------
describe('runSourcingAgent options shape is unchanged by the harness extraction', () => {
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

  const SOURCING_OPTION_KEYS = [
    'abortController',
    'allowedTools',
    'env',
    'maxBudgetUsd',
    'maxTurns',
    'mcpServers',
    'model',
    'outputFormat',
    'permissionMode',
    'persistSession',
    'settingSources',
    'systemPrompt',
    'tools',
  ]

  function candidates(): HarvestCandidate[] {
    return [{ supplierProductId: 'cjp-1', title: 'Dog Toy', categoryName: 'Toys', sellPriceCents: 2999, listedNum: 120, imageUrl: 'https://x/y.png', keyword: 'dog toy' }]
  }
  function trendSignals(): TrendSignal[] {
    return [{ keyword: 'dog toy', score: 75, snapshot: {} }]
  }

  it('passes exactly the pre-refactor option keys — no more, no fewer', async () => {
    uid += 1
    const [row] = await db
      .insert(agentRuns)
      .values({ workflow: `run-harness-options-${Date.now()}-${uid}`, model: 'claude-sonnet-5', status: 'running', triggerRef: 'opts' })
      .returning({ id: agentRuns.id })
    createdRunIds.push(row!.id)
    const runId = row!.id

    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's1', structured_output: { winners: [] } }
    }
    const deps: SourcingRunDeps = {
      db,
      alert: vi.fn().mockResolvedValue(undefined),
      mcpServer: {} as unknown as SourcingRunDeps['mcpServer'],
      queryFn: (args) => {
        captured = args.options
        return stream()
      },
    }

    await runSourcingAgent(deps, { runId, candidates: candidates(), trendSignals: trendSignals() })

    expect(Object.keys(captured!).sort()).toEqual(SOURCING_OPTION_KEYS)
  })
})
