import { auditLog, supportTickets, type createDb } from '@doge-buddy/db'
import { and, asc, count, eq, gte, inArray, isNull } from 'drizzle-orm'
import type { NotifyOwner } from '../notify/notify.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/** Alert-bombing bound (spec §3): overflow beyond this many notify BATCHES per UTC day folds into
 * one summary warning instead of paging the owner further. */
export const ESCALATION_NOTIFY_MAX_PER_DAY = 10

/** IMPORTANT 2: the collapsed Telegram body must be bounded — one line per pending ticket with no
 * cap can blow past Telegram's ~4096-char message limit, which fails the send, leaves the whole
 * batch unstamped, and gets retried (and re-fail) every single minute forever. Cap the LISTED
 * tickets, not the ones actually stamped: every pending ticket is still stamped on a successful
 * notify (see below), this only bounds what's rendered into the message text. */
const MAX_LISTED_TICKETS_IN_BODY = 10
/** Hard backstop under Telegram's ~4096-char limit, in case even 10 lines run long (very long
 * subjects). */
const BODY_MAX_CHARS = 3500

function buildBody(pending: { id: string; subject: string | null }[], adminBaseUrl: string): string {
  const listed = pending.slice(0, MAX_LISTED_TICKETS_IN_BODY)
  const lines = listed.map((t) => `${t.subject ?? '(no subject)'} — ${adminBaseUrl}/admin/tickets/${t.id}`)

  const overflow = pending.length - listed.length
  if (overflow > 0) lines.push(`…and ${overflow} more`)

  const body = lines.join('\n')
  return body.length > BODY_MAX_CHARS ? body.slice(0, BODY_MAX_CHARS) : body
}

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

  // IMPORTANT 4c note: this cap is a plain check-then-act (count audit rows, decide, act) — it is
  // NOT safe against two concurrent callers both reading the same under-cap count and both
  // proceeding. It is only correct because `support.poll-gmail`'s `policy: 'singleton'` queue
  // (index.ts) guarantees at most one poll — and therefore at most one call into this function —
  // runs at a time. If notifyPendingEscalations ever gets a second caller outside that queue, this
  // guard needs a real lock (e.g. the pg_advisory_xact_lock pattern in agents/lifecycle.ts).
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
      await deps
        .alert('warning', 'support_escalation_capped', {
          max: ESCALATION_NOTIFY_MAX_PER_DAY,
          pendingCount: pending.length,
        })
        .catch(() => {})
    }
    return { notified: 0 }
  }

  const body = buildBody(pending, deps.adminBaseUrl)
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
