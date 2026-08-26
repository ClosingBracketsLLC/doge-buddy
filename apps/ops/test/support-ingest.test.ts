import { createDb, gmailSyncState, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, GmailApiError, MessageGoneError, type MockGmail } from '@doge-buddy/gmail'
import { asc, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEW_LABEL, runIngest, tripwireHit, type IngestDeps } from '../src/support/ingest.ts'

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
    await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket.id))

    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: Hi', bodyText: 'still broken', threadId: first.threadId,
    })
    await runIngest(deps)

    const reopened = (await ticketByThread(first.threadId))!
    expect(reopened.status).toBe('new')
    expect(reopened.lastInboundAt!.getTime()).toBeGreaterThan(ticket.lastInboundAt!.getTime())
    expect(await messagesOfTicket(ticket.id)).toHaveLength(2)
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

  it('propagates HistoryExpiredError (the resync path is a separate concern)', async () => {
    await seedSyncState()
    gmail.receiveInbound({ from: 'jane@example.com', to: [SUPPORT], subject: 'Hi', bodyText: 'body' })
    gmail.expireHistory()

    await expect(runIngest(deps)).rejects.toThrow('History ID is no longer valid')
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
