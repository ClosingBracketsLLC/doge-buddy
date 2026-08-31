import { auditLog, createDb, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.ts'
import {
  CONTACT_MAX_PER_DAY,
  FORM_CAPPED_ACTION,
  FORM_FLOOD_ALERT_ACTION,
  FORM_HONEYPOT_ACTION,
  FORM_SUBMISSION_ACTION,
  HONEYPOT_AUDIT_MAX_PER_DAY,
  type ContactRouteDeps,
} from '../src/http/contact.ts'
import { FORM_ACK_QUEUE } from '../src/jobs/support-form-ack.ts'
import { MAX_TICKETS_PER_SENDER_PER_DAY } from '../src/support/ingest.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
const EMAIL = 'contact-test@example.com'
const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z')

function valid(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Rob', email: EMAIL, orderNumber: '', message: 'Hi there, my snuff pad question is here.',
    turnstileToken: 'tok', honeypot: '', ip: '203.0.113.9', ...overrides,
  }
}

describe('POST /public/contact', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let enqueue: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>
  let verify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    enqueue = vi.fn(async () => {})
    alert = vi.fn(async () => {})
    verify = vi.fn(async () => ({ ok: true, errorCodes: [] as string[] }))
  })

  afterEach(async () => {
    const rows = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ids))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ids))
    }
    await db.delete(auditLog).where(inArray(auditLog.action, [FORM_SUBMISSION_ACTION, FORM_HONEYPOT_ACTION, FORM_CAPPED_ACTION, FORM_FLOOD_ALERT_ACTION]))
  })

  function app(overrides: Partial<ContactRouteDeps> = {}) {
    const deps: ContactRouteDeps = {
      db, enqueue: enqueue as never, alert: alert as never, turnstileSecretKey: 'sec',
      verify: verify as never, now: () => FIXED_NOW, ...overrides,
    }
    return buildServer({ pool, isQueueReady: () => true, contact: deps })
  }
  const post = (server: ReturnType<typeof buildServer>, payload: object | string) =>
    server.inject({ method: 'POST', url: '/public/contact', payload })

  it('happy path: verifies Turnstile with the ip, creates a form ticket + inbound message + audit row in one go, enqueues the ack', async () => {
    const res = await post(app(), valid({ orderNumber: '#1001' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ secretKey: 'sec', token: 'tok', remoteIp: '203.0.113.9' }))

    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket).toMatchObject({ source: 'form', status: 'new', subject: 'Contact form: order #1001', gmailSpam: false, lastInboundAt: FIXED_NOW })
    expect(ticket!.gmailThreadId).toBe(`form:${ticket!.id}`)
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, ticket!.id))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ direction: 'inbound', fromEmail: EMAIL, rfcMessageId: null, sentAt: FIXED_NOW })
    expect(msgs[0]!.gmailMessageId).toMatch(/^form:/)
    expect(msgs[0]!.bodyText).toBe('Name: Rob\nOrder number (claimed): #1001\n\nHi there, my snuff pad question is here.')
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, FORM_SUBMISSION_ACTION), eq(auditLog.entityId, ticket!.id)))
    expect(audits).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledWith(FORM_ACK_QUEUE, { ticketId: ticket!.id }, expect.objectContaining({ singletonKey: ticket!.id, retryLimit: 5 }))
  })

  it('subject falls back to the first 60 chars of the message (single line) when no order number is given', async () => {
    const long = 'Line one of a very long message that keeps going\nand going well past sixty characters in total length.'
    await post(app(), valid({ message: long }))
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket!.subject).toBe(`Contact form: ${long.replace(/\s+/g, ' ').slice(0, 60)}`)
  })

  it('honeypot filled → 200 ok, nothing stored, one honeypot audit row, Turnstile never called', async () => {
    const res = await post(app(), valid({ honeypot: 'http://spam' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(verify).not.toHaveBeenCalled()
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_HONEYPOT_ACTION))).toHaveLength(1)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('honeypot audit rows are capped per UTC day: past the ceiling the response stays 200 but no new row is written', async () => {
    await db.insert(auditLog).values(
      Array.from({ length: HONEYPOT_AUDIT_MAX_PER_DAY }, () => ({ actor: 'system', action: FORM_HONEYPOT_ACTION, detail: {}, createdAt: FIXED_NOW })),
    )
    const res = await post(app(), valid({ honeypot: 'http://spam' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_HONEYPOT_ACTION))).toHaveLength(HONEYPOT_AUDIT_MAX_PER_DAY)
  })

  it('orderNumber is optional: a payload without the key at all still succeeds', async () => {
    const { orderNumber: _omit, ...withoutOrderNumber } = valid()
    const res = await post(app(), withoutOrderNumber)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('orderNumber whitespace-only counts as absent: 200, subject falls back to the message snippet', async () => {
    const res = await post(app(), valid({ orderNumber: '   ' }))
    expect(res.statusCode).toBe(200)
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket!.subject).toBe(`Contact form: ${valid().message}`)
  })

  it('validation: bad email, short message, long name, bad order number → 400 with per-field messages; nothing stored', async () => {
    const res = await post(app(), valid({ email: 'nope', message: 'short', name: 'x'.repeat(101), orderNumber: 'not an order' }))
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('validation')
    expect(Object.keys(body.fields).sort()).toEqual(['email', 'message', 'name', 'orderNumber'])
    expect(verify).not.toHaveBeenCalled()
  })

  it('Turnstile failure → 400 turnstile, nothing stored', async () => {
    verify.mockResolvedValueOnce({ ok: false, errorCodes: ['invalid-input-response'] })
    const res = await post(app(), valid())
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ ok: false, error: 'turnstile' })
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toEqual([])
  })

  it('daily cap: the 101st accepted submission of the UTC day → 429 + ONE capped warning per day', async () => {
    await db.insert(auditLog).values(Array.from({ length: CONTACT_MAX_PER_DAY }, () => ({ actor: 'system', action: FORM_SUBMISSION_ACTION, detail: {}, createdAt: FIXED_NOW })))
    const server = app()
    const res = await post(server, valid())
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ ok: false, error: 'capped' })
    expect(alert).toHaveBeenCalledWith('warning', 'support_form_capped', expect.any(Object))
    const again = await post(server, valid())
    expect(again.statusCode).toBe(429)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_CAPPED_ACTION))).toHaveLength(1)
  })

  it('per-sender fold: the 6th ticket in a UTC day lands as a message on the sender\'s newest ticket (no new ticket, no ack job)', async () => {
    const server = app()
    for (let i = 0; i < MAX_TICKETS_PER_SENDER_PER_DAY; i++) expect((await post(server, valid({ message: `message number ${i} here` }))).statusCode).toBe(200)
    enqueue.mockClear()
    const res = await post(server, valid({ message: 'one more message from me' }))
    expect(res.statusCode).toBe(200)
    const tickets = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(tickets).toHaveLength(MAX_TICKETS_PER_SENDER_PER_DAY)
    const msgCounts = await Promise.all(tickets.map(async (t) => (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, t.id))).length))
    expect(msgCounts.reduce((a, b) => a + b, 0)).toBe(MAX_TICKETS_PER_SENDER_PER_DAY + 1)
    expect(enqueue).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', 'support_sender_flood', expect.objectContaining({ customerEmail: EMAIL }))

    // A second folded submission from the SAME sender on the SAME UTC day must not page the owner
    // again — ingest.ts's own per-poll dedup exists for the identical reason ("pages the owner
    // once, not 50 times"); this is that same guarantee across separate HTTP requests. Two folds
    // in a row → `support_sender_flood` fires exactly once total.
    const secondFold = await post(server, valid({ message: 'yet another message from me' }))
    expect(secondFold.statusCode).toBe(200)
    const floodAlertCalls = alert.mock.calls.filter(([, kind]) => kind === 'support_sender_flood')
    expect(floodAlertCalls).toHaveLength(1)
  })

  it('tripwire: a keyword in the message escalates the ticket with escalation_notified_at null', async () => {
    await post(app(), valid({ message: 'If this is not fixed I will file a chargeback with my bank today.' }))
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket!.status).toBe('escalated')
    expect(ticket!.escalationReason).toBe('tripwire: chargeback')
    expect(ticket!.escalationNotifiedAt).toBeNull()
  })

  it('atomic: a failing ack enqueue does NOT lose the ticket (enqueue runs after commit; failure is alerted, the poll sweep re-enqueues)', async () => {
    enqueue.mockRejectedValueOnce(new Error('boss down'))
    const res = await post(app(), valid())
    expect(res.statusCode).toBe(200)
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toHaveLength(1)
    expect(alert).toHaveBeenCalledWith('warning', 'support_form_ack_enqueue_failed', expect.any(Object))
  })

  it('an unhandled error (e.g. a DB failure) is contained by a plugin-scoped error handler: 500 {ok:false,error:"internal"}, no internals leaked', async () => {
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:5433')
    const originalTransaction = db.transaction
    // Mutate the real db instance's `transaction` method in place (rather than spreading a copy —
    // drizzle's other methods rely on internal state a plain-object spread doesn't carry) so every
    // other query still works right up to the point the handler calls `db.transaction(...)`.
    ;(db as unknown as { transaction: unknown }).transaction = () => {
      throw boom
    }
    try {
      const res = await post(app(), valid())
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ ok: false, error: 'internal' })
      expect(res.body).not.toContain('ECONNREFUSED')
      expect(res.body).not.toContain('127.0.0.1')
      expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toEqual([])
    } finally {
      ;(db as unknown as { transaction: unknown }).transaction = originalTransaction
    }
  })

  it('rejects non-JSON and oversized bodies without touching the DB', async () => {
    const server = app()
    const res = await server.inject({ method: 'POST', url: '/public/contact', payload: 'name=x', headers: { 'content-type': 'text/plain' } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const big = await post(server, valid({ message: 'a'.repeat(9000) }))
    expect(big.statusCode).toBe(413)
  })
})
