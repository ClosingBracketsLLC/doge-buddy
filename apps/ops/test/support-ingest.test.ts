import { auditLog, createDb, gmailSyncState, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, GmailApiError, MessageGoneError, type MockGmail } from '@doge-buddy/gmail'
import { asc, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TICKETS_PER_SENDER_PER_DAY,
  NEW_LABEL,
  runIngest,
  tripwireHit,
  type IngestDeps,
} from '../src/support/ingest.ts'
import { notifyPendingEscalations } from '../src/support/escalate.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SUPPORT = 'support@dogebuddy.com'

describe('runIngest', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>
  let deps: IngestDeps

  beforeEach(() => {
    // selfAddress mirrors production: the impersonated mailbox IS the support address, so the
    // mock's own SENT copies (sendDraft/sendReply) carry `From: support@`.
    gmail = createMockGmail({ selfAddress: SUPPORT })
    alert = vi.fn(async () => {})
    deps = { db, gmail, supportAddress: SUPPORT, alert }
  })

  // Everything this file creates is reachable from the mock's `mock-thread-*` ids, so the sweep is
  // both complete and scoped to this file (vitest runs files serially — see vitest.config.ts).
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'mock-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, 1))
    vi.restoreAllMocks()
  })

  /** Seeds gmail_sync_state from the mock's current historyId (spec §2.1) so the next call walks. */
  async function seedSyncState(): Promise<void> {
    await runIngest(deps)
  }

  async function syncState(): Promise<{ lastHistoryId: bigint | null } | undefined> {
    const [row] = await db
      .select({ lastHistoryId: gmailSyncState.lastHistoryId })
      .from(gmailSyncState)
      .where(eq(gmailSyncState.id, 1))
    return row
  }

  async function ticketByThread(threadId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.gmailThreadId, threadId))
    return row
  }

  async function messagesOfTicket(ticketId: string) {
    return db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.ticketId, ticketId))
      .orderBy(asc(supportMessages.sentAt))
  }

  async function newLabelId(): Promise<string | undefined> {
    const labels = await gmail.listLabels()
    return labels.find((l) => l.name === NEW_LABEL)?.id
  }

  it('seed-on-null: first run stores the profile historyId and ingests nothing', async () => {
    gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Pre-existing', bodyText: 'hi' })

    const result = await runIngest(deps)

    expect(result).toEqual({ insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] })
    expect((await syncState())?.lastHistoryId).toBe(1n)
    expect(await db.select().from(supportTickets).where(like(supportTickets.gmailThreadId, 'mock-%'))).toEqual([])
  })

  // 1
  it('inbound mail to support@ creates the ticket, the message row, and the DogeBuddy/New label', async () => {
    await seedSyncState()
    const sent = gmail.receiveInbound({
      from: 'Jane Doe <Jane@Example.COM>',
      to: [SUPPORT],
      subject: 'Where is my order?',
      bodyText: 'Ordered a week ago and heard nothing.',
    })

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)

    const ticket = await ticketByThread(sent.threadId)
    expect(ticket).toBeDefined()
    expect(ticket!.customerEmail).toBe('jane@example.com')
    expect(ticket!.subject).toBe('Where is my order?')
    expect(ticket!.status).toBe('new')
    expect(result.newInboundTicketIds).toEqual([ticket!.id])

    const messages = await messagesOfTicket(ticket!.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.gmailMessageId).toBe(sent.id)
    expect(messages[0]!.direction).toBe('inbound')
    expect(messages[0]!.fromEmail).toBe('jane@example.com')
    expect(messages[0]!.bodyText).toBe('Ordered a week ago and heard nothing.')
    expect(messages[0]!.rfcMessageId).toBe(`<${sent.id}@mock.gmail>`)
    expect(messages[0]!.sentAt).toEqual(ticket!.lastInboundAt)

    expect(gmail.labelsOf(sent.id)).toContain(await newLabelId())
    expect(alert).not.toHaveBeenCalled()
  })

  it('matches the support address on Cc and on Delivered-To, not just To', async () => {
    await seedSyncState()
    const viaCc = gmail.receiveInbound({
      from: 'cc@example.com', to: ['someone@example.com'], cc: [SUPPORT], subject: 'cc', bodyText: 'cc body',
    })
    const viaDeliveredTo = gmail.receiveInbound({
      from: 'dt@example.com', to: ['alias@dogebuddy.com'], deliveredTo: [SUPPORT], subject: 'dt', bodyText: 'dt body',
    })

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(2)
    expect(await ticketByThread(viaCc.threadId)).toBeDefined()
    expect(await ticketByThread(viaDeliveredTo.threadId)).toBeDefined()
  })

  // 2
  it('mail not addressed to support@ is skipped without ever fetching its body', async () => {
    await seedSyncState()
    const other = gmail.receiveInbound({
      from: 'someone@example.com',
      to: ['marketing@dogebuddy.com'],
      subject: 'Partnership?',
      bodyText: 'private, must never be read',
    })
    const getMessage = vi.spyOn(gmail, 'getMessage')

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(0)
    expect(await ticketByThread(other.threadId)).toBeUndefined()
    expect(await db.select().from(supportMessages).where(eq(supportMessages.gmailMessageId, other.id))).toEqual([])

    const fullFetches = getMessage.mock.calls.filter(([id, opts]) => id === other.id && opts.format === 'full')
    expect(fullFetches).toEqual([])
    expect(getMessage.mock.calls.filter(([id]) => id === other.id)).toHaveLength(1)
  })

  it('a spoofed display name containing support@ does not pass the filter', async () => {
    await seedSyncState()
    const spoof = gmail.receiveInbound({
      from: 'evil@evil.test',
      to: ['"support@dogebuddy.com" <victim@evil.test>'],
      subject: 'spoof',
      bodyText: 'spoof body',
    })
    const legit = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await ticketByThread(legit.threadId)).toBeDefined()
    expect(await ticketByThread(spoof.threadId)).toBeUndefined()
  })

  // 3
  it('re-running with no new history inserts nothing and touches no labels; re-seen messages stay side-effect-free', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

    const modifyMessage = vi.spyOn(gmail, 'modifyMessage')

    const noop = await runIngest(deps)
    expect(noop.insertedMessages).toBe(0)
    expect(modifyMessage).not.toHaveBeenCalled()

    // Force the SAME message to be walked again (what a crash-replay or a resync does): the
    // ON CONFLICT DO NOTHING insert returns no row, so no reopen, no label, no counter bump.
    await db.update(gmailSyncState).set({ lastHistoryId: 0n }).where(eq(gmailSyncState.id, 1))
    const replay = await runIngest(deps)

    expect(replay.insertedMessages).toBe(0)
    expect(replay.newInboundTicketIds).toEqual([])
    expect(modifyMessage).not.toHaveBeenCalled()
    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(await messagesOfTicket(ticket.id)).toHaveLength(1)
  })

  // 4
  it('a follow-up reopens a resolved ticket and bumps last_inbound_at', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db
      .update(supportTickets)
      .set({ status: 'resolved', triageFailureCount: 1 })
      .where(eq(supportTickets.id, ticket.id))

    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'still broken', threadId: first.threadId,
    })
    await runIngest(deps)

    const reopened = (await ticketByThread(first.threadId))!
    expect(reopened.status).toBe('new')
    expect(reopened.lastInboundAt!.getTime()).toBeGreaterThan(ticket.lastInboundAt!.getTime())
    expect(await messagesOfTicket(ticket.id)).toHaveLength(2)
    // Reopening restarts the triage budget for this ticket (spec §3: reset on success and on reopen).
    expect(reopened.triageFailureCount).toBe(0)
  })

  it('a reply Gmail filed under a NEW thread still attaches to the original ticket via In-Reply-To (no duplicate ticket)', async () => {
    // Seen live 2026-08-30: the customer's first email sat in Gmail's Spam folder; their follow-up
    // (a proper reply, In-Reply-To set) landed in the INBOX under a brand-new Gmail thread id, so
    // thread-keyed lookup opened a SECOND ticket — which then counted toward repeat-complainant.
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    const [firstRow] = await messagesOfTicket(ticket.id)
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

    const reply = gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'following up',
      inReplyTo: firstRow!.rfcMessageId, references: firstRow!.rfcMessageId,
      // NO threadId → the mock assigns a fresh one, exactly what Gmail did.
    })
    await runIngest(deps)

    expect(reply.threadId).not.toBe(first.threadId)
    expect(await ticketByThread(reply.threadId)).toBeUndefined() // no second ticket
    const reopened = (await ticketByThread(first.threadId))!
    expect(reopened.status).toBe('new')
    const msgs = await messagesOfTicket(ticket.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.gmailMessageId).toBe(reply.id)
  })

  it('a follow-up on a waiting_on_customer ticket reopens it, but an escalated ticket stays escalated', async () => {
    await seedSyncState()
    const waiting = gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'W', bodyText: 'w' })
    const escalated = gmail.receiveInbound({ from: 'b@example.com', to: [SUPPORT], subject: 'E', bodyText: 'e' })
    await runIngest(deps)
    const waitingTicket = (await ticketByThread(waiting.threadId))!
    const escalatedTicket = (await ticketByThread(escalated.threadId))!
    await db.update(supportTickets).set({ status: 'waiting_on_customer' }).where(eq(supportTickets.id, waitingTicket.id))
    await db
      .update(supportTickets)
      .set({ status: 'escalated', escalationReason: 'owner escalated' })
      .where(eq(supportTickets.id, escalatedTicket.id))

    gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'Re: W', bodyText: 'w2', threadId: waiting.threadId })
    gmail.receiveInbound({ from: 'b@example.com', to: [SUPPORT], subject: 'Re: E', bodyText: 'e2', threadId: escalated.threadId })
    await runIngest(deps)

    expect((await ticketByThread(waiting.threadId))!.status).toBe('new')
    const stillEscalated = (await ticketByThread(escalated.threadId))!
    expect(stillEscalated.status).toBe('escalated')
    expect(stillEscalated.escalationReason).toBe('owner escalated')
  })

  it('last_inbound_at is a GREATEST bump: an older message never moves it backwards', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    const future = new Date('2099-01-01T00:00:00.000Z')
    await db.update(supportTickets).set({ lastInboundAt: future }).where(eq(supportTickets.id, ticket.id))

    gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'more', threadId: first.threadId })
    await runIngest(deps)

    expect((await ticketByThread(first.threadId))!.lastInboundAt).toEqual(future)
  })

  // Per-sender flood bound (spec §3, last bullet).
  it('folds a flooding sender`s 6th same-day thread into their newest ticket instead of creating a 6th, with one warning per poll', async () => {
    await seedSyncState()
    const flooder = 'flood@example.com'
    async function ticketsOfFlooder() {
      return db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.customerEmail, flooder))
        .orderBy(asc(supportTickets.createdAt))
    }

    for (let i = 0; i < MAX_TICKETS_PER_SENDER_PER_DAY; i++) {
      gmail.receiveInbound({ from: flooder, to: [SUPPORT], subject: `Flood ${i}`, bodyText: `body ${i}` })
    }
    await runIngest(deps)

    const seeded = await ticketsOfFlooder()
    expect(seeded).toHaveLength(MAX_TICKETS_PER_SENDER_PER_DAY)
    const newest = seeded[seeded.length - 1]!
    expect(alert).not.toHaveBeenCalled()

    const sixth = gmail.receiveInbound({ from: flooder, to: [SUPPORT], subject: 'Flood 6', bodyText: 'body 6' })
    const result = await runIngest(deps)

    // The message is still ingested — it just lands on the existing ticket, with no 6th ticket and
    // no new thread row anywhere.
    expect(result.insertedMessages).toBe(1)
    expect(await ticketsOfFlooder()).toHaveLength(MAX_TICKETS_PER_SENDER_PER_DAY)
    expect(await ticketByThread(sixth.threadId)).toBeUndefined()
    expect((await messagesOfTicket(newest.id)).map((m) => m.gmailMessageId)).toContain(sixth.id)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('warning', 'support_sender_flood', expect.objectContaining({ customerEmail: flooder }))

    // Two more folds inside ONE poll still page the owner only once (the alert bound is the point).
    gmail.receiveInbound({ from: flooder, to: [SUPPORT], subject: 'Flood 7', bodyText: 'body 7' })
    gmail.receiveInbound({ from: flooder, to: [SUPPORT], subject: 'Flood 8', bodyText: 'body 8' })
    await runIngest(deps)

    expect(await ticketsOfFlooder()).toHaveLength(MAX_TICKETS_PER_SENDER_PER_DAY)
    // Its own original message plus the 6th, 7th and 8th threads folded onto it.
    expect(await messagesOfTicket(newest.id)).toHaveLength(4)
    expect(alert).toHaveBeenCalledTimes(2)
  })

  // 5
  it('draft churn produces zero draft rows and exactly one outbound row (the SENT copy)', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

    gmail.saveDraft({ threadId: first.threadId, bodyText: 'draft rev 1' })
    gmail.saveDraft({ threadId: first.threadId, bodyText: 'draft rev 2' })
    const sent = gmail.sendDraft(first.threadId)
    const modifyMessage = vi.spyOn(gmail, 'modifyMessage')

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(result.newInboundTicketIds).toEqual([])

    const messages = await messagesOfTicket(ticket.id)
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound'])
    expect(messages[1]!.gmailMessageId).toBe(sent.id)
    expect(messages[1]!.bodyText).toBe('draft rev 2')

    // The owner's own reply is not an inbound event: no reopen, no DogeBuddy/New label.
    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(modifyMessage).not.toHaveBeenCalled()
  })

  // 6
  it('a spoofed From: support@ without the SENT label is inbound', async () => {
    await seedSyncState()
    const spoof = gmail.receiveInbound({
      from: `"DogeBuddy Support" <${SUPPORT}>`,
      to: [SUPPORT],
      subject: 'Account notice',
      bodyText: 'click here',
    })

    await runIngest(deps)

    const ticket = (await ticketByThread(spoof.threadId))!
    const messages = await messagesOfTicket(ticket.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.direction).toBe('inbound')
    expect(gmail.labelsOf(spoof.id)).toContain(await newLabelId())
  })

  // 7
  it('a message deleted mid-batch is skipped and the poll still completes and advances', async () => {
    await seedSyncState()
    const doomed = gmail.receiveInbound({ from: 'gone@example.com', to: [SUPPORT], subject: 'Gone', bodyText: 'gone' })
    const survivor = gmail.receiveInbound({ from: 'ok@example.com', to: [SUPPORT], subject: 'Still here', bodyText: 'ok' })
    // The first getMessage of the batch is `doomed`'s metadata fetch — Gmail 404s deleted mail.
    gmail.failNext('getMessage', new MessageGoneError())

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await ticketByThread(doomed.threadId)).toBeUndefined()
    expect(await ticketByThread(survivor.threadId)).toBeDefined()
    expect((await syncState())?.lastHistoryId).toBe(2n)
    expect(alert).not.toHaveBeenCalled()
  })

  it('messages labeled DRAFT or TRASH are skipped without a body fetch', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)

    // A live (not yet superseded) draft on a known ticket thread: only the DRAFT label stops it.
    const draft = gmail.saveDraft({ threadId: first.threadId, bodyText: 'half-written reply' })
    const trashed = gmail.receiveInbound({
      from: 'spam@example.com', to: [SUPPORT], subject: 'Trashed', bodyText: 'trash', labelIds: ['TRASH'],
    })
    const legit = gmail.receiveInbound({ from: 'ok@example.com', to: [SUPPORT], subject: 'Real', bodyText: 'real' })
    const getMessage = vi.spyOn(gmail, 'getMessage')

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await ticketByThread(legit.threadId)).toBeDefined()
    expect(await ticketByThread(trashed.threadId)).toBeUndefined()
    expect(await messagesOfTicket((await ticketByThread(first.threadId))!.id)).toHaveLength(1)
    expect(await db.select().from(supportMessages).where(eq(supportMessages.gmailMessageId, draft.id))).toEqual([])

    const fullFetches = getMessage.mock.calls.filter(([, opts]) => opts.format === 'full').map(([id]) => id)
    expect(fullFetches).toEqual([legit.id])
  })

  it('SPAM-labeled mail that passes the filter is ingested normally (triage decides, not ingest)', async () => {
    await seedSyncState()
    const spam = gmail.receiveInbound({
      from: 'bulk@example.com', to: [SUPPORT], subject: 'WIN NOW', bodyText: 'spam body', labelIds: ['SPAM'],
    })

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    const ticket = await ticketByThread(spam.threadId)
    expect(ticket).toBeDefined()
    expect(ticket!.status).toBe('new')
    // The Gmail-folder fact rides on the ticket for triage's pre-LLM spam short-circuit.
    expect(ticket!.gmailSpam).toBe(true)

    // A follow-up that lands in the INBOX flips it back — the LATEST inbound wins.
    gmail.receiveInbound({
      from: 'bulk@example.com', to: [SUPPORT], subject: 'Re: WIN NOW', bodyText: 'a real person here', threadId: spam.threadId,
    })
    await runIngest(deps)
    expect((await ticketByThread(spam.threadId))!.gmailSpam).toBe(false)
  })

  it('gmail_spam follows last_inbound_at, not arrival order: an OLDER spam-foldered message handed over late never overrides the newer inbox one', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    expect((await ticketByThread(first.threadId))!.gmailSpam).toBe(false)

    // Simulate history delivering an older, spam-foldered message on the same thread after the
    // newer one is already in: MockGmail stamps increasing internalDates, so rewind this one.
    const late = gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'older', threadId: first.threadId, labelIds: ['SPAM'],
    })
    gmail.backdate(late.id, new Date((await gmail.getMessage(first.id, { format: 'metadata' })).internalDate.getTime() - 60_000))
    await runIngest(deps)

    const ticket = await ticketByThread(first.threadId)
    expect(ticket!.gmailSpam).toBe(false)
    expect(ticket!.lastInboundAt).toEqual((await gmail.getMessage(first.id, { format: 'metadata' })).internalDate)
  })

  // 8
  it('the tripwire escalates on a keyword in the body and reports the ticket', async () => {
    await seedSyncState()
    const angry = gmail.receiveInbound({
      from: 'jane@example.com',
      to: [SUPPORT],
      subject: 'Order 1001',
      bodyText: 'If I do not hear back I will file a Chargeback with my bank.',
    })

    const result = await runIngest(deps)

    const ticket = (await ticketByThread(angry.threadId))!
    expect(ticket.status).toBe('escalated')
    expect(ticket.escalationReason).toBe('tripwire: chargeback')
    expect(result.tripwiredTicketIds).toEqual([ticket.id])
    expect(ticket.escalationNotifiedAt).toBeNull()
  })

  it('the tripwire never overwrites an existing escalation reason', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db
      .update(supportTickets)
      .set({ status: 'escalated', escalationReason: 'triage: angry' })
      .where(eq(supportTickets.id, ticket.id))

    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'lawsuit incoming', threadId: first.threadId,
    })
    const result = await runIngest(deps)

    const after = (await ticketByThread(first.threadId))!
    expect(after.status).toBe('escalated')
    expect(after.escalationReason).toBe('triage: angry')
    expect(result.tripwiredTicketIds).toEqual([])
  })

  // 9
  it('stores the numerically-largest history record id, not the lexicographic one', async () => {
    await seedSyncState()
    gmail.advanceHistoryTo('98')
    gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'A', bodyText: 'a' }) // record 99
    gmail.receiveInbound({ from: 'b@example.com', to: [SUPPORT], subject: 'B', bodyText: 'b' }) // record 100

    await runIngest(deps)

    // '99' > '100' lexicographically; 100n > 99n numerically.
    expect((await syncState())?.lastHistoryId).toBe(100n)
  })

  it('a stale sync-state write loses to a concurrently-advanced history id', async () => {
    await seedSyncState()
    const msg = gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'A', bodyText: 'a' })

    // A concurrent poller finishes (and advances the state far ahead) between this run's read of
    // the sync state and its own guarded write.
    const realListHistory = gmail.listHistory.bind(gmail)
    vi.spyOn(gmail, 'listHistory').mockImplementation(async (q) => {
      const page = await realListHistory(q)
      await db.update(gmailSyncState).set({ lastHistoryId: 500n }).where(eq(gmailSyncState.id, 1))
      return page
    })

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await ticketByThread(msg.threadId)).toBeDefined()
    expect((await syncState())?.lastHistoryId).toBe(500n)
  })

  // 10 — label plumbing (spec §2.7): failures are warnings, never job failures.
  it('a stale label id is retried once after invalidating the cache', async () => {
    await seedSyncState()
    const msg = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    gmail.failNext('modifyMessage', new GmailApiError('Invalid label id', 400, 'invalidArgument'))

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(gmail.labelsOf(msg.id)).toContain(await newLabelId())
    expect(alert).not.toHaveBeenCalled()
  })

  it('a persistent label failure is a warning alert, not a thrown poll', async () => {
    await seedSyncState()
    const msg = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    vi.spyOn(gmail, 'modifyMessage').mockRejectedValue(new GmailApiError('Not found', 404, 'notFound'))

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await ticketByThread(msg.threadId)).toBeDefined()
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]![0]).toBe('warning')
    expect(alert.mock.calls[0]![1]).toBe('support_label_failed')
  })

  // Task 9 — bounded, resumable resync on history expiry (spec §2 step 2).
  it('a plain history expiry with no complications resolves normally (HistoryExpiredError never surfaces)', async () => {
    await seedSyncState()
    gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    gmail.expireHistory()

    await expect(runIngest(deps)).resolves.toBeDefined()
  })

  it('(a) mixed mailbox: new support mail ingested, resolved ticket NOT reopened, non-support mail absent, sync state = pre-captured id', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const resolvedTicket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, resolvedTicket.id))

    gmail.expireHistory()
    const newMail = gmail.receiveInbound({ from: 'bob@example.com', to: [SUPPORT], subject: 'New', bodyText: 'new mail' })
    const nonSupport = gmail.receiveInbound({
      from: 'x@example.com', to: ['other@dogebuddy.com'], subject: 'Not support', bodyText: 'irrelevant',
    })
    // Nothing advances the mock's history counter between this read and runIngest's own internal
    // getProfile() call inside the resync, so the two values are the same pre-captured id.
    const expectedHistoryId = BigInt((await gmail.getProfile()).historyId)
    const modifyMessage = vi.spyOn(gmail, 'modifyMessage')

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    const newTicket = await ticketByThread(newMail.threadId)
    expect(newTicket).toBeDefined()
    expect(newTicket!.status).toBe('new')
    expect(await messagesOfTicket(newTicket!.id)).toHaveLength(1)

    // The resolved ticket's original message re-matches the resync's q filter and is walked again,
    // but the insert gate makes it a no-op: no reopen, no re-label.
    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(await messagesOfTicket(resolvedTicket.id)).toHaveLength(1)
    expect(modifyMessage).toHaveBeenCalledTimes(1)
    expect(modifyMessage).not.toHaveBeenCalledWith(first.id, expect.anything())

    expect(await ticketByThread(nonSupport.threadId)).toBeUndefined()
    expect(await db.select().from(supportMessages).where(eq(supportMessages.gmailMessageId, nonSupport.id))).toEqual([])

    expect((await syncState())?.lastHistoryId).toBe(expectedHistoryId)
  })

  it('(b) a follow-up that dropped support@ from every header is still picked up via the known-thread walk, and reopens the ticket', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

    gmail.expireHistory()
    // Addressed to neither support@ (To/Cc/Delivered-To) — the q filter cannot see this one.
    gmail.receiveInbound({
      from: 'jane@example.com', to: ['jane-cc@example.com'], subject: 'Re: Hi', bodyText: 'still need help',
      threadId: first.threadId,
    })
    const getThread = vi.spyOn(gmail, 'getThread')

    await runIngest(deps)

    expect(getThread).toHaveBeenCalledWith(first.threadId)
    const reopened = (await ticketByThread(first.threadId))!
    expect(reopened.status).toBe('new')
    expect(await messagesOfTicket(ticket.id)).toHaveLength(2)
  })

  it('(c) a mid-resync failure on listMessages page 2 leaves page 1 durable; the next runIngest resumes without reopening or duplicating anything', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const resolvedTicket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, resolvedTicket.id))

    gmail.expireHistory()
    const msgA = gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'A', bodyText: 'a body' })
    const msgB = gmail.receiveInbound({ from: 'b@example.com', to: [SUPPORT], subject: 'B', bodyText: 'b body' })

    let call = 0
    const listMessagesSpy = vi.spyOn(gmail, 'listMessages').mockImplementation(async () => {
      call++
      if (call === 1) return { ids: [{ id: msgA.id, threadId: msgA.threadId }], nextPageToken: 'page-2' }
      throw new Error('boom mid-resync')
    })

    const stateBeforeFailure = await syncState()
    await expect(runIngest(deps)).rejects.toThrow('boom mid-resync')

    // Page 1's write already committed — it isn't rolled back by page 2's failure.
    const ticketA = await ticketByThread(msgA.threadId)
    expect(ticketA).toBeDefined()
    expect(await messagesOfTicket(ticketA!.id)).toHaveLength(1)
    // Nothing the failed resync never reached was touched.
    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(await ticketByThread(msgB.threadId)).toBeUndefined()
    // The pre-captured historyId is never stored until the WHOLE resync completes — a mid-resync
    // failure must leave gmail_sync_state exactly where it was, not a partial/interim value.
    expect((await syncState())?.lastHistoryId).toBe(stateBeforeFailure?.lastHistoryId)

    listMessagesSpy.mockRestore()
    const modifyMessage = vi.spyOn(gmail, 'modifyMessage')

    // History is no longer expired (the mock's expiry is one-shot), so this resumes via the plain
    // incremental walk — which is exactly the point: the retry doesn't need to be a resync to be
    // safe, because page 1's insert gate already made msgA idempotent.
    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    expect(await messagesOfTicket(ticketA!.id)).toHaveLength(1)
    expect(await ticketByThread(msgB.threadId)).toBeDefined()
    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(modifyMessage).not.toHaveBeenCalledWith(msgA.id, expect.anything())
  })

  it('(c2) a retried resync (history still expired on the retry) replays page 1 as a no-op and finishes the sweep on the second attempt', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const resolvedTicket = (await ticketByThread(first.threadId))!
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, resolvedTicket.id))

    gmail.expireHistory()
    const msgA = gmail.receiveInbound({ from: 'a@example.com', to: [SUPPORT], subject: 'A', bodyText: 'a body' })
    const msgB = gmail.receiveInbound({ from: 'b@example.com', to: [SUPPORT], subject: 'B', bodyText: 'b body' })

    let call = 0
    const listMessagesSpy = vi.spyOn(gmail, 'listMessages').mockImplementation(async () => {
      call++
      if (call === 1) return { ids: [{ id: msgA.id, threadId: msgA.threadId }], nextPageToken: 'page-2' }
      throw new Error('boom mid-resync')
    })

    await expect(runIngest(deps)).rejects.toThrow('boom mid-resync')
    const ticketA = await ticketByThread(msgA.threadId)
    expect(ticketA).toBeDefined()
    expect(await ticketByThread(msgB.threadId)).toBeUndefined()

    listMessagesSpy.mockRestore()
    // Unlike scenario (c): real Gmail keeps 404ing on the same now-expired startHistoryId until the
    // NEXT successful resync stores a fresh one. Simulate that by expiring history again, forcing
    // the retry to go through runResync a second time rather than falling back to the incremental
    // walk (which is what (c) already covers).
    gmail.expireHistory()
    const expectedHistoryId = BigInt((await gmail.getProfile()).historyId)
    const modifyMessage = vi.spyOn(gmail, 'modifyMessage')

    const result = await runIngest(deps)

    // msgA (and the resolved ticket's original message) re-match the q filter and are walked again
    // by this second resync — both are no-ops via the insert gate. Only msgB, never reached by the
    // first attempt, is newly inserted.
    expect(result.insertedMessages).toBe(1)
    expect(await messagesOfTicket(ticketA!.id)).toHaveLength(1)
    const ticketB = await ticketByThread(msgB.threadId)
    expect(ticketB).toBeDefined()
    expect(ticketB!.status).toBe('new')
    expect(await messagesOfTicket(ticketB!.id)).toHaveLength(1)

    expect((await ticketByThread(first.threadId))!.status).toBe('resolved')
    expect(await messagesOfTicket(resolvedTicket.id)).toHaveLength(1)
    expect(modifyMessage).not.toHaveBeenCalledWith(msgA.id, expect.anything())
    expect(modifyMessage).not.toHaveBeenCalledWith(first.id, expect.anything())

    expect((await syncState())?.lastHistoryId).toBe(expectedHistoryId)
  })

  it('a getThread failure on one known thread is skipped, not fatal: the resync still completes, other mail is still ingested, and sync state still advances', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)

    gmail.expireHistory()
    const healthy = gmail.receiveInbound({ from: 'bob@example.com', to: [SUPPORT], subject: 'New', bodyText: 'new mail' })

    // `healthy` mints its own ticket during this same resync's q-filter walk (step 2), so by the
    // time the known-thread walk (step 3) runs, BOTH `first.threadId` and `healthy.threadId` are
    // known threads — and `SELECT DISTINCT` gives no ordering guarantee over which one is walked
    // first. Target the failure at `first.threadId` specifically (rather than relying on
    // `failNext`'s one-shot-in-call-order semantics) so the assertions below are deterministic
    // regardless of query order — this simulates a thread the owner deleted from Gmail entirely
    // (getThread 404s -> plain GmailApiError) while everything else in the mailbox is healthy.
    const realGetThread = gmail.getThread.bind(gmail)
    vi.spyOn(gmail, 'getThread').mockImplementation(async (threadId) => {
      if (threadId === first.threadId) throw new GmailApiError('Requested entity was not found.', 404, 'notFound')
      return realGetThread(threadId)
    })

    const expectedHistoryId = BigInt((await gmail.getProfile()).historyId)

    const result = await runIngest(deps)

    expect(result.insertedMessages).toBe(1)
    const healthyTicket = await ticketByThread(healthy.threadId)
    expect(healthyTicket).toBeDefined()
    expect(healthyTicket!.status).toBe('new')

    // The resync completed and stored the pre-captured id despite the dead thread.
    expect((await syncState())?.lastHistoryId).toBe(expectedHistoryId)

    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]![0]).toBe('warning')
    expect(alert.mock.calls[0]![1]).toBe('support_resync_thread_failed')
    expect(alert.mock.calls[0]![2]).toMatchObject({ threadIds: [first.threadId] })
  })

  // Final review I3 — a contact-form ticket sits on a `form:<id>` placeholder until its ack job
  // creates a real Gmail thread. Handing that to getThread is a guaranteed 404 that would page the
  // owner with support_resync_thread_failed on every single resync.
  it("a form ticket's placeholder thread id is never handed to getThread during a resync", async () => {
    await seedSyncState()
    gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)

    const [formTicket] = await db
      .insert(supportTickets)
      .values({ gmailThreadId: 'placeholder-tmp', customerEmail: 'form-resync@example.com', subject: 'Contact form: hi', status: 'new', source: 'form' })
      .returning({ id: supportTickets.id })
    await db.update(supportTickets).set({ gmailThreadId: `form:${formTicket!.id}` }).where(eq(supportTickets.id, formTicket!.id))

    try {
      gmail.expireHistory()
      const asked: string[] = []
      const realGetThread = gmail.getThread.bind(gmail)
      vi.spyOn(gmail, 'getThread').mockImplementation(async (threadId) => {
        asked.push(threadId)
        return realGetThread(threadId)
      })

      await runIngest(deps)

      expect(asked.length).toBeGreaterThan(0)
      expect(asked).not.toContain(`form:${formTicket!.id}`)
      expect(asked.some((t) => t.startsWith('form:'))).toBe(false)
      expect(alert.mock.calls.filter((c) => c[1] === 'support_resync_thread_failed')).toHaveLength(0)
    } finally {
      await db.delete(supportMessages).where(eq(supportMessages.ticketId, formTicket!.id))
      await db.delete(supportTickets).where(eq(supportTickets.id, formTicket!.id))
    }
  })

  // Task 4 — auth_results capture (spec: Task 1's authenticationResults on the normalized full
  // message flows through to the stored message row).
  it('captures Authentication-Results from the inbound message onto support_messages.auth_results', async () => {
    await seedSyncState()
    const authHeader = 'mx.google.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com'
    const sent = gmail.receiveInbound({
      from: 'jane@example.com',
      to: [SUPPORT],
      subject: 'Where is my order?',
      bodyText: 'Ordered a week ago and heard nothing.',
      authenticationResults: authHeader,
    })

    await runIngest(deps)

    const ticket = (await ticketByThread(sent.threadId))!
    const messages = await messagesOfTicket(ticket.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.authResults).toBe(authHeader)
  })

  it('leaves auth_results null when the inbound message carries no Authentication-Results header', async () => {
    await seedSyncState()
    const sent = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })

    await runIngest(deps)

    const ticket = (await ticketByThread(sent.threadId))!
    const messages = await messagesOfTicket(ticket.id)
    expect(messages[0]!.authResults).toBeNull()
  })

  // Task 4 — reopen resets the agent failure budget alongside the triage failure budget (spec: a
  // new conversation gets its own agent attempts too, not a stale count from the last one).
  it('a follow-up on a waiting_on_customer ticket reopens to new and resets BOTH agent_failure_count and triage_failure_count', async () => {
    await seedSyncState()
    const first = gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    await runIngest(deps)
    const ticket = (await ticketByThread(first.threadId))!
    await db
      .update(supportTickets)
      .set({ status: 'waiting_on_customer', agentFailureCount: 2, triageFailureCount: 1 })
      .where(eq(supportTickets.id, ticket.id))

    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'still broken', threadId: first.threadId,
    })
    await runIngest(deps)

    const reopened = (await ticketByThread(first.threadId))!
    expect(reopened.status).toBe('new')
    expect(reopened.agentFailureCount).toBe(0)
    expect(reopened.triageFailureCount).toBe(0)
  })

  // CRITICAL 1 regression: escalate -> notify stamps `escalation_notified_at` -> owner resolves
  // (the admin Resolve/Escalate handlers never touch that column) -> customer replies with a new
  // chargeback -> the tripwire re-escalates. Without clearing the stamp on every transition INTO
  // 'escalated', the re-escalated ticket is permanently invisible to notifyPendingEscalations'
  // `escalation_notified_at IS NULL` selection, and the owner is never paged for the reopened case.
  it('re-escalation re-notify cycle: stamp clears on re-escalation so a second notify fires', async () => {
    // This test calls notifyPendingEscalations directly, which (unlike everything else in this
    // file) writes `support.escalation_notified` audit rows — a table this file's afterEach never
    // sweeps. Snapshot so cleanup at the end removes only the rows this test creates.
    const notifiedBefore = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'support.escalation_notified'))

    try {
      await seedSyncState()
      const first = gmail.receiveInbound({
        from: 'jane@example.com',
        to: [SUPPORT],
        subject: 'Order 1001',
        bodyText: 'If I do not hear back I will file a chargeback with my bank.',
      })
      await runIngest(deps)

      const ticket = (await ticketByThread(first.threadId))!
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationNotifiedAt).toBeNull()

      const notify = vi.fn(async () => true)
      const escalateDeps = { db, notify, alert, adminBaseUrl: 'http://admin.test' }

      const firstNotify = await notifyPendingEscalations(escalateDeps)
      expect(firstNotify.notified).toBe(1)
      expect(notify).toHaveBeenCalledTimes(1)
      expect((await ticketByThread(first.threadId))!.escalationNotifiedAt).not.toBeNull()

      // Owner resolves it from /admin — the guarded transition never clears escalation_notified_at
      // (an owner-initiated Escalate/Resolve must not page the owner's own phone).
      await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

      // Customer replies with a fresh chargeback threat on the same thread.
      gmail.receiveInbound({
        from: 'jane@example.com',
        to: [SUPPORT],
        subject: 'Re: Order 1001',
        bodyText: 'Filing the chargeback today, this is final.',
        threadId: first.threadId,
      })
      await runIngest(deps)

      const reEscalated = (await ticketByThread(first.threadId))!
      expect(reEscalated.status).toBe('escalated')
      // The bug: without clearing the stamp on the re-escalation write, this stays non-null forever.
      expect(reEscalated.escalationNotifiedAt).toBeNull()

      const secondNotify = await notifyPendingEscalations(escalateDeps)
      expect(secondNotify.notified).toBe(1)
      expect(notify).toHaveBeenCalledTimes(2)
      expect((await ticketByThread(first.threadId))!.escalationNotifiedAt).not.toBeNull()
    } finally {
      const notifiedAfter = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.action, 'support.escalation_notified'))
      const newIds = notifiedAfter.map((r) => r.id).filter((id) => !notifiedBefore.some((b) => b.id === id))
      if (newIds.length > 0) await db.delete(auditLog).where(inArray(auditLog.id, newIds))
    }
  })

  // Task 3 regression guard: the contact-form path (Task 5) creates its own OUTBOUND ack row
  // directly (never through Gmail), so the References fallback must be able to attach a customer's
  // Gmail reply to that ack regardless of direction — and the guarded reopen (resolved/waiting_on_
  // customer only) means a `triaged` ticket stays `triaged`, it just gets its last_inbound_at bumped.
  it('a customer reply whose In-Reply-To names an OUTBOUND message of ours (the form ack) attaches to that ticket even under a brand-new Gmail thread id', async () => {
    await seedSyncState()
    const [ticket] = await db.insert(supportTickets).values({
      gmailThreadId: 'mock-ack-thread-1', customerEmail: 'jane@example.com', subject: 'Contact form: hello', status: 'triaged', source: 'form',
    }).returning({ id: supportTickets.id })
    await db.insert(supportMessages).values({
      ticketId: ticket!.id, gmailMessageId: 'ack-sent-1', direction: 'outbound', fromEmail: SUPPORT,
      // Fixed, well before MockGmail's internalDate baseline (Nov 2023) rather than `new Date()` —
      // messagesOfTicket orders by sentAt ascending, and the ack must sort first regardless of the
      // real wall clock at test time (which is always later than the mock's fixed baseline).
      bodyText: 'Thanks', rfcMessageId: '<form-ack-x@dogebuddy.com>', sentAt: new Date('2020-01-01T00:00:00.000Z'),
    })
    const before = (await ticketByThread('mock-ack-thread-1'))!
    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: We got your message', bodyText: 'here is more',
      inReplyTo: '<form-ack-x@dogebuddy.com>', references: '<form-ack-x@dogebuddy.com>',
    })

    await runIngest(deps)

    const msgs = await messagesOfTicket(ticket!.id)
    expect(msgs.map((m) => m.direction)).toEqual(['outbound', 'inbound'])
    const after = (await ticketByThread('mock-ack-thread-1'))!
    // Reopen only covers resolved/waiting_on_customer, so a `triaged` ticket does NOT flip to `new`.
    expect(after.status).toBe('triaged')
    expect(after.lastInboundAt!.getTime()).toBeGreaterThan(before.lastInboundAt?.getTime() ?? -Infinity)
  })
})

describe('tripwireHit', () => {
  it('matches case-insensitively in the subject or the body and returns the keyword', () => {
    expect(tripwireHit('CHARGEBACK incoming', null)).toBe('chargeback')
    expect(tripwireHit(null, 'my attorney will be in touch')).toBe('attorney')
    expect(tripwireHit('Re: order', 'the toy caused an Injury')).toBe('injury')
  })

  it('returns null when nothing matches, including on empty input', () => {
    expect(tripwireHit(null, null)).toBeNull()
    expect(tripwireHit('Where is my order?', 'It has been a week.')).toBeNull()
  })
})
