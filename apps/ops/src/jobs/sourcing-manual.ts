import type PgBoss from 'pg-boss'
import type { SourcingOverrides } from '../sourcing/knobs.ts'
import { runSourcingPipeline, type SourcingPipelineDeps } from '../sourcing/pipeline.ts'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface SourcingManualJobData {
  overrides?: SourcingOverrides
}

/**
 * Worker for the `sourcing.manual` queue — the dashboard's "Run sourcing now" button (owner ask
 * 2026-09-03: a dashboard experience instead of the terminal). Same thin-adapter shape and
 * no-blind-retry stance as `sourcing-weekly.ts` (`retryLimit: 0` on the queue): a thrown run is
 * alerted, never silently re-spent. `force: true` because a button press means "now" — the
 * same-day circuit breaker records it as a 'manual' trigger, exactly like the CLI's `--force`.
 * The queue's `policy: 'singleton'` (index.ts) is what keeps a double-click from running twice.
 */
export const sourcingManualHandler =
  (deps: SourcingPipelineDeps) =>
  async (jobs: PgBoss.Job<SourcingManualJobData>[]): Promise<void> => {
    for (const job of jobs) {
      try {
        await runSourcingPipeline({ ...deps, force: true, overrides: job.data?.overrides })
      } catch (err) {
        await deps.alert('critical', 'sourcing_run_failed', { error: errorMessage(err), trigger: 'manual' }).catch(() => {})
      }
    }
  }
