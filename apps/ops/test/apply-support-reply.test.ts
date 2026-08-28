import { auditLog, createDb, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPPORT_AGENT_QUEUE } from '../src/jobs/support-agent-run.ts'
import {
  PROPOSAL_APPLIED_ACTION,
  PROPOSAL_APPLY_FAILED_ACTION,
  STALE_APPLY_ERROR,
  THREAD_TOO_BUSY_ERROR,
  applySupportReply,
} from '../src/proposals/apply-support-reply.ts'
import type { ApplyProposalDeps, ProposalShopifyOps } from '../src/proposals/apply-shared.ts'
import { executeApplyProposal } from '../src/proposals/run-apply.ts'
import { selectAndEnqueueAgentRuns } from '../src/support/agent-select.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SUPPORT_ADDRESS = 'support@dogebuddy.test'
const CUSTOMER = 'jane@example.com'
const SUBJECT = 'Where is my order?'
const REPLY_BODY = 'Hi Jane,\n\nYour order shipped yesterday and is moving.\n\nDoge Buddy Support'
/** Every ticket this file creates carries this thread-id prefix — the afterEach hook's handle on
 * everything it must clean up (same convention as support-agent-run.test.ts). */
const THREAD_PREFIX = 'applyreply-'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

/** Decodes one MockGmail `sentMessages()` entry back into its raw RFC 2822 text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

/** The raw message's header block, split into lines (headers end at the first blank line). */
function headerLines(raw: string): string[] {
  return decodeRaw(raw).split('\r\n\r\n')[0]!.split('\r\n')
}

