import { auditLog, proposals, type createDb } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * CJ dispute statuses spec §4.5 treats as terminal — once `getDispute` reports one of these, the
 * poll writes its marker and this row drops out of selection for good.
 *
 * `'pending'` stays live by definition — it's still open on CJ's side.
 *
 * `'unknown'` is deliberately NOT terminal, even though the name sounds final: `DisputeStatus`
 * (packages/supplier/src/types.ts) maps it whenever CJ's raw status string didn't match any known
 * value — a brand-new CJ status this adapter hasn't learned yet, a transient shape change, etc.
 * Treating it as terminal would permanently stop tracking a dispute that may still be live on CJ's
 * side, with no way to notice later. Leaving it unmarked means the row is retried every 6-hour
 * cycle until CJ's mapping is updated or the dispute reaches a real terminal value.
 */
const TERMINAL_STATUSES = new Set(['refunded', 'reissued', 'rejected'])

/**
 * Rows polled per cycle (spec §4.5) — a courtesy to CJ's 1-request-per-second bucket, not a
 * correctness bound. Anything past 20 open disputes simply waits for the next 6-hourly cycle
 * rather than this poll trying to drain an arbitrarily large backlog in one burst.
 */
const SELECT_LIMIT = 20

export interface DisputePollDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getDispute'>
  alert: Alert
  now?: () => Date
}

/**
 * `cj.dispute-poll` (Task 17): every 6 hours, polls CJ for the live status of every open dispute
 * this system has on record and, once CJ reports a terminal outcome, writes a terminal marker into
 * the owning `refund` proposal's payload so the row drops out of selection for good.
 *
 * **Selection** (spec §4.5): `type='refund' AND status='applied' AND payload->cjDispute->>id IS
 * NOT NULL AND payload->cjDispute->>status IS NULL` — every applied refund proposal that opened a
 * CJ dispute (`apply-refund.ts`'s `openCjDispute` step, which writes `cjDispute.id` and nothing
 * else) and hasn't yet been marked terminal by an earlier poll cycle. Ordered oldest-created-first
 * so the `LIMIT 20` budget is spent fairly across cycles rather than always favouring whatever the
 * DB happens to return first.
 *
 * **Terminal write.** `apply-refund.ts` carries a WARNING at its own jsonb `||` merge site for
 * exactly this poll: that merge is SHALLOW — it replaces the whole `cjDispute` value rather than
 * deep-merging into it. So the write here is always the COMPLETE object,
 * `{ cjDispute: { id, status, closedAt } }`, built from `row.disputeId` (read fresh off THIS row,
 * never re-derived) — never a partial `{ status }`, which would silently destroy the `id` this same
 * selection query depends on and make the dispute permanently unpollable.
 *
 * **Isolation.** A per-row `getDispute` throw is caught, alerted (`cj_dispute_poll_error`,
 * warning), and the loop moves on — same stance as `cj-wallet-monitor.ts`'s resume loop: one
 * flaky/unreachable dispute must never block the rest of the batch.
 *
 * **Once-guard.** There's no separate dedupe flag for the terminal info alert — the terminal
 * marker itself is the guard. Once a row is marked, the selection query above can never select it
 * again, so `cj_dispute_terminal` fires exactly once per dispute, ever.
 */
export async function executeDisputePoll(deps: DisputePollDeps): Promise<{ polled: number; terminal: number }> {
  const now = deps.now ?? (() => new Date())

  const rows = await deps.db
    .select({ id: proposals.id, disputeId: sql<string>`${proposals.payload} -> 'cjDispute' ->> 'id'` })
    .from(proposals)
    .where(
      and(
        eq(proposals.type, 'refund'),
        eq(proposals.status, 'applied'),
        isNotNull(sql`${proposals.payload} -> 'cjDispute' ->> 'id'`),
        isNull(sql`${proposals.payload} -> 'cjDispute' ->> 'status'`),
      ),
    )
    .orderBy(asc(proposals.createdAt))
    .limit(SELECT_LIMIT)

  let terminal = 0
  for (const row of rows) {
    try {
      const status = await deps.adapter.getDispute(row.disputeId)
      if (!TERMINAL_STATUSES.has(status.value)) {
        // 'pending' or 'unknown' — leave unmarked, next cycle retries. See TERMINAL_STATUSES above.
        continue
      }

      await deps.db
        .update(proposals)
        .set({
          payload: sql`${proposals.payload} || ${JSON.stringify({
            cjDispute: { id: row.disputeId, status: status.value, closedAt: now().toISOString() },
          })}::jsonb`,
        })
        .where(eq(proposals.id, row.id))

      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: 'cj.dispute_terminal',
        entityType: 'proposal',
        entityId: row.id,
        detail: { disputeId: row.disputeId, status: status.value },
      })

      await deps.alert('info', 'cj_dispute_terminal', {
        proposalId: row.id,
        disputeId: row.disputeId,
        status: status.value,
      })
      terminal += 1
    } catch (err) {
      await deps.alert('warning', 'cj_dispute_poll_error', {
        proposalId: row.id,
        disputeId: row.disputeId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { polled: rows.length, terminal }
}

/**
 * Worker callback for the `cj.dispute-poll` cron queue. Same thin-wrapper shape as
 * `cjWalletMonitorHandler` (jobs/cj-wallet-monitor.ts): the job payload carries no data (this is a
 * cron trigger, not a per-entity job) — all the actual logic lives in `executeDisputePoll` above.
 */
export function cjDisputePollHandler(deps: DisputePollDeps): PgBoss.WorkHandler<object> {
  return async (jobs: PgBoss.Job<object>[]): Promise<void> => {
    for (const _job of jobs) {
      await executeDisputePoll(deps)
    }
  }
}
