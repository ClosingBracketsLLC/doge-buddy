import { type createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { CATEGORIES, CATEGORY_TAGS } from '@doge-buddy/core'
import { type createDb } from '@doge-buddy/db'
import { CLAIM_TERMS, EXCLUDED_CATEGORY_TERMS } from '../sourcing/guards.ts'
import type { HarvestCandidate } from '../sourcing/harvest.ts'
import type { SourcingKnobs } from '../sourcing/knobs.ts'
import type { TrendSignal } from '../sourcing/trends.ts'
import { DEFAULT_MAX_PRICE_TO_MARKET_BPS } from '../sourcing/market-price.ts'
import { runAgentQuery, type QueryFn } from './run-harness.ts'
import { DEFAULT_MAX_WINNERS, sourcingOutputJsonSchema, sourcingOutputSchema, type SourcingOutput } from './output-schema.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

// --- Global Constraints (spec §Stage 3) ------------------------------------------------------
export const SOURCING_MODEL = 'claude-sonnet-5'
export const SOURCING_MAX_TURNS = 30
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
  /**
   * Resolved catalog-build knobs for this run (`sourcing/knobs.ts`). Only `maxWinners` and
   * `maxBudgetUsd` reach the agent; the harvest knobs are already spent by the time we get here.
   * Optional: absent means the module constants, i.e. exactly the pre-knobs behaviour.
   */
  knobs?: SourcingKnobs
  /** True when the market-price tool is registered this run (SERPAPI_KEY configured) — picks the
   *  armed prompt wording. Absent/false = unarmed = advisory sentence only. */
  marketGateArmed?: boolean
}

const buildSystemPrompt = (maxWinners: number, marketGateArmed: boolean): string => {
  const basePrompt =
    'You are the sourcing researcher for a US dog-products store. You research demand and competition ' +
    `for a fixed set of candidate products and return up to ${maxWinners} ready-to-approve new_listing ` +
    'proposals as structured output. You never take side-effecting actions; plain code validates, ' +
    'prices, and submits everything you return, and re-verifies every number against the supplier — ' +
    'so propose real candidates confidently; the downstream gate catches anything that does not hold up. ' +
    'You MUST use the read-only mcp__sourcing__* tools before you output: the candidate list gives you ' +
    'only a title, a rough price, and a category — you cannot build a complete new_listing payload ' +
    '(real variants, SKUs, supplier costs, description, image URLs, US stock, freight) without calling ' +
    'get_product_detail, get_stock, and quote_freight on the candidates you are evaluating.'
  const marketSentence = marketGateArmed
    ? ' When the lookup_market_price tool is available you MUST call it for every winner and carry its lookupId.'
    : ''
  return (
    basePrompt +
    marketSentence +
    ' Calling the StructuredOutput tool ENDS your run, so never call it until you have actually researched. Obey the ' +
    'category-exclusion and disallowed-claims lists absolutely.'
  )
}

/** Compact, deterministic prompt per spec §Stage 3: candidates + signals as JSON lines, store
 * context with the freight-inclusive margin formula spelled out, BOTH guard lists verbatim, and a
 * hard "winners ONLY from these candidates" instruction. */
