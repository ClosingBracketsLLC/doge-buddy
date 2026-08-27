import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentRuns, auditLog, createDb, orders, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import type { DisputeOptions } from '@doge-buddy/supplier'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessResult } from '../src/agents/run-harness.ts'
import { SUPPORT_PROJECT_KEY } from '../src/agents/session-store.ts'
import type { SupportOutput } from '../src/agents/support-output-schema.ts'
import { SUPPORT_MODEL, type SupportRunContext, type SupportRunInput } from '../src/agents/support-run.ts'
import {
  AGENT_ESCALATE_LOST_RACE_ACTION,
  AGENT_NO_ACTION_ACTION,
  AGENT_PROPOSE_LOST_RACE_ACTION,
  AGENT_RUN_AUDIT_ACTION,
  AGENT_RUN_CAPPED_ACTION,
  AGENT_RUN_FAILED_ACTION,
  AGENT_RUN_SKIPPED_ACTION,
  AGENT_RUN_TICKET_CAPPED_ACTION,
  PROPOSAL_SUPERSEDED_ACTION,
  SUPPORT_AGENT_MAX_RUNS_PER_DAY,
  SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY,
  SUPPORT_AGENT_QUEUE,
  enqueueSupportAgentRun,
  executeSupportAgentRun,
  supportAgentRunHandler,
  type SupportAgentJobDeps,
} from '../src/jobs/support-agent-run.ts'
import { SETTINGS_DEFAULTS, createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

/** Mid-day so every relative seed below (±30 min) stays inside the same UTC day as `utcMidnight`. */
const NOW = new Date('2026-06-15T12:00:00.000Z')
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)

const AUDIT_ACTIONS = [
  AGENT_RUN_AUDIT_ACTION,
  AGENT_RUN_SKIPPED_ACTION,
  AGENT_RUN_CAPPED_ACTION,
  AGENT_RUN_TICKET_CAPPED_ACTION,
  AGENT_NO_ACTION_ACTION,
  AGENT_PROPOSE_LOST_RACE_ACTION,
  AGENT_ESCALATE_LOST_RACE_ACTION,
  AGENT_RUN_FAILED_ACTION,
]

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

function succeededResult(
  output: SupportOutput,
  overrides: Partial<HarnessResult<SupportOutput>> = {},
): HarnessResult<SupportOutput> {
  return {
    status: 'succeeded',
    output,
    costUsd: 0,
    costEstimated: false,
    sessionId: 'stub-session',
    sawMirrorError: false,
    failedBeforeFirstAssistant: false,
    ...overrides,
  }
}

function benignResult(): HarnessResult<SupportOutput> {
  return succeededResult({ outcome: 'no_action', rationale: 'stub' })
}

/** A run that produced no usable output — `status` distinguishes throw/watchdog from budget abort. */
function unusableResult(overrides: Partial<HarnessResult<SupportOutput>> = {}): HarnessResult<SupportOutput> {
  return {
    status: 'failed',
    output: null,
    costUsd: 0,
    costEstimated: false,
    sessionId: null,
    sawMirrorError: false,
    failedBeforeFirstAssistant: false,
    ...overrides,
  }
}

/** A body that passes every validator screen: no HTML, no domains, no digits, no promised action. */
const CLEAN_BODY = 'Hi Jane,\n\nThanks for reaching out — your package is moving through the carrier network.\n\nDoge Buddy Support'

function proposeOutput(overrides: Partial<Extract<SupportOutput, { outcome: 'propose' }>> = {}): SupportOutput {
  return { outcome: 'propose', reply: { body: CLEAN_BODY }, rationale: 'drafted', ...overrides }
}

