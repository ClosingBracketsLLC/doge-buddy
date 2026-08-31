import { randomUUID } from 'node:crypto'
import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SendOpts } from '../fulfillment/types.ts'
import { FORM_ACK_QUEUE, FORM_ACK_SEND_OPTS } from '../jobs/support-form-ack.ts'
import { formMessageId, formPlaceholderThreadId } from '../support/form-ids.ts'
import { findFloodFoldTarget, MAX_TICKETS_PER_SENDER_PER_DAY, recordInboundOnTicket, type Alert } from '../support/ingest.ts'
import { verifyTurnstile } from '../support/turnstile.ts'

type Db = ReturnType<typeof createDb>['db']

/** Accepted submissions per UTC day — a flood costs at most this many ack emails (spec §2.4). */
export const CONTACT_MAX_PER_DAY = 100
export const FORM_SUBMISSION_ACTION = 'support.form_submission'
export const FORM_HONEYPOT_ACTION = 'support.form_honeypot'
export const FORM_CAPPED_ACTION = 'support.form_capped'
const BODY_LIMIT_BYTES = 8 * 1024

export interface ContactRouteDeps {
  db: Db
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
  turnstileSecretKey: string
  /** Injectable seam for tests; production uses the real siteverify call. */
  verify?: typeof verifyTurnstile
  now?: () => Date
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORDER_RE = /^#?[0-9A-Za-z-]{1,19}$/

const SubmissionSchema = z.object({
  name: z.string().trim().min(1, 'Please tell us your name').max(100, 'Name is too long'),
  email: z.string().trim().toLowerCase().max(254, 'Email is too long').regex(EMAIL_RE, 'Enter a valid email address'),
  orderNumber: z.string().trim().max(20, 'Order number is too long').regex(ORDER_RE, 'That does not look like an order number').or(z.literal('')),
  message: z.string().trim().min(10, 'Tell us a little more (at least 10 characters)').max(4000, 'Message is too long (4000 characters max)'),
  turnstileToken: z.string().min(1, 'Verification is required').max(2048),
  honeypot: z.string().max(2048).default(''),
  ip: z.string().max(64).nullable().default(null),
})

export function buildTicketSubject(message: string, orderNumber: string | null): string {
  if (orderNumber) return `Contact form: order ${orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`}`
  return `Contact form: ${message.replace(/\s+/g, ' ').slice(0, 60)}`
}

export function buildFormBody(name: string, orderNumber: string | null, message: string): string {
  return `Name: ${name}\nOrder number (claimed): ${orderNumber ?? '—'}\n\n${message}`
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * `POST /public/contact` (spec 2026-08-31 §2). Registered only when Gmail AND Turnstile are
 * configured (index.ts) — without either the route does not exist and the storefront shows its
 * "unavailable" copy. Check order is a hard sequence: honeypot → validation → Turnstile → daily cap
 * → one transaction (fold | create ticket; inbound row; shared inbound bookkeeping incl. tripwire;
 * submission audit) → enqueue the ack AFTER commit (failure alerted; the poll sweep re-enqueues).
 */
export function contactRoutes(deps: ContactRouteDeps): FastifyPluginAsync {
  const verify = deps.verify ?? verifyTurnstile
  const now = deps.now ?? (() => new Date())

  return async (app) => {
    app.post('/public/contact', { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const raw = request.body
      if (typeof raw !== 'object' || raw === null) {
        return reply.code(400).send({ ok: false, error: 'validation', fields: { body: 'Expected a JSON object' } })
      }
      const honeypot = (raw as { honeypot?: unknown }).honeypot
      if (typeof honeypot === 'string' && honeypot.trim() !== '') {
        await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_HONEYPOT_ACTION, detail: {} })
        return reply.code(200).send({ ok: true })
      }

      const parsed = SubmissionSchema.safeParse(raw)
      if (!parsed.success) {
        const fields: Record<string, string> = {}
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? 'body')
          if (!(key in fields)) fields[key] = issue.message
        }
        return reply.code(400).send({ ok: false, error: 'validation', fields })
      }
      const input = parsed.data
      const orderNumber = input.orderNumber === '' ? null : input.orderNumber

      const turnstile = await verify({ secretKey: deps.turnstileSecretKey, token: input.turnstileToken, remoteIp: input.ip })
      if (!turnstile.ok) return reply.code(400).send({ ok: false, error: 'turnstile' })

      const midnight = utcMidnight(now())
      const [accepted] = await deps.db
        .select({ value: count() })
        .from(auditLog)
        .where(and(eq(auditLog.action, FORM_SUBMISSION_ACTION), gte(auditLog.createdAt, midnight)))
      if ((accepted?.value ?? 0) >= CONTACT_MAX_PER_DAY) {
        await warnCapped(deps, midnight)
        return reply.code(429).send({ ok: false, error: 'capped' })
      }

      const at = now()
      const subject = buildTicketSubject(input.message, orderNumber)
      const bodyText = buildFormBody(input.name, orderNumber, input.message)

      const outcome = await deps.db.transaction(async (tx) => {
        const foldTarget = await findFloodFoldTarget(tx, at, input.email)
        let ticketId: string
        if (foldTarget) {
          ticketId = foldTarget.id
        } else {
          // Temporary literal for the insert-then-update dance below (the ticket id is
          // DB-generated, so the real placeholder can't be known until after the insert
          // returns). `gmail_thread_id` is UNIQUE, so a bare 'pending' would collide between two
          // concurrent submissions racing this same statement — the randomUUID suffix makes each
          // insert's temporary value unique regardless.
          const [created] = await tx
            .insert(supportTickets)
            .values({ gmailThreadId: `pending:${randomUUID()}`, customerEmail: input.email, subject, status: 'new', source: 'form' })
            .returning({ id: supportTickets.id })
          ticketId = created!.id
          await tx.update(supportTickets).set({ gmailThreadId: formPlaceholderThreadId(ticketId) }).where(eq(supportTickets.id, ticketId))
        }
        await tx.insert(supportMessages).values({
          ticketId, gmailMessageId: formMessageId(), direction: 'inbound', fromEmail: input.email,
          bodyText, rfcMessageId: null, authResults: null, sentAt: at,
        })
        const tripwireKeyword = await recordInboundOnTicket(tx, { ticketId, subject, bodyText, sentAt: at, gmailSpam: false })
        await tx.insert(auditLog).values({
          actor: 'system', action: FORM_SUBMISSION_ACTION, entityType: 'support_ticket', entityId: ticketId,
          detail: { folded: foldTarget !== null, tripwire: tripwireKeyword },
        })
        return { ticketId, folded: foldTarget !== null }
      })

      if (outcome.folded) {
        await deps.alert('warning', 'support_sender_flood', {
          customerEmail: input.email, foldedOntoTicketId: outcome.ticketId, maxPerDay: MAX_TICKETS_PER_SENDER_PER_DAY, via: 'form',
        }).catch(() => {})
      } else {
        try {
          await deps.enqueue(FORM_ACK_QUEUE, { ticketId: outcome.ticketId }, FORM_ACK_SEND_OPTS(outcome.ticketId))
        } catch (err) {
          await deps.alert('warning', 'support_form_ack_enqueue_failed', {
            ticketId: outcome.ticketId, error: err instanceof Error ? err.message : String(err),
          }).catch(() => {})
        }
      }
      return reply.code(200).send({ ok: true })
    })
  }
}

/** ONE cap warning per UTC day, guarded by that day's audit row (the triage-cap idiom). */
async function warnCapped(deps: ContactRouteDeps, midnight: Date): Promise<void> {
  const [existing] = await deps.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, FORM_CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
    .limit(1)
  if (existing) return
  await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_CAPPED_ACTION, detail: { max: CONTACT_MAX_PER_DAY } })
  await deps.alert('warning', 'support_form_capped', { max: CONTACT_MAX_PER_DAY }).catch(() => {})
}
