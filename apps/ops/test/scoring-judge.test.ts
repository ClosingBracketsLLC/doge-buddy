import { agentRunEvents, agentRuns, createDb } from '@doge-buddy/db'
import { inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  JUDGE_OUTPUT_JSON_SCHEMA,
  SCORING_JUDGE_MAX_BUDGET_USD,
  SCORING_MAX_CONSECUTIVE_SPARES,
  SCORING_MODEL,
  SCORING_WATCHDOG_MS,
  runDeprecationJudge,
  type JudgeCandidate,
} from '../src/scoring/judge.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

function candidates(): JudgeCandidate[] {
  return [
    { productId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Dog Toy', category: 'Toys', unitsSold28d: 0, refundCount28d: 0, daysLive: 40 },
    { productId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Dog Bowl', category: 'Feeding', unitsSold28d: 1, refundCount28d: 3, daysLive: 60 },
  ]
}

describe('runDeprecationJudge (fake SDK stream)', () => {
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

  /** Mirrors sourcing-run.test.ts's `claimRow` — Task 9 (the real caller) inserts this row and
   *  passes `runId` in; here the test stands in for that caller. */
  async function claimRow(): Promise<string> {
    const [row] = await db
      .insert(agentRuns)
      .values({ workflow: 'scoring', model: SCORING_MODEL, status: 'running', triggerRef: null })
      .returning({ id: agentRuns.id })
    createdRunIds.push(row!.id)
    return row!.id
  }

  function deps(queryFn: Parameters<typeof runDeprecationJudge>[0]['queryFn']) {
    return { db, alert: vi.fn().mockResolvedValue(undefined), queryFn }
  }

  it('constants match the spec Global Constraints', () => {
    expect(SCORING_MODEL).toBe('claude-sonnet-5')
    expect(SCORING_JUDGE_MAX_BUDGET_USD).toBe(0.25)
    expect(SCORING_WATCHDOG_MS).toBe(120_000)
    expect(SCORING_MAX_CONSECUTIVE_SPARES).toBe(3)
  })

  it('spare:true for a known candidate -> spared, with its reason recorded', async () => {
    const runId = await claimRow()
    const [c1, c2] = candidates()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        modelUsage: { 'claude-sonnet-5': { costUSD: 0.01 } },
        num_turns: 1,
        session_id: 's1',
        structured_output: {
          spares: [
            { productId: c1!.productId, spare: true, reason: 'recent listing fix, ramping up' },
            { productId: c2!.productId, spare: false, reason: 'genuinely dead, high refunds' },
          ],
        },
      }
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(false)
    expect(result.sparedProductIds.has(c1!.productId)).toBe(true)
    expect(result.reasons.get(c1!.productId)).toBe('recent listing fix, ramping up')
  })

  it('spare:false -> not in sparedProductIds', async () => {
    const runId = await claimRow()
    const [c1, c2] = candidates()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's2',
        structured_output: { spares: [{ productId: c2!.productId, spare: false, reason: 'no' }] },
      }
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(false)
    expect(result.sparedProductIds.has(c2!.productId)).toBe(false)
    expect(result.sparedProductIds.size).toBe(0)
    expect(result.reasons.size).toBe(0)
  })

  it('spare:true for an id NOT in the input candidate set -> ignored (downgrade-only safety core)', async () => {
    const runId = await claimRow()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's3',
        structured_output: { spares: [{ productId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', spare: true, reason: 'injected' }] },
      }
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(false)
    expect(result.sparedProductIds.size).toBe(0)
    expect(result.reasons.size).toBe(0)
  })

  it('a thrown query -> failed:true, empty spares, alert fired, resolves without throwing', async () => {
    const runId = await claimRow()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } } }
      throw new Error('stream blew up')
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(true)
    expect(result.sparedProductIds.size).toBe(0)
    expect(result.reasons.size).toBe(0)
    expect(d.alert).toHaveBeenCalledWith('critical', 'scoring_judge_failed', expect.objectContaining({ runId }))
  })

  it('aborted (budget truncation) query -> failed:true, empty spares', async () => {
    const runId = await claimRow()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } } }
      yield { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 0.25, modelUsage: {}, num_turns: 1, session_id: 's4' }
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(true)
    expect(result.sparedProductIds.size).toBe(0)
  })

  it('schema-invalid structured output (error result) -> failed:true, empty spares, invalidOutput alert', async () => {
    const runId = await claimRow()
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's5',
        structured_output: { spares: [{ bogus: true }] },
      }
    }
    const d = deps(() => stream())

    const result = await runDeprecationJudge({ ...d, runId }, candidates())

    expect(result.failed).toBe(true)
    expect(result.sparedProductIds.size).toBe(0)
    expect(d.alert).toHaveBeenCalledWith('critical', 'scoring_judge_output_invalid', expect.objectContaining({ runId }))
  })

  it('passes the exact single-structured-call options: no tools, maxTurns 1, budget/watchdog/model constants', async () => {
    const runId = await claimRow()
    let captured: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's6', structured_output: { spares: [] } }
    }
    const d = deps((args) => { captured = args.options; return stream() })

    await runDeprecationJudge({ ...d, runId }, candidates())

    expect(captured!.model).toBe(SCORING_MODEL)
    expect(captured!.maxTurns).toBe(1)
    expect(captured!.maxBudgetUsd).toBe(SCORING_JUDGE_MAX_BUDGET_USD)
    expect(captured!.tools).toEqual([])
    expect(captured!.allowedTools).toEqual([])
    expect(captured!.persistSession).toBe(false)
    expect((captured!.outputFormat as { type: string }).type).toBe('json_schema')
  })

  it('system prompt states the downgrade-only rule and the untrusted-data warning', async () => {
    const runId = await claimRow()
    let capturedOptions: Record<string, unknown> | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's7', structured_output: { spares: [] } }
    }
    const d = deps((args) => { capturedOptions = args.options; return stream() })

    await runDeprecationJudge({ ...d, runId }, candidates())

    const systemPrompt = capturedOptions!.systemPrompt as string
    expect(systemPrompt).toContain('UNTRUSTED')
    expect(systemPrompt).toContain('ONLY recommend SPARING')
    expect(systemPrompt).toContain('CANNOT deprecate')
  })

  it('builds the candidate prompt with each productId verbatim', async () => {
    const runId = await claimRow()
    let capturedPrompt: string | undefined
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {}, num_turns: 1, session_id: 's8', structured_output: { spares: [] } }
    }
    const d = deps((args) => { capturedPrompt = args.prompt; return stream() })

    const [c1, c2] = candidates()
    await runDeprecationJudge({ ...d, runId }, candidates())

    expect(capturedPrompt).toContain(c1!.productId)
    expect(capturedPrompt).toContain(c2!.productId)
  })
})

describe('JUDGE_OUTPUT_JSON_SCHEMA', () => {
  it('is a JSON Schema object', () => {
    expect((JUDGE_OUTPUT_JSON_SCHEMA as { type?: string }).type).toBe('object')
  })

  it('targets draft-07 — the SDK validator (ajv) rejects the zod-default draft-2020-12', () => {
    const schema = JUDGE_OUTPUT_JSON_SCHEMA as { $schema?: string }
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(JSON.stringify(schema)).not.toContain('draft/2020-12')
  })

  it('is fully inlined (no $ref) — draft-07 output should not reference $defs', () => {
    expect(JSON.stringify(JUDGE_OUTPUT_JSON_SCHEMA)).not.toContain('$ref')
  })
})
