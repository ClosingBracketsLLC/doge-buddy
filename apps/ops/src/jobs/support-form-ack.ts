import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import { and, asc, eq, like, lt, notExists, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { SendOpts } from '../fulfillment/types.ts'
import {
  formPlaceholderThreadId,
  formSendingSentinel,
  formThreadIdLikePattern,
  isFormPlaceholder,
  parseSendingSentinel,
} from '../support/form-ids.ts'
import type { Alert } from '../support/ingest.ts'
import { validateReplyBody } from '../support/validator.ts'

type Db = ReturnType<typeof createDb>['db']
type SendFn = (name: string, data: object, opts?: SendOpts) => Promise<void>

export const FORM_ACK_QUEUE = 'support.form-ack'
/**
 * Retry/expiry policy for the ack (final review C1c + I4).
 *
 * `expireInSeconds: 600` — the OLD 120s was below a plausible Gmail send + search round trip, so
 * pg-boss could expire an invocation that was still running and hand the same ticket to a second
 * worker mid-send. 600s is the same ceiling `support.agent-run` and `proposal.apply` use.
 *
 * `retryDelay: 20` with `retryLimit: 5` + `retryBackoff` — the ack chain must finish INSIDE the
 * reply worker's own chain, because `apply-support-reply.ts` retries while a form ticket still
 * sits on its placeholder. `PROPOSAL_RETRY_OPTS` (proposals/submit.ts) is 30s × 5 with backoff
 * ≈ 15.5 min; at 20s × 5 with backoff the ack chain is ≈ 10 min, so a slow-but-eventually-
 * successful ack no longer dead-letters an approved reply that was only waiting for it. Any
 * change to `PROPOSAL_RETRY_OPTS` must keep that ordering (ack budget < apply budget).
 */
export const FORM_ACK_SEND_OPTS = (ticketId: string): SendOpts => ({
  singletonKey: ticketId, retryLimit: 5, retryDelay: 20, retryBackoff: true, expireInSeconds: 600,
})
export const FORM_ACK_SUBJECT = 'We got your message — Doge Buddy Support'
export const FORM_ACK_SENT_ACTION = 'support.form_ack_sent'
export const FORM_ACK_SKIPPED_ACTION = 'support.form_ack_skipped'
/** The composed ack failed `validateReplyBody` (only reachable through the customer-supplied
 * greeting name) and the nameless copy was sent instead — see `composeAckBody`. */
export const FORM_ACK_BODY_SCREENED_ACTION = 'support.form_ack_body_screened'
/** A form ticket still on its placeholder this long after creation is re-enqueued by the poll. */
export const FORM_ACK_SWEEP_AFTER_MS = 2 * 60_000
/**
 * How old a `:sending:` claim must be before another attempt may take it over. Set to the job's own
 * `expireInSeconds` (600s) — past that ceiling pg-boss has already expired the invocation that
 * wrote the claim, so no live worker can still be inside `sendNew` holding it. Below the ceiling a
 * sentinel is assumed live and the attempt still skips.
 */
export const FORM_ACK_CLAIM_STALE_MS = 600_000
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

/** Greeting-name whitelist: letters, combining marks, digits, apostrophe, hyphen, period, space. */
const GREETING_NAME_RE = /^[\p{L}\p{M}\p{Nd}'\-. ]+$/u
const GREETING_NAME_MAX = 40

/**
 * Screens the customer-supplied name before it is interpolated into an email THIS SERVICE sends
 * from `support@` to an address the same anonymous submitter chose (final review C2b).
 *
 * `name` is up to 100 attacker-controlled characters. Reflected unchanged into the greeting it
 * becomes a free line of support@-signed copy — "Hi there — your refund of $89 has been approved,
 * see" or "Hi there, verify at http://evil.example/x," — i.e. a phishing lure with our From: on
 * it. So: first line only, a conservative character class, at most 40 chars, and `'there'` for
 * anything else. Rejecting (rather than truncating) an over-long or off-class name is deliberate —
 * a half-cut name reads worse than the neutral greeting, and no legitimate greeting needs `:`,
 * `/`, `$`, `—` or a digit run.
 */
export function greetingName(raw: string | null | undefined): string {
  const first = (raw ?? '').split('\n')[0]?.trim() ?? ''
  if (first.length === 0 || first.length > GREETING_NAME_MAX) return 'there'
  if (!GREETING_NAME_RE.test(first)) return 'there'
  return first
}

/** The form body starts with `Name: <name>` (http/contact.ts's buildFormBody). */
export function nameFromFormBody(bodyText: string | null): string {
  const m = bodyText?.match(/^Name: (.+)$/m)
  return greetingName(m?.[1])
}

export interface FormAckDeps {
  db: Db
  gmail: GmailClient | null
  supportAddress: string
  alert: Alert
  now?: () => Date
}

/**
 * Postgres unique-violation (23505). drizzle 0.44 wraps a driver error in a `DrizzleQueryError`
 * that carries the original `pg` error as `cause`, so the chain is walked rather than reading
 * `err.code` off the top-level throw.
 */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; e != null && depth < 5; depth++) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '23505') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

