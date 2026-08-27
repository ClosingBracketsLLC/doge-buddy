import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { agentRuns, auditLog, createDb, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import type { DisputeOptions } from '@doge-buddy/supplier'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessResult } from '../src/agents/run-harness.ts'
import { SUPPORT_PROJECT_KEY } from '../src/agents/session-store.ts'
import type { SupportOutput } from '../src/agents/support-output-schema.ts'
import { SUPPORT_MODEL, type SupportRunContext, type SupportRunInput } from '../src/agents/support-run.ts'
import {
  AGENT_RUN_AUDIT_ACTION,
  AGENT_RUN_CAPPED_ACTION,
  AGENT_RUN_SKIPPED_ACTION,
  AGENT_RUN_TICKET_CAPPED_ACTION,
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
]

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

function benignResult(): HarnessResult<SupportOutput> {
  return {
    status: 'succeeded',
    output: { outcome: 'no_action', rationale: 'stub' },
    costUsd: 0,
    costEstimated: false,
    sessionId: 'stub-session',
    sawMirrorError: false,
    failedBeforeFirstAssistant: false,
  }
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
  })

  // Everything this file creates is reachable from the `agentrun-%` thread-id prefix, and it
  // exclusively owns these four audit actions (vitest runs files serially — see vitest.config.ts).
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'agentrun-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(proposals).where(inArray(proposals.ticketId, ticketIds))
      await db.delete(agentRuns).where(inArray(agentRuns.triggerRef, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    await db.delete(auditLog).where(inArray(auditLog.action, AUDIT_ACTIONS))
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
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
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `agentrun-${uid()}`,
        customerEmail: 'jane@example.com',
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

  describe('step 2: per-ticket daily cap', () => {
    it('escalates with agent_run_cap and a cleared notify stamp at the cap', async () => {
      const ticketId = await seedTicket({ escalationNotifiedAt: NOW })
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY, ticketId)

      await executeSupportAgentRun(makeDeps(), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('escalated')
      expect(ticket.escalationReason).toBe('agent_run_cap')
      expect(ticket.escalationNotifiedAt).toBeNull()
      // No stamp and no new spend row: the ticket is selectable again after UTC midnight.
      expect(ticket.lastAgentRunAt).toBeNull()
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

  describe('step 3: global daily cap', () => {
    it('leaves the ticket untouched and warns exactly once per UTC day', async () => {
      const ticketId = await seedTicket()
      await seedRunAudits(SUPPORT_AGENT_MAX_RUNS_PER_DAY, null)

      await executeSupportAgentRun(makeDeps(), ticketId)
      await executeSupportAgentRun(makeDeps(), ticketId)

      const ticket = await ticketById(ticketId)
      expect(ticket.status).toBe('triaged')
      expect(ticket.lastAgentRunAt).toBeNull()
      expect(runFn).not.toHaveBeenCalled()
      // No extra spend rows were inserted past the cap.
      expect(await auditRows(AGENT_RUN_AUDIT_ACTION)).toHaveLength(SUPPORT_AGENT_MAX_RUNS_PER_DAY)
      expect(await auditRows(AGENT_RUN_CAPPED_ACTION)).toHaveLength(1)
      expect(alert.mock.calls.filter((c) => c[1] === 'support_agent_run_capped')).toHaveLength(1)
    })
  })

  describe('step 4: CAS claim', () => {
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
      expect(ticket.agentSessionId).toBeNull()
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

      await executeSupportAgentRun(makeDeps(), ticketId)

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
