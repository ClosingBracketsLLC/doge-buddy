import { createDb, gmailSyncState } from '@doge-buddy/db'
import { createMockGmail } from '@doge-buddy/gmail'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeSupportPoll,
  resetSupportPollOnceFlags,
  supportPollGmailHandler,
  SUPPORT_POLL_QUEUE,
  type SupportPollDeps,
} from '../src/jobs/support-poll-gmail.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'
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
      ingestFn: vi.fn(async () => ({ insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [] })),
      triageFn: vi.fn(async () => ({ triaged: 0, escalatedTicketIds: [] })),
      escalateFn: vi.fn(async () => ({ notified: 0 })),
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

      // Both polls succeeded (ingest/escalate stubs resolve) — success is still recorded.
      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(0)
    })
  })

  describe('success', () => {
    it('all stages succeed: runs ingest → triage → escalate in order, resets counter, stamps last_success_at', async () => {
      await seedSyncState(7, null)
      const deps = baseDeps()

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.triageFn).toHaveBeenCalledTimes(1)
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)
      expect(deps.alert).not.toHaveBeenCalled()
      expect(deps.notify).not.toHaveBeenCalled()

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(0)
      expect(row?.lastSuccessAt).toEqual(new Date('2026-08-25T12:00:00.000Z'))
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

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
      expect(row?.lastSuccessAt).toBeNull()
    })

    it('triage throws: escalate still runs (not skipped), failure is accounted with the triage error', async () => {
      await seedSyncState(0, null)
      const triageFn = vi.fn(async () => {
        throw new Error('triage boom')
      })
      const deps = baseDeps({ triageFn })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.escalateFn).toHaveBeenCalledTimes(1)

      const row = await readSyncState()
      expect(row?.consecutiveFailures).toBe(1)
    })

    it('escalate throws alone (ingest+triage succeed): still accounted as a failed poll', async () => {
      await seedSyncState(0, null)
      const escalateFn = vi.fn(async () => {
        throw new Error('escalate boom')
      })
      const deps = baseDeps({ escalateFn })

      await executeSupportPoll(deps)

      expect(deps.ingestFn).toHaveBeenCalledTimes(1)
      expect(deps.triageFn).toHaveBeenCalledTimes(1)

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
      ingestFn,
      triageFn: vi.fn(async () => ({ triaged: 0, escalatedTicketIds: [] })),
      escalateFn: vi.fn(async () => ({ notified: 0 })),
    }

    await supportPollGmailHandler(deps)([
      { id: 'job-1', name: SUPPORT_POLL_QUEUE, data: {}, expireInSeconds: 120 },
      { id: 'job-2', name: SUPPORT_POLL_QUEUE, data: {}, expireInSeconds: 120 },
    ])

    expect(ingestFn).toHaveBeenCalledTimes(2)
  })
})
