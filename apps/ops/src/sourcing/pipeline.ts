import { agentRuns, auditLog, sourcingSignals, type createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import { claimDailyRun } from '../agents/lifecycle.ts'
import { createSourcingMcpServer } from '../agents/mcp-tools.ts'
import { PointsAllowance } from '../agents/points.ts'
import { runSourcingAgent, SOURCING_MODEL, type SourcingRunDeps } from '../agents/sourcing-run.ts'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { SubmitProposalDeps } from '../proposals/submit.ts'
import { submitProposal } from '../proposals/submit.ts'
import type { Settings } from '../settings.ts'
import { ReviewsSeen } from './decision-context.ts'
import type { DemandProbeProvider } from './demand-probe.ts'
import { MIN_CANDIDATES, runHarvest } from './harvest.ts'
import { expandKeywords } from './keyword-expansion.ts'
import { resolveSourcingKnobs, type SourcingOverrides } from './knobs.ts'
import { MarketLookups, type MarketLookup, type MarketPriceProvider } from './market-price.ts'
import { validateAndSubmitWinners } from './submit-winners.ts'
import type { TrendSignal, TrendsProvider } from './trends.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type Enqueue = (name: string, data: object, opts?: SendOpts) => Promise<void>

export interface SourcingProviders {
  trends: TrendsProvider | null
  marketPrice: MarketPriceProvider | null
  demand: DemandProbeProvider | null
}

export interface SourcingPipelineDeps {
  db: Db
  adapter: SupplierAdapter
  settings: Settings
  alert: Alert
  enqueue: Enqueue
  notify: NotifyOwner
  adminBaseUrl?: string
  /**
   * Produces FRESH providers per pipeline run (both null when SERPAPI_KEY is absent — trends stage
   * skipped per spec §Stage 2, market gate skipped per market-price spec Decision 5). A factory,
   * not instances, for the same reason trendsFactory was (Phase 5 FIX C2): both providers share
   * ONE SerpApiClient whose per-run request cap never resets — composition roots build
   * client + both providers fresh inside this factory so every run starts with a zero counter.
   */
  providersFactory: () => SourcingProviders
  /** Test seam, threaded straight through to `runSourcingAgent`. */
  queryFn?: SourcingRunDeps['queryFn']
  /** Bypasses the same-day circuit breaker (`claimDailyRun`) — `--force` on the manual script. */
  force?: boolean
  /**
   * Per-run catalog-build knob overrides (spec 2026-08-31 catalog-p0 §5) — the manual
   * `run-sourcing` script's flags. The Monday cron NEVER passes these, so it keeps running on the
   * settings (whose defaults are the old constants).
   */
  overrides?: SourcingOverrides
}

/** The `agent_runs.workflow` value this pipeline claims/runs under — shared with the dashboard's
 * `sourcingLastRun` health-strip loader (`http/admin/health.ts`) so both sides name the same
 * workflow string exactly once. */
export const SOURCING_WORKFLOW = 'sourcing.weekly'

export interface SourcingPipelineResult {
  runId: string | null
  outcome: 'refused' | 'no_candidates' | 'agent_failed' | 'completed'
  submitted: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Task 14: the whole `sourcing.weekly` workflow, one call. Composes every prior Phase 5 stage in
 * the spec's normative order — this function has no domain logic of its own, only the wiring and
 * the two documented short-circuits (refused / no_candidates).
 *
 * THROWS in exactly one place: Stage 0's `resolveSourcingKnobs`, on an out-of-range or unparseable
 * knob (a `sourcing.*` setting outside `SOURCING_KNOB_RANGES`, or a > 8 keyword override). That is
 * NOT an exotic failure — an owner typo on `/admin/settings` is normal operation — so the throw is
 * deliberate and loud, and it happens before the day is claimed: the cron's
 * `jobs/sourcing-weekly.ts` catch turns it into a `critical` `sourcing_run_failed` alert with NO
 * `agent_runs` row created and the day's slot untouched, and `scripts/run-sourcing.ts` prints
 * `run-sourcing: FAILED — <the knob message>` and exits 1. Both name the offending knob and source.
 *
 * Past Stage 0, every failure mode is a clean return, never a throw (Decision 10 for the refusal
 * path; the agent runner and submit-winners are already internally throw-free by construction) —
 * the only other way out through `throw` is the belt below re-raising a genuinely unexpected
 * stage error (a transient DB/trends failure) after flipping the claimed row terminal.
 */
export async function runSourcingPipeline(deps: SourcingPipelineDeps): Promise<SourcingPipelineResult> {
  const { db, adapter, settings, alert, enqueue, notify, adminBaseUrl, providersFactory, queryFn, force, overrides } = deps

  // --- Stage 0: resolve the run's knobs (override > setting > constant), ONCE ------------------
  // Deliberately BEFORE the day-claim: an out-of-range override or setting throws, and a knob
  // mistake must not burn the day's run slot on a run that never started.
  const knobs = await resolveSourcingKnobs(settings, overrides)

  // --- Stage 1: claim the day's run (Task 11's atomic breaker) --------------------------------
  const claim = await claimDailyRun(db, alert, {
    workflow: SOURCING_WORKFLOW,
    model: SOURCING_MODEL,
    triggerRef: force ? 'manual' : 'cron',
    force,
  })
  if (!claim.claimed) {
    await alert('info', 'sourcing_run_refused', { existingRunId: claim.existingRunId }).catch(() => {})
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'sourcing.run_refused',
      entityType: 'agent_run',
      entityId: claim.existingRunId,
      detail: { existingRunId: claim.existingRunId },
    })
    // Decision 10: a refusal is a clean no-op, never a throw — the job simply did nothing today.
    return { runId: null, outcome: 'refused', submitted: 0 }
  }
  const { runId } = claim

  // Everything past the claim is wrapped so a throw OUTSIDE the agent runner (harvest's db.insert on
  // a transient DB error, the trends insert, etc.) can't leave the claimed row stuck 'running' for
  // up to ~7 days with no `agent_run_orphaned` alert — the belt for stages the runner's own internal
  // try/finally (Task 12) doesn't cover (FIX C1/C4b). The runner already sets its own terminal
  // status; the guarded UPDATE below (`where status = 'running'`) is a no-op when it did, so we
  // never double-flip a succeeded/failed/aborted row.
  try {
    // Construct FRESH providers per run (FIX C2) so their shared per-run SerpApi request counter
    // resets. Moved up (was Stage 3) so Stage 1b below can use `trends` before harvest runs.
    const { trends, marketPrice, demand } = providersFactory()

    // --- Stage 1b: keyword expansion (spec 2026-09-03 Decisions 1-4) — best-effort, never blocks.
    // Base keywords always survive; expansion only appends. Persist/alert failures must not cost
    // the run its expanded keywords (same stance as persistMarketLookups).
    let runKeywords: readonly string[] = knobs.keywords
    if (trends) {
      const expansion = await expandKeywords(trends, knobs.keywords)
      runKeywords = expansion.keywords
      if (expansion.kept.length > 0) {
        try {
          await db.insert(sourcingSignals).values(
            expansion.kept.map((k) => ({
              source: 'trends_rising' as const,
              keyword: k.query,
              score: k.extractedValue != null ? String(k.extractedValue) : null,
              snapshot: { baseKeyword: k.baseKeyword, value: k.value, extractedValue: k.extractedValue },
            })),
          )
        } catch (err) {
          await alert('warning', 'keyword_expansion_persist_failed', { error: errorMessage(err) }).catch(() => {})
        }
        await alert('info', 'sourcing_keywords_expanded', { added: expansion.kept.map((k) => k.query), dropped: expansion.dropped }).catch(() => {})
      }
    }

    // --- Stage 2: harvest (Task 9) -------------------------------------------------------------
    const { candidates, pagesFetched } = await runHarvest({
      db,
      adapter,
      alert,
      keywords: runKeywords,
      candidateTarget: knobs.candidateTarget,
      maxPages: knobs.maxPages,
    })
    if (candidates.length < MIN_CANDIDATES) {
      await db
        .update(agentRuns)
        .set({ status: 'aborted', totalCostUsd: '0', finishedAt: new Date() })
        .where(eq(agentRuns.id, runId))
      await alert('warning', 'sourcing_run_skipped_no_candidates', { found: candidates.length }).catch(() => {})
      return { runId, outcome: 'no_candidates', submitted: 0 }
    }

    // --- Stage 3: trends (Task 7) — best-effort, never blocks the run --------------------------
    let trendSignals: TrendSignal[] = []
    if (!trends) {
      await alert('warning', 'trends_stage_skipped', {}).catch(() => {})
    } else {
      try {
        // Distinct harvest keywords, NEVER full product titles — CJ titles are long/messy and
        // Google Trends 400s on them (live-probed 2026-08-25: `q=dog bowl` works, a title doesn't).
        // The agent maps scores back to candidates via the `keyword` each candidate carries.
        trendSignals = await trends.fetchInterest([...new Set(candidates.map((c) => c.keyword))])
        if (trendSignals.length > 0) {
          await db.insert(sourcingSignals).values(
            trendSignals.map((s) => ({
              source: 'google_trends' as const,
              keyword: s.keyword,
              score: s.score != null ? String(s.score) : null,
              snapshot: s.snapshot,
            })),
          )
        }
      } catch (err) {
        await alert('warning', 'trends_stage_failed', { error: errorMessage(err) }).catch(() => {})
        trendSignals = []
      }
    }

    // --- Stage 4: run-scoped CJ points allowance, seeded with the harvest's own spend ---------
    const allowance = new PointsAllowance()
    allowance.spend(pagesFetched * 50, 'harvest')

    // --- Stage 5: the agent run (Task 10 MCP server + Task 12 runner) -------------------------
    const marketLookups = new MarketLookups()
    if (!marketPrice) {
      await alert('warning', 'market_price_stage_skipped', {}).catch(() => {})
    }
    const reviewsSeen = new ReviewsSeen()
    const mcpServer = createSourcingMcpServer({ adapter, allowance, marketPrice, marketLookups, reviewsSeen })
    const agentResult = await runSourcingAgent(
      { db, alert, mcpServer, queryFn },
      { runId, candidates, trendSignals, knobs, marketGateArmed: marketPrice !== null },
    )

    // --- Stage 5b: persist the run's market lookups, whatever the agent's status --------------
    // (a failed run's lookups are the most useful ones to have on record; spec §7). Never blocks.
    await persistMarketLookups(db, alert, marketLookups.all())

    if (agentResult.status !== 'succeeded' || !agentResult.output) {
      // The runner already recorded the row's terminal status/cost and fired its own alert.
      return { runId, outcome: 'agent_failed', submitted: 0 }
    }

    // --- Stage 6: validate & submit (Task 13) --------------------------------------------------
    const candidateIds = new Set(candidates.map((c) => c.supplierProductId))
    const candidatesByPid = new Map(candidates.map((c) => [c.supplierProductId, c]))
    const submitDeps: SubmitProposalDeps = { db, settings, notify, enqueue, alert, adminBaseUrl }

    const outcomes = await validateAndSubmitWinners(
      {
        db,
        adapter,
        allowance,
        submit: submitProposal,
        submitDeps,
        settings,
        alert,
        marketLookups: marketPrice ? marketLookups : null,
        demandProbe: demand,
        reviewsSeen,
        trendSignalsByKeyword: new Map(trendSignals.map((s) => [s.keyword, s])),
      },
      { runId, candidateIds, candidatesByPid, winners: agentResult.output.winners, maxPriceToMarketBps: knobs.maxPriceToMarketBps },
    )

    const submitted = outcomes.filter((o) => o.outcome === 'submitted').length
    const dropped = outcomes.length - submitted

    await db.insert(auditLog).values({
      actor: 'system',
      action: 'sourcing.run_completed',
      entityType: 'agent_run',
      entityId: runId,
      detail: { submitted, dropped },
    })

    return { runId, outcome: 'completed', submitted }
  } catch (err) {
    // A stage outside the runner threw. Flip the claimed row to a terminal 'failed' with finishedAt
    // BEFORE the error propagates to the job's catch, so it never sits 'running'. Guarded on
    // `status = 'running'` so we don't clobber a terminal status the runner already set; the
    // status-flip is itself .catch-guarded so its own failure can't mask the original error.
    await db
      .update(agentRuns)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
      .catch(() => {})
    throw err
  }
}

/** Stage 5b: one insert for the run's recorded market lookups (source 'market_price'). Its own
 *  try/catch — a persist failure warns and moves on; the in-memory registry is what the gate
 *  reads, so submission must never hinge on this insert (spec §7). */
export async function persistMarketLookups(db: Db, alert: Alert, lookups: MarketLookup[]): Promise<void> {
  if (lookups.length === 0) return
  try {
    await db.insert(sourcingSignals).values(
      lookups.map((l) => ({
        source: 'market_price' as const,
        keyword: l.query,
        supplierProductId: l.supplierProductId,
        score: l.medianCents != null ? String(l.medianCents) : null,
        evidenceUrl: l.offers[0]?.url ?? null,
        snapshot: l.snapshot,
      })),
    )
  } catch (err) {
    await alert('warning', 'market_price_persist_failed', { error: errorMessage(err) }).catch(() => {})
  }
}
