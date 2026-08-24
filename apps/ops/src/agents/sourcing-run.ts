import { query as sdkQuery, type Options, type createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CATEGORY_TAGS } from '@doge-buddy/core'
import { agentRunEvents, agentRuns, type createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { CLAIM_TERMS, EXCLUDED_CATEGORY_TERMS } from '../sourcing/guards.ts'
import type { HarvestCandidate } from '../sourcing/harvest.ts'
import type { TrendSignal } from '../sourcing/trends.ts'
import { createUsageAccumulator } from './pricing.ts'
import { SOURCING_OUTPUT_JSON_SCHEMA, SourcingOutputSchema, type SourcingOutput } from './output-schema.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

// --- Global Constraints (spec §Stage 3) ------------------------------------------------------
export const SOURCING_MODEL = 'claude-sonnet-5'
export const SOURCING_MAX_TURNS = 25
/** Hard SDK stop-loss (not a ≤ guarantee — the run halts once spend crosses it). */
export const SOURCING_MAX_BUDGET_USD = 2.0
/** Wall-clock watchdog: abort the SDK query after 15 minutes (inside the 60-minute job expiry). */
export const SOURCING_WATCHDOG_MS = 15 * 60 * 1000
/** Freight-inclusive margin floor (bps) stated to the agent; Stage 4 re-enforces the live value. */
export const SOURCING_MARGIN_FLOOR_BPS = 6000

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'aborted'
  output: SourcingOutput | null
  /** Authoritative when a result message arrived, else the streaming accumulator estimate. */
  costUsd: number | null
  costEstimated: boolean
}

export interface SourcingRunDeps {
  db: Db
  alert: Alert
  mcpServer: ReturnType<typeof createSdkMcpServer>
  /** Injection seam. Production passes the SDK's `query`; tests pass an async-generator factory. */
  queryFn?: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>
}

export interface SourcingRunInput {
  runId: string
  candidates: HarvestCandidate[]
  trendSignals: TrendSignal[]
}

