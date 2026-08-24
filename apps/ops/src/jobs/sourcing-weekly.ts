import { runSourcingPipeline, type SourcingPipelineDeps } from '../sourcing/pipeline.ts'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Worker callback for the `sourcing.weekly` cron queue. Thin adapter, same shape as every other
 * queue wrapper in this directory — all the orchestration logic lives in `pipeline.ts`, not here.
 *
 * `retryLimit: 0` on this queue (see `index.ts`'s `registerCron` call) means a thrown job is just
 * painted red with no retry — so this wraps the pipeline call in try/catch and fires a `critical`
 * alert on anything that slips past the pipeline's own internal safety nets, rather than letting
 * pg-boss's dead-letter handling be the only record of a failure this severe.
 */
export const sourcingWeeklyHandler = (deps: SourcingPipelineDeps) => async (): Promise<void> => {
  try {
    await runSourcingPipeline(deps)
  } catch (err) {
    await deps.alert('critical', 'sourcing_run_failed', { error: errorMessage(err) }).catch(() => {})
  }
}
