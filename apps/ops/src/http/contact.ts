import { randomUUID } from 'node:crypto'
import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { FastifyError, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SendOpts } from '../fulfillment/types.ts'
import { FORM_ACK_QUEUE, FORM_ACK_SEND_OPTS } from '../jobs/support-form-ack.ts'
import { formMessageId, formPlaceholderThreadId } from '../support/form-ids.ts'
import { findFloodFoldTarget, MAX_TICKETS_PER_SENDER_PER_DAY, recordInboundOnTicket, type Alert } from '../support/ingest.ts'
import { verifyTurnstile } from '../support/turnstile.ts'

type Db = ReturnType<typeof createDb>['db']

/** Accepted submissions per UTC day — a flood costs at most this many ack emails (spec §2.4). */
export const CONTACT_MAX_PER_DAY = 100
/**
 * Honeypot hits are unauthenticated and reachable before validation/Turnstile (fix round 1,
 * finding 3) — without a ceiling of their own, a bot looping `{"honeypot":"x"}` writes unbounded
 * `audit_log` rows. Capped the same way as real submissions; the response stays 200 `{ok:true}` on
 * both sides of the ceiling — only the audit insert is skipped past it, so the caller sees no
 * change in behavior (nothing here is meant to be observable from outside).
 */
export const HONEYPOT_AUDIT_MAX_PER_DAY = 100
export const FORM_SUBMISSION_ACTION = 'support.form_submission'
export const FORM_HONEYPOT_ACTION = 'support.form_honeypot'
export const FORM_CAPPED_ACTION = 'support.form_capped'
/**
 * Guards the once-per-sender-per-UTC-day `support_sender_flood` alert (fix round 1, finding 4) —
 * same idea as ingest.ts's in-memory `floodAlerted` set ("pages the owner once, not 50 times"), but
 * this path is stateless across HTTP requests, so the guard has to live in the DB instead. Same
 * check-then-insert shape as `FORM_CAPPED_ACTION`'s guard, keyed on the sender rather than the
 * whole endpoint.
 */
export const FORM_FLOOD_ALERT_ACTION = 'support.form_flood_alerted'
/**
 * 32 KB (final review I5). The 8 KB it replaced was BELOW the largest legal submission: `message`
 * alone allows 4000 CHARACTERS, and a CJK/emoji message is 3-4 UTF-8 bytes per character (~16 KB)
 * before the JSON envelope, the name, and a 2 KB Turnstile token — so a perfectly valid non-Latin
 * message was answered 413 by the framework before any of this route's own validation ran.
 */
const BODY_LIMIT_BYTES = 32 * 1024

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
  // Optional per spec (fix round 1, finding 1): the old `.max(...).regex(...).or(z.literal(''))`
  // still required the KEY to be present (some string had to match one of the two branches), and
  // compared the literal `''` against the RAW input — so a whitespace-only value matched neither
  // branch and 400'd. `.trim()` runs before `.refine` ever sees the value, so '   ' takes the ''
  // branch same as an empty string or an absent key; `.optional().default('')` is what actually
  // makes the key itself optional.
  orderNumber: z
    .string()
    .trim()
    .max(20, 'Order number is too long')
    .refine((v) => v === '' || ORDER_RE.test(v), 'That does not look like an order number')
    .optional()
    .default(''),
  message: z.string().trim().min(10, 'Tell us a little more (at least 10 characters)').max(4000, 'Message is too long (4000 characters max)'),
  turnstileToken: z.string().min(1, 'Verification is required').max(2048),
  honeypot: z.string().max(2048).default(''),
  ip: z.string().max(64).nullable().default(null),
})

