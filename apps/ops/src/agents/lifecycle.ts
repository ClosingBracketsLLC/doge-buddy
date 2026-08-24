import { agentRuns, auditLog, type createDb } from '@doge-buddy/db'
import { and, eq, inArray, sql } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

// Ops boot's periodic watchdog (spec §Stage 3) runs every 15 minutes; this is that interval plus a
// 5-minute margin, so a run genuinely still in flight is never mistaken for an orphan by a sweep
// that merely caught it between two watchdog ticks.
export const ORPHAN_AFTER_MINUTES = 20

export type ClaimResult = { claimed: true; runId: string } | { claimed: false; existingRunId: string }

/**
 * Flips `agent_runs` rows stuck in `'running'` past `ORPHAN_AFTER_MINUTES` to `'aborted'` — the
 * self-heal for a crashed/killed run that never reached a terminal status. Fires a `warning`
 * alert per orphaned row (best-effort — a failed page must not stop the sweep or the caller) and
 * writes its own `audit_log` row per row too, distinct from whatever `alert` itself logs, so the
 * durable audit trail records every orphan even if the alert channel is down.
 *
 * Called both at ops boot (see `index.ts`) and at the top of every `claimDailyRun` — the latter so
 * a stale row never needs to wait for the next boot or watchdog tick to be healed before it stops
 * looking like an in-progress run to anything inspecting `agent_runs`.
 */
export async function sweepOrphanRuns(db: Db, alert: Alert): Promise<number> {
  const orphaned = await db
    .update(agentRuns)
    .set({ status: 'aborted', finishedAt: new Date() })
    .where(
      and(
        eq(agentRuns.status, 'running'),
        sql`${agentRuns.startedAt} < now() - (${ORPHAN_AFTER_MINUTES} * interval '1 minute')`,
      ),
    )
    .returning({ id: agentRuns.id, workflow: agentRuns.workflow })

  for (const row of orphaned) {
    await alert('warning', 'agent_run_orphaned', { runId: row.id, workflow: row.workflow }).catch(() => {})
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'agent_run.orphaned',
      entityType: 'agent_run',
      entityId: row.id,
      detail: { workflow: row.workflow },
    })
  }

  return orphaned.length
}

/**
 * The money guard (spec Decision 10) against concurrent paid agent runs: at most one claimed
 * `agent_runs` row per `workflow` per UTC calendar day, unless `force` is set. Check-and-insert
 * happens inside ONE transaction holding `pg_advisory_xact_lock(hashtext('agent-run:' + workflow))`
 * — the xact-scoped variant, not the session one, so the lock auto-releases the instant the
 * transaction ends (commit, rollback, or a dropped connection) with no separate unlock call and no
 * way to leak a held lock past process death. Two callers racing for the same workflow (e.g. a
 * cron firing while a manual run is mid-flight) serialize on this lock: the loser's SELECT can't
 * even run until the winner's transaction — including its INSERT — has already committed, so it
 * reliably sees the winner's row and backs off instead of racing it.
 *
 * Sweeps orphans FIRST, outside this transaction: a previous run that crashed mid-flight without
 * reaching a terminal status must not sit around as a stale 'running' row confusing whatever else
 * inspects `agent_runs` (dashboards, monitoring) one moment longer than necessary — self-heal runs
 * on every claim attempt, not just at boot or on the watchdog's own schedule. It's also what makes
 * the status filter below meaningful same-day, not just across a day boundary: a row this sweep
 * just flipped to 'aborted' is no longer in the blocking set, so the very next line in this same
 * call can claim past it.
 */
export async function claimDailyRun(
  db: Db,
  alert: Alert,
  input: { workflow: string; model: string; triggerRef: string; force?: boolean },
): Promise<ClaimResult> {
  await sweepOrphanRuns(db, alert)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'agent-run:' + input.workflow}))`)
    if (!input.force) {
      // Only a live ('running') or a done ('succeeded') run enforces the one-claim-per-day rule.
      // A 'failed' run, or a 'running' run the sweep above just flipped to 'aborted' because it
      // crashed without reaching a terminal status, must NOT keep wedging the breaker for the
      // rest of the day — that's the spec's promised same-day self-heal. Only 'running'/'succeeded'
      // represent "a paid run is in flight or already completed today," which is the only thing
      // this breaker exists to prevent duplicating.
      const [existing] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.workflow, input.workflow),
            inArray(agentRuns.status, ['running', 'succeeded']),
            sql`(${agentRuns.startedAt} AT TIME ZONE 'utc') >= date_trunc('day', now() AT TIME ZONE 'utc')`,
          ),
        )
        .limit(1)
      if (existing) return { claimed: false, existingRunId: existing.id }
    }
    const [row] = await tx
      .insert(agentRuns)
      .values({ workflow: input.workflow, model: input.model, triggerRef: input.triggerRef, status: 'running' })
      .returning({ id: agentRuns.id })
    return { claimed: true, runId: row!.id }
  })
}
