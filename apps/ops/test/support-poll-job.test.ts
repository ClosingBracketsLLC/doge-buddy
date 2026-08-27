import { auditLog, createDb, gmailSyncState, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail } from '@doge-buddy/gmail'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeSupportPoll,
  resetSupportPollOnceFlags,
  supportPollGmailHandler,
  SUPPORT_POLL_QUEUE,
  type SupportPollDeps,
} from '../src/jobs/support-poll-gmail.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'
import type { AgentSelectDeps } from '../src/support/agent-select.ts'
import type { TriageCall } from '../src/support/triage.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
const SYNC_STATE_ID = 1

describe('executeSupportPoll', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  beforeEach(async () => {
    resetSupportPollOnceFlags()
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, SYNC_STATE_ID))
  })

  afterEach(async () => {
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, SYNC_STATE_ID))
  })

  async function seedSyncState(consecutiveFailures: number, lastSuccessAt: Date | null = null): Promise<void> {
    await db
      .insert(gmailSyncState)
      .values({ id: SYNC_STATE_ID, consecutiveFailures, lastSuccessAt })
      .onConflictDoUpdate({ target: gmailSyncState.id, set: { consecutiveFailures, lastSuccessAt } })
  }

  async function readSyncState() {
    const [row] = await db.select().from(gmailSyncState).where(eq(gmailSyncState.id, SYNC_STATE_ID))
    return row
  }

  function baseDeps(overrides: Partial<SupportPollDeps> = {}): SupportPollDeps {
    return {
      db,
      gmail: createMockGmail(),
      supportAddress: 'support@dogebuddy.com',
      settings,
      alert: vi.fn(async () => {}),
      notify: vi.fn(async () => true),
      adminBaseUrl: 'https://admin.example.com',
      triageCall: vi.fn(async () => {
        throw new Error('unused: triageFn is stubbed in these tests')
      }) as unknown as TriageCall,
      enqueue: vi.fn(async () => {}),
      ingestFn: vi.fn(async () => ({ insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] })),
      triageFn: vi.fn(async () => ({ triaged: 0, escalatedTicketIds: [] })),
      escalateFn: vi.fn(async () => ({ notified: 0 })),
      agentSelect: vi.fn(async () => ({ enqueued: 0, orphansEscalated: 0 })),
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      ...overrides,
    }
  }

  describe('skip paths', () => {
    it('gmail === null: fires ONE info alert, touches no stage fn, leaves gmail_sync_state untouched', async () => {
      await seedSyncState(3, null)
      const deps = baseDeps({ gmail: null })

      await executeSupportPoll(deps)
      await executeSupportPoll(deps) // second poll same boot — alert must not fire again

      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledWith('info', 'support_gmail_not_configured', {})
      expect(deps.ingestFn).not.toHaveBeenCalled()
      expect(deps.triageFn).not.toHaveBeenCalled()
      expect(deps.escalateFn).not.toHaveBeenCalled()
      expect(deps.agentSelect).not.toHaveBeenCalled()
      expect(deps.notify).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(3)
      expect(row?.lastSuccessAt).toBeNull()
    })

    it('killswitch.global on: full skip — no stage fn calls, no alert, sync state untouched', async () => {
      await settings.set('killswitch.global', true)
      await seedSyncState(2, null)
      const deps = baseDeps()

      await executeSupportPoll(deps)

      expect(deps.ingestFn).not.toHaveBeenCalled()
      expect(deps.triageFn).not.toHaveBeenCalled()
      expect(deps.escalateFn).not.toHaveBeenCalled()
      expect(deps.agentSelect).not.toHaveBeenCalled()
      expect(deps.alert).not.toHaveBeenCalled()
      expect(deps.notify).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(2)
    })

    it('workflow.support.enabled = false: full skip — no stage fn calls, no alert, sync state untouched', async () => {
      await settings.set('workflow.support.enabled', false)
      await seedSyncState(4, null)
      const deps = baseDeps()

      await executeSupportPoll(deps)

      expect(deps.ingestFn).not.toHaveBeenCalled()
      expect(deps.triageFn).not.toHaveBeenCalled()
      expect(deps.escalateFn).not.toHaveBeenCalled()
      expect(deps.agentSelect).not.toHaveBeenCalled()
      expect(deps.alert).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(4)
    })
  })

  describe('triage-not-configured (triageCall null)', () => {
    it('fires ONE info alert, never calls triageFn, ingest+escalate still run', async () => {
      const deps = baseDeps({ triageCall: null })

      await executeSupportPoll(deps)
      await executeSupportPoll(deps) // second poll — alert must not fire again

      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledWith('info', 'support_triage_not_configured', {})
      expect(deps.triageFn).not.toHaveBeenCalled()
      expect(deps.ingestFn).toHaveBeenCalledTimes(2)
      expect(deps.escalateFn).toHaveBeenCalledTimes(2)
      // agent-select is gated on ingest, not triage — it still runs both times.
      expect(deps.agentSelect).toHaveBeenCalledTimes(2)

      // Both polls succeeded (ingest/escalate stubs resolve) — success is still recorded.
      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(0)
    })
  })

  describe('success', () => {
    it('all stages succeed: runs ingest → triage → escalate → agent-select in order, resets counter, stamps last_success_at', async () => {
      await seedSyncState(7, null)
      const callOrder: string[] = []
      const deps = baseDeps({
        ingestFn: vi.fn(async () => {
          callOrder.push('ingest')
          return { insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] }
        }),
        triageFn: vi.fn(async () => {
          callOrder.push('triage')
          return { triaged: 0, escalatedTicketIds: [] }
        }),
        escalateFn: vi.fn(async () => {
          callOrder.push('escalate')
          return { notified: 0 }
        }),
        agentSelect: vi.fn(async () => {
          callOrder.push('agentSelect')
          return { enqueued: 0, orphansEscalated: 0 }
        }),
      })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.triageFn).toHaveBeenCalledTimes(1)
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)
      expect(deps.agentSelect).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['ingest', 'triage', 'escalate', 'agentSelect'])
      expect(deps.alert).not.toHaveBeenCalled()
      expect(deps.notify).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(0)
      expect(row?.lastSuccessAt).toEqual(new Date('2026-08-25T12:00:00.000Z'))
    })

    it('threads db/enqueue/alert/now into the agent-select stage', async () => {
      await seedSyncState(0, null)
      let received: AgentSelectDeps | null = null
      const deps = baseDeps({
        agentSelect: vi.fn(async (d: AgentSelectDeps) => {
          received = d
          return { enqueued: 0, orphansEscalated: 0 }
        }),
      })

      await executeSupportPoll(deps)

      expect(received).not.toBeNull()
      expect(received!.db).toBe(db)
      expect(received!.enqueue).toBe(deps.enqueue)
      expect(received!.alert).toBe(deps.alert)
      expect(received!.now!()).toEqual(new Date('2026-08-25T12:00:00.000Z'))
    })

    it('no pre-existing gmail_sync_state row: upsert still stamps success correctly', async () => {
      const deps = baseDeps() // no seedSyncState call — row starts absent (beforeEach deleted it)

      await executeSupportPoll(deps)

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(0)
      expect(row?.lastSuccessAt).toEqual(new Date('2026-08-25T12:00:00.000Z'))
    })
  })

  describe('failure accounting and stage isolation', () => {
    it('ingest throws: triage is skipped entirely, escalate still runs, failure is accounted', async () => {
      await seedSyncState(0, null)
      const ingestFn = vi.fn(async () => {
        throw new Error('ingest boom')
      })
      const deps = baseDeps({ ingestFn })

      await executeSupportPoll(deps)

      expect(deps.triageFn).not.toHaveBeenCalled()
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)
      // agent-select is gated on ingest the same way triage is — an ingest failure skips it too.
      expect(deps.agentSelect).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
      expect(row?.lastSuccessAt).toBeNull()
    })

    it('triage throws: escalate AND agent-select still run (not skipped), failure is accounted with the triage error', async () => {
      await seedSyncState(0, null)
      const triageFn = vi.fn(async () => {
        throw new Error('triage boom')
      })
      const deps = baseDeps({ triageFn })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)
      expect(deps.agentSelect).toHaveBeenCalledTimes(1)

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
    })

    it('escalate throws alone (ingest+triage succeed): still accounted as a failed poll, agent-select still runs', async () => {
      await seedSyncState(0, null)
      const escalateFn = vi.fn(async () => {
        throw new Error('escalate boom')
      })
      const deps = baseDeps({ escalateFn })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.triageFn).toHaveBeenCalledTimes(1)
      expect(deps.agentSelect).toHaveBeenCalledTimes(1)

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
    })

    it('agent-select throws alone (ingest+triage+escalate succeed): escalate already ran, failure is still accounted', async () => {
      await seedSyncState(0, null)
      const agentSelect = vi.fn(async () => {
        throw new Error('agent-select boom')
      })
      const deps = baseDeps({ agentSelect })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.triageFn).toHaveBeenCalledTimes(1)
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
    })

    it('first error wins: ingest AND triage both throw — the recorded error is ingest\'s (triage never even runs)', async () => {
      await seedSyncState(4, null) // one more failure lands exactly on the warning threshold
      const ingestFn = vi.fn(async () => {
        throw new Error('ingest-specific failure')
      })
      const deps = baseDeps({ ingestFn })

      await executeSupportPoll(deps)

      expect(deps.alert).toHaveBeenCalledWith(
        'warning',
        'support_poll_degraded',
        expect.objectContaining({ consecutiveFailures: 5, error: 'ingest-specific failure' }),
      )
    })
  })

  describe('exact-threshold alerting', () => {
    it('warning fires exactly once, exactly at consecutive_failures = 5', async () => {
      await seedSyncState(0, null)
      const ingestFn = vi.fn(async () => {
        throw new Error('ingest boom')
      })
      const deps = baseDeps({ ingestFn })

      for (let i = 1; i <= 8; i++) {
        await executeSupportPoll(deps)
        const row = await readSyncState()
        expect(row?.consecutiveFailures).toBe(i)
      }

      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledWith(
        'warning',
        'support_poll_degraded',
        expect.objectContaining({ consecutiveFailures: 5, error: 'ingest boom' }),
      )
      expect(deps.notify).not.toHaveBeenCalled()
    })

    it('critical + notify fire exactly once, exactly at consecutive_failures = 20; nothing extra at 21', async () => {
      await seedSyncState(19, null)
      const ingestFn = vi.fn(async () => {
        throw new Error('ingest boom')
      })
      const deps = baseDeps({ ingestFn })

      await executeSupportPoll(deps) // -> 20
      expect((await readSyncState())?.consecutiveFailures).toBe(20)
      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledWith(
        'critical',
        'support_poll_down',
        expect.objectContaining({ consecutiveFailures: 20, error: 'ingest boom' }),
      )
      expect(deps.notify).toHaveBeenCalledTimes(1)
      expect(deps.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Support poll failing') }),
      )

      await executeSupportPoll(deps) // -> 21, past the threshold
      expect((await readSyncState())?.consecutiveFailures).toBe(21)
      expect(deps.alert).toHaveBeenCalledTimes(1) // still just the one from count 20
      expect(deps.notify).toHaveBeenCalledTimes(1)
    })

    it('a success between failures resets the counter, so a later streak re-earns its own threshold alerts', async () => {
      await seedSyncState(4, null)
      const ingestFn = vi.fn(async () => {
        throw new Error('ingest boom')
      })
      const deps = baseDeps({ ingestFn })

      await executeSupportPoll(deps) // -> 5, warning fires
      expect(deps.alert).toHaveBeenCalledTimes(1)

      // Recover: ingest succeeds this time.
      deps.ingestFn = vi.fn(async () => ({ insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] }))
      await executeSupportPoll(deps)
      expect((await readSyncState())?.consecutiveFailures).toBe(0)

      // Fail again, four more times — should NOT re-fire the warning (only at 5, and we're back at 4).
      deps.ingestFn = ingestFn
      for (let i = 1; i <= 4; i++) await executeSupportPoll(deps)
      expect((await readSyncState())?.consecutiveFailures).toBe(4)
      expect(deps.alert).toHaveBeenCalledTimes(1) // unchanged since the first warning

      // One more failure re-earns the warning at 5.
      await executeSupportPoll(deps)
      expect((await readSyncState())?.consecutiveFailures).toBe(5)
      expect(deps.alert).toHaveBeenCalledTimes(2)
    })
  })
})