async function auditSkip(deps: FormAckDeps, ticketId: string, reason: string): Promise<void> {
  await deps.db.insert(auditLog).values({
    actor: 'system', action: FORM_ACK_SKIPPED_ACTION, entityType: 'support_ticket', entityId: ticketId,
    detail: { reason },
  })
}

/**
 * Belt-and-braces screen (final review C2c): the ack is fixed copy EXCEPT the greeting, and the
 * greeting comes from the customer. `greetingName` already reduces it to a conservative class, but
 * an in-class name ("Your refund has been approved") can still compose a body that trips the same
 * promised-action screen every agent-written reply must pass. If it does, the nameless copy goes
 * out instead and the incident is audited — the customer still gets their acknowledgement.
 */
async function composeAckBody(deps: FormAckDeps, ticketId: string, inboundBody: string | null): Promise<string> {
  const body = formAckBody(nameFromFormBody(inboundBody))
  const screened = await validateReplyBody(deps.db, ticketId, body, { hasRefundInOutput: false, trackingUrl: null })
  if (screened.ok) return body
  await deps.db.insert(auditLog).values({
    actor: 'system', action: FORM_ACK_BODY_SCREENED_ACTION, entityType: 'support_ticket', entityId: ticketId,
    detail: { reason: screened.code },
  })
  return formAckBody('there')
}

/**
 * Sends the contact-form acknowledgement that CREATES the ticket's Gmail thread (spec §4).
 *
 * Exactly-once, in three guards (final review C1):
 *  1. CLAIM before sending — the plain placeholder is swapped for a `form:<id>:sending:<uuid>`
 *     sentinel in a guarded UPDATE. A second worker (pg-boss will hand a `created` job to another
 *     worker behind an `active` one, and an expired invocation can still be running) matches 0
 *     rows and stops without sending. The sentinel keeps the `form:` prefix, so a process that
 *     dies mid-send leaves the reply worker's hold and the poll sweep working exactly as before.
 *  2. RECOVER instead of re-sending — the Message-ID is deterministic, so a prior attempt's sent
 *     copy is found by `rfc822msgid:` and its thread adopted. This runs BEFORE the claim, which is
 *     what makes a crash on the sentinel recoverable.
 *  3. GUARDED SWAP — the thread swap matches any `form:<id>%` value for this ticket and returns
 *     its rowcount; the outbound message row and the `form_ack_sent` audit row are written ONLY
 *     when it matched, so a worker that lost the race writes nothing at all.
 *
 * A claim is never permanent: a sentinel older than `FORM_ACK_CLAIM_STALE_MS` (the job's own
 * expiry, past which pg-boss has already expired the invocation that wrote it) is taken over by a
 * compare-and-swap on the exact observed value, with a `support_form_ack_stale_claim_reclaimed`
 * warning. Without that a kill inside the claim window stranded the ticket for good.
 */
