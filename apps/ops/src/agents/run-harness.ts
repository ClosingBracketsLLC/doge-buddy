import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk'
import { agentRunEvents, agentRuns, type createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { createUsageAccumulator } from './pricing.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Injection seam shared by every agent runner. Production passes the SDK's `query`; tests pass an
 * async-generator factory. Structurally identical to `SourcingRunDeps['queryFn']` (which is now
 * declared as this type), so `NonNullable<SourcingRunDeps['queryFn']>` and `QueryFn` are the same
 * type — Tasks 10/11 use this name.
 */
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>

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

export interface HarnessConfig {
  model: string
  maxTurns: number
  maxBudgetUsd: number
  watchdogMs: number
  systemPrompt: string
  outputJsonSchema: object
  /** The tool AVAILABILITY layer — sourcing: ['WebSearch','WebFetch']; support: []. */
  tools: string[]
  allowedTools: string[]
  mcpServers: Record<string, unknown>
  /** Merged over `{ ...process.env, MCP_TOOL_TIMEOUT: '60000' }` (so it can override that default). */
  envExtra?: Record<string, string>
  resume?: string
  /** SDK `SessionStore`. When set, `persistSession: true` is forced (the SDK requires local writes). */
  sessionStore?: unknown
  /** sourcing: false (today's behavior); support: true. Ignored when `sessionStore` is set. */
  persistSession: boolean
  alertKinds: { invalidOutput: string; runFailed: string }
}

export interface HarnessResult<T> {
  status: 'succeeded' | 'failed' | 'aborted'
  output: T | null
  /** Authoritative when a result message arrived, else the streaming accumulator estimate. */
  costUsd: number | null
  costEstimated: boolean
  /** The result message's `session_id`; null when no result message arrived. */
  sessionId: string | null
  /** A `type:'system'` message with `subtype:'mirror_error'` streamed at some point in the run. */
  sawMirrorError: boolean
  /** True when the throw/abort happened before ANY `type:'assistant'` message streamed. */
  failedBeforeFirstAssistant: boolean
}

/** Convenience alias for the inline `deps` parameter type of {@link runAgentQuery}. */
export interface HarnessDeps {
  db: Db
  alert: Alert
  queryFn?: QueryFn
}

/** numeric columns take a string in drizzle's default mode; keep null as null. */
function toNumericString(n: number | null | undefined): string | null {
  return n == null ? null : String(n)
}

function errorToDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Shared agent-run harness (extracted verbatim from Phase 5's `runSourcingAgent`). The `agent_runs`
 * row is ALREADY claimed by the caller — this UPDATES it. Streams every SDK message to
 * `agent_run_events`, accumulates a running cost estimate, and on the (authoritative) result message
 * overwrites the row's cost/usage and flips status. If no result message arrives (throw or watchdog
 * abort) the row records the accumulator estimate instead. This function NEVER throws — it always
 * resolves to a HarnessResult.
 */
export async function runAgentQuery<T>(
  deps: { db: Db; alert: Alert; queryFn?: QueryFn },
  runId: string,
  prompt: string,
  cfg: HarnessConfig,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; issues: unknown },
): Promise<HarnessResult<T>> {
  const { db, alert } = deps
  const accumulator = createUsageAccumulator()

  // Watchdog: caller's immediate abort signal (sdk.d.ts `Options.abortController`).
  const abortController = new AbortController()
  let watchdogAborted = false
  const watchdog = setTimeout(() => {
    watchdogAborted = true
    abortController.abort()
  }, cfg.watchdogMs)

  const runQuery: QueryFn = deps.queryFn ?? ((args) => sdkQuery({ prompt: args.prompt, options: args.options as Options }))

  // `sessionStore` requires local session writes, so it forces `persistSession: true`.
  const hasSessionStore = cfg.sessionStore != null

  // Keys are assembled conditionally, never as `undefined` values: a caller that omits
  // `sessionStore`/`resume` must see EXACTLY the pre-refactor option key set (guarded by
  // test/run-harness.test.ts's sourcing options-shape test).
  const options = {
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    maxBudgetUsd: cfg.maxBudgetUsd,
    settingSources: [],
    permissionMode: 'dontAsk',
    // The availability layer: for sourcing NEVER [] — that would strip WebSearch/WebFetch and
    // allowedTools cannot restore availability. MCP tools come from mcpServers and are unaffected
    // by this list.
    tools: cfg.tools,
    allowedTools: cfg.allowedTools,
    persistSession: hasSessionStore ? true : cfg.persistSession,
    systemPrompt: cfg.systemPrompt,
    // `env` REPLACES the subprocess env entirely — spread process.env so PATH/HOME/API key survive.
    env: { ...process.env, MCP_TOOL_TIMEOUT: '60000', ...cfg.envExtra },
    mcpServers: cfg.mcpServers,
    outputFormat: { type: 'json_schema', schema: cfg.outputJsonSchema },
    abortController,
    ...(hasSessionStore ? { sessionStore: cfg.sessionStore, sessionStoreFlush: 'batched' } : {}),
    ...(cfg.resume === undefined ? {} : { resume: cfg.resume }),
  }

  let resultMsg: ResultMessageLike | undefined
  let thrownError: unknown
  let sawMirrorError = false
  let sawAssistant = false

  try {
    const stream = runQuery({ prompt, options })
    let seq = 0
    for await (const message of stream) {
      await db.insert(agentRunEvents).values({ runId, seq, message })
      seq += 1

      if (message.type === 'assistant') {
        sawAssistant = true
        accumulator.add(message as unknown as AssistantMessageLike)
      }

      if (message.type === 'system' && message.subtype === 'mirror_error') {
        sawMirrorError = true
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
      const sessionId = resultMsg.session_id ?? null
      if (resultMsg.subtype === 'success') {
        const parsed = parse(resultMsg.structured_output)
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
          return {
            status: 'succeeded',
            output: parsed.data,
            costUsd: resultMsg.total_cost_usd ?? null,
            costEstimated: false,
            sessionId,
            sawMirrorError,
            failedBeforeFirstAssistant: false,
          }
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
        await alert('critical', cfg.alertKinds.invalidOutput, { runId, issues: parsed.issues }).catch(() => {})
        return {
          status: 'failed',
          output: null,
          costUsd: resultMsg.total_cost_usd ?? null,
          costEstimated: false,
          sessionId,
          sawMirrorError,
          failedBeforeFirstAssistant: false,
        }
      }

      // Error result subtypes. Budget/turn truncation is an 'aborted' run; anything else 'failed'.
      const status: HarnessResult<T>['status'] =
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
      return {
        status,
        output: null,
        costUsd: resultMsg.total_cost_usd ?? null,
        costEstimated: false,
        sessionId,
        sawMirrorError,
        failedBeforeFirstAssistant: false,
      }
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
  const status: HarnessResult<T>['status'] = watchdogAborted ? 'aborted' : 'failed'
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
  await alert('critical', cfg.alertKinds.runFailed, { runId, error: errorToDetail(thrownError) }).catch(() => {})
  return {
    status,
    output: null,
    costUsd,
    costEstimated,
    sessionId: resultMsg?.session_id ?? null,
    sawMirrorError,
    // Only a run that produced NO result message can be "failed before the first assistant" — a
    // result message means the subprocess ran to completion and it was the DB write that threw.
    failedBeforeFirstAssistant: resultMsg === undefined && !sawAssistant,
  }
}
