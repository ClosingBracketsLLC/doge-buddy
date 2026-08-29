import { type createDb } from '@doge-buddy/db'
import type PgBoss from 'pg-boss'
import { computeProductScores } from '../scoring/metrics.ts'
import type { Settings } from '../settings.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const SCORING_NIGHTLY_QUEUE = 'scoring.nightly'

export interface ScoringNightlyDeps {
  db: Db
  settings: Settings
  alert: Alert
  now?: () => Date
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `scoring.nightly` (Phase 7, Task 7): gates on `killswitch.global` and `workflow.scoring.enabled`
 * before delegating to `computeProductScores` (Task 6), which does the actual metric computation,
 * `product_scores` upsert, and null-gid warning alerts. Both gates short-circuit to `{scored:0}`
 * with no DB write beyond what `computeProductScores` itself does — killswitch/disabled means this
 * cron simply doesn't run today, same "gate then delegate" shape as every other conditional cron
 * in this directory.
 */
export async function executeScoringNightly(deps: ScoringNightlyDeps): Promise<{ scored: number }> {
  const { db, settings, alert } = deps

  if (await settings.get('killswitch.global')) return { scored: 0 }
  if (!(await settings.get('workflow.scoring.enabled'))) return { scored: 0 }

  const now = deps.now ?? (() => new Date())
  const rows = await computeProductScores({ db, alert, settings }, now())
  return { scored: rows.length }
}

/**
 * Worker callback for the `scoring.nightly` cron queue. Thin adapter, same shape as
 * `sourcingWeeklyHandler` (jobs/sourcing-weekly.ts): all the orchestration logic lives in
 * `executeScoringNightly`/`computeProductScores`, not here.
 *
 * This queue has no `retryLimit: 0` override (unlike `sourcing.weekly`), so pg-boss's own default
 * retry policy still applies — but a thrown job is nonetheless caught here and turned into a loud
 * `critical` alert rather than relying solely on pg-boss's dead-letter handling to surface a
 * failure this severe (an entire night's scoring run silently not happening).
 */
export function scoringNightlyHandler(deps: ScoringNightlyDeps): PgBoss.WorkHandler<object> {
  return async (): Promise<void> => {
    try {
      await executeScoringNightly(deps)
    } catch (err) {
      await deps.alert('critical', 'scoring_nightly_failed', { error: errorMessage(err) }).catch(() => {})
    }
  }
}
