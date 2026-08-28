import { createDb, proposals, supportTickets } from '@doge-buddy/db'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SELECT_CAP_PER_CYCLE,
  selectAndEnqueueAgentRuns,
  type AgentSelectDeps,
} from '../src/support/agent-select.ts'
import { SUPPORT_AGENT_QUEUE } from '../src/jobs/support-agent-run.ts'
import { proposalExpireSweepHandler } from '../src/jobs/proposal-expire-sweep.ts'

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
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
    createdAt?: Date
    expiresAt?: Date
  }): Promise<void> {
    await db.insert(proposals).values({
      type: opts.type ?? 'support_reply',
      status: opts.status,
      summary: 'prior draft',
      payload: {},
      sourceWorkflow: 'support',
      ticketId: opts.ticketId,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
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

  /** The set of ticket ids `enqueue` was actually called with, in call order. */
  function enqueuedIds(deps: AgentSelectDeps): string[] {
    return (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { ticketId: string }).ticketId)
  }

  describe('selection predicate', () => {
    // Each case below seeds an ELIGIBLE ticket alongside an INELIGIBLE sibling in the SAME test
    // (fix round 1, Minor 6) — a bare `enqueued === 0` or `enqueued === 1` assertion can pass
    // vacuously if the whole query is broken (e.g. always empty, or always everything); pinning the
    // exact enqueued ticket id proves the predicate discriminated the RIGHT ticket, not just SOME
    // ticket count.
    it('enqueues a triaged never-run ticket, but not a claimed sibling with no new inbound', async () => {
      const eligible = await seedTicket({ lastAgentRunAt: null })
      await seedTicket({ lastAgentRunAt: minutesAgo(5), lastInboundAt: minutesAgo(30), lastAgentFinishedAt: minutesAgo(4) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(enqueuedIds(deps)).toEqual([eligible])
      expect(deps.enqueue).toHaveBeenCalledWith(
        SUPPORT_AGENT_QUEUE,
        { ticketId: eligible },
        { singletonKey: eligible, retryLimit: 1, retryDelay: 30, expireInSeconds: 600 },
      )
    })

    it('enqueues a ticket with new inbound since its last run, but not a sibling that already finished with no new inbound', async () => {
      const eligible = await seedTicket({ lastAgentRunAt: minutesAgo(10), lastInboundAt: minutesAgo(5) })
      await seedTicket({ lastAgentRunAt: minutesAgo(30), lastInboundAt: minutesAgo(40), lastAgentFinishedAt: minutesAgo(29) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(enqueuedIds(deps)).toEqual([eligible])
    })

    it('enqueues a stuck ticket (claimed 20+ minutes ago, never finished), but not a sibling still within the stuck window', async () => {
      const eligible = await seedTicket({
        lastAgentRunAt: minutesAgo(25),
        lastInboundAt: minutesAgo(30), // no new inbound — only the stuck branch authorizes this
        lastAgentFinishedAt: null,
      })
      await seedTicket({ lastAgentRunAt: minutesAgo(10), lastInboundAt: minutesAgo(30), lastAgentFinishedAt: null })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(enqueuedIds(deps)).toEqual([eligible])
    })

    it('skips a ticket at the failure ceiling even though never run, alongside an eligible sibling', async () => {
      await seedTicket({ lastAgentRunAt: null, agentFailureCount: 2 })
      const eligible = await seedTicket({ lastAgentRunAt: null, agentFailureCount: 0 })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(enqueuedIds(deps)).toEqual([eligible])
    })

    it('skips tickets not in triaged status, alongside an eligible triaged sibling', async () => {
      await seedTicket({ status: 'new', lastAgentRunAt: null })
      await seedTicket({ status: 'resolved', lastAgentRunAt: null })
      await seedTicket({ status: 'escalated', lastAgentRunAt: null })
      const eligible = await seedTicket({ status: 'triaged', lastAgentRunAt: null })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(1)
      expect(enqueuedIds(deps)).toEqual([eligible])
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
      // The 10 OLDEST-inbound tickets (i = 12 down to i = 3) are the ones enqueued; the 2 newest
      // (i = 1, i = 2) are left for the next cycle.
      expect(enqueuedIds(deps)).toEqual(ids.slice(0, 10))
    })

    // Minor 5: Postgres's default for ASC is NULLS LAST, which would sort a ticket with no inbound
    // at all BEHIND every ticket that has one — starving it off the back of the cap forever on a
    // busy cycle. NULLS FIRST treats "no inbound yet" as the oldest possible case.
    it('NULLS FIRST: a ticket with no inbound at all is not starved behind the cap', async () => {
      const noInbound = await seedTicket({ lastAgentRunAt: null, lastInboundAt: null })
      const withInbound: string[] = []
      // 10 more eligible tickets, all with a real (non-null) last_inbound_at — one over the cap
      // together with `noInbound`, so something has to be excluded.
      for (let i = 1; i <= 10; i++) {
        withInbound.push(await seedTicket({ lastAgentRunAt: null, lastInboundAt: minutesAgo(i) }))
      }
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.enqueued).toBe(AGENT_SELECT_CAP_PER_CYCLE)
      const ids = enqueuedIds(deps)
      // The null-inbound ticket sorts FIRST (oldest-possible reading) and is always included.
      expect(ids).toContain(noInbound)
      // The newest real-timestamp ticket (i = 1, smallest minutesAgo => most recent) is the one
      // bumped off the cap to make room.
      expect(ids).not.toContain(withInbound[0])
    })
  })

  describe('orphan backstop', () => {
    // IMPORTANT 2 (fix round 1): terminal proposal statuses (applied/rejected/failed) are NOT
    // "live" — a ticket stuck in awaiting_approval behind only a terminal proposal is exactly the
    // crash/lost-race window this backstop exists to catch. `it.each` over all three terminal
    // statuses plus the pre-existing `expired`.
    it.each(['expired', 'applied', 'rejected', 'failed'] as const)(
      'escalates when the only proposal is terminal (%s), created 20+ minutes ago',
      async (status) => {
        const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
        await seedProposal({ ticketId, status, createdAt: minutesAgo(20) })
        const deps = makeDeps()

        const result = await selectAndEnqueueAgentRuns(deps)

        expect(result.orphansEscalated).toBe(1)
        const ticket = await ticketById(ticketId)
        expect(ticket.status).toBe('escalated')
        expect(ticket.escalationReason).toBe('orphaned_awaiting_approval')
        expect(ticket.escalationNotifiedAt).toBeNull()
      },
    )

    it.each(['pending', 'approved', 'applying'] as const)(
      'leaves the ticket untouched when a %s proposal is live, regardless of age',
      async (status) => {
        const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
        await seedProposal({ ticketId, status, createdAt: minutesAgo(20) })
        const deps = makeDeps()

        const result = await selectAndEnqueueAgentRuns(deps)

        expect(result.orphansEscalated).toBe(0)
        expect((await ticketById(ticketId)).status).toBe('awaiting_approval')
      },
    )

    // Anchor precedence tier 1: the newest proposal's created_at wins over everything else,
    // INCLUDING a much older ticket.updated_at — proposal activity (even one that later expired)
    // is what resets the clock.
    it('leaves the ticket untouched when its newest proposal was created within the last 15 minutes, even if updated_at is old', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(999) })
      await seedProposal({ ticketId, status: 'expired', createdAt: minutesAgo(5) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      expect((await ticketById(ticketId)).status).toBe('awaiting_approval')
    })

    // IMPORTANT 3: the anchor must NOT degrade on customer chasing. A customer writing again and
    // again bumps ticket.updated_at via the column's own $onUpdate on every real inbound — this
    // simulates that by seeding a FRESH updated_at directly, while the proposal anchor (tier 1)
    // stays old. If the old (updated_at-only) logic were still in place, this ticket would look
    // freshly active and never get escalated — exactly backwards, since a chasing customer IS the
    // signal something is stuck.
    it('CHASING CUSTOMER: a fresh updated_at (simulating a new inbound) does not reset the orphan clock', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(1) })
      await seedProposal({ ticketId, status: 'expired', createdAt: minutesAgo(20) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(1)
      expect((await ticketById(ticketId)).status).toBe('escalated')
    })

    // Anchor precedence tier 2: no proposal ever existed, but last_agent_run_at is fresh — still
    // not touched, and specifically NOT because of ticket.updated_at (seeded old here, to isolate
    // that this is the last_agent_run_at fallback doing the work, not the updated_at floor).
    it('leaves the ticket untouched when it has no proposal but last_agent_run_at is fresh, even with an old updated_at', async () => {
      const ticketId = await seedTicket({
        status: 'awaiting_approval',
        updatedAt: minutesAgo(999),
        lastAgentRunAt: minutesAgo(5),
      })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      expect((await ticketById(ticketId)).status).toBe('awaiting_approval')
    })

    // Anchor precedence tier 3 (the floor): neither a proposal nor a claim ever happened — falls
    // all the way back to updated_at.
    it('escalates a stale awaiting_approval ticket with NO proposal and NO last_agent_run_at (falls back to updated_at)', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(1)
      expect((await ticketById(ticketId)).status).toBe('escalated')
    })

    it('leaves untouched when idle only 5 minutes by the updated_at floor', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(5) })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(0)
      expect((await ticketById(ticketId)).status).toBe('awaiting_approval')
    })

    it('does not notify — CRITICAL-1: nothing here calls the owner directly', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(20) })
      const deps = makeDeps()

      await selectAndEnqueueAgentRuns(deps)

      expect((await ticketById(ticketId)).escalationNotifiedAt).toBeNull()
      // No `notify` dep exists on AgentSelectDeps at all — this is a compile-time guarantee too.
    })

    // Minor 4 (folded into IMPORTANT 3's single set-based query): the backstop must not try to
    // escalate an unbounded backlog in one cycle.
    it('caps orphan escalations at AGENT_SELECT_CAP_PER_CYCLE per cycle, oldest anchor first', async () => {
      const ids: string[] = []
      // Oldest (largest minutesAgo => furthest in the past) first, via last_agent_run_at (tier 2,
      // no proposal seeded) so each ticket's anchor is distinct and independently controllable.
      for (let i = 12; i >= 1; i--) {
        ids.push(await seedTicket({ status: 'awaiting_approval', lastAgentRunAt: minutesAgo(15 + i) }))
      }
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.orphansEscalated).toBe(AGENT_SELECT_CAP_PER_CYCLE)
      // Re-read each ticket by id to determine exactly which ones were escalated: the 10 OLDEST
      // anchors (i = 12 down to i = 3) should be escalated; the 2 newest (i = 1, i = 2) left
      // untouched for the next cycle.
      const statuses = await Promise.all(ids.map((id) => ticketById(id)))
      const actuallyEscalated = ids.filter((_, i) => statuses[i]!.status === 'escalated')
      expect(actuallyEscalated).toEqual(ids.slice(0, 10))
    })
  })

  // FR2b: the unbacked-refund-promise backstop. A `waiting_on_customer` ticket whose reply SHIPPED
  // (applied support_reply) but whose paired refund died (expired/rejected/failed) with no live
  // refund left is a written refund promise with nothing behind it — escalate + PAGE.
  describe('unbacked-refund-promise backstop (FR2b)', () => {
    async function seedUnbacked(refundStatus: 'expired' | 'rejected' | 'failed'): Promise<string> {
      const ticketId = await seedTicket({ status: 'waiting_on_customer' })
      await seedProposal({ ticketId, type: 'support_reply', status: 'applied' })
      await seedProposal({ ticketId, type: 'refund', status: refundStatus })
      return ticketId
    }

    it.each(['expired', 'rejected', 'failed'] as const)(
      'escalates a shipped-reply ticket whose paired refund is %s, with a page (notify stamp NULL)',
      async (refundStatus) => {
        const ticketId = await seedUnbacked(refundStatus)
        const deps = makeDeps()

        const result = await selectAndEnqueueAgentRuns(deps)

        expect(result.unbackedEscalated).toBe(1)
        const ticket = await ticketById(ticketId)
        expect(ticket.status).toBe('escalated')
        expect(ticket.escalationReason).toBe('refund_promise_unbacked')
        expect(ticket.escalationNotifiedAt).toBeNull()
      },
    )

    it.each(['pending', 'approved', 'applying', 'applied'] as const)(
      'leaves the ticket untouched when a %s refund still backs the promise',
      async (refundStatus) => {
        const ticketId = await seedTicket({ status: 'waiting_on_customer' })
        await seedProposal({ ticketId, type: 'support_reply', status: 'applied' })
        // A dead refund AND a still-live one — a later run re-proposed a fresh refund.
        await seedProposal({ ticketId, type: 'refund', status: 'expired' })
        await seedProposal({ ticketId, type: 'refund', status: refundStatus })
        const deps = makeDeps()

        const result = await selectAndEnqueueAgentRuns(deps)

        expect(result.unbackedEscalated).toBe(0)
        expect((await ticketById(ticketId)).status).toBe('waiting_on_customer')
      },
    )

    it('does not escalate a shipped reply with NO refund proposal at all (reply-only ticket)', async () => {
      const ticketId = await seedTicket({ status: 'waiting_on_customer' })
      await seedProposal({ ticketId, type: 'support_reply', status: 'applied' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.unbackedEscalated).toBe(0)
      expect((await ticketById(ticketId)).status).toBe('waiting_on_customer')
    })

    it('happy path unchanged: reply NOT yet shipped (still awaiting_approval) with a pending refund is untouched', async () => {
      const ticketId = await seedTicket({ status: 'awaiting_approval', updatedAt: minutesAgo(1) })
      await seedProposal({ ticketId, type: 'support_reply', status: 'pending' })
      await seedProposal({ ticketId, type: 'refund', status: 'pending' })
      const deps = makeDeps()

      const result = await selectAndEnqueueAgentRuns(deps)

      expect(result.unbackedEscalated).toBe(0)
      expect(result.orphansEscalated).toBe(0)
      expect((await ticketById(ticketId)).status).toBe('awaiting_approval')
    })

    it('the real expire path: a pending refund past its expiresAt is swept, THEN the next select cycle escalates', async () => {
      const ticketId = await seedTicket({ status: 'waiting_on_customer' })
      await seedProposal({ ticketId, type: 'support_reply', status: 'applied' })
      await seedProposal({ ticketId, type: 'refund', status: 'pending', expiresAt: minutesAgo(60) })

      // Run the actual sweep — it flips the pending refund to expired.
      await proposalExpireSweepHandler(db)([] as never)

      const result = await selectAndEnqueueAgentRuns(makeDeps())

      expect(result.unbackedEscalated).toBe(1)
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('refund_promise_unbacked')
      expect(ticket.escalationNotifiedAt).toBeNull()
    })
  })
})