describe('applySupportReply', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let gmail: MockGmail
  let notify: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>
  let enqueue: ReturnType<typeof vi.fn>

  beforeEach(() => {
    gmail = createMockGmail({ selfAddress: SUPPORT_ADDRESS })
    notify = vi.fn(async () => true)
    alert = vi.fn(async () => {})
    enqueue = vi.fn(async () => {})
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, `${THREAD_PREFIX}%`))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      const proposalRows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
      if (proposalRows.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.entityId, proposalRows.map((r) => r.id)))
      }
    }
    vi.restoreAllMocks()
  })

  /** `ApplyProposalDeps` with everything this executor never touches stubbed to throw loudly. */
  function makeDeps(overrides: Partial<ApplyProposalDeps> = {}): ApplyProposalDeps {
    const shopifyUnused = new Proxy({} as ProposalShopifyOps, {
      get: (_t, prop) => () => {
        throw new Error(`applySupportReply must not touch shopify (called ${String(prop)})`)
      },
    })
    return {
      db,
      alert: alert as unknown as ApplyProposalDeps['alert'],
      shopify: shopifyUnused,
      adapter: {
        subscribeProductWebhook: async () => {
          throw new Error('applySupportReply must not touch the supplier adapter')
        },
        getDisputeOptions: async () => {
          throw new Error('applySupportReply must not touch the supplier adapter')
        },
        openDispute: async () => {
          throw new Error('applySupportReply must not touch the supplier adapter')
        },
      } as unknown as ApplyProposalDeps['adapter'],
      gmail: gmail as GmailClient,
      refundOps: null,
      supportAddress: SUPPORT_ADDRESS,
      notify: notify as unknown as ApplyProposalDeps['notify'],
      enqueue: enqueue as unknown as ApplyProposalDeps['enqueue'],
      adminBaseUrl: 'https://admin.test',
      ...overrides,
    }
  }

  interface SeededThread {
    ticketId: string
    threadId: string
    /** Every inbound message seeded, oldest first: gmail id + the rfc id Gmail minted for it. */
    inbound: { id: string; rfcMessageId: string; sentAt: Date }[]
  }

  /**
   * Seeds a MockGmail thread of `count` customer messages plus the matching ticket +
   * `support_messages` rows. rfc ids are read back out of the mock rather than hardcoded, so the
   * byte-exact threading assertions below pin the executor's behavior, not the mock's id format.
   */
  async function seedThread(
    opts: {
      count?: number
      status?: (typeof supportTickets.$inferInsert)['status']
      customerEmail?: string | null
      subject?: string | null
      rfcMessageIdOnLatest?: boolean
      lastAgentRunAt?: Date | null
      lastAgentFinishedAt?: Date | null
    } = {},
  ): Promise<SeededThread> {
    const count = opts.count ?? 1
    const threadId = `${THREAD_PREFIX}${uid()}`

    const inbound: SeededThread['inbound'] = []
    for (let i = 0; i < count; i += 1) {
      const { id } = gmail.receiveInbound({
        from: CUSTOMER,
        to: [SUPPORT_ADDRESS],
        subject: SUBJECT,
        bodyText: `customer message ${i}`,
        threadId,
      })
      const meta = await gmail.getMessage(id, { format: 'metadata' })
      inbound.push({ id, rfcMessageId: meta.rfcMessageId!, sentAt: meta.internalDate })
    }

    const latest = inbound[inbound.length - 1]!
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: threadId,
        customerEmail: opts.customerEmail === undefined ? CUSTOMER : opts.customerEmail,
        subject: opts.subject === undefined ? SUBJECT : opts.subject,
        status: opts.status ?? 'awaiting_approval',
        lastInboundAt: latest.sentAt,
        lastAgentRunAt: opts.lastAgentRunAt ?? new Date(latest.sentAt.getTime() + 60_000),
        lastAgentFinishedAt: opts.lastAgentFinishedAt ?? null,
      })
      .returning({ id: supportTickets.id })

    for (const [i, m] of inbound.entries()) {
      const isLatest = i === inbound.length - 1
      await db.insert(supportMessages).values({
        ticketId: ticket!.id,
        gmailMessageId: m.id,
        direction: 'inbound',
        fromEmail: CUSTOMER,
        bodyText: `customer message ${i}`,
        rfcMessageId: isLatest && opts.rfcMessageIdOnLatest === false ? null : m.rfcMessageId,
        sentAt: m.sentAt,
      })
    }

    return { ticketId: ticket!.id, threadId, inbound }
  }

  /** Seeds an `applying` support_reply proposal for a ticket — the state the shell hands the
   * executor (`executeApplyProposal` commits `approved -> applying` before dispatching). */
  async function seedProposal(ticketId: string, threadSnapshotAt: Date, body = REPLY_BODY) {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'support_reply',
        status: 'applying',
        summary: `Reply: ${SUBJECT}`,
        payload: {
          type: 'support_reply',
          ticketId,
          body,
          threadSnapshotAt: threadSnapshotAt.toISOString(),
        },
        sourceWorkflow: 'support',
        ticketId,
      })
      .returning()
    return row!
  }

  async function readTicket(ticketId: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
    return row!
  }

  async function readProposal(proposalId: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId))
    return row!
  }

  async function readMessages(ticketId: string) {
    return db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.ticketId, ticketId))
      .orderBy(asc(supportMessages.sentAt))
  }

  async function auditActions(proposalId: string) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, proposalId))
    return rows.map((r) => r.action)
  }

  it('happy path: sends a byte-exact threaded reply, records ONE outbound row, flips the ticket, applies the proposal', async () => {
    const thread = await seedThread({ count: 2 })
    const latest = thread.inbound[1]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)

    await applySupportReply(makeDeps(), proposal)

    // --- the wire message ---
    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(1)
    const lines = headerLines(sent[0]!.raw)
    expect(lines).toContain(`From: ${SUPPORT_ADDRESS}`)
    expect(lines).toContain(`To: ${CUSTOMER}`)
    expect(lines).toContain(`Subject: Re: ${SUBJECT}`)
    expect(lines).toContain(`In-Reply-To: ${latest.rfcMessageId}`)
    // Every thread rfc id, oldest -> newest, final one = the In-Reply-To target.
    expect(lines).toContain(
      `References: ${thread.inbound[0]!.rfcMessageId} ${latest.rfcMessageId}`,
    )
    expect(lines).toContain(`X-DogeBuddy-Proposal: ${proposal.id}`)
    expect(sent[0]!.threadId).toBe(thread.threadId)
    expect(decodeRaw(sent[0]!.raw)).toContain('Your order shipped yesterday')

    // --- the outbound support_messages row, and its ONE-row invariant ---
    const afterSend = await readMessages(thread.ticketId)
    const outbound = afterSend.filter((m) => m.direction === 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.gmailMessageId).toBe(sent[0]!.id)
    expect(outbound[0]!.fromEmail).toBe(SUPPORT_ADDRESS)
    expect(outbound[0]!.bodyText).toBe(REPLY_BODY)
    expect(outbound[0]!.sentAt).not.toBeNull()

    // Ingest polls the same mailbox and will see this SENT message too — its insert is the same
    // conflict-tolerant upsert. Replay it here: exactly ONE outbound row must survive (6A's
    // invariant), whichever writer got there first.
    await db
      .insert(supportMessages)
      .values({
        ticketId: thread.ticketId,
        gmailMessageId: sent[0]!.id,
        direction: 'outbound',
        fromEmail: SUPPORT_ADDRESS,
        bodyText: REPLY_BODY,
        sentAt: new Date(),
      })
      .onConflictDoNothing({ target: supportMessages.gmailMessageId })
    const afterIngest = await readMessages(thread.ticketId)
    expect(afterIngest.filter((m) => m.direction === 'outbound')).toHaveLength(1)

    // --- statuses ---
    expect((await readTicket(thread.ticketId)).status).toBe('waiting_on_customer')
    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).not.toBeNull()
    expect(applied.applyError).toBeNull()
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLIED_ACTION)
    expect(notify).not.toHaveBeenCalled()
  })

  it('run-apply dispatches support_reply to this executor', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'support_reply',
        status: 'approved',
        summary: `Reply: ${SUBJECT}`,
        payload: {
          type: 'support_reply',
          ticketId: thread.ticketId,
          body: REPLY_BODY,
          threadSnapshotAt: latest.sentAt.toISOString(),
        },
        sourceWorkflow: 'support',
        ticketId: thread.ticketId,
      })
      .returning()

    await executeApplyProposal(makeDeps(), row!.id)

    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readProposal(row!.id)).status).toBe('applied')
  })

  it('stale: a newer inbound than the snapshot fails the proposal, re-triages the ticket, clears the claim stamp, re-enqueues — and sends NOTHING', async () => {
    const thread = await seedThread({ count: 1 })
    const snapshotAt = thread.inbound[0]!.sentAt
    const proposal = await seedProposal(thread.ticketId, snapshotAt)

    // The customer wrote again after the agent took its snapshot. Deliberately stamped OLDER than
    // the ticket's claim stamp — the exact case that makes clearing last_agent_run_at load-bearing.
    const newer = gmail.receiveInbound({
      from: CUSTOMER,
      to: [SUPPORT_ADDRESS],
      subject: SUBJECT,
      bodyText: 'actually, cancel that',
      threadId: thread.threadId,
    })
    const newerSentAt = new Date(snapshotAt.getTime() + 1000)
    await db.insert(supportMessages).values({
      ticketId: thread.ticketId,
      gmailMessageId: newer.id,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'actually, cancel that',
      rfcMessageId: `<${newer.id}@mock.gmail>`,
      sentAt: newerSentAt,
    })
    await db
      .update(supportTickets)
      .set({ lastInboundAt: newerSentAt })
      .where(eq(supportTickets.id, thread.ticketId))

    await applySupportReply(makeDeps(), proposal)

    expect(gmail.sentMessages()).toHaveLength(0)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe(STALE_APPLY_ERROR)

    const ticket = await readTicket(thread.ticketId)
    expect(ticket.status).toBe('triaged')
    // Without this clear, the re-run's claim CAS finds a claim stamp NEWER than the stale
    // message's own timestamp and no-ops for 20 minutes.
    expect(ticket.lastAgentRunAt).toBeNull()

    expect(enqueue).toHaveBeenCalledWith(
      SUPPORT_AGENT_QUEUE,
      { ticketId: thread.ticketId },
      expect.objectContaining({ singletonKey: thread.ticketId }),
    )
    // The owner approved a send that did not happen — they must hear about it.
    expect(notify).toHaveBeenCalledTimes(1)
    // Task 18 review ruling: wording unified with `applyRefund`'s own stale hand-back notify (see
    // that file's own test asserting the identical phrase) — a continuation, not an error.
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('re-approve after the agent re-drafts') }),
    )
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)
    expect((await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')).toHaveLength(0)
  })

  it('stale: a best-effort enqueue failure alerts but still leaves the proposal failed and the ticket triaged', async () => {
    const thread = await seedThread()
    const snapshotAt = thread.inbound[0]!.sentAt
    const proposal = await seedProposal(thread.ticketId, snapshotAt)
    const newerSentAt = new Date(snapshotAt.getTime() + 1000)
    // Carries an rfc id: the hard pre-checks run BEFORE the staleness guard (spec §4 step order),
    // so a newest-inbound with no rfc id would be refused by the pre-check and never reach the
    // stale path this test is about.
    await db.insert(supportMessages).values({
      ticketId: thread.ticketId,
      gmailMessageId: `${thread.threadId}-newer`,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'ping',
      rfcMessageId: `<${thread.threadId}-newer@mock.gmail>`,
      sentAt: newerSentAt,
    })

    const failingEnqueue = vi.fn(async () => {
      throw new Error('boss down')
    })
    await applySupportReply(makeDeps({ enqueue: failingEnqueue as unknown as ApplyProposalDeps['enqueue'] }), proposal)

    expect((await readProposal(proposal.id)).status).toBe('failed')
    expect((await readTicket(thread.ticketId)).status).toBe('triaged')
    expect(alert).toHaveBeenCalled()
    expect(gmail.sentMessages()).toHaveLength(0)
  })

  it('pre-check: gmail unconfigured fails the proposal terminally and notifies', async () => {
    const thread = await seedThread()
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)

    await applySupportReply(makeDeps({ gmail: null }), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('gmail not configured')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)
  })

  it('pre-check: an escalated ticket refuses a late Approve tap — failed, nothing sent', async () => {
    const thread = await seedThread({ status: 'escalated' })
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)

    await applySupportReply(makeDeps(), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('ticket no longer awaiting approval')
    expect(gmail.sentMessages()).toHaveLength(0)
    // The escalated ticket is the owner's now — the failing apply must not move it.
    expect((await readTicket(thread.ticketId)).status).toBe('escalated')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('pre-check: a ticket with no customer_email fails, nothing sent', async () => {
    const thread = await seedThread({ customerEmail: null })
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)

    await applySupportReply(makeDeps(), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('ticket has no customer email')
    expect(gmail.sentMessages()).toHaveLength(0)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('pre-check: a latest inbound with no rfc_message_id fails rather than sending unthreaded', async () => {
    const thread = await seedThread({ rfcMessageIdOnLatest: false })
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)

    await applySupportReply(makeDeps(), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('latest inbound message has no rfc message id')
    expect(gmail.sentMessages()).toHaveLength(0)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('recovery: a re-entered apply finds its own marker on the thread and does NOT send twice', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)

    // Prior attempt: the send landed, then the process died before the support_messages upsert.
    const priorSend = await gmail.sendReply({
      threadId: thread.threadId,
      to: CUSTOMER,
      subject: SUBJECT,
      inReplyTo: latest.rfcMessageId,
      references: latest.rfcMessageId,
      bodyText: REPLY_BODY,
      extraHeaders: { 'X-DogeBuddy-Proposal': proposal.id },
    })
    expect(gmail.sentMessages()).toHaveLength(1)

    await applySupportReply(makeDeps(), proposal)

    // No second copy for the customer.
    expect(gmail.sentMessages()).toHaveLength(1)
    const outbound = (await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.gmailMessageId).toBe(priorSend.id)
    expect((await readProposal(proposal.id)).status).toBe('applied')
    expect((await readTicket(thread.ticketId)).status).toBe('waiting_on_customer')
  })

  it('recovery: an ingested prior send is still recognized — a marked outbound row on the ticket does not hide it', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)

    const priorSend = await gmail.sendReply({
      threadId: thread.threadId,
      to: CUSTOMER,
      subject: SUBJECT,
      inReplyTo: latest.rfcMessageId,
      references: latest.rfcMessageId,
      bodyText: REPLY_BODY,
      extraHeaders: { 'X-DogeBuddy-Proposal': proposal.id },
    })
    // ...and this time ingest's poll got there first, so the sent id is ALREADY a support_messages
    // row when the apply re-enters. A recovery scan that skipped every known id would miss its own
    // marker here and send the customer a second copy.
    await db.insert(supportMessages).values({
      ticketId: thread.ticketId,
      gmailMessageId: priorSend.id,
      direction: 'outbound',
      fromEmail: SUPPORT_ADDRESS,
      bodyText: REPLY_BODY,
      sentAt: new Date(latest.sentAt.getTime() + 1000),
    })

    await applySupportReply(makeDeps(), proposal)

    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  /** Puts `n` messages on the Gmail thread that ingest has NOT recorded yet — i.e. exactly the
   * candidates the recovery scan must examine. */
  function addUnrecordedThreadMessages(threadId: string, n: number): void {
    for (let i = 0; i < n; i += 1) {
      gmail.receiveInbound({
        from: CUSTOMER,
        to: [SUPPORT_ADDRESS],
        subject: SUBJECT,
        bodyText: `unrecorded ${i}`,
        threadId,
      })
    }
  }

  /** A prior attempt's marked send, sitting on the thread exactly as a crash would have left it. */
  async function priorMarkedSend(thread: SeededThread, proposalId: string) {
    const latest = thread.inbound[thread.inbound.length - 1]!
    return gmail.sendReply({
      threadId: thread.threadId,
      to: CUSTOMER,
      subject: SUBJECT,
      inReplyTo: latest.rfcMessageId,
      references: latest.rfcMessageId,
      bodyText: REPLY_BODY,
      extraHeaders: { 'X-DogeBuddy-Proposal': proposalId },
    })
  }

  it('recovery: finds its own marker behind 21 newer unrecorded messages — the scan is not silently capped', async () => {
    const thread = await seedThread()
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)
    const priorSend = await priorMarkedSend(thread, proposal.id)
    // 21 > the old 20-message slice: with that cap the scan never reached our own send, reported
    // "nothing sent", and mailed the customer a second copy (the reviewer's reproduction).
    addUnrecordedThreadMessages(thread.threadId, 21)

    await applySupportReply(makeDeps(), proposal)

    expect(gmail.sentMessages()).toHaveLength(1)
    const outbound = (await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.gmailMessageId).toBe(priorSend.id)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('recovery: a thread with more candidates than the scan limit THROWS rather than sending blind', async () => {
    const thread = await seedThread()
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)
    addUnrecordedThreadMessages(thread.threadId, 51)

    await expect(applySupportReply(makeDeps(), proposal)).rejects.toThrow(THREAD_TOO_BUSY_ERROR)

    // Erring toward "retry" costs a delay; erring toward "send" costs the customer a duplicate.
    expect(gmail.sentMessages()).toHaveLength(0)
    expect((await readProposal(proposal.id)).status).toBe('applying')
    expect(notify).not.toHaveBeenCalled()
  })

  it('recovery runs BEFORE the staleness guard: a crashed-after-send re-entry with a newer inbound completes instead of refusing', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const snapshotAt = latest.sentAt
    const proposal = await seedProposal(thread.ticketId, snapshotAt)
    const priorSend = await priorMarkedSend(thread, proposal.id)

    // The crash window did its worst: the customer wrote again AND ingest recorded it before this
    // re-entry. The reply is already in their inbox — a "was NOT sent" refusal here would be a lie.
    const newerSentAt = new Date(snapshotAt.getTime() + 5_000)
    await db.insert(supportMessages).values({
      ticketId: thread.ticketId,
      gmailMessageId: `${thread.threadId}-post-send`,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'one more thing',
      rfcMessageId: `<${thread.threadId}-post-send@mock.gmail>`,
      sentAt: newerSentAt,
    })
    await db
      .update(supportTickets)
      .set({ lastInboundAt: newerSentAt })
      .where(eq(supportTickets.id, thread.ticketId))

    await applySupportReply(makeDeps(), proposal)

    expect(gmail.sentMessages()).toHaveLength(1)
    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.applyError).toBeNull()
    const outbound = (await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.gmailMessageId).toBe(priorSend.id)
    // No owner page claiming it didn't send, and no re-draft enqueue — the send happened.
    expect(notify).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    // The newer message still needs an answer, so the ticket goes back to the agent.
    expect((await readTicket(thread.ticketId)).status).toBe('triaged')
  })

  it('recovery after a crash between the flip and the applied transition completes to applied, not a false failure', async () => {
    const thread = await seedThread({ status: 'awaiting_approval' })
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)
    const priorSend = await priorMarkedSend(thread, proposal.id)
    // Prior attempt got all the way through the outbound row AND the flip, then died.
    await db.insert(supportMessages).values({
      ticketId: thread.ticketId,
      gmailMessageId: priorSend.id,
      direction: 'outbound',
      fromEmail: SUPPORT_ADDRESS,
      bodyText: REPLY_BODY,
      sentAt: new Date(thread.inbound[0]!.sentAt.getTime() + 1000),
    })
    await db
      .update(supportTickets)
      .set({ status: 'waiting_on_customer' })
      .where(eq(supportTickets.id, thread.ticketId))

    await applySupportReply(makeDeps(), proposal)

    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
    expect((await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')).toHaveLength(1)
    // The ticket already parked on the customer; recovery leaves that alone.
    expect((await readTicket(thread.ticketId)).status).toBe('waiting_on_customer')
    expect(notify).not.toHaveBeenCalled()
  })

  it("recovery: the owner's own unmarked reply in the crash window is NOT mistaken for ours — the approved draft still sends", async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)

    // The owner hand-replied from Gmail. No marker header — this is not our send.
    await gmail.sendReply({
      threadId: thread.threadId,
      to: CUSTOMER,
      subject: SUBJECT,
      inReplyTo: latest.rfcMessageId,
      references: latest.rfcMessageId,
      bodyText: 'typed by the owner on their phone',
    })

    await applySupportReply(makeDeps(), proposal)

    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(2)
    expect(headerLines(sent[1]!.raw)).toContain(`X-DogeBuddy-Proposal: ${proposal.id}`)
    expect(decodeRaw(sent[1]!.raw)).toContain('Your order shipped yesterday')
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('inbound during apply: a message landing between the send and the flip lands the ticket in triaged, not waiting_on_customer', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const snapshotAt = latest.sentAt
    const proposal = await seedProposal(thread.ticketId, snapshotAt)

    // Wraps the mock so a new customer message lands exactly in the window the conditional flip
    // exists to catch: after the send, before the status write.
    const arrivalAt = new Date(snapshotAt.getTime() + 5_000)
    const racingGmail: GmailClient = {
      ...gmail,
      sendReply: async (r) => {
        const result = await gmail.sendReply(r)
        await db.insert(supportMessages).values({
          ticketId: thread.ticketId,
          gmailMessageId: `${thread.threadId}-mid-apply`,
          direction: 'inbound',
          fromEmail: CUSTOMER,
          bodyText: 'one more thing',
          sentAt: arrivalAt,
        })
        await db
          .update(supportTickets)
          .set({ lastInboundAt: arrivalAt })
          .where(eq(supportTickets.id, thread.ticketId))
        return result
      },
    }

    await applySupportReply(makeDeps({ gmail: racingGmail }), proposal)

    // The reply DID send (it was approved before the new message existed) and the proposal applied…
    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
    // …but the ticket goes back to the agent instead of parking on the customer.
    expect((await readTicket(thread.ticketId)).status).toBe('triaged')
  })

  it('inbound during apply: the triaged hand-back clears the claim stamp, so selection can actually pick the ticket up again', async () => {
    // The nasty timing: the message reached Gmail BEFORE the agent claimed the ticket, but ingest
    // only recorded it during this apply. So last_inbound_at < last_agent_run_at — selection's
    // "new inbound" branch never fires — and the run FINISHED, so the stuck branch never fires
    // either. Without clearing the stamp the ticket sits in `triaged` forever, unselectable.
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const snapshotAt = latest.sentAt
    const claimAt = new Date(snapshotAt.getTime() + 60_000)
    await db
      .update(supportTickets)
      .set({ lastAgentRunAt: claimAt, lastAgentFinishedAt: new Date(claimAt.getTime() + 1_000) })
      .where(eq(supportTickets.id, thread.ticketId))
    const proposal = await seedProposal(thread.ticketId, snapshotAt)

    const arrivalAt = new Date(snapshotAt.getTime() + 1_000) // newer than the snapshot, OLDER than the claim
    const racingGmail: GmailClient = {
      ...gmail,
      sendReply: async (r) => {
        const result = await gmail.sendReply(r)
        await db.insert(supportMessages).values({
          ticketId: thread.ticketId,
          gmailMessageId: `${thread.threadId}-late-ingest`,
          direction: 'inbound',
          fromEmail: CUSTOMER,
          bodyText: 'sent before the claim, ingested during the apply',
          sentAt: arrivalAt,
        })
        await db
          .update(supportTickets)
          .set({ lastInboundAt: arrivalAt })
          .where(eq(supportTickets.id, thread.ticketId))
        return result
      },
    }

    await applySupportReply(makeDeps({ gmail: racingGmail }), proposal)

    const ticket = await readTicket(thread.ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()

    // The real selection predicate must now pick it up — the point of the clear.
    const selectedIds: string[] = []
    await selectAndEnqueueAgentRuns({
      db,
      enqueue: async (_name, data) => {
        selectedIds.push((data as { ticketId: string }).ticketId)
      },
      alert: vi.fn(async () => {}),
      now: () => new Date(claimAt.getTime() + 5 * 60_000),
    })
    expect(selectedIds).toContain(thread.ticketId)
  })

  it('double delivery: two sequential proposal.apply runs for the same proposal send exactly once', async () => {
    const thread = await seedThread()
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'support_reply',
        status: 'approved',
        summary: `Reply: ${SUBJECT}`,
        payload: {
          type: 'support_reply',
          ticketId: thread.ticketId,
          body: REPLY_BODY,
          threadSnapshotAt: thread.inbound[0]!.sentAt.toISOString(),
        },
        sourceWorkflow: 'support',
        ticketId: thread.ticketId,
      })
      .returning()

    await executeApplyProposal(makeDeps(), row!.id)
    // pg-boss's singletonKey dedupes concurrent deliveries; a *sequential* redelivery (retry after
    // a completed-but-unacked run) still reaches the shell, which must refuse it.
    await executeApplyProposal(makeDeps(), row!.id)

    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readMessages(thread.ticketId)).filter((m) => m.direction === 'outbound')).toHaveLength(1)
    expect((await readProposal(row!.id)).status).toBe('applied')
  })

  it('references: caps at the last 20 thread ids and always ends with the In-Reply-To target', async () => {
    const thread = await seedThread({ count: 23 })
    const latest = thread.inbound[22]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)

    await applySupportReply(makeDeps(), proposal)

    const refs = headerLines(gmail.sentMessages()[0]!.raw)
      .find((l) => l.startsWith('References: '))!
      .slice('References: '.length)
      .split(' ')
    expect(refs).toHaveLength(20)
    expect(refs[19]).toBe(latest.rfcMessageId)
    // RFC 5322 §3.6.4 trimming: the thread ROOT is kept (dropping it can split a long thread into
    // a second conversation in the customer's client), then the newest 19.
    expect(refs[0]).toBe(thread.inbound[0]!.rfcMessageId)
    expect(refs[1]).toBe(thread.inbound[4]!.rfcMessageId)
  })

  it('a proposal whose ticket vanished fails terminally rather than retrying forever', async () => {
    const thread = await seedThread()
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)
    await db.delete(supportMessages).where(eq(supportMessages.ticketId, thread.ticketId))
    await db.update(proposals).set({ ticketId: null }).where(eq(proposals.id, proposal.id))
    await db.delete(supportTickets).where(eq(supportTickets.id, thread.ticketId))

    await applySupportReply(makeDeps(), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('ticket not found')
    expect(gmail.sentMessages()).toHaveLength(0)
    await db.delete(auditLog).where(eq(auditLog.entityId, proposal.id))
    await db.delete(proposals).where(eq(proposals.id, proposal.id))
  })

  it('a getMessage failure during the recovery scan throws (retry) rather than risking a double send', async () => {
    const thread = await seedThread()
    const latest = thread.inbound[0]!
    const proposal = await seedProposal(thread.ticketId, latest.sentAt)
    await gmail.sendReply({
      threadId: thread.threadId,
      to: CUSTOMER,
      subject: SUBJECT,
      inReplyTo: latest.rfcMessageId,
      references: latest.rfcMessageId,
      bodyText: REPLY_BODY,
      extraHeaders: { 'X-DogeBuddy-Proposal': proposal.id },
    })
    gmail.failNext('getMessage', new Error('gmail 500'))

    await expect(applySupportReply(makeDeps(), proposal)).rejects.toThrow('gmail 500')

    // Unresolved: still `applying`, so the retry re-enters and re-checks rather than sending blind.
    expect(gmail.sentMessages()).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applying')
  })

  it('a ticket whose support_messages hold no inbound at all fails rather than sending', async () => {
    const thread = await seedThread()
    await db
      .update(supportMessages)
      .set({ direction: 'outbound' })
      .where(and(eq(supportMessages.ticketId, thread.ticketId), eq(supportMessages.direction, 'inbound')))
    const proposal = await seedProposal(thread.ticketId, thread.inbound[0]!.sentAt)

    await applySupportReply(makeDeps(), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('no inbound message to reply to')
    expect(gmail.sentMessages()).toHaveLength(0)
  })
})
