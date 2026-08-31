import { auditLog, createDb, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORM_ACK_QUEUE, FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION, FORM_ACK_SUBJECT, FORM_ACK_SWEEP_AFTER_MS,
  executeFormAck, formAckBody, formAckHandler, formAckMessageId, nameFromFormBody, sweepUnackedFormTickets,
} from '../src/jobs/support-form-ack.ts'
import { formPlaceholderThreadId } from '../src/support/form-ids.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
const SUPPORT = 'support@dogebuddy.com'
const EMAIL = 'formack-test@example.com'
const NOW = new Date('2024-06-15T12:00:00.000Z')

describe('support.form-ack', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>
  beforeEach(() => { gmail = createMockGmail({ selfAddress: SUPPORT }); alert = vi.fn(async () => {}) })
  afterEach(async () => {
    const rows = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    const ids = rows.map((r) => r.id)
    if (ids.length) { await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ids)); await db.delete(supportTickets).where(inArray(supportTickets.id, ids)) }
    await db.delete(auditLog).where(inArray(auditLog.action, [FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION]))
  })

  async function seedFormTicket(opts: { createdAt?: Date; acked?: boolean } = {}): Promise<string> {
    const [t] = await db.insert(supportTickets).values({
      gmailThreadId: `formack-tmp-${Math.random()}`, customerEmail: EMAIL, subject: 'Contact form: hi', status: 'new', source: 'form',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning({ id: supportTickets.id })
    await db.update(supportTickets).set({ gmailThreadId: opts.acked ? 'real-thread-1' : formPlaceholderThreadId(t!.id) }).where(eq(supportTickets.id, t!.id))
    await db.insert(supportMessages).values({
      ticketId: t!.id, gmailMessageId: `form:${t!.id}`, direction: 'inbound', fromEmail: EMAIL,
      bodyText: 'Name: Rob\nOrder number (claimed): —\n\nhi there friend', sentAt: NOW,
    })
    return t!.id
  }
  const deps = () => ({ db, gmail: gmail as GmailClient, supportAddress: SUPPORT, alert: alert as never, now: () => NOW })

  it('formAckMessageId / formAckBody / nameFromFormBody', () => {
    expect(formAckMessageId('abc', SUPPORT)).toBe('<form-ack-abc@dogebuddy.com>')
    expect(nameFromFormBody('Name: Rob\nOrder number (claimed): —\n\nhi')).toBe('Rob')
    expect(nameFromFormBody(null)).toBe('there')
    expect(formAckBody('Rob')).toBe(
      "Hi Rob,\n\nThanks for reaching out — we've received your message and will reply in this email thread, usually within one business day. If you're writing about a damaged or wrong item, please reply here with a photo.\n\nDoge Buddy Support",
    )
  })

  it('sends the ack on a NEW thread with our Message-ID, swaps the placeholder for the real thread id, records the outbound row', async () => {
    const id = await seedFormTicket()
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(1)
    const raw = Buffer.from(sent[0]!.raw, 'base64url').toString()
    expect(raw).toContain(`Message-ID: <form-ack-${id}@dogebuddy.com>\r\n`)
    expect(raw).toContain(`To: ${EMAIL}\r\n`)
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/) // em dash → RFC 2047
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(sent[0]!.threadId)
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))
    const out = msgs.find((m) => m.direction === 'outbound')
    expect(out).toMatchObject({ gmailMessageId: sent[0]!.id, fromEmail: SUPPORT, rfcMessageId: `<form-ack-${id}@dogebuddy.com>`, sentAt: NOW })
    expect(out!.bodyText).toBe(formAckBody('Rob'))
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SENT_ACTION))).toHaveLength(1)
  })

  it('already acked (no placeholder) → skipped, no send', async () => {
    const id = await seedFormTicket({ acked: true })
    await expect(executeFormAck(deps(), id)).resolves.toBe('skipped')
    expect(gmail.sentMessages()).toHaveLength(0)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SKIPPED_ACTION))).toHaveLength(1)
  })

  it('crash recovery: a sent copy already carries our Message-ID → NO second send, thread recovered from it', async () => {
    const id = await seedFormTicket()
    const prior = await gmail.sendNew({ to: EMAIL, subject: FORM_ACK_SUBJECT, messageId: formAckMessageId(id, SUPPORT), bodyText: 'x' })
    await expect(executeFormAck(deps(), id)).resolves.toBe('recovered')
    expect(gmail.sentMessages()).toHaveLength(1)
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(prior.threadId)
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.gmailMessageId).toBe(prior.id)
  })

  it('a failed send throws (pg-boss retries); nothing recorded', async () => {
    const id = await seedFormTicket()
    gmail.failNext('sendNew', new Error('503'))
    await expect(executeFormAck(deps(), id)).rejects.toThrow('503')
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(formPlaceholderThreadId(id))
  })

  it('handler: on the FINAL retry a failure is alerted as support_form_ack_failed and rethrown', async () => {
    const id = await seedFormTicket()
    gmail.failNext('sendNew', new Error('503'))
    const handler = formAckHandler(deps())
    await expect(handler([{ id: 'j1', name: FORM_ACK_QUEUE, data: { ticketId: id }, retryCount: 5, retryLimit: 5 } as never])).rejects.toThrow('503')
    expect(alert).toHaveBeenCalledWith('critical', 'support_form_ack_failed', expect.objectContaining({ ticketId: id }))
  })

  it('gmail null → throws (misconfiguration must be loud, not a silent skip)', async () => {
    const id = await seedFormTicket()
    await expect(executeFormAck({ ...deps(), gmail: null }, id)).rejects.toThrow(/gmail/i)
  })

  it('sweep: re-enqueues form tickets still on their placeholder after 2 minutes, not fresh ones, not acked ones', async () => {
    const stale = await seedFormTicket({ createdAt: new Date(NOW.getTime() - FORM_ACK_SWEEP_AFTER_MS - 1000) })
    await seedFormTicket({ createdAt: NOW })
    await seedFormTicket({ createdAt: new Date(NOW.getTime() - 10 * 60_000), acked: true })
    const enqueue = vi.fn(async () => {})
    await expect(sweepUnackedFormTickets({ db, enqueue, alert: alert as never, now: () => NOW })).resolves.toEqual({ enqueued: 1 })
    expect(enqueue).toHaveBeenCalledWith(FORM_ACK_QUEUE, { ticketId: stale }, expect.objectContaining({ singletonKey: stale }))
  })
})