export async function executeFormAck(deps: FormAckDeps, ticketId: string): Promise<'sent' | 'recovered' | 'skipped'> {
  if (!deps.gmail) throw new Error('support.form-ack: gmail not configured')
  const gmail = deps.gmail
  const now = deps.now ?? (() => new Date())

  const [ticket] = await deps.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
  if (!ticket) throw new Error(`support.form-ack: ticket ${ticketId} not found`)
  if (!isFormPlaceholder(ticket.gmailThreadId)) {
    await auditSkip(deps, ticketId, 'already_acked')
    return 'skipped'
  }
  if (!ticket.customerEmail) throw new Error(`support.form-ack: ticket ${ticketId} has no customer email`)

  // OLDEST inbound (T6-4): the form submission itself is the row whose `Name:` line the greeting
  // comes from — a customer follow-up would otherwise win on an unordered select.
  const [inbound] = await deps.db
    .select({ bodyText: supportMessages.bodyText })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.direction, 'inbound')))
    .orderBy(asc(supportMessages.sentAt))
    .limit(1)
  const messageId = formAckMessageId(ticketId, deps.supportAddress)
  const bodyText = await composeAckBody(deps, ticketId, inbound?.bodyText ?? null)

  let sent: { id: string; threadId: string }
  let recovered = false
  let rfcMessageId = messageId
  const prior = await gmail.listMessages({ q: `in:sent rfc822msgid:${messageId}` })
  if (prior.ids[0]) {
    sent = prior.ids[0]
    recovered = true
  } else {
    // A claim we may be allowed to TAKE OVER: the ticket already carries a sentinel, and it is old
    // enough that pg-boss has expired whatever invocation wrote it (a kill / redeploy / expiry
    // between the claim and `sendNew` returning). Without this the ticket is stranded forever —
    // the search above finds nothing and a placeholder-only guard can never match again.
    const priorClaim = parseSendingSentinel(ticket.gmailThreadId)
    const staleClaim = priorClaim !== null && now().getTime() - priorClaim.claimedAtMs >= FORM_ACK_CLAIM_STALE_MS

    const sentinel = formSendingSentinel(ticketId, now().getTime())
    const claimed = await deps.db
      .update(supportTickets)
      .set({ gmailThreadId: sentinel })
      // Stale takeover is a compare-and-swap against the EXACT value we observed, so two workers
      // reclaiming the same dead sentinel still cannot both win. A fresh sentinel (someone is
      // plausibly still sending) keeps the plain-placeholder guard and therefore still skips.
      .where(and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.gmailThreadId, staleClaim ? ticket.gmailThreadId : formPlaceholderThreadId(ticketId)),
      ))
      .returning({ id: supportTickets.id })
    if (claimed.length === 0) {
      await auditSkip(deps, ticketId, 'claimed_elsewhere')
      return 'skipped'
    }
    if (staleClaim) {
      // The owner needs to know: the dead attempt MAY have reached Gmail without the search
      // catching it (index lag), so this recovery can produce a duplicate acknowledgement.
      await deps
        .alert('warning', 'support_form_ack_stale_claim_reclaimed', { ticketId, claimedAtMs: priorClaim!.claimedAtMs })
        .catch(() => {})
    }
    try {
      sent = await gmail.sendNew({ to: ticket.customerEmail, subject: FORM_ACK_SUBJECT, messageId, bodyText })
    } catch (err) {
      // An EXPLICIT send failure means this attempt is over and (unlike a crash) we are still here
      // to say so: release the claim so the pg-boss retry can try again instead of finding its own
      // sentinel and skipping for good. A crash never reaches this line, which is exactly the case
      // the sentinel is meant to survive — there the `rfc822msgid:` recovery above takes over.
      await deps.db
        .update(supportTickets)
        .set({ gmailThreadId: formPlaceholderThreadId(ticketId) })
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.gmailThreadId, sentinel)))
        .catch(() => {})
      throw err
    }
    // #13: persist the Message-ID Gmail ACTUALLY stamped rather than assuming ours survived — the
    // whole idempotency chain reads this value back. Ours stays the fallback (and the search key).
    try {
      const meta = await gmail.getMessage(sent.id, { format: 'metadata' })
      rfcMessageId = meta.rfcMessageId ?? messageId
    } catch {
      // Metadata is a nicety; a failure here must not re-send an email that already went out.
    }
  }

  let outcome: 'sent' | 'recovered' | 'skipped'
  try {
    outcome = await deps.db.transaction(async (tx) => {
      const swapped = await tx
        .update(supportTickets)
        .set({ gmailThreadId: sent.threadId })
        .where(and(eq(supportTickets.id, ticketId), like(supportTickets.gmailThreadId, formThreadIdLikePattern(ticketId))))
        .returning({ id: supportTickets.id })
      if (swapped.length === 0) return 'skipped'
      await tx
        .insert(supportMessages)
        .values({
          ticketId, gmailMessageId: sent.id, direction: 'outbound', fromEmail: deps.supportAddress,
          bodyText, rfcMessageId, authResults: null, sentAt: now(),
        })
        .onConflictDoNothing({ target: supportMessages.gmailMessageId })
      await tx.insert(auditLog).values({
        actor: 'system', action: FORM_ACK_SENT_ACTION, entityType: 'support_ticket', entityId: ticketId,
        detail: { gmailMessageId: sent.id, threadId: sent.threadId, recovered },
      })
      return recovered ? 'recovered' : 'sent'
    })
  } catch (err) {
    // I7: `gmail_thread_id` is UNIQUE, so if ingest created a ticket for this very thread inside
    // the crash window the swap violates the constraint on every retry — an unrecoverable loop.
    // Page the owner to merge the two tickets by hand and stop the chain instead.
    if (isUniqueViolation(err)) {
      await deps.alert('warning', 'support_form_ack_thread_taken', { ticketId, threadId: sent.threadId }).catch(() => {})
      await auditSkip(deps, ticketId, 'thread_taken')
      return 'skipped'
    }
    throw err
  }
  if (outcome === 'skipped') await auditSkip(deps, ticketId, 'swap_lost')
  return outcome
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

