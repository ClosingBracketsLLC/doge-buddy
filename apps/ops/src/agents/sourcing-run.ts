import { type createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CATEGORY_TAGS } from '@doge-buddy/core'
import { type createDb } from '@doge-buddy/db'
import { CLAIM_TERMS, EXCLUDED_CATEGORY_TERMS } from '../sourcing/guards.ts'
import type { HarvestCandidate } from '../sourcing/harvest.ts'
import type { TrendSignal } from '../sourcing/trends.ts'
import { runAgentQuery, type QueryFn } from './run-harness.ts'
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
  queryFn?: QueryFn
}

export interface SourcingRunInput {
  runId: string
  candidates: HarvestCandidate[]
  trendSignals: TrendSignal[]
}

const SYSTEM_PROMPT =
  'You are the sourcing researcher for a US dog-products store. You research demand and competition ' +
  'for a fixed set of candidate products and return up to three ready-to-approve new_listing ' +
  'proposals as structured output. You never take side-effecting actions; plain code validates, ' +
  'prices, and submits everything you return, and re-verifies every number against the supplier — ' +
  'so propose real candidates confidently; the downstream gate catches anything that does not hold up. ' +
  'You MUST use the read-only mcp__sourcing__* tools before you output: the candidate list gives you ' +
  'only a title, a rough price, and a category — you cannot build a complete new_listing payload ' +
  '(real variants, SKUs, supplier costs, description, image URLs, US stock, freight) without calling ' +
  'get_product_detail, get_stock, and quote_freight on the candidates you are evaluating. Calling the ' +
  'StructuredOutput tool ENDS your run, so never call it until you have actually researched. Obey the ' +
  'category-exclusion and disallowed-claims lists absolutely.'

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
    '## Disallowed claims — HARD RULE',
    'These exact words/phrases must NOT appear ANYWHERE in a winner — not in title, not in',
    'descriptionHtml, and not in your rationale (all three are scanned; a single occurrence,',
    'case-insensitive, discards the ENTIRE winner):',
    CLAIM_TERMS.join(', '),
    'Dog products are accessories and gear, not treatments — describe what the item IS and DOES',
    '(durable, non-slip, easy to clean, 60cm, machine-washable), never a health/therapeutic benefit.',
    'Before you output, re-read every title, description, and rationale and remove any of these terms.',
    '',
    '## US stock — HARD RULE',
    'Every variant you propose MUST show a US warehouse row with quantity >= 1 in its get_stock',
    'result. A variant whose get_stock returns only CN (or any non-US) rows is DISQUALIFIED, no',
    'matter how good its freight quote looks — quote_freight returns US shipping options even for',
    'CN-only variants, so a freight quote is NOT evidence of US stock. Plain code re-checks the US',
    'stock row exactly and silently drops any winner without one: pick a different variant of the',
    'same product that does have US stock, or a different candidate.',
    '',
    '## Task',
    'Work the candidates in this order — do NOT skip straight to output:',
    '1. Pick your ~3-5 most promising candidates from the list above (best demand signal, price band',
    '   that can clear the margin floor, not in an excluded category).',
    '2. For EACH, call get_product_detail (variants, supplier costs, description, images), get_stock',
    '   (confirm real US warehouse stock), and quote_freight (US shipping cost + days). Use get_reviews',
    '   and web search to judge demand and competition. You cannot fill in a valid payload without this.',
    '3. Build a complete new_listing payload for each candidate that clears the margin floor: one',
    '   categoryTag, real variants with SKUs/priceCents/supplierCostCents from the detail call, an',
    "   http(s) image URL, US-appropriate delivery days, and clean marketing copy (no disallowed claims).",
    '4. Return up to THREE winners in the required structured output, each with rationale, marginPct,',
    '   and freightEstimateCents (from your quote_freight call).',
    '',
    'Do NOT return zero winners without first calling get_product_detail on at least your top three',
    'candidates — an empty result is only acceptable AFTER genuine investigation shows none can clear',
    'the margin floor or all fall in an excluded category. Prefer proposing a real, verified candidate:',
    'plain code re-verifies every number against the supplier and drops anything that does not hold up,',
    'so a borderline-but-real winner is far better than an empty result.',
  ].join('\n')
}

/**
 * Stage 3 runner (spec §Stage 3). A thin consumer of the shared `runAgentQuery` harness
 * (`run-harness.ts`), which owns everything this function used to do inline: the `agent_runs` row is
 * ALREADY claimed (Task 11) and this UPDATES it; every SDK message is streamed to
 * `agent_run_events`; a running cost estimate is accumulated and checkpointed every 5 events; and on
 * the (authoritative) result message the row's cost/usage is overwritten and status flipped. If no
 * result message arrives (throw or watchdog abort) the row records the accumulator estimate instead.
 * This function NEVER throws — it always resolves to an AgentRunResult.
 *
 * Sourcing passes `persistSession: false` and NO sessionStore/resume/envExtra, so the harness
 * assembles exactly the SDK options object (same keys, same values) this runner passed inline before
 * the Phase 6B extraction.
 */
export async function runSourcingAgent(deps: SourcingRunDeps, input: SourcingRunInput): Promise<AgentRunResult> {
  const result = await runAgentQuery<SourcingOutput>(
    { db: deps.db, alert: deps.alert, queryFn: deps.queryFn },
    input.runId,
    buildPrompt(input),
    {
      model: SOURCING_MODEL,
      maxTurns: SOURCING_MAX_TURNS,
      maxBudgetUsd: SOURCING_MAX_BUDGET_USD,
      watchdogMs: SOURCING_WATCHDOG_MS,
      systemPrompt: SYSTEM_PROMPT,
      outputJsonSchema: SOURCING_OUTPUT_JSON_SCHEMA,
      // The availability layer: NEVER [] — that would strip WebSearch/WebFetch and allowedTools
      // cannot restore availability. MCP tools come from mcpServers and are unaffected by this list.
      tools: ['WebSearch', 'WebFetch'],
      allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch'],
      mcpServers: { sourcing: deps.mcpServer },
      persistSession: false,
      alertKinds: { invalidOutput: 'sourcing_output_invalid', runFailed: 'sourcing_run_failed' },
    },
    (raw) => {
      const parsed = SourcingOutputSchema.safeParse(raw)
      return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues }
    },
  )

  // Re-projected onto AgentRunResult's four fields rather than returned wholesale: sourcing's public
  // result shape must not silently grow the harness's new sessionId / sawMirrorError /
  // failedBeforeFirstAssistant fields.
  return { status: result.status, output: result.output, costUsd: result.costUsd, costEstimated: result.costEstimated }
}