describe('executeSupportAgentRun', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  let alert: ReturnType<typeof vi.fn>
  let notify: ReturnType<typeof vi.fn>
  let runFn: ReturnType<typeof vi.fn>
  /** Every `ctx` the stubbed runner was handed, in call order. */
  let contexts: SupportRunContext[]
  let runIds: string[]
  let sessionEntries: SessionStoreEntry[] | null
  let sessionStore: SessionStore

  beforeEach(async () => {
    alert = vi.fn(async () => {})
    notify = vi.fn(async () => true)
    contexts = []
    runIds = []
    sessionEntries = null
    runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
      contexts.push(input.ctx)
      runIds.push(input.runId)
      return benignResult()
    })
    sessionStore = {
      append: vi.fn(async () => {}),
      load: vi.fn(async () => sessionEntries),
      listSubkeys: vi.fn(async () => []),
    } as unknown as SessionStore
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    // Both default to 'manual' (SETTINGS_DEFAULTS); pinned here so a stray row from another
    // test file cannot flip these runs into auto mode.
    await settings.set('workflow.support_reply.mode', 'manual')
    await settings.set('workflow.refund.mode', 'manual')
  })

  // Everything this file creates is reachable from the `agentrun-%` thread-id prefix (orders from
  // `agentrun-order-%`), and it exclusively owns the audit actions above (vitest runs files
  // serially — see vitest.config.ts). Proposal-scoped audit rows (`proposal.created`,
  // `proposal.superseded`, …) are removed by entity id rather than by action, so nothing another
  // file's proposals wrote is touched.
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'agentrun-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      const proposalRows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(inArray(proposals.ticketId, ticketIds))
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(agentRuns).where(inArray(agentRuns.triggerRef, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
      if (proposalRows.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.entityId, proposalRows.map((r) => r.id)))
      }
    }
    await db.delete(orders).where(like(orders.shopifyOrderGid, 'gid://shopify/Order/agentrun-order-%'))
    await db.delete(auditLog).where(inArray(auditLog.action, AUDIT_ACTIONS))
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    // Both default to 'manual' (SETTINGS_DEFAULTS); pinned here so a stray row from another
    // test file cannot flip these runs into auto mode.
    await settings.set('workflow.support_reply.mode', 'manual')
    await settings.set('workflow.refund.mode', 'manual')
    vi.restoreAllMocks()
  })

  function makeDeps(overrides: Partial<SupportAgentJobDeps> = {}): SupportAgentJobDeps {
    return {
      db,
      settings,
      alert,
      notify,
      adminBaseUrl: 'https://admin.test',
      adapter: { getDisputeOptions: vi.fn(async (): Promise<DisputeOptions> => ({}) as DisputeOptions) },
      enqueue: vi.fn(async () => {}),
      sessionStore,
      anthropicConfigured: true,
      runFn: runFn as unknown as SupportAgentJobDeps['runFn'],
      now: () => NOW,
      ...overrides,
    }
  }

  async function seedTicket(
    opts: {
      status?: (typeof supportTickets.$inferInsert)['status']
      lastInboundAt?: Date | null
      lastAgentRunAt?: Date | null
      lastAgentPromptedAt?: Date | null
      lastAgentFinishedAt?: Date | null
      agentFailureCount?: number
      agentSessionId?: string | null
      escalationNotifiedAt?: Date | null
      escalationReason?: string | null
      orderId?: string | null
      customerEmail?: string | null
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `agentrun-${uid()}`,
        customerEmail: opts.customerEmail === undefined ? 'jane@example.com' : opts.customerEmail,
        orderId: opts.orderId ?? null,
        subject: 'Where is my order?',
        status: opts.status ?? 'triaged',
        category: 'shipping',
        sentiment: 'neutral',
        lastInboundAt: opts.lastInboundAt === undefined ? minutesAgo(30) : opts.lastInboundAt,
        lastAgentRunAt: opts.lastAgentRunAt ?? null,
        lastAgentPromptedAt: opts.lastAgentPromptedAt ?? null,
        lastAgentFinishedAt: opts.lastAgentFinishedAt ?? null,
        agentFailureCount: opts.agentFailureCount ?? 0,
        agentSessionId: opts.agentSessionId ?? null,
        escalationNotifiedAt: opts.escalationNotifiedAt ?? null,
        escalationReason: opts.escalationReason ?? null,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedMessage(
    ticketId: string,
    opts: { bodyText: string; sentAt: Date; direction?: 'inbound' | 'outbound'; authResults?: string | null },
  ): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: `agentrun-msg-${uid()}`,
      direction: opts.direction ?? 'inbound',
      fromEmail: 'jane@example.com',
      bodyText: opts.bodyText,
      authResults: opts.authResults ?? null,
      sentAt: opts.sentAt,
    })
  }

  /** Seeds `n` `support.agent_run` audit rows dated today, optionally attributed to a ticket. */
  async function seedRunAudits(n: number, ticketId: string | null): Promise<void> {
    if (n === 0) return
    await db.insert(auditLog).values(
      Array.from({ length: n }, () => ({
        actor: 'system',
        action: AGENT_RUN_AUDIT_ACTION,
        entityType: 'ticket',
        entityId: ticketId,
        detail: { seeded: true },
        createdAt: NOW,
      })),
    )
  }

  async function ticketById(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row!
  }

  async function auditRows(action: string, entityId?: string) {
    return db
      .select()
      .from(auditLog)
      .where(entityId ? and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)) : eq(auditLog.action, action))
  }

  async function runRows(ticketId: string) {
    return db.select().from(agentRuns).where(eq(agentRuns.triggerRef, ticketId))
  }

  async function seedOrder(
    opts: { totalCents?: number | null; orderNumber?: string } = {},
  ): Promise<{ id: string; gid: string }> {
    // Must satisfy RefundPayloadSchema's `gid://shopify/Order/` prefix AND stay findable by the
    // afterEach cleanup.
    const gid = `gid://shopify/Order/agentrun-order-${uid()}`
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: gid,
        shopifyOrderNumber: opts.orderNumber ?? '1042',
        isTest: true,
        totalCents: opts.totalCents === undefined ? 5000 : opts.totalCents,
      })
      .returning({ id: orders.id })
    return { id: row!.id, gid }
  }

  async function proposalRows(ticketId: string) {
    return db.select().from(proposals).where(eq(proposals.ticketId, ticketId)).orderBy(asc(proposals.createdAt))
  }

  /** Stubs `runFn` with one result per call (the last one repeats), recording ctx/runId per call. */
  function stubRun(...results: HarnessResult<SupportOutput>[]): ReturnType<typeof vi.fn> {
    let call = 0
    return vi.fn(async (_deps: unknown, input: SupportRunInput) => {
      contexts.push(input.ctx)
      runIds.push(input.runId)
      const result = results[Math.min(call, results.length - 1)]!
      call += 1
      return result
    })
  }

  function withRun(...results: HarnessResult<SupportOutput>[]): SupportAgentJobDeps {
    runFn = stubRun(...results)
    return makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] })
  }

  describe('step 1: kill levers', () => {
    it('killswitch.global stops the job before any stamp or audit row', async () => {
      const ticketId = await seedTicket()
      await settings.set('killswitch.global', true)

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toEqual([])
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION)).toEqual([])
      expect((await ticketById(ticketId)).lastAgentRunAt).toBeNull()
    })

    it('workflow.support.enabled = false stops the job', async () => {
      const ticketId = await seedTicket()
      await settings.set('workflow.support.enabled', false)

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toEqual([])
      expect((await ticketById(ticketId)).lastAgentRunAt).toBeNull()
    })

    it('anthropicConfigured = false stops the job', async () => {
      const ticketId = await seedTicket()

      await executeSupportAgentRun(makeDeps({ anthropicConfigured: false }), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toEqual([])
      expect((await ticketById(ticketId)).lastAgentRunAt).toBeNull()
    })
  })

  describe('step 4 (post-claim): per-ticket daily cap', () => {
    it('escalates with agent_run_cap and a cleared notify stamp at the cap', async () => {
      const ticketId = await seedTicket({ escalationNotifiedAt: NOW })
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, ticketId)

      await executeSupportAgentRun(makeDeps(), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('agent_run_cap')
      expect(ticket.escalationNotifiedAt).toBeNull()
      // CRITICAL-1b: the claim (step 3) runs BEFORE this cap check now, so it already stamped
      // last_agent_run_at — that stamp is simply moot once the ticket is escalated (every
      // selection/claim predicate requires status = 'triaged').
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      // No NEW spend row past the 3 pre-seeded ones: the cap trips before the spend insert.
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)).toHaveLength(
        SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY,
      )
      expect(await auditRows(AGENT_RUN_TICKET_CAPPED_ACTION, ticketId)).toHaveLength(1)
      expect(runFn).not.toHaveBeenCalled()
      // CRITICAL-1: this job never notifies — the poll's notifyPendingEscalations is the notifier.
      expect(notify).not.toHaveBeenCalled()
    })

    it("counts only this ticket's rows — another ticket's runs never cap it", async () => {
      const otherTicketId = await seedTicket()
      const ticketId = await seedTicket()
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, otherTicketId)

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect((await ticketById(ticketId)).status).toBe('triaged')
      expect(runFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('step 4 (post-claim): global daily cap', () => {
    it('leaves the ticket untouched, stamps the claim, and warns exactly once per UTC day', async () => {
      // Two SEPARATE tickets, each independently eligible to claim: CRITICAL-1b means a single
      // ticket can only reach this cap check ONCE per claim (a second call on the same ticket, same
      // frozen clock, would now fail the CAS itself — see the "duplicate delivery" test below — so
      // re-exercising the cap-warning dedup needs a second, independently-claimable ticket instead
      // of calling this function twice on the same one.
      const ticketId1 = await seedTicket()
      const ticketId2 = await seedTicket()
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_DAY, null)

      await executeSupportAgentRun(makeDeps(), ticketId1)
      await executeSupportAgentRun(makeDeps(), ticketId2)

      const ticket1 = await ticketById(ticketId1)
      const ticket2 = await ticketById(ticketId2)
      expect(ticket1.status).toBe('triaged')
      expect(ticket2.status).toBe('triaged')
      // CRITICAL-1b: the claim stamp survives a global-capped exit — see this function's own doc
      // comment. It's what lets the 20-minute stuck gate re-claim and re-check the cap later.
      expect(ticket1.lastAgentRunAt).toEqual(NOW)
      expect(ticket2.lastAgentRunAt).toEqual(NOW)
      expect(runFn).not.toHaveBeenCalled()
      // No extra spend rows were inserted past the cap, for EITHER ticket.
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toHaveLength(SUPPORT_AGENT_MAX_RUNS_PER_DAY)
      expect(await auditRows(AGENT_RUN_CAPPED_ACTION)).toHaveLength(1)
      expect(alert.mock.calls.filter((c) => c[1] === 'support_agent_run_capped')).toHaveLength(1)
    })
  })

  describe('CRITICAL-1b: claim runs BEFORE the cap/spend transaction', () => {
    it('a duplicate delivery whose claim is rejected writes NO spend row at all', async () => {
      const ticketId = await seedTicket()

      // First delivery: claims cleanly and runs, writing exactly one spend row.
      await executeSupportAgentRun(makeDeps(), ticketId)
      expect(runFn).toHaveBeenCalledTimes(1)
      const spendRowsAfterFirst = await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)
      expect(spendRowsAfterFirst).toHaveLength(1)

      // A duplicate delivery of the SAME job (pg-boss redelivery, a straggling second worker): the
      // ticket is already stamped by the first claim, with no new inbound and not yet stuck, so the
      // CAS rejects it. Under the OLD order (cap-then-claim) this would still have burned a SECOND
      // spend row before the claim ever got a chance to reject it — that's the bug this pins.
      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).toHaveBeenCalledTimes(1) // unchanged — the duplicate never ran
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)).toEqual(spendRowsAfterFirst)
    })

    it('a per-ticket-capped claim writes the cap outcome, not a spend row, and the claim stamp stands', async () => {
      const ticketId = await seedTicket()
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, ticketId)

      await executeSupportAgentRun(makeDeps(), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('agent_run_cap')
      expect(ticket.lastAgentRunAt).toEqual(NOW) // the claim (step 3) ran and stamped before the cap tripped
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)).toHaveLength(
        SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, // no new spend row past the pre-seeded ones
      )
      expect(await auditRows(AGENT_RUN_TICKET_CAPPED_ACTION, ticketId)).toHaveLength(1)
      expect(runFn).not.toHaveBeenCalled()
    })

    it('a globally-capped claim writes the cap outcome, not a spend row, and the claim stamp stands', async () => {
      const ticketId = await seedTicket()
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_DAY, null)

      await executeSupportAgentRun(makeDeps(), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('triaged') // NOT escalated — global cap just defers, doesn't escalate
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toHaveLength(SUPPORT_AGENT_MAX_RUNS_PER_DAY)
      expect(await auditRows(AGENT_RUN_CAPPED_ACTION)).toHaveLength(1)
      expect(runFn).not.toHaveBeenCalled()
    })
  })

  describe('step 3: CAS claim (now runs before the cap check — CRITICAL-1b)', () => {
    it('claims a fresh triaged ticket, writing the spend audit row BEFORE the run', async () => {
      const ticketId = await seedTicket()
      let auditRowsAtRunTime = -1
      let runRowsAtRunTime: { id: string; status: string }[] = []
      runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
        contexts.push(input.ctx)
        runIds.push(input.runId)
        auditRowsAtRunTime = (await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)).length
        runRowsAtRunTime = (await runRows(ticketId)).map((r) => ({ id: r.id, status: r.status }))
        return benignResult()
      })

      await executeSupportAgentRun(makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] }), ticketId)

      // The ordering IS the correctness: fail-closed spend accounting means the row exists before
      // a single token can be spent.
      expect(auditRowsAtRunTime).toBe(1)
      const [auditRow] = await auditRows(AGENT_RUN_AUDIT_ACTION, ticketId)
      expect(auditRow?.entityType).toBe('ticket')
      expect(auditRow?.entityId).toBe(ticketId)
      // Step 6's agent_runs row is also already in place, and is the runId handed to the runner.
      expect(runRowsAtRunTime).toEqual([{ id: runIds[0], status: 'running' }])
      const [runRow] = await runRows(ticketId)
      expect(runRow?.workflow).toBe('support')
      expect(runRow?.model).toBe(SUPPORT_MODEL)
      const ticket = await ticketById(ticketId)
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      expect(ticket.agentFailureCount).toBe(0)
    })

    it('skips a ticket that is not triaged', async () => {
      const ticketId = await seedTicket({ status: 'waiting_on_customer' })

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect((await ticketById(ticketId)).lastAgentRunAt).toBeNull()
      expect(await runRows(ticketId)).toEqual([])
    })

    it('skips a ticket claimed 5 minutes ago with no new inbound', async () => {
      const claimedAt = minutesAgo(5)
      const ticketId = await seedTicket({ lastAgentRunAt: claimedAt, lastInboundAt: minutesAgo(10) })

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect((await ticketById(ticketId)).lastAgentRunAt).toEqual(claimedAt)
    })

    it('skips a ticket already at the failure ceiling', async () => {
      const ticketId = await seedTicket({ agentFailureCount: 2 })

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
    })

    it('re-claims on new inbound after a completed run', async () => {
      const ticketId = await seedTicket({
        lastAgentRunAt: minutesAgo(10),
        lastAgentFinishedAt: minutesAgo(10),
        lastAgentPromptedAt: minutesAgo(10),
        lastInboundAt: minutesAgo(2),
      })

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(runFn).toHaveBeenCalledTimes(1)
      const ticket = await ticketById(ticketId)
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      expect(ticket.agentFailureCount).toBe(0)
    })

    // The three watermarks: `last_agent_run_at` and `last_agent_finished_at` are wall-clock and
    // comparable; `last_agent_prompted_at` is MESSAGE-time and is not. Comparing the prompt
    // watermark against the claim stamp made every completed run look stuck 20 minutes later — a
    // re-run of settled tickets on a timer, at real cost. These four cases pin the corrected gate.
    describe('stuck gate (wall-clock only)', () => {
      it('A: a run that finished 60 minutes ago claims on new inbound, with no failure charged', async () => {
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(60),
          lastAgentFinishedAt: minutesAgo(59),
          lastAgentPromptedAt: minutesAgo(61),
          lastInboundAt: minutesAgo(2),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).toHaveBeenCalledTimes(1)
        expect((await ticketById(ticketId)).agentFailureCount).toBe(0)
      })

      it('B: the same ticket already carrying one failure still is not charged a second', async () => {
        const ticketId = await seedTicket({
          agentFailureCount: 1,
          lastAgentRunAt: minutesAgo(60),
          lastAgentFinishedAt: minutesAgo(59),
          lastInboundAt: minutesAgo(2),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        // The bug this pins: charging a healthy new-inbound claim would escalate this ticket here.
        expect(runFn).toHaveBeenCalledTimes(1)
        const ticket = await ticketById(ticketId)
        expect(ticket.agentFailureCount).toBe(1)
        expect(ticket.status).toBe('triaged')
      })

      it('C: a completed run with no new inbound is not claimable 25 minutes later', async () => {
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(25),
          lastAgentFinishedAt: minutesAgo(24),
          // Message-time watermark, deliberately older than the claim stamp: the degenerate
          // comparison would read this as "stuck" and burn a run on a settled ticket.
          lastAgentPromptedAt: minutesAgo(50),
          lastInboundAt: minutesAgo(50),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).not.toHaveBeenCalled()
        expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
        expect((await ticketById(ticketId)).lastAgentRunAt).toEqual(minutesAgo(25))
      })

      it('D: a true hard-kill (claimed, never finished) re-claims and charges a failure', async () => {
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(25),
          lastAgentFinishedAt: null,
          lastAgentPromptedAt: minutesAgo(40),
          lastInboundAt: minutesAgo(45),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).toHaveBeenCalledTimes(1)
        const ticket = await ticketById(ticketId)
        expect(ticket.agentFailureCount).toBe(1)
        expect(ticket.status).toBe('triaged')
        expect(ticket.lastAgentRunAt).toEqual(NOW)
      })

      it('D2: a stale finish stamp from a PRIOR run also reads as a hard-kill', async () => {
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(25),
          // Finished before it was last claimed — the second claim never finished.
          lastAgentFinishedAt: minutesAgo(40),
          lastInboundAt: minutesAgo(45),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).toHaveBeenCalledTimes(1)
        expect((await ticketById(ticketId)).agentFailureCount).toBe(1)
      })

      it('F: new inbound on a never-finished claim is a new-work claim, not a failure', async () => {
        // Both branches would authorize this one: the claim is 25 minutes old and never finished
        // (stuck), AND the customer wrote again since. New work wins — the run is about to happen
        // for a legitimate reason, so charging it a failure would penalize a healthy ticket.
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(25),
          lastAgentFinishedAt: null,
          lastInboundAt: minutesAgo(5),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).toHaveBeenCalledTimes(1)
        expect((await ticketById(ticketId)).agentFailureCount).toBe(0)
      })

      it('E: a stuck-aged claim that DID finish claims on new inbound without a failure', async () => {
        const ticketId = await seedTicket({
          lastAgentRunAt: minutesAgo(25),
          lastAgentFinishedAt: minutesAgo(24),
          lastInboundAt: minutesAgo(2),
        })

        await executeSupportAgentRun(makeDeps(), ticketId)

        expect(runFn).toHaveBeenCalledTimes(1)
        const ticket = await ticketById(ticketId)
        expect(ticket.agentFailureCount).toBe(0)
        expect(ticket.lastAgentRunAt).toEqual(NOW)
      })
    })

    // What makes the claim a true CAS rather than a check-then-act: the predicate is evaluated
    // against a row this transaction holds locked, so a claimer that arrives while another writer
    // holds it blocks and then reads that writer's committed state — never the stale pre-write row.
    it('evaluates the predicate under a row lock, so a concurrent status change wins', async () => {
      const ticketId = await seedTicket()
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM support_tickets WHERE id = $1 FOR UPDATE', [ticketId])
        const job = executeSupportAgentRun(makeDeps(), ticketId)
        // Long enough for the job to reach its claim and block on this lock.
        await new Promise((resolve) => setTimeout(resolve, 200))
        await holder.query("UPDATE support_tickets SET status = 'escalated' WHERE id = $1", [ticketId])
        await holder.query('COMMIT')
        await job
      } finally {
        holder.release()
      }

      expect(runFn).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect(await runRows(ticketId)).toEqual([])
    })

    it('escalates instead of running when a stuck re-claim reaches the failure ceiling', async () => {
      const ticketId = await seedTicket({
        agentFailureCount: 1,
        agentSessionId: 'session-poisoned',
        lastAgentRunAt: minutesAgo(25),
        lastAgentFinishedAt: null,
        escalationNotifiedAt: NOW,
      })
      const throwIfCalled = vi.fn(async () => {
        throw new Error('runFn must not be called on the stuck-escalation path')
      })

      await executeSupportAgentRun(
        makeDeps({ runFn: throwIfCalled as unknown as SupportAgentJobDeps['runFn'] }),
        ticketId,
      )

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('agent_failed')
      expect(ticket.escalationNotifiedAt).toBeNull()
      expect(ticket.agentFailureCount).toBe(2)
      expect(ticket.agentSessionId).toBeNull()
      expect(throwIfCalled).not.toHaveBeenCalled()
      expect(await runRows(ticketId)).toEqual([])
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect(notify).not.toHaveBeenCalled()
    })

    // The stranding bug this pins: with the increment and the escalation in SEPARATE transactions,
    // a hard-kill between them leaves the ticket `triaged` at count 2 — below no selection
    // predicate, above the `< 2` claim guard, never escalated, so never notified. Forever, with
    // zero owner signal. One commit means that state is never reachable, not merely unlikely.
    it('commits the ceiling escalation and the increment together — (triaged, 2) is unobservable', async () => {
      const ticketId = await seedTicket({
        agentFailureCount: 1,
        lastAgentRunAt: minutesAgo(25),
        lastAgentFinishedAt: null,
      })
      const observations: string[] = []
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM support_tickets WHERE id = $1 FOR UPDATE', [ticketId])
        const job = executeSupportAgentRun(makeDeps(), ticketId)
        await new Promise((resolve) => setTimeout(resolve, 100))
        // Release: from here the job's claim transaction runs, and this connection polls every
        // committed state it can see until the job settles.
        await holder.query('COMMIT')
        let running = true
        void job.then(() => {
          running = false
        })
        while (running) {
          const { rows } = await holder.query(
            'SELECT status, agent_failure_count FROM support_tickets WHERE id = $1',
            [ticketId],
          )
          observations.push(`${rows[0].status}:${rows[0].agent_failure_count}`)
        }
        await job
      } finally {
        holder.release()
      }

      expect(observations).not.toContain('triaged:2')
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.agentFailureCount).toBe(2)
    })
  })

  describe('step 5: resume pre-flight and context assembly', () => {
    it('clears an agent_session_id the store does not have, without counting a failure', async () => {
      const ticketId = await seedTicket({ agentSessionId: 'session-gone', agentFailureCount: 1 })
      sessionEntries = null

      await executeSupportAgentRun(makeDeps(), ticketId)

      expect(sessionStore.load).toHaveBeenCalledWith({
        projectKey: SUPPORT_PROJECT_KEY,
        sessionId: 'session-gone',
      })
      const ticket = await ticketById(ticketId)
      // The stale id was cleared before the run (proved by the fresh `resumeSessionId` below); the
      // id on the row now is the one THIS run produced, stored by the outcome handler.
      expect(ticket.agentSessionId).toBe('stub-session')
      expect(ticket.agentFailureCount).toBe(1)
      expect(contexts[0]?.resumeSessionId).toBeNull()
      expect(contexts[0]?.isResume).toBe(false)
    })

    it('does not clear a session id that changed while the store was being checked', async () => {
      const ticketId = await seedTicket({ agentSessionId: 'session-gone' })
      sessionStore = {
        append: vi.fn(async () => {}),
        // Whatever else writes the column (Task 12's outcome handling, an owner reject) lands
        // while this load is in flight — the stale clear must not erase the newer value.
        load: vi.fn(async () => {
          await db
            .update(supportTickets)
            .set({ agentSessionId: 'session-newer' })
            .where(eq(supportTickets.id, ticketId))
          return null
        }),
        listSubkeys: vi.fn(async () => []),
      } as unknown as SessionStore

      await executeSupportAgentRun(makeDeps({ sessionStore }), ticketId)

      expect((await ticketById(ticketId)).agentSessionId).toBe('session-newer')
      expect(contexts[0]?.resumeSessionId).toBeNull()
    })

    it('resumes a stored session and sends only messages newer than the prompt watermark', async () => {
      const promptedAt = minutesAgo(20)
      const ticketId = await seedTicket({
        agentSessionId: 'session-live',
        lastAgentRunAt: minutesAgo(20),
        lastAgentPromptedAt: promptedAt,
        lastInboundAt: minutesAgo(5),
      })
      await seedMessage(ticketId, { bodyText: 'old question', sentAt: minutesAgo(40) })
      await seedMessage(ticketId, { bodyText: 'new question', sentAt: minutesAgo(5), authResults: 'dmarc=pass' })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]
      // A resumed run reports the same session id back on its result message.
      const deps = withRun(succeededResult({ outcome: 'no_action', rationale: 'stub' }, { sessionId: 'session-live' }))

      await executeSupportAgentRun(deps, ticketId)

      const ctx = contexts[0]!
      expect(ctx.resumeSessionId).toBe('session-live')
      expect(ctx.isResume).toBe(true)
      expect(ctx.messages.map((m) => m.bodyText)).toEqual(['new question'])
      expect((await ticketById(ticketId)).agentSessionId).toBe('session-live')
    })

    it('sends the full thread ascending plus prior proposals on a fresh run', async () => {
      const ticketId = await seedTicket()
      await seedMessage(ticketId, { bodyText: 'second', sentAt: minutesAgo(20) })
      await seedMessage(ticketId, { bodyText: 'first', sentAt: minutesAgo(40) })
      await seedMessage(ticketId, { bodyText: 'our reply', sentAt: minutesAgo(30), direction: 'outbound' })
      await db.insert(proposals).values({
        type: 'support_reply',
        status: 'rejected',
        summary: 'Prior draft',
        payload: {},
        sourceWorkflow: 'support',
        ticketId,
      })

      await executeSupportAgentRun(makeDeps(), ticketId)

      const ctx = contexts[0]!
      expect(ctx.isResume).toBe(false)
      expect(ctx.messages.map((m) => m.bodyText)).toEqual(['first', 'our reply', 'second'])
      expect(ctx.messages.map((m) => m.direction)).toEqual(['inbound', 'outbound', 'inbound'])
      expect(ctx.priorProposals).toEqual([
        { id: expect.any(String), type: 'support_reply', status: 'rejected', summary: 'Prior draft' },
      ])
      expect(ctx.ticket).toMatchObject({ id: ticketId, status: 'triaged', category: 'shipping' })
    })
  })

  // -----------------------------------------------------------------------------------------
  // Step 7 outcome handling (Task 12): transitions, supersede + submit, failure semantics.
  // -----------------------------------------------------------------------------------------

  async function seedProposal(opts: {
    ticketId: string
    type: 'support_reply' | 'refund'
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applied'
  }): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: opts.type,
        status: opts.status,
        summary: 'prior draft',
        payload: {},
        sourceWorkflow: 'support',
        ticketId: opts.ticketId,
      })
      .returning({ id: proposals.id })
    return row!.id
  }

  async function proposalStatus(id: string): Promise<string> {
    const [row] = await db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, id))
    return row!.status
  }

  describe('step 7: propose outcome', () => {
    it('commits awaiting_approval BEFORE submitting, and stores the reply on the ticket row', async () => {
      const ticketId = await seedTicket()
      // `notify` fires from inside `submitProposal` (manual mode) — reading the ticket there is
      // how this pins the ordering the spec calls load-bearing: an auto-mode flip enqueues apply
      // instantly, and the apply's `awaiting_approval`-anchored checks must already hold.
      const statusAtSubmit: string[] = []
      notify = vi.fn(async () => {
        statusAtSubmit.push((await ticketById(ticketId)).status)
        return true
      })

      await executeSupportAgentRun(withRun(succeededResult(proposeOutput())), ticketId)

      expect(statusAtSubmit).toEqual(['awaiting_approval'])
      expect((await ticketById(ticketId)).status).toBe('awaiting_approval')

      const rows = await proposalRows(ticketId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.type).toBe('support_reply')
      expect(rows[0]!.status).toBe('pending')
      expect(rows[0]!.summary).toBe('Reply: Where is my order?')
      expect(rows[0]!.sourceWorkflow).toBe('support')
      expect(rows[0]!.ticketId).toBe(ticketId)
      expect(rows[0]!.agentRunId).toBe(runIds[0])
      expect(rows[0]!.payload).toEqual({
        type: 'support_reply',
        ticketId,
        body: CLEAN_BODY,
        threadSnapshotAt: minutesAgo(30).toISOString(),
      })
    })

    it('advances the prompt watermark, stamps the finish watermark, and stores the session id', async () => {
      const ticketId = await seedTicket()

      await executeSupportAgentRun(withRun(succeededResult(proposeOutput())), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.lastAgentPromptedAt).toEqual(minutesAgo(30))
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
      expect(ticket.agentSessionId).toBe('stub-session')
    })

    it("expires this ticket's pending REPLY proposals, one superseded audit row each", async () => {
      const ticketId = await seedTicket()
      const otherTicketId = await seedTicket()
      const pendingReply = await seedProposal({ ticketId, type: 'support_reply', status: 'pending' })
      const rejectedReply = await seedProposal({ ticketId, type: 'support_reply', status: 'rejected' })
      const otherTicketReply = await seedProposal({ ticketId: otherTicketId, type: 'support_reply', status: 'pending' })

      await executeSupportAgentRun(withRun(succeededResult(proposeOutput())), ticketId)

      expect(await proposalStatus(pendingReply)).toBe('expired')
      expect(await proposalStatus(rejectedReply)).toBe('rejected')
      expect(await proposalStatus(otherTicketReply)).toBe('pending')

      const superseded = await auditRows(PROPOSAL_SUPERSEDED_ACTION)
      expect(superseded.map((r) => r.entityId)).toEqual([pendingReply])
      expect(superseded[0]!.entityType).toBe('proposal')
    })

    // A reopen re-run must never leave two live refund approvals on the owner's phone — but ONLY a
    // run that carries its own refund is replacing the standing one.
    it('supersedes a pending sibling refund when this run carries a refund of its own', async () => {
      const order = await seedOrder({ totalCents: 5000 })
      const ticketId = await seedTicket({ orderId: order.id })
      await seedMessage(ticketId, { bodyText: 'still broken', sentAt: minutesAgo(30), authResults: 'dmarc=pass' })
      const staleRefund = await seedProposal({ ticketId, type: 'refund', status: 'pending' })

      await executeSupportAgentRun(
        withRun(
          succeededResult(proposeOutput({ refund: { amountCents: 1000, reason: 'damaged', openCjDispute: false } })),
        ),
        ticketId,
      )

      expect(await proposalStatus(staleRefund)).toBe('expired')
      expect((await auditRows(PROPOSAL_SUPERSEDED_ACTION)).map((r) => r.entityId)).toEqual([staleRefund])
      const live = (await proposalRows(ticketId)).filter((r) => r.status === 'pending')
      expect(live.map((r) => r.type).sort()).toEqual(['refund', 'support_reply'])
    })

    // The bug this pins: expiring the sibling refund after the promised-action screen already
    // passed BECAUSE of it would ship "your refund is on the way" with nothing behind it.
    it('leaves a pending sibling refund alone when this run proposes no refund of its own', async () => {
      const order = await seedOrder({ totalCents: 5000 })
      const ticketId = await seedTicket({ orderId: order.id })
      await seedMessage(ticketId, { bodyText: 'any news?', sentAt: minutesAgo(30), authResults: 'dmarc=pass' })
      const siblingRefund = await seedProposal({ ticketId, type: 'refund', status: 'pending' })
      // Only allowed past the promised-action screen because that live sibling refund exists.
      const promisingBody = 'Hi Jane,\n\nYour refund has been approved and is on its way.\n\nDoge Buddy Support'

      await executeSupportAgentRun(
        withRun(succeededResult(proposeOutput({ reply: { body: promisingBody } }))),
        ticketId,
      )

      expect(await proposalStatus(siblingRefund)).toBe('pending')
      expect(await auditRows(PROPOSAL_SUPERSEDED_ACTION)).toEqual([])
      const rows = await proposalRows(ticketId)
      expect(rows.filter((r) => r.type === 'support_reply' && r.status === 'pending')).toHaveLength(1)
    })

    it('with no sibling refund, that same promising body is still rejected by the screen', async () => {
      const ticketId = await seedTicket()
      const promisingBody = 'Hi Jane,\n\nYour refund has been approved and is on its way.\n\nDoge Buddy Support'
      const deps = withRun(succeededResult(proposeOutput({ reply: { body: promisingBody } })))

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      expect(await proposalRows(ticketId)).toEqual([])
      expect((await ticketById(ticketId)).status).toBe('triaged')
      expect((await auditRows(AGENT_RUN_FAILED_ACTION, ticketId))[0]!.detail).toMatchObject({
        code: 'promised_action',
      })
    })

    it('losing the transition race submits nothing and audits it', async () => {
      const ticketId = await seedTicket()
      // The owner (or the orphan backstop) moves the ticket while the SDK call is in flight.
      runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
        contexts.push(input.ctx)
        runIds.push(input.runId)
        await db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, ticketId))
        return succeededResult(proposeOutput())
      })

      await executeSupportAgentRun(makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] }), ticketId)

      expect(await proposalRows(ticketId)).toEqual([])
      expect(notify).not.toHaveBeenCalled()
      expect(await auditRows(AGENT_PROPOSE_LOST_RACE_ACTION, ticketId)).toHaveLength(1)
      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      // Still an authoritative outcome: the run DID finish, so the stuck gate must not re-run it.
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
    })

    it('submits the REFUND FIRST, then the reply, with the row-level orderId and the order gid', async () => {
      const order = await seedOrder({ totalCents: 5000, orderNumber: '1042' })
      const ticketId = await seedTicket({ orderId: order.id })
      await seedMessage(ticketId, {
        bodyText: 'my toy arrived torn',
        sentAt: minutesAgo(30),
        authResults: 'spf=pass; dkim=pass; dmarc=pass',
      })
      const reason = 'Arrived damaged; customer sent photos of the torn seam and missing squeaker'
      // One notify per `submitProposal` in manual mode — the call order IS the submit order.
      const notifiedTypes: string[] = []
      notify = vi.fn(async (msg: { title: string }) => {
        notifiedTypes.push(msg.title)
        return true
      })

      await executeSupportAgentRun(
        withRun(
          succeededResult(
            proposeOutput({ refund: { amountCents: 2500, reason, openCjDispute: false } }),
          ),
        ),
        ticketId,
      )

      // A crash between the two must leave money-with-no-email (recoverable by hand), never a
      // customer-facing promise with no refund behind it.
      expect(notifiedTypes).toEqual(['New refund proposal', 'New support_reply proposal'])

      const rows = await proposalRows(ticketId)
      expect(rows.map((r) => r.type)).toEqual(['refund', 'support_reply'])
      const refundRow = rows.find((r) => r.type === 'refund')!
      expect(refundRow.ticketId).toBe(ticketId)
      // The Task-8 accumulation bound reads `proposals.order_id` — an unset one makes prior
      // refunds invisible to it.
      expect(refundRow.orderId).toBe(order.id)
      expect(refundRow.summary).toBe(
        'Refund $25.00 order #1042 — Arrived damaged; customer sent photos of the torn seam and m',
      )
      expect(refundRow.payload).toEqual({
        type: 'refund',
        orderId: order.id,
        shopifyOrderGid: order.gid,
        amountCents: 2500,
        reason,
        openCjDispute: false,
        threadSnapshotAt: minutesAgo(30).toISOString(),
      })
    })

    it('fails closed with the epoch when the ticket has no inbound message to snapshot', async () => {
      const ticketId = await seedTicket({ lastInboundAt: null })

      await executeSupportAgentRun(withRun(succeededResult(proposeOutput())), ticketId)

      const [row] = await proposalRows(ticketId)
      // Every conceivable later inbound reads as newer than this, so the apply staleness guard
      // treats the draft as stale rather than waving it through.
      expect((row!.payload as { threadSnapshotAt: string }).threadSnapshotAt).toBe('1970-01-01T00:00:00.000Z')
      const ticket = await ticketById(ticketId)
      // The message-time watermark is NOT advanced to the epoch — there was nothing to advance it to.
      expect(ticket.lastAgentPromptedAt).toBeNull()
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
    })

    it('stores the NFKC-normalized body that was actually screened, not the raw model output', async () => {
      const ticketId = await seedTicket()
      const raw = 'Hi Jane,\n\nThanks for conﬁrming your address\n\nDoge Buddy Support'

      await executeSupportAgentRun(withRun(succeededResult(proposeOutput({ reply: { body: raw } }))), ticketId)

      const [row] = await proposalRows(ticketId)
      const payload = row!.payload as { body: string }
      expect(payload.body).toContain('confirming')
      expect(payload.body).not.toContain('ﬁ')
    })
  })

  describe('step 7: escalate outcome', () => {
    it('escalates with the reason, clears the notify stamp, and stamps the finish watermark', async () => {
      const ticketId = await seedTicket({ escalationNotifiedAt: NOW })

      await executeSupportAgentRun(
        withRun(
          succeededResult({
            outcome: 'escalate',
            escalationReason: 'customer says they filed a chargeback',
            rationale: 'out of policy',
          }),
        ),
        ticketId,
      )

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('customer says they filed a chargeback')
      // CRITICAL-1: cleared so the poll's notifyPendingEscalations (the ONLY notifier) picks it up.
      expect(ticket.escalationNotifiedAt).toBeNull()
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
      expect(ticket.lastAgentPromptedAt).toEqual(minutesAgo(30))
      expect(await proposalRows(ticketId)).toEqual([])
      expect(notify).not.toHaveBeenCalled()
    })

    it('skips silently when the ticket left triaged mid-run', async () => {
      const ticketId = await seedTicket()
      runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
        contexts.push(input.ctx)
        runIds.push(input.runId)
        await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticketId))
        return succeededResult({ outcome: 'escalate', escalationReason: 'unsure', rationale: 'r' })
      })

      await executeSupportAgentRun(makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] }), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('resolved')
      expect(ticket.escalationReason).toBeNull()
      // Its own action, not the generic claim skip: this one happened after a run was paid for.
      expect(await auditRows(AGENT_ESCALATE_LOST_RACE_ACTION, ticketId)).toHaveLength(1)
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toEqual([])
    })
  })

  describe('step 7: no_action outcome', () => {
    it('stays triaged, audits the rationale, and the next immediate run skips at the CAS', async () => {
      const ticketId = await seedTicket()
      const deps = withRun(succeededResult({ outcome: 'no_action', rationale: 'waiting on the carrier' }))

      await executeSupportAgentRun(deps, ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('triaged')
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
      expect(ticket.lastAgentPromptedAt).toEqual(minutesAgo(30))
      const audits = await auditRows(AGENT_NO_ACTION_ACTION, ticketId)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.detail).toMatchObject({ rationale: 'waiting on the carrier' })

      // No new inbound, and the finish stamp is newer than the claim stamp — neither the new-work
      // branch nor the stuck branch authorizes a second claim.
      await executeSupportAgentRun(deps, ticketId)

      expect(runFn).toHaveBeenCalledTimes(1)
      expect(await auditRows(AGENT_RUN_SKIPPED_ACTION, ticketId)).toHaveLength(1)
      expect((await ticketById(ticketId)).agentFailureCount).toBe(0)
    })
  })

  describe('step 7: failure path', () => {
    it('a validator rejection counts a failure, clears the claim stamp, audits, and throws', async () => {
      const ticketId = await seedTicket()
      const deps = withRun(
        succeededResult(proposeOutput({ reply: { body: 'Write to us at help@gmail.com instead' } })),
      )

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('triaged')
      expect(ticket.agentFailureCount).toBe(1)
      // Immediately re-claimable — otherwise the retry's CAS finds no new inbound and no-ops,
      // stranding the ticket at count 1 for 20 minutes.
      expect(ticket.lastAgentRunAt).toBeNull()
      // A failed run must keep looking UNFINISHED, or stuck recovery can never see it.
      expect(ticket.lastAgentFinishedAt).toBeNull()
      expect(ticket.lastAgentPromptedAt).toBeNull()
      expect(await proposalRows(ticketId)).toEqual([])
      const audits = await auditRows(AGENT_RUN_FAILED_ACTION, ticketId)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.detail).toMatchObject({ code: 'contact_channel' })
    })

    it('the second failure escalates agent_failed and clears the session id', async () => {
      const ticketId = await seedTicket({
        agentFailureCount: 1,
        agentSessionId: 'session-live',
        escalationNotifiedAt: NOW,
      })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]
      const deps = withRun(
        succeededResult(proposeOutput({ reply: { body: 'Write to us at help@gmail.com instead' } })),
      )

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('agent_failed')
      expect(ticket.escalationNotifiedAt).toBeNull()
      expect(ticket.agentFailureCount).toBe(2)
      expect(ticket.agentSessionId).toBeNull()
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      expect(ticket.lastAgentFinishedAt).toBeNull()
      expect(notify).not.toHaveBeenCalled()
    })

    it('a budget abort takes the same path', async () => {
      const ticketId = await seedTicket()
      const deps = withRun(unusableResult({ status: 'aborted' }))

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      const ticket = await ticketById(ticketId)
      expect(ticket.agentFailureCount).toBe(1)
      expect(ticket.lastAgentRunAt).toBeNull()
      expect(ticket.lastAgentFinishedAt).toBeNull()
      expect((await auditRows(AGENT_RUN_FAILED_ACTION, ticketId))[0]!.detail).toMatchObject({
        code: 'run_aborted',
      })
    })

    it('a run that produced no usable output takes the same path', async () => {
      const ticketId = await seedTicket()
      const deps = withRun(unusableResult())

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      expect((await ticketById(ticketId)).agentFailureCount).toBe(1)
      expect((await auditRows(AGENT_RUN_FAILED_ACTION, ticketId))[0]!.detail).toMatchObject({
        code: 'run_failed',
      })
    })

    it('a throw out of the runner is recorded and rethrown unchanged', async () => {
      const ticketId = await seedTicket()
      runFn = vi.fn(async () => {
        throw new Error('sdk exploded')
      })

      await expect(
        executeSupportAgentRun(makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] }), ticketId),
      ).rejects.toThrow('sdk exploded')

      const ticket = await ticketById(ticketId)
      expect(ticket.agentFailureCount).toBe(1)
      expect(ticket.lastAgentRunAt).toBeNull()
      expect(ticket.lastAgentFinishedAt).toBeNull()
      expect((await auditRows(AGENT_RUN_FAILED_ACTION, ticketId))[0]!.detail).toMatchObject({
        code: 'run_threw',
      })
    })
  })

  describe('step 7: session bookkeeping', () => {
    it('a mirror error warns, clears the session id, and still processes the outcome', async () => {
      const ticketId = await seedTicket({ agentSessionId: 'session-live' })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]

      await executeSupportAgentRun(
        withRun(succeededResult(proposeOutput(), { sawMirrorError: true, sessionId: 'session-live' })),
        ticketId,
      )

      expect(alert.mock.calls.filter((c) => c[1] === 'support_session_mirror_error')).toHaveLength(1)
      const ticket = await ticketById(ticketId)
      // Never resume a holed transcript — and the store must not write it straight back either.
      expect(ticket.agentSessionId).toBeNull()
      expect(ticket.status).toBe('awaiting_approval')
      expect(await proposalRows(ticketId)).toHaveLength(1)
    })

    it('a resumed run that died before the first assistant message retries once, fresh', async () => {
      const ticketId = await seedTicket({
        agentSessionId: 'session-live',
        lastAgentPromptedAt: minutesAgo(40),
        lastInboundAt: minutesAgo(30),
      })
      await seedMessage(ticketId, { bodyText: 'old question', sentAt: minutesAgo(50) })
      await seedMessage(ticketId, { bodyText: 'new question', sentAt: minutesAgo(30) })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]
      const deps = withRun(
        unusableResult({ failedBeforeFirstAssistant: true }),
        succeededResult({ outcome: 'no_action', rationale: 'ok' }, { sessionId: 'session-fresh' }),
      )

      await executeSupportAgentRun(deps, ticketId)

      expect(runFn).toHaveBeenCalledTimes(2)
      expect(contexts[0]!.resumeSessionId).toBe('session-live')
      expect(contexts[0]!.messages.map((m) => m.bodyText)).toEqual(['new question'])
      // The fallback prompt is standalone-sufficient: a fresh session gets the FULL thread.
      expect(contexts[1]!.resumeSessionId).toBeNull()
      expect(contexts[1]!.isResume).toBe(false)
      expect(contexts[1]!.messages.map((m) => m.bodyText)).toEqual(['old question', 'new question'])
      expect(alert.mock.calls.filter((c) => c[1] === 'support_resume_failed')).toHaveLength(1)

      const ticket = await ticketById(ticketId)
      expect(ticket.agentFailureCount).toBe(0)
      expect(ticket.status).toBe('triaged')
      expect(ticket.agentSessionId).toBe('session-fresh')
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
      // Each SDK call records its own run row rather than overwriting the dead attempt's.
      expect(runIds[1]).not.toBe(runIds[0])
      expect(await runRows(ticketId)).toHaveLength(2)
    })

    // The other shape resume failure arrives in: no HarnessResult at all. A throw out of the
    // runner on a RESUMED attempt is the strongest form of "died before the first assistant
    // message", so it must retry rather than burn the ticket's one remaining failure budget.
    it('a THROW on a resumed attempt is treated as resume failure and retried fresh', async () => {
      const ticketId = await seedTicket({ agentSessionId: 'session-live' })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]
      let call = 0
      runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
        contexts.push(input.ctx)
        runIds.push(input.runId)
        call += 1
        if (call === 1) throw new Error('could not materialize session')
        return succeededResult({ outcome: 'no_action', rationale: 'ok' }, { sessionId: 'session-fresh' })
      })

      await executeSupportAgentRun(makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] }), ticketId)

      expect(runFn).toHaveBeenCalledTimes(2)
      expect(contexts[1]!.resumeSessionId).toBeNull()
      expect(contexts[1]!.isResume).toBe(false)
      const resumeAlerts = alert.mock.calls.filter((c) => c[1] === 'support_resume_failed')
      expect(resumeAlerts).toHaveLength(1)
      expect(resumeAlerts[0]![2]).toMatchObject({ error: 'could not materialize session' })
      const ticket = await ticketById(ticketId)
      expect(ticket.agentFailureCount).toBe(0)
      expect(ticket.agentSessionId).toBe('session-fresh')
      expect(ticket.lastAgentFinishedAt).toEqual(NOW)
      expect(await auditRows(AGENT_RUN_FAILED_ACTION, ticketId)).toEqual([])
    })

    it("only the resume retry's failure enters the failure path", async () => {
      const ticketId = await seedTicket({ agentSessionId: 'session-live' })
      sessionEntries = [{ uuid: 'e1' } as unknown as SessionStoreEntry]
      const deps = withRun(unusableResult({ failedBeforeFirstAssistant: true }), unusableResult())

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      expect(runFn).toHaveBeenCalledTimes(2)
      const ticket = await ticketById(ticketId)
      expect(ticket.agentFailureCount).toBe(1)
      expect(ticket.agentSessionId).toBeNull()
      expect(ticket.lastAgentFinishedAt).toBeNull()
    })

    it('does not retry a FRESH run that died before the first assistant message', async () => {
      const ticketId = await seedTicket()
      const deps = withRun(unusableResult({ failedBeforeFirstAssistant: true }))

      await expect(executeSupportAgentRun(deps, ticketId)).rejects.toThrow()

      expect(runFn).toHaveBeenCalledTimes(1)
      expect(alert.mock.calls.filter((c) => c[1] === 'support_resume_failed')).toHaveLength(0)
      expect((await ticketById(ticketId)).agentFailureCount).toBe(1)
    })
  })

  describe('queue wiring', () => {
    it('enqueues with the pinned singleton/retry/expiry options', async () => {
      const enqueue = vi.fn(async () => {})

      await enqueueSupportAgentRun(enqueue, 'ticket-x')

      expect(enqueue).toHaveBeenCalledWith(
        SUPPORT_AGENT_QUEUE,
        { ticketId: 'ticket-x' },
        { singletonKey: 'ticket-x', retryLimit: 1, retryDelay: 30, expireInSeconds: 600 },
      )
    })

    it('the handler executes every job in the batch', async () => {
      const ticketId = await seedTicket()

      await supportAgentRunHandler(makeDeps())([{ data: { ticketId } }] as never)

      expect(runFn).toHaveBeenCalledTimes(1)
      expect((await ticketById(ticketId)).lastAgentRunAt).toEqual(NOW)
    })

    it('one job throwing does not abandon the rest of the batch, and still fails it', async () => {
      const firstId = await seedTicket()
      const secondId = await seedTicket()
      runFn = vi.fn(async (_deps: unknown, input: SupportRunInput) => {
        contexts.push(input.ctx)
        if (input.ctx.ticket.id === firstId) throw new Error('boom')
        return benignResult()
      })
      const deps = makeDeps({ runFn: runFn as unknown as SupportAgentJobDeps['runFn'] })

      await expect(
        supportAgentRunHandler(deps)([{ data: { ticketId: firstId } }, { data: { ticketId: secondId } }] as never),
      ).rejects.toThrow('boom')

      // The second ticket was still attempted — it must not be failed without ever being tried.
      expect(contexts.map((c) => c.ticket.id)).toEqual([firstId, secondId])
      expect((await ticketById(secondId)).lastAgentRunAt).toEqual(NOW)
    })
  })

  it('ignores a ticket id that no longer exists', async () => {
    await executeSupportAgentRun(makeDeps(), '00000000-0000-0000-0000-000000000000')

    expect(runFn).not.toHaveBeenCalled()
    expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toEqual([])
  })

  it('orders selected messages deterministically', async () => {
    const ticketId = await seedTicket()
    await seedMessage(ticketId, { bodyText: 'a', sentAt: minutesAgo(10) })
    await seedMessage(ticketId, { bodyText: 'b', sentAt: minutesAgo(10) })

    await executeSupportAgentRun(makeDeps(), ticketId)

    const stored = await db
      .select({ bodyText: supportMessages.bodyText })
      .from(supportMessages)
      .where(eq(supportMessages.ticketId, ticketId))
      .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt), asc(supportMessages.id))
    expect(contexts[0]?.messages.map((m) => m.bodyText)).toEqual(stored.map((m) => m.bodyText))
  })
})
