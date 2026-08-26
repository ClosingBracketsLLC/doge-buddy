import { auditLog, supportTickets, type createDb } from '@doge-buddy/db'
import { and, asc, count, eq, gte, inArray, isNull } from 'drizzle-orm'
import type { NotifyOwner } from '../notify/notify.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/** Alert-bombing bound (spec §3): overflow beyond this many notify BATCHES per UTC day folds into
 * one summary warning instead of paging the owner further. */
export const ESCALATION_NOTIFY_MAX_PER_DAY = 10

const NOTIFIED_ACTION = 'support.escalation_notified'
const CAPPED_ACTION = 'support.escalation_capped'

export interface EscalateDeps {
  db: Db
  notify: NotifyOwner
  alert: Alert
  adminBaseUrl: string
  now?: () => Date
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Notifies every escalated ticket with `escalation_notified_at IS NULL`: ONE collapsed Telegram
 * message per call (deep links per ticket), and stamps `escalation_notified_at` ONLY on
 * `notify()===true` — a false result (NotifyOwner never rejects, per its contract) leaves the
 * batch untouched so the next poll retries it (at-least-once).
 *
 * The daily cap is counted via audit rows (`support.escalation_notified`, one per BATCH — not per
 * ticket) since UTC midnight. At cap, no notify is attempted and the batch stays pending; a single
 * `support.escalation_capped` warning alert fires per UTC day, guarded by that day's existing
 * cap-warning audit row so a second call the same day is silent.
 */
export async function notifyPendingEscalations(deps: EscalateDeps): Promise<{ notified: number }> {
  const now = deps.now ?? (() => new Date())
  const midnight = utcMidnight(now())

  const pending = await deps.db
    .select({ id: supportTickets.id, subject: supportTickets.subject })
    .from(supportTickets)
    .where(and(eq(supportTickets.status, 'escalated'), isNull(supportTickets.escalationNotifiedAt)))
    .orderBy(asc(supportTickets.createdAt))

  if (pending.length === 0) return { notified: 0 }

  const [notifiedRow] = await deps.db
    .select({ value: count() })
    .from(auditLog)
    .where(and(eq(auditLog.action, NOTIFIED_ACTION), gte(auditLog.createdAt, midnight)))
  const notifiedBatchesToday = notifiedRow?.value ?? 0

  if (notifiedBatchesToday >= ESCALATION_NOTIFY_MAX_PER_DAY) {
    const [existingCapWarning] = await deps.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
      .limit(1)

    if (!existingCapWarning) {
      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: CAPPED_ACTION,
        detail: { max: ESCALATION_NOTIFY_MAX_PER_DAY, pendingCount: pending.length },
      })
      await deps.alert('warning', 'support_escalation_capped', {
        max: ESCALATION_NOTIFY_MAX_PER_DAY,
        pendingCount: pending.length,
      })
    }
    return { notified: 0 }
  }

  const body = pending.map((t) => `${t.subject ?? '(no subject)'} — ${deps.adminBaseUrl}/admin/tickets/${t.id}`).join('\n')
  const ok = await deps.notify({
    title: `${pending.length} ticket${pending.length === 1 ? '' : 's'} escalated`,
    body,
    actions: [{ label: 'View tickets', url: `${deps.adminBaseUrl}/admin/tickets` }],
  })
  if (!ok) return { notified: 0 }

  const ids = pending.map((t) => t.id)
  await deps.db.update(supportTickets).set({ escalationNotifiedAt: now() }).where(inArray(supportTickets.id, ids))
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: NOTIFIED_ACTION,
    detail: { ticketIds: ids, count: ids.length },
  })

  return { notified: ids.length }
}