/**
 * Poll stage: any form ticket still on its placeholder after FORM_ACK_SWEEP_AFTER_MS gets its ack
 * job (re-)enqueued — `stately` + singletonKey make this idempotent. Oldest first (T6-2) so the
 * LIMIT can never starve an early ticket behind newer ones.
 *
 * A ticket whose thread id was TAKEN by an ingest-created ticket (I7) is excluded: its swap can
 * only ever raise 23505, so re-enqueueing it every poll cycle buys nothing and grows the audit log
 * forever while occupying one of the LIMIT slots. The `support_form_ack_thread_taken` warning has
 * already asked the owner to merge the two tickets by hand; that merge clears the placeholder and
 * the ticket leaves this select for good.
 */
export async function sweepUnackedFormTickets(deps: { db: Db; enqueue: SendFn; now?: () => Date }): Promise<{ enqueued: number }> {
  const now = deps.now ?? (() => new Date())
  const cutoff = new Date(now().getTime() - FORM_ACK_SWEEP_AFTER_MS)
  const rows = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(
      eq(supportTickets.source, 'form'),
      like(supportTickets.gmailThreadId, 'form:%'),
      lt(supportTickets.createdAt, cutoff),
      notExists(
        deps.db
          .select({ one: sql`1` })
          .from(auditLog)
          .where(and(
            eq(auditLog.action, FORM_ACK_SKIPPED_ACTION),
            // audit_log.entity_id is text, support_tickets.id is uuid.
            sql`${auditLog.entityId} = ${supportTickets.id}::text`,
            sql`${auditLog.detail} ->> 'reason' = 'thread_taken'`,
          )),
      ),
    ))
    .orderBy(asc(supportTickets.createdAt))
    .limit(SWEEP_LIMIT)
  for (const { id } of rows) await deps.enqueue(FORM_ACK_QUEUE, { ticketId: id }, FORM_ACK_SEND_OPTS(id))
  return { enqueued: rows.length }
}
