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
import { MIN_CANDIDATES, runHarvest } from './harvest.ts'
import { validateAndSubmitWinners } from './submit-winners.ts'
import type { TrendSignal, TrendsProvider } from './trends.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type Enqueue = (name: string, data: object, opts?: SendOpts) => Promise<void>

export interface SourcingPipelineDeps {
  db: Db
  adapter: SupplierAdapter
  settings: Settings
  alert: Alert
  enqueue: Enqueue
  notify: NotifyOwner
  adminBaseUrl?: string
  /**
   * Produces a FRESH TrendsProvider per pipeline run (returns null when SERPAPI_KEY is absent → the
   * trends stage is skipped, spec §Stage 2). A factory, not a constructed instance, because
   * `createSerpApiTrends` enforces its `SERPAPI_MAX_REQUESTS_PER_RUN` cap via a per-instance closure
   * counter that never resets (trends.ts:20-26 — "one instance = one run"): a single instance baked
   * in at boot and reused across weekly runs would accumulate that counter and permanently trip
   * (~week 4), after which the trends stage silently returns all-null signals (FIX C2). Calling the
   * factory once per run guarantees each run starts with a fresh counter.
   */
  trendsFactory: () => TrendsProvider | null
  /** Test seam, threaded straight through to `runSourcingAgent`. */
  queryFn?: SourcingRunDeps['queryFn']
  /** Bypasses the same-day circuit breaker (`claimDailyRun`) — `--force` on the manual script. */
  force?: boolean
}

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
 * the two documented short-circuits (refused / no_candidates). Every failure mode here is a clean
 * return, never a throw (Decision 10 for the refusal path; the agent runner and submit-winners are
 * already internally throw-free by construction) — `jobs/sourcing-weekly.ts` still wraps the call
 * in try/catch as a last-resort net, but nothing in normal operation should ever reach it.
 */
export async function runSourcingPipeline(deps: SourcingPipelineDeps): Promise<SourcingPipelineResult> {
  const { db, adapter, settings, alert, enqueue, notify, adminBaseUrl, trendsFactory, queryFn, force } = deps

  // --- Stage 1: claim the day's run (Task 11's atomic breaker) --------------------------------
  const claim = await claimDailyRun(db, alert, {
    workflow: 'sourcing.weekly',
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
    // --- Stage 2: harvest (Task 9) -------------------------------------------------------------
    const { candidates, pagesFetched } = await runHarvest({ db, adapter, alert })
    if (candidates.length < MIN_CANDIDATES) {
      await db
        .update(agentRuns)
        .set({ status: 'aborted', totalCostUsd: '0', finishedAt: new Date() })
        .where(eq(agentRuns.id, runId))
      await alert('warning', 'sourcing_run_skipped_no_candidates', { found: candidates.length }).catch(() => {})
      return { runId, outcome: 'no_candidates', submitted: 0 }
    }

    // --- Stage 3: trends (Task 7) — best-effort, never blocks the run --------------------------
    // Construct a FRESH provider per run (FIX C2) so its per-run SerpApi request counter resets.
    const trends = trendsFactory()
    let trendSignals: TrendSignal[] = []
    if (!trends) {
      await alert('warning', 'trends_stage_skipped', {}).catch(() => {})
    } else {
      try {
        trendSignals = await trends.fetchInterest(candidates.map((c) => c.title))
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
    const mcpServer = createSourcingMcpServer({ adapter, allowance })
    const agentResult = await runSourcingAgent({ db, alert, mcpServer, queryFn }, { runId, candidates, trendSignals })
    if (agentResult.status !== 'succeeded' || !agentResult.output) {
      // The runner already recorded the row's terminal status/cost and fired its own alert.
      return { runId, outcome: 'agent_failed', submitted: 0 }
    }

    // --- Stage 6: validate & submit (Task 13) --------------------------------------------------
    const candidateIds = new Set(candidates.map((c) => c.supplierProductId))
    const candidatesByPid = new Map(candidates.map((c) => [c.supplierProductId, c]))
    const submitDeps: SubmitProposalDeps = { db, settings, notify, enqueue, alert, adminBaseUrl }

    const outcomes = await validateAndSubmitWinners(
      { db, adapter, allowance, submit: submitProposal, submitDeps, settings, alert },
      { runId, candidateIds, candidatesByPid, winners: agentResult.output.winners },
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