describe('supportPollGmailHandler', () => {
  const { db, pool } = createDb(url)
  const settings = createSettings(db)
  afterAll(() => pool.end())

  beforeEach(async () => {
    resetSupportPollOnceFlags()
    await settings.set('killswitch.global', SETTINGS_DEFAULTS['killswitch.global'])
    await settings.set('workflow.support.enabled', SETTINGS_DEFAULTS['workflow.support.enabled'])
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, SYNC_STATE_ID))
  })

  // The INTEGRATED test below drives the REAL runIngest through several polls, which leaves a
  // real, non-null gmail_sync_state row behind. beforeEach alone only protects tests declared
  // AFTER it in this same describe block — without this, that row leaks into whatever runs next
  // in the same process (another describe block, another file) and corrupts its OWN
  // `lastHistoryId == null` seed-on-null check.
  afterEach(async () => {
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, SYNC_STATE_ID))
  })

  it('SUPPORT_POLL_QUEUE constant matches the spec queue name', () => {
    expect(SUPPORT_POLL_QUEUE).toBe('support.poll-gmail')
  })

  it('cron job wrapper: calls executeSupportPoll (via ingestFn) once per job in the batch', async () => {
    const ingestFn = vi.fn(async () => ({ insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] }))
    const deps: SupportPollDeps = {
      db,
      gmail: createMockGmail(),
      supportAddress: 'support@dogebuddy.com',
      settings,
      alert: vi.fn(async () => {}),
      notify: vi.fn(async () => true),
      adminBaseUrl: 'https://admin.example.com',
      triageCall: null,
      enqueue: vi.fn(async () => {}),
      ingestFn,
      triageFn: vi.fn(async () => ({ triaged: 0, escalatedTicketIds: [] })),
      escalateFn: vi.fn(async () => ({ notified: 0 })),
      agentSelect: vi.fn(async () => ({ enqueued: 0, orphansEscalated: 0 })),
    }

    await supportPollGmailHandler(deps)([
      { id: 'job-1', name: SUPPORT_POLL_QUEUE, data: {}, expireInSeconds: 120 },
      { id: 'job-2', name: SUPPORT_POLL_QUEUE, data: {}, expireInSeconds: 120 },
    ])

    expect(ingestFn).toHaveBeenCalledTimes(2)
  })

  // CRITICAL 1 INTEGRATED regression: every other test in this file stubs ingestFn/triageFn/
  // escalateFn, which is exactly the structural blind spot that hid the re-escalation-never-
  // re-notified bug — none of those tests ever let a real escalated ticket flow from ingest into
  // escalate. This one wires the REAL runIngest + REAL notifyPendingEscalations (only the
  // injectable TriageCall model seam is stubbed) through the actual cron handler, against a
  // MockGmail mailbox, end to end.
  it('INTEGRATED: a ticket that re-escalates after being resolved gets re-notified end to end', async () => {
    const gmail = createMockGmail()
    const notify = vi.fn(async () => true)
    const triageCall = vi.fn(async () => ({
      category: 'other' as const,
      order_number: null,
      sentiment: 'neutral' as const,
      is_spam: false,
      escalation_flags: [],
    }))
    const deps: SupportPollDeps = {
      db,
      gmail,
      supportAddress: 'support@dogebuddy.com',
      settings,
      alert: vi.fn(async () => {}),
      notify,
      adminBaseUrl: 'https://admin.example.com',
      triageCall,
      // `enqueue` is a no-op spy purely to satisfy the type — the REAL agent-select stage (also
      // left un-stubbed below) never finds a `triaged` ticket in this scenario (the ticket ends up
      // `escalated` via triage's own tripwire), so it's never actually called.
      enqueue: vi.fn(async () => {}),
      // ingestFn/triageFn/escalateFn/agentSelect intentionally omitted: this test relies on the
      // REAL pipeline.
    }
    const job = (id: string) => [{ id, name: SUPPORT_POLL_QUEUE, data: {}, expireInSeconds: 120 }]

    // Snapshot so cleanup below removes only the rows THIS test creates, not another file's
    // (support-escalate.test.ts owns the same audit action and cleans up its own rows, but files
    // run serially — this just avoids any ordering assumption).
    const notifiedBefore = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'support.escalation_notified'))

    let threadId: string | undefined
    try {
      // Poll #1: seed-on-null (no mail yet).
      await supportPollGmailHandler(deps)(job('job-1'))

      const sent = gmail.receiveInbound({
        from: 'jane@example.com',
        to: ['support@dogebuddy.com'],
        subject: 'Order 1001',
        bodyText: 'If I do not hear back I will file a chargeback with my bank.',
      })
      threadId = sent.threadId

      // Poll #2: ingest tripwires the ticket to escalated; escalate notifies in the same cycle.
      await supportPollGmailHandler(deps)(job('job-2'))

      const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.gmailThreadId, sent.threadId))
      expect(ticket?.status).toBe('escalated')
      expect(notify).toHaveBeenCalledTimes(1)

      // Owner resolves from /admin (does not clear escalation_notified_at).
      await db.update(supportTickets).set({ status: 'resolved' }).where(eq(supportTickets.id, ticket!.id))

      // Customer replies with a fresh chargeback.
      gmail.receiveInbound({
        from: 'jane@example.com',
        to: ['support@dogebuddy.com'],
        subject: 'Re: Order 1001',
        bodyText: 'Filing the chargeback today, this is final.',
        threadId: sent.threadId,
      })

      // Poll #3: reopen -> re-tripwire -> escalate must notify AGAIN.
      await supportPollGmailHandler(deps)(job('job-3'))

      const [reEscalated] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket!.id))
      expect(reEscalated?.status).toBe('escalated')
      expect(notify).toHaveBeenCalledTimes(2)
    } finally {
      // try/finally so a genuine assertion failure here still can't leak a ticket or an audit row
      // into whatever test file runs next.
      if (threadId) {
        const [ticket] = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.gmailThreadId, threadId))
        if (ticket) {
          await db.delete(supportMessages).where(eq(supportMessages.ticketId, ticket.id))
          await db.delete(supportTickets).where(eq(supportTickets.id, ticket.id))
        }
      }
      const notifiedAfter = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.action, 'support.escalation_notified'))
      const newIds = notifiedAfter.map((r) => r.id).filter((id) => !notifiedBefore.some((b) => b.id === id))
      if (newIds.length > 0) await db.delete(auditLog).where(inArray(auditLog.id, newIds))
    }
  })
})