export function buildTicketSubject(message: string, orderNumber: string | null): string {
  if (orderNumber) return `Contact form: order ${orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`}`
  return `Contact form: ${message.replace(/\s+/g, ' ').slice(0, 60)}`
}

/**
 * Control/format characters out of the customer-supplied name (final review C2a). The name is the
 * FIRST line of a body whose next line is `Order number (claimed): …` — a name carrying `\n` forges
 * a second `Order number (claimed):` line that the admin UI, the agent's prompt and the ack's
 * `^Name: (.+)$` scrape all read as if we had recorded it. Category Cc (control) and Cf (format,
 * incl. the invisible bidi/zero-width family) collapse to a space, runs of whitespace collapse to
 * one, and the result is trimmed.
 */
export function sanitizeFormName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
}

export function buildFormBody(name: string, orderNumber: string | null, message: string): string {
  return `Name: ${sanitizeFormName(name)}\nOrder number (claimed): ${orderNumber ?? '—'}\n\n${message}`
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
 *
 * A plugin-scoped error handler (fix round 1, finding 2) is registered on THIS plugin's Fastify
 * instance, not the top-level app — Fastify's default handler echoes `error.message` back to the
 * client on any unhandled throw, which for a DB failure can be a raw connection string, host, or
 * constraint name. Scoping it to this plugin (rather than a global `setErrorHandler` on `app`)
 * keeps every other route's own error behavior untouched.
 */
export function contactRoutes(deps: ContactRouteDeps): FastifyPluginAsync {
  const verify = deps.verify ?? verifyTurnstile
  const now = deps.now ?? (() => new Date())

  return async (app) => {
    app.setErrorHandler<FastifyError>((err, request, reply) => {
      // Fastify's own protocol-level errors (oversized body, unsupported content-type, bad JSON)
      // carry a legitimate client-facing `statusCode` under 500 and a generic, non-sensitive
      // message — pass those through unchanged. Anything else (a DB failure, a thrown bug) is an
      // internal error: log it and answer with a fixed, content-free body so nothing about the
      // failure (host, credentials, constraint names, stack) ever reaches an anonymous caller.
      const statusCode = typeof err.statusCode === 'number' && err.statusCode < 500 ? err.statusCode : 500
      if (statusCode < 500) {
        return reply.code(statusCode).send({ ok: false, error: 'request' })
      }
      request.log.error({ err }, 'contact form: unhandled error')
      return reply.code(500).send({ ok: false, error: 'internal' })
    })

    app.post('/public/contact', { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const raw = request.body
      if (typeof raw !== 'object' || raw === null) {
        return reply.code(400).send({ ok: false, error: 'validation', fields: { body: 'Expected a JSON object' } })
      }
      // Computed once and reused everywhere below (including the honeypot path, which needs its
      // own UTC-midnight cap check) rather than calling `now()` again at each use site.
      const at = now()
      const midnight = utcMidnight(at)

      // Any NON-EMPTY value counts, whatever its JSON type (final review #14): the old
      // `typeof honeypot === 'string'` test let a bot posting `{"website": 1}` or `{"website":
      // ["x"]}` past the trap and into the real pipeline (zod then 400'd it, naming the honeypot
      // field in the response — a free oracle). Coerce first, then ask if anything is there.
      const honeypotRaw = (raw as { honeypot?: unknown }).honeypot
      const honeypot = honeypotRaw === undefined || honeypotRaw === null ? '' : String(honeypotRaw)
      if (honeypot.trim() !== '') {
        await recordHoneypotHit(deps, midnight)
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

      const turnstile = await verify({
        secretKey: deps.turnstileSecretKey,
        token: input.turnstileToken,
        // Client-supplied ip stays preferred (fix round 1, minor a) — it's what the storefront
        // proxy forwarded from the actual visitor; the raw connection ip is only the floor for
        // when the client omitted one.
        remoteIp: input.ip ?? request.ip,
      })
      if (!turnstile.ok) return reply.code(400).send({ ok: false, error: 'turnstile' })

      const [accepted] = await deps.db
        .select({ value: count() })
        .from(auditLog)
        .where(and(eq(auditLog.action, FORM_SUBMISSION_ACTION), gte(auditLog.createdAt, midnight)))
      if ((accepted?.value ?? 0) >= CONTACT_MAX_PER_DAY) {
        await warnCapped(deps, midnight)
        return reply.code(429).send({ ok: false, error: 'capped' })
      }

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
        // Best-effort, and — like the enqueue branch just below — never allowed to turn an
        // already-committed submission into a client-visible 500 (fix round 1, minor b): a sync
        // throw here must not retry-storm a visitor whose message was, in fact, already recorded.
        try {
          await warnFloodOnce(deps, midnight, input.email, outcome.ticketId)
        } catch {
          // swallowed — see comment above.
        }
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

/**
 * ONE `support_sender_flood` alert per sender per UTC day (fix round 1, finding 4) — see
 * `FORM_FLOOD_ALERT_ACTION`'s doc comment. Check-then-insert guard, same shape as `warnCapped`,
 * keyed on `entityType:'customer_email'`/`entityId:email` instead of a single day-wide row.
 */
async function warnFloodOnce(deps: ContactRouteDeps, midnight: Date, email: string, foldedOntoTicketId: string): Promise<void> {
  const [existing] = await deps.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, FORM_FLOOD_ALERT_ACTION),
      eq(auditLog.entityType, 'customer_email'),
      eq(auditLog.entityId, email),
      gte(auditLog.createdAt, midnight),
    ))
    .limit(1)
  if (existing) return
  await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_FLOOD_ALERT_ACTION, entityType: 'customer_email', entityId: email, detail: {} })
  await deps.alert('warning', 'support_sender_flood', {
    customerEmail: email, foldedOntoTicketId, maxPerDay: MAX_TICKETS_PER_SENDER_PER_DAY, via: 'form',
  }).catch(() => {})
}

/** See `HONEYPOT_AUDIT_MAX_PER_DAY`'s doc comment. */
async function recordHoneypotHit(deps: ContactRouteDeps, midnight: Date): Promise<void> {
  const [today] = await deps.db
    .select({ value: count() })
    .from(auditLog)
    .where(and(eq(auditLog.action, FORM_HONEYPOT_ACTION), gte(auditLog.createdAt, midnight)))
  if ((today?.value ?? 0) >= HONEYPOT_AUDIT_MAX_PER_DAY) return
  await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_HONEYPOT_ACTION, detail: {} })
}