/** The shape the streaming cost accumulator consumes off an SDK `type:'assistant'` message. */
interface AssistantMessageLike {
  message: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/** The subset of an SDK `type:'result'` message the runner reads. */
interface ResultMessageLike {
  type: 'result'
  subtype: string
  total_cost_usd?: number
  modelUsage?: unknown
  num_turns?: number
  session_id?: string
  structured_output?: unknown
}

const SYSTEM_PROMPT =
  'You are the sourcing researcher for a US dog-products store. You research demand and competition ' +
  'for a fixed set of candidate products and return up to three ready-to-approve new_listing ' +
  'proposals as structured output. You never take side-effecting actions; plain code validates, ' +
  'prices, and submits everything you return. Use the read-only mcp__sourcing__* tools and web ' +
  'search/fetch to gather evidence. Obey the category-exclusion and disallowed-claims lists absolutely.'

/** numeric columns take a string in drizzle's default mode; keep null as null. */
function toNumericString(n: number | null | undefined): string | null {
  return n == null ? null : String(n)
}

function errorToDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Compact, deterministic prompt per spec §Stage 3: candidates + signals as JSON lines, store
 * context with the freight-inclusive margin formula spelled out, BOTH guard lists verbatim, and a
 * hard "winners ONLY from these candidates" instruction. */
function buildPrompt(input: SourcingRunInput): string {
  const candidateLines = input.candidates.map((c) => JSON.stringify(c)).join('\n')
  const signalLines = input.trendSignals.map((s) => JSON.stringify(s)).join('\n')

  return [
    '## Store context',
    `Category tags (pick exactly one per listing): ${CATEGORY_TAGS.join(', ')}.`,
    'Prices and costs are integer cents. Ships from US only; buyers expect a few-days delivery window.',
    'A winner must clear the freight-inclusive margin floor. For every variant:',
    `  floor((priceCents - supplierCostCents - freightCents) * 10000 / priceCents) >= ${SOURCING_MARGIN_FLOOR_BPS} bps.`,
    'Get freightCents from your quote_freight calls. Plain code re-checks this exactly — do not guess.',
    '',
    '## Candidates (pick winners ONLY from these — never invent or substitute a product)',
    candidateLines || '(none)',
    '',
    '## Trend signals',
    signalLines || '(none — trends data may be unavailable; use web search instead)',
    '',
    '## Excluded categories (NEVER propose anything matching these terms)',
    EXCLUDED_CATEGORY_TERMS.join(', '),
    '',
    '## Disallowed claims (NEVER use these phrases in any copy)',
    CLAIM_TERMS.join(', '),
    '',
    '## Task',
    'Research demand and competition for the candidates using the available tools, then return up to',
    'THREE winners in the required structured output. Each winner is a complete new_listing payload',
    'draft plus rationale, marginPct, and freightEstimateCents (from your quote_freight calls).',
    'Return zero winners rather than a weak or non-compliant one.',
  ].join('\n')
}

/**
 * Stage 3 runner (spec §Stage 3). The `agent_runs` row is ALREADY claimed (Task 11) — this UPDATES
 * it. Streams every SDK message to `agent_run_events`, accumulates a running cost estimate, and on
 * the (authoritative) result message overwrites the row's cost/usage and flips status. If no result
 * message arrives (throw or watchdog abort) the row records the accumulator estimate instead. This
 * function NEVER throws — it always resolves to an AgentRunResult.
 */
export async function runSourcingAgent(deps: SourcingRunDeps, input: SourcingRunInput): Promise<AgentRunResult> {
  const { db, alert } = deps
  const { runId } = input
  const accumulator = createUsageAccumulator()

  // Watchdog: caller's immediate abort signal (sdk.d.ts `Options.abortController`).
  const abortController = new AbortController()
  let watchdogAborted = false
  const watchdog = setTimeout(() => {
    watchdogAborted = true
    abortController.abort()
  }, SOURCING_WATCHDOG_MS)

  const runQuery: NonNullable<SourcingRunDeps['queryFn']> =
    deps.queryFn ?? ((args) => sdkQuery({ prompt: args.prompt, options: args.options as Options }))

  const options = {
    model: SOURCING_MODEL,
    maxTurns: SOURCING_MAX_TURNS,
    maxBudgetUsd: SOURCING_MAX_BUDGET_USD,
    settingSources: [],
    permissionMode: 'dontAsk',
    // The availability layer: NEVER [] — that would strip WebSearch/WebFetch and allowedTools cannot
    // restore availability. MCP tools come from mcpServers and are unaffected by this list.
    tools: ['WebSearch', 'WebFetch'],
    allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch'],
    persistSession: false,
    systemPrompt: SYSTEM_PROMPT,
    // `env` REPLACES the subprocess env entirely — spread process.env so PATH/HOME/API key survive.
    env: { ...process.env, MCP_TOOL_TIMEOUT: '60000' },
    mcpServers: { sourcing: deps.mcpServer },
    outputFormat: { type: 'json_schema', schema: SOURCING_OUTPUT_JSON_SCHEMA },
    abortController,
  }

  let resultMsg: ResultMessageLike | undefined
  let thrownError: unknown

  try {
    const stream = runQuery({ prompt: buildPrompt(input), options })
    let seq = 0
    for await (const message of stream) {
      await db.insert(agentRunEvents).values({ runId, seq, message })
      seq += 1

      if (message.type === 'assistant') {
        accumulator.add(message as unknown as AssistantMessageLike)
      }

      // Every 5 events, persist the streaming lower-bound estimate (best-effort — a transient DB
      // hiccup mid-stream must not kill the run).
      if (seq % 5 === 0) {
        await db
          .update(agentRuns)
          .set({ totalCostUsd: toNumericString(accumulator.tally().estimatedCostUsd) })
          .where(eq(agentRuns.id, runId))
          .catch(() => {})
      }

      if (message.type === 'result') {
        resultMsg = message as unknown as ResultMessageLike
      }
    }
  } catch (err) {
    thrownError = err
  } finally {
    clearTimeout(watchdog)
  }

  // --- Authoritative path: a result message arrived ------------------------------------------
  if (resultMsg) {
    try {
      const finishedAt = new Date()
      if (resultMsg.subtype === 'success') {
        const parsed = SourcingOutputSchema.safeParse(resultMsg.structured_output)
        if (parsed.success) {
          await db
            .update(agentRuns)
            .set({
              status: 'succeeded',
              totalCostUsd: toNumericString(resultMsg.total_cost_usd),
              modelUsage: resultMsg.modelUsage ?? null,
              numTurns: resultMsg.num_turns ?? null,
              sessionId: resultMsg.session_id ?? null,
              finishedAt,
            })
            .where(eq(agentRuns.id, runId))
          return { status: 'succeeded', output: parsed.data, costUsd: resultMsg.total_cost_usd ?? null, costEstimated: false }
        }
        // A schema-invalid structured_output is a FAILED run, not a throw.
        await db
          .update(agentRuns)
          .set({
            status: 'failed',
            totalCostUsd: toNumericString(resultMsg.total_cost_usd),
            modelUsage: resultMsg.modelUsage ?? null,
            numTurns: resultMsg.num_turns ?? null,
            sessionId: resultMsg.session_id ?? null,
            finishedAt,
          })
          .where(eq(agentRuns.id, runId))
        await alert('critical', 'sourcing_output_invalid', { runId, issues: parsed.error.issues }).catch(() => {})
        return { status: 'failed', output: null, costUsd: resultMsg.total_cost_usd ?? null, costEstimated: false }
      }

      // Error result subtypes. Budget/turn truncation is an 'aborted' run; anything else 'failed'.
      const status: AgentRunResult['status'] =
        resultMsg.subtype === 'error_max_budget_usd' || resultMsg.subtype === 'error_max_turns' ? 'aborted' : 'failed'
      await db
        .update(agentRuns)
        .set({
          status,
          totalCostUsd: toNumericString(resultMsg.total_cost_usd),
          modelUsage: resultMsg.modelUsage ?? null,
          numTurns: resultMsg.num_turns ?? null,
          sessionId: resultMsg.session_id ?? null,
          finishedAt,
        })
        .where(eq(agentRuns.id, runId))
      return { status, output: null, costUsd: resultMsg.total_cost_usd ?? null, costEstimated: false }
    } catch (err) {
      // A DB failure while recording an authoritative result degrades to the estimate path below.
      thrownError = err
    }
  }

  // --- Fallback path: no authoritative record was written ------------------------------------
  // Two ways in: (1) no result message at all — a true throw / watchdog abort before any result —
  // so the streaming accumulator ESTIMATE is the best cost we have; or (2) a result message DID
  // arrive but its authoritative UPDATE above threw — in which case resultMsg.total_cost_usd /
  // modelUsage are still in scope and known-accurate, so prefer them over the estimate. Both
  // branches stay .catch-guarded so this path never throws.
  const tally = accumulator.tally()
  const status: AgentRunResult['status'] = watchdogAborted ? 'aborted' : 'failed'
  const costUsd = resultMsg ? (resultMsg.total_cost_usd ?? null) : tally.estimatedCostUsd
  const costEstimated = resultMsg === undefined
  const modelUsage = resultMsg ? (resultMsg.modelUsage ?? null) : { ...tally.perModel, estimated: true }
  await db
    .update(agentRuns)
    .set({
      status,
      totalCostUsd: toNumericString(costUsd),
      modelUsage,
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId))
    .catch(() => {})
  await alert('critical', 'sourcing_run_failed', { runId, error: errorToDetail(thrownError) }).catch(() => {})
  return { status, output: null, costUsd, costEstimated }
}
