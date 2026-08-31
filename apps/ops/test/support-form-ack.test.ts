import { auditLog, createDb, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORM_ACK_BODY_SCREENED_ACTION, FORM_ACK_QUEUE, FORM_ACK_SEND_OPTS, FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION,
  FORM_ACK_SUBJECT, FORM_ACK_SWEEP_AFTER_MS, executeFormAck, formAckBody, formAckHandler, formAckMessageId,
  greetingName, nameFromFormBody, sweepUnackedFormTickets,
} from '../src/jobs/support-form-ack.ts'
import { PROPOSAL_RETRY_OPTS } from '../src/proposals/submit.ts'
import { formPlaceholderThreadId, formSendingSentinel } from '../src/support/form-ids.ts'

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
    await db.delete(auditLog).where(inArray(auditLog.action, [FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION, FORM_ACK_BODY_SCREENED_ACTION]))
  })

  async function seedFormTicket(opts: { createdAt?: Date; acked?: boolean; name?: string; threadId?: string } = {}): Promise<string> {
    const [t] = await db.insert(supportTickets).values({
      gmailThreadId: `formack-tmp-${Math.random()}`, customerEmail: EMAIL, subject: 'Contact form: hi', status: 'new', source: 'form',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning({ id: supportTickets.id })
    const threadId = opts.threadId ?? (opts.acked ? 'real-thread-1' : formPlaceholderThreadId(t!.id))
    await db.update(supportTickets).set({ gmailThreadId: threadId }).where(eq(supportTickets.id, t!.id))
    await db.insert(supportMessages).values({
      ticketId: t!.id, gmailMessageId: `form:${t!.id}`, direction: 'inbound', fromEmail: EMAIL,
      bodyText: `Name: ${opts.name ?? 'Rob'}\nOrder number (claimed): —\n\nhi there friend`, sentAt: NOW,
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

  it('a failed send throws (pg-boss retries); nothing recorded and the claim is RELEASED so the retry can re-send', async () => {
    const id = await seedFormTicket()
    gmail.failNext('sendNew', new Error('503'))
    await expect(executeFormAck(deps(), id)).rejects.toThrow('503')
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(formPlaceholderThreadId(id))
    // and the retry really does go through
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    expect(gmail.sentMessages()).toHaveLength(1)
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
    await expect(sweepUnackedFormTickets({ db, enqueue, now: () => NOW })).resolves.toEqual({ enqueued: 1 })
    expect(enqueue).toHaveBeenCalledWith(FORM_ACK_QUEUE, { ticketId: stale }, expect.objectContaining({ singletonKey: stale }))
  })

  // -- C1: exactly-once across concurrent workers and crashes --

  it("a concurrent worker that finds the sentinel returns 'skipped' and sends nothing", async () => {
    const id = await seedFormTicket()
    // Worker A has claimed the ticket and is inside gmail.sendNew right now.
    await db.update(supportTickets).set({ gmailThreadId: formSendingSentinel(id) }).where(eq(supportTickets.id, id))
    await expect(executeFormAck(deps(), id)).resolves.toBe('skipped')
    expect(gmail.sentMessages()).toHaveLength(0)
    const skipped = await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SKIPPED_ACTION))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'claimed_elsewhere' })
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))
    expect(msgs.filter((m) => m.direction === 'outbound')).toHaveLength(0)
  })

  it('the send CLAIMS the ticket first: the sentinel is still a form: placeholder, so the reply worker keeps holding', async () => {
    const id = await seedFormTicket()
    let seenMidSend: string | undefined
    const claimWatcher = {
      ...gmail,
      sendNew: async (r: Parameters<MockGmail['sendNew']>[0]) => {
        const [mid] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
        seenMidSend = mid!.gmailThreadId
        return gmail.sendNew(r)
      },
    }
    await expect(executeFormAck({ ...deps(), gmail: claimWatcher as unknown as GmailClient }, id)).resolves.toBe('sent')
    expect(seenMidSend).toMatch(new RegExp(`^form:${id}:sending:`))
  })

  it('crash recovery still works with the sentinel in place (died between send and DB write)', async () => {
    const id = await seedFormTicket()
    const prior = await gmail.sendNew({ to: EMAIL, subject: FORM_ACK_SUBJECT, messageId: formAckMessageId(id, SUPPORT), bodyText: 'x' })
    await db.update(supportTickets).set({ gmailThreadId: formSendingSentinel(id) }).where(eq(supportTickets.id, id))
    await expect(executeFormAck(deps(), id)).resolves.toBe('recovered')
    expect(gmail.sentMessages()).toHaveLength(1)
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(prior.threadId)
  })

  it('guarded swap loses the race → no outbound row, no form_ack_sent audit row', async () => {
    const id = await seedFormTicket()
    // Another worker completes the whole swap while this one is inside gmail.sendNew.
    const racing = {
      ...gmail,
      sendNew: async (r: Parameters<MockGmail['sendNew']>[0]) => {
        const res = await gmail.sendNew(r)
        await db.update(supportTickets).set({ gmailThreadId: `raced-${id}` }).where(eq(supportTickets.id, id))
        return res
      },
    }
    await expect(executeFormAck({ ...deps(), gmail: racing as unknown as GmailClient }, id)).resolves.toBe('skipped')
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))
    expect(msgs.filter((m) => m.direction === 'outbound')).toHaveLength(0)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SENT_ACTION))).toHaveLength(0)
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(`raced-${id}`)
  })

  // -- I7: the thread id was taken by an ingest-created ticket inside the crash window --

  it("swap hits a UNIQUE violation → warning alert, 'skipped', no throw (the retry chain stops)", async () => {
    const id = await seedFormTicket()
    const prior = await gmail.sendNew({ to: EMAIL, subject: FORM_ACK_SUBJECT, messageId: formAckMessageId(id, SUPPORT), bodyText: 'x' })
    // Ingest got there first and already owns this thread id.
    await db.insert(supportTickets).values({ gmailThreadId: prior.threadId, customerEmail: EMAIL, subject: 'from ingest', status: 'new' })
    await expect(executeFormAck(deps(), id)).resolves.toBe('skipped')
    expect(alert).toHaveBeenCalledWith('warning', 'support_form_ack_thread_taken', expect.objectContaining({ ticketId: id, threadId: prior.threadId }))
    const skipped = await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SKIPPED_ACTION))
    expect(skipped[0]!.detail).toMatchObject({ reason: 'thread_taken' })
  })

  // -- C2: the customer-supplied name never becomes free copy signed by support@ --

  it('greetingName: keeps real names, rejects everything that could carry a lure', () => {
    expect(greetingName('Rob')).toBe('Rob')
    expect(greetingName("María-José O'Neil")).toBe("María-José O'Neil")
    expect(greetingName('  Rob  ')).toBe('Rob')
    expect(greetingName('there — your refund of $89 has been approved, see')).toBe('there')
    expect(greetingName('there, verify at http://evil.example/x')).toBe('there')
    expect(greetingName('Rob\nOrder number (claimed): #9999')).toBe('Rob')
    expect(greetingName('Rob​ert')).toBe('there')
    expect(greetingName('a'.repeat(41))).toBe('there')
    expect(greetingName('')).toBe('there')
    expect(greetingName(null)).toBe('there')
    expect(nameFromFormBody('Name: there, verify at http://evil.example/x\n\nhi')).toBe('there')
  })

  it.each([
    'there — your refund of $89 has been approved, see',
    'there, verify at http://evil.example/x',
    'Rob​',
  ])('a hostile name (%s) is not reflected into the ack — it greets "there" and still sends', async (name) => {
    const id = await seedFormTicket({ name })
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.bodyText).toBe(formAckBody('there'))
    expect(out!.bodyText!.startsWith('Hi there,')).toBe(true)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SENT_ACTION))).toHaveLength(1)
  })

  it('an in-class name that still composes a body failing validateReplyBody falls back to the nameless copy + audit', async () => {
    const id = await seedFormTicket({ name: 'Your refund has been approved' })
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.bodyText).toBe(formAckBody('there'))
    const screened = await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_BODY_SCREENED_ACTION))
    expect(screened).toHaveLength(1)
    expect(screened[0]!.detail).toMatchObject({ reason: 'promised_action' })
    const raw = Buffer.from(gmail.sentMessages()[0]!.raw, 'base64url').toString()
    expect(raw).not.toContain('refund')
  })

  it('a normal name is kept', async () => {
    const id = await seedFormTicket({ name: "María-José O'Neil" })
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.bodyText).toBe(formAckBody("María-José O'Neil"))
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_BODY_SCREENED_ACTION))).toHaveLength(0)
  })

  // -- #13: store the Message-ID Gmail actually stamped --

  it("persists the SENT message's real rfcMessageId (read back via getMessage metadata)", async () => {
    const id = await seedFormTicket()
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const sent = gmail.sentMessages()[0]!
    const meta = await gmail.getMessage(sent.id, { format: 'metadata' })
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(meta.rfcMessageId).not.toBeNull()
    expect(out!.rfcMessageId).toBe(meta.rfcMessageId)
  })

  it('a metadata read-back failure falls back to our generated Message-ID (never a re-send)', async () => {
    const id = await seedFormTicket()
    gmail.failNext('getMessage', new Error('500'))
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.rfcMessageId).toBe(formAckMessageId(id, SUPPORT))
    expect(gmail.sentMessages()).toHaveLength(1)
  })

  it('the ack retry budget stays UNDER the reply worker’s apply budget (I4)', () => {
    const ack = FORM_ACK_SEND_OPTS('t')
    expect(ack).toMatchObject({ retryLimit: 5, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 })
    const chain = (delay: number, limit: number) => Array.from({ length: limit }, (_, i) => delay * 2 ** i).reduce((a, b) => a + b, 0)
    expect(chain(ack.retryDelay!, ack.retryLimit!)).toBeLessThan(chain(PROPOSAL_RETRY_OPTS.retryDelay, PROPOSAL_RETRY_OPTS.retryLimit))
  })

  it('sweep returns the OLDEST stuck tickets first (T6-2)', async () => {
    const older = await seedFormTicket({ createdAt: new Date(NOW.getTime() - 60 * 60_000) })
    const newer = await seedFormTicket({ createdAt: new Date(NOW.getTime() - 30 * 60_000) })
    const seen: string[] = []
    const enqueue = vi.fn(async (_name: string, data: object) => { seen.push((data as { ticketId: string }).ticketId) })
    await sweepUnackedFormTickets({ db, enqueue, now: () => NOW })
    expect(seen).toEqual([older, newer])
  })
})