function buildPrompt(input: SourcingRunInput, maxWinners: number): string {
  const candidateLines = input.candidates.map((c) => JSON.stringify(c)).join('\n')
  const signalLines = input.trendSignals.map((s) => JSON.stringify(s)).join('\n')

  const bps = input.knobs?.maxPriceToMarketBps ?? DEFAULT_MAX_PRICE_TO_MARKET_BPS
  const ratio = String(bps / 10_000)
  const exampleCeiling = (Math.floor(2499 * bps / 10_000) / 100).toFixed(2)
  const marketSection = input.marketGateArmed
    ? [
        '## Market price — HARD RULE',
        'For every winner call lookup_market_price with a generic US-shopper query for that product',
        '(e.g. "orthopedic dog bed large", never a CJ title) and set the winner\'s marketLookupId to the',
        `returned id (same supplierProductId). Plain code enforces: the median of your variant prices`,
        `must be <= ${ratio}× the market median (e.g. market $24.99 → ceiling $${exampleCeiling}). A lookup with`,
        'fewer than 5 offers is inconclusive — broaden the query once. Winners with no conclusive lookup,',
        'a lookup for a different product, or a price above the ceiling are dropped. Price TOWARD the',
        "market median when the margin floor allows: don't overprice, don't leave money on the table.",
      ]
    : [
        '## Market price',
        'Market price lookup is unavailable this run (no SerpApi). Use web search to sanity-check',
        'pricing; this is advisory only — the price-to-market gate is skipped.',
      ]

  return [
    '## Store context',
    `Category tags (pick exactly one per listing): ${CATEGORY_TAGS.join(', ')}.`,
    `categoryTag must be one of ${CATEGORIES.map((c) => c.tag).join('|')} (the store's CATEGORIES); match the keyword's intent when obvious.`,
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
    'descriptionHtml, not in highlights, specs, or whatsInBox, and not in your rationale (ALL of',
    'these are scanned; a single occurrence, case-insensitive, discards the ENTIRE winner):',
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
    ...marketSection,
    '',
    '## Task',
    'Work the candidates in this order — do NOT skip straight to output:',
    `1. Pick your ~${maxWinners}-${maxWinners + 2} most promising candidates from the list above (best demand signal, price band`,
    '   that can clear the margin floor, not in an excluded category).',
    '2. For EACH, call get_product_detail (variants, supplier costs, description, images), get_stock',
    '   (confirm real US warehouse stock), and quote_freight (US shipping cost + days). Use get_reviews',
    '   and web search to judge demand and competition. You cannot fill in a valid payload without this.',
    '3. Build a complete new_listing payload for each candidate that clears the margin floor: one',
    '   categoryTag, real variants with SKUs/priceCents/supplierCostCents from the detail call, at',
    "   LEAST 3 http(s) imageUrls from the detail call, each variant's imageUrl copied from that",
    "   variant's variantImage in get_product_detail (omit it for variants CJ shows no image for),",
    '   3-5 factual `highlights` bullets (what the item IS: material, size, cleaning, use), a',
    '   `specs` table as [{label, value}] rows from CJ detail data (size/material/weight), an',
    '   optional one-line `whatsInBox`, US-appropriate delivery days, and clean marketing copy',
    '   (no disallowed claims).',
    `4. Return up to ${maxWinners} winners in the required structured output, each with rationale, marginPct,`,
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
  // No knobs resolved (existing callers/tests) => the module constants, i.e. today's behaviour.
  const maxWinners = input.knobs?.maxWinners ?? DEFAULT_MAX_WINNERS
  const maxBudgetUsd = input.knobs?.maxBudgetUsd ?? SOURCING_MAX_BUDGET_USD
  const outputSchema = sourcingOutputSchema(maxWinners)

  const result = await runAgentQuery<SourcingOutput>(
    { db: deps.db, alert: deps.alert, queryFn: deps.queryFn },
    input.runId,
    buildPrompt(input, maxWinners),
    {
      model: SOURCING_MODEL,
      maxTurns: SOURCING_MAX_TURNS,
      maxBudgetUsd,
      watchdogMs: SOURCING_WATCHDOG_MS,
      systemPrompt: buildSystemPrompt(maxWinners, input.marketGateArmed ?? false),
      outputJsonSchema: sourcingOutputJsonSchema(maxWinners),
      // The availability layer: NEVER [] — that would strip WebSearch/WebFetch and allowedTools
      // cannot restore availability. MCP tools come from mcpServers and are unaffected by this list.
      tools: ['WebSearch', 'WebFetch'],
      allowedTools: ['mcp__sourcing__*', 'WebSearch', 'WebFetch'],
      mcpServers: { sourcing: deps.mcpServer },
      persistSession: false,
      alertKinds: { invalidOutput: 'sourcing_output_invalid', runFailed: 'sourcing_run_failed' },
    },
    (raw) => {
      const parsed = outputSchema.safeParse(raw)
      return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues }
    },
  )

  // Re-projected onto AgentRunResult's four fields rather than returned wholesale: sourcing's public
  // result shape must not silently grow the harness's new sessionId / sawMirrorError /
  // failedBeforeFirstAssistant fields.
  return { status: result.status, output: result.output, costUsd: result.costUsd, costEstimated: result.costEstimated }
}
