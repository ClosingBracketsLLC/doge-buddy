import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import { and, eq, like, lt } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { SendOpts } from '../fulfillment/types.ts'
import { formPlaceholderThreadId, isFormPlaceholder } from '../support/form-ids.ts'
import type { Alert } from '../support/ingest.ts'

type Db = ReturnType<typeof createDb>['db']
type SendFn = (name: string, data: object, opts?: SendOpts) => Promise<void>

export const FORM_ACK_QUEUE = 'support.form-ack'
export const FORM_ACK_SEND_OPTS = (ticketId: string): SendOpts => ({
  singletonKey: ticketId, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 120,
})
export const FORM_ACK_SUBJECT = 'We got your message — Doge Buddy Support'
export const FORM_ACK_SENT_ACTION = 'support.form_ack_sent'
export const FORM_ACK_SKIPPED_ACTION = 'support.form_ack_skipped'
/** A form ticket still on its placeholder this long after creation is re-enqueued by the poll. */
export const FORM_ACK_SWEEP_AFTER_MS = 2 * 60_000
const SWEEP_LIMIT = 20

export function formAckMessageId(ticketId: string, supportAddress: string): string {
  const domain = supportAddress.split('@')[1] ?? 'dogebuddy.com'
  return `<form-ack-${ticketId}@${domain}>`
}

/** Fixed copy (spec §4.3) — NOT agent-written; guarded by a validator test so it never carries a promise token beside an action token. */
export function formAckBody(name: string): string {
  return (
    `Hi ${name},\n\n` +
    "Thanks for reaching out — we've received your message and will reply in this email thread, usually within one business day. " +
    "If you're writing about a damaged or wrong item, please reply here with a photo.\n\n" +
    'Doge Buddy Support'
  )
}

/** The form body starts with `Name: <name>` (http/contact.ts's buildFormBody). */
export function nameFromFormBody(bodyText: string | null): string {
  const m = bodyText?.match(/^Name: (.+)$/m)
  const name = m?.[1]?.trim()
  return name && name.length > 0 ? name : 'there'
}

export interface FormAckDeps {
  db: Db
  gmail: GmailClient | null
  supportAddress: string
  alert: Alert
  now?: () => Date
}

/**
 * Sends the contact-form acknowledgement that CREATES the ticket's Gmail thread (spec §4).
 * Idempotent across a crash between send and DB write: the Message-ID is deterministic, and a
 * prior sent copy found via `rfc822msgid:` is recovered instead of re-sent. The thread swap is a
 * guarded UPDATE (`WHERE gmail_thread_id = placeholder`), so a duplicate worker matching 0 rows
 * writes nothing.
 */
export async function executeFormAck(deps: FormAckDeps, ticketId: string): Promise<'sent' | 'recovered' | 'skipped'> {
  if (!deps.gmail) throw new Error('support.form-ack: gmail not configured')
  const gmail = deps.gmail
  const now = deps.now ?? (() => new Date())

  const [ticket] = await deps.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
  if (!ticket) throw new Error(`support.form-ack: ticket ${ticketId} not found`)
  if (!isFormPlaceholder(ticket.gmailThreadId)) {
    await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_ACK_SKIPPED_ACTION, entityType: 'support_ticket', entityId: ticketId, detail: { reason: 'already_acked' } })
    return 'skipped'
  }
  if (!ticket.customerEmail) throw new Error(`support.form-ack: ticket ${ticketId} has no customer email`)

  const [inbound] = await deps.db
    .select({ bodyText: supportMessages.bodyText })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.direction, 'inbound')))
    .limit(1)
  const messageId = formAckMessageId(ticketId, deps.supportAddress)
  const bodyText = formAckBody(nameFromFormBody(inbound?.bodyText ?? null))

  let sent: { id: string; threadId: string }
  let recovered = false
  const prior = await gmail.listMessages({ q: `in:sent rfc822msgid:${messageId}` })
  if (prior.ids[0]) {
    sent = prior.ids[0]
    recovered = true
  } else {
    sent = await gmail.sendNew({ to: ticket.customerEmail, subject: FORM_ACK_SUBJECT, messageId, bodyText })
  }

  await deps.db.transaction(async (tx) => {
    await tx
      .update(supportTickets)
      .set({ gmailThreadId: sent.threadId })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.gmailThreadId, formPlaceholderThreadId(ticketId))))
    await tx
      .insert(supportMessages)
      .values({
        ticketId, gmailMessageId: sent.id, direction: 'outbound', fromEmail: deps.supportAddress,
        bodyText, rfcMessageId: messageId, authResults: null, sentAt: now(),
      })
      .onConflictDoNothing({ target: supportMessages.gmailMessageId })
    await tx.insert(auditLog).values({
      actor: 'system', action: FORM_ACK_SENT_ACTION, entityType: 'support_ticket', entityId: ticketId,
      detail: { gmailMessageId: sent.id, threadId: sent.threadId, recovered },
    })
  })
  return recovered ? 'recovered' : 'sent'
}

/** Worker (`boss.work(FORM_ACK_QUEUE, { includeMetadata: true }, …)`): the last retry's failure pages the owner. */
export function formAckHandler(deps: FormAckDeps): PgBoss.WorkHandler<{ ticketId: string }> {
  return async (jobs) => {
    let firstError: unknown = null
    for (const job of jobs) {
      try {
        await executeFormAck(deps, job.data.ticketId)
      } catch (err) {
        firstError = firstError ?? err
        const meta = job as unknown as { retryCount?: number; retryLimit?: number }
        if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
          await deps.alert('critical', 'support_form_ack_failed', {
            ticketId: job.data.ticketId, error: err instanceof Error ? err.message : String(err),
          }).catch(() => {})
        }
      }
    }
    if (firstError !== null) throw firstError
  }
}

/** Poll stage: any form ticket still on its placeholder after FORM_ACK_SWEEP_AFTER_MS gets its ack job (re-)enqueued — `stately` + singletonKey make this idempotent. */
export async function sweepUnackedFormTickets(deps: { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }): Promise<{ enqueued: number }> {
  const now = deps.now ?? (() => new Date())
  const cutoff = new Date(now().getTime() - FORM_ACK_SWEEP_AFTER_MS)
  const rows = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(eq(supportTickets.source, 'form'), like(supportTickets.gmailThreadId, 'form:%'), lt(supportTickets.createdAt, cutoff)))
    .limit(SWEEP_LIMIT)
  for (const { id } of rows) await deps.enqueue(FORM_ACK_QUEUE, { ticketId: id }, FORM_ACK_SEND_OPTS(id))
  return { enqueued: rows.length }
}
