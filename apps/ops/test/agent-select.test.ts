import { createDb, proposals, supportTickets } from '@doge-buddy/db'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SELECT_CAP_PER_CYCLE,
  selectAndEnqueueAgentRuns,
  type AgentSelectDeps,
} from '../src/support/agent-select.ts'
import { SUPPORT_AGENT_QUEUE } from '../src/jobs/support-agent-run.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

/** Mid-day so every relative seed below stays inside the same UTC day. */
const NOW = new Date('2026-06-15T12:00:00.000Z')
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)

describe('selectAndEnqueueAgentRuns', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let uidCounter = 0
  function uid(): string {
    uidCounter += 1
    return `${Date.now()}-${uidCounter}`
  }

  async function seedTicket(
    opts: {
      status?: (typeof supportTickets.$inferInsert)['status']
      lastInboundAt?: Date | null
      lastAgentRunAt?: Date | null
      lastAgentFinishedAt?: Date | null
      agentFailureCount?: number
      updatedAt?: Date
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `agentselect-${uid()}`,
        customerEmail: 'jane@example.com',
        subject: 'Where is my order?',
        status: opts.status ?? 'triaged',
        category: 'shipping',
        sentiment: 'neutral',
        lastInboundAt: opts.lastInboundAt === undefined ? minutesAgo(30) : opts.lastInboundAt,
        lastAgentRunAt: opts.lastAgentRunAt ?? null,
        lastAgentFinishedAt: opts.lastAgentFinishedAt ?? null,
        agentFailureCount: opts.agentFailureCount ?? 0,
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedProposal(opts: {
    ticketId: string
    type?: 'support_reply' | 'refund'
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied'
  }): Promise<void> {
    await db.insert(proposals).values({
      type: opts.type ?? 'support_reply',
      status: opts.status,
      summary: 'prior draft',
      payload: {},
      sourceWorkflow: 'support',
      ticketId: opts.ticketId,
    })
  }

  async function ticketById(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row!
  }

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'agentselect-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
  })

  function makeDeps(overrides: Partial<AgentSelectDeps> = {}): AgentSelectDeps {
    return {
      db,
      enqueue: vi.fn(async () => {}),
      alert: vi.fn(async () => {}),
      now: () => NOW,
      ...overrides,
    }
  }

  describe('selection predicate', () => {
    it('enqueues a triaged, never-run ticket', async () => {
      const ticketId = await seedTicket({ lastAgentRunAt: null })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(deps.enqueue).toHaveBeenCalledWith(
        SUPPORT_AGENT_QUEUE,
        { ticketId },
        { singletonKey: ticketId, retryLimit: 1, retryDelay: 30, expireInSeconds: 600 },
      )
    })

    it('enqueues a ticket with new inbound since its last run', async () => {
      const ticketId = await seedTicket({ lastAgentRunAt: minutesAgo(10), lastInboundAt: minutesAgo(5) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(deps.enqueue).toHaveBeenCalledWith(SUPPORT_AGENT_QUEUE, { ticketId }, expect.anything())
    })

    it('enqueues a stuck ticket: claimed 20+ minutes ago, never finished', async () => {
      const ticketId = await seedTicket({
        lastAgentRunAt: minutesAgo(25),
        lastInboundAt: minutesAgo(30), // no new inbound — only the stuck branch authorizes this
        lastAgentFinishedAt: null,
      })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(deps.enqueue).toHaveBeenCalledWith(SUPPORT_AGENT_QUEUE, { ticketId }, expect.anything())
    })

    it('skips a claimed ticket with no new inbound (not yet stuck)', async () => {
      await seedTicket({
        lastAgentRunAt: minutesAgo(5),
        lastInboundAt: minutesAgo(30),
        lastAgentFinishedAt: minutesAgo(4),
      })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(0)
      expect(deps.enqueue).not.toHaveBeenCalled()
    })

    it('skips a ticket that already finished a run and has no new inbound', async () => {
      await seedTicket({
        lastAgentRunAt: minutesAgo(30),
        lastInboundAt: minutesAgo(40),
        lastAgentFinishedAt: minutesAgo(29),
      })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(0)
      expect(deps.enqueue).not.toHaveBeenCalled()
    })

    it('skips a ticket at the failure ceiling (agent_failure_count = 2), even if never run', async () => {
      await seedTicket({ lastAgentRunAt: null, agentFailureCount: 2 })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(0)
      expect(deps.enqueue).not.toHaveBeenCalled()
    })

    it('skips tickets not in triaged status', async () => {
      await seedTicket({ status: 'new', lastAgentRunAt: null })
      await seedTicket({ status: 'resolved', lastAgentRunAt: null })
      await seedTicket({ status: 'escalated', lastAgentRunAt: null })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(0)
      expect(deps.enqueue).not.toHaveBeenCalled()
    })

    it('caps at AGENT_SELECT_CAP_PER_CYCLE, oldest inbound first, when 12 are eligible', async () => {
      const ids: string[] = []
      // Oldest (smallest minutesAgo argument = furthest in the past = smallest timestamp) first.
      for (let i = 12; i >= 1; i--) {
        ids.push(await seedTicket({ lastAgentRunAt: null, lastInboundAt: minutesAgo(i) }))
      }
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(AGENT_SELECT_CAP_PER_CYCLE)
      expect(AGENT_SELECT_CAP_PER_CYCLE).toBe(10)
      expect(deps.enqueue).toHaveBeenCalledTimes(10)
      // The 10 OLDEST-inbound tickets (i = 12 down to i = 3) are the ones enqueued; the 2 newest
      // (i = 1, i = 2) are left for the next cycle.
      const enqueuedIds = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { ticketId: string }).ticketId)
      expect(enqueuedIds).toEqual(ids.slice(0, 10))
    })
  })

  describe('orphan backstop', () => {
    it('escalates an awaiting_approval ticket idle 15+ minutes with only an expired proposal', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      await seedProposal({ ticketId, status: 'expired' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(1)
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('orphaned_awaiting_approval')
      expect(ticket.escalationNotifiedAt).toBeNull()
    })

    it('leaves an awaiting_approval ticket untouched when only idle 5 minutes', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(5) })
      await seedProposal({ ticketId, status: 'expired' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('awaiting_approval')
    })

    it('leaves an awaiting_approval ticket untouched when a pending proposal is live', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      await seedProposal({ ticketId, status: 'pending' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('awaiting_approval')
    })

    it('leaves an awaiting_approval ticket untouched when an approved or applying proposal is live', async () => {
      const approvedId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      await seedProposal({ ticketId: approvedId, status: 'approved' })
      const applyingId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      await seedProposal({ ticketId: applyingId, status: 'applying' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      expect((await ticketById(approvedId)).status).toBe('awaiting_approval')
      expect((await ticketById(applyingId)).status).toBe('awaiting_approval')
    })

    it('escalates a stale awaiting_approval ticket with NO proposal at all', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(1)
      expect((await ticketById(ticketId)).status).toBe('escalated')
    })

    it('does not notify — CRITICAL-1: nothing here calls the owner directly', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      const deps = makeDeps()

      await selectAndEnqueueAgentRuns(deps)

      expect((await ticketById(ticketId)).escalationNotifiedAt).toBeNull()
      // No `notify` dep exists on AgentSelectDeps at all — this is a compile-time guarantee too.
    })
  })
})
