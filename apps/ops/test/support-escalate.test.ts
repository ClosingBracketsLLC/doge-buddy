import { auditLog, createDb, supportTickets } from '@doge-buddy/db'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  ESCALATION_NOTIFY_MAX_PER_DAY,
  notifyPendingEscalations,
  type EscalateDeps,
} from '../src/support/escalate.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const NOTIFIED_ACTION = 'support.escalation_notified'
const CAPPED_ACTION = 'support.escalation_capped'
const ADMIN_BASE_URL = 'http://admin.test'
const FIXED_NOW = new Date('2024-06-15T00:05:00.000Z')

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

describe('notifyPendingEscalations', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  afterEach(async () => {
    await db.delete(supportTickets).where(like(supportTickets.gmailThreadId, 'esc-%'))
    // This test file exclusively owns these two audit actions, so a blanket sweep is both
    // complete and scoped (vitest runs test files serially — see vitest.config.ts).
    await db.delete(auditLog).where(inArray(auditLog.action, [NOTIFIED_ACTION, CAPPED_ACTION]))
  })

  async function seedTicket(opts: {
    subject: string
    escalationNotifiedAt?: Date | null
  }): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `esc-${uid()}`,
        customerEmail: 'customer@example.com',
        subject: opts.subject,
        status: 'escalated',
        escalationReason: 'tripwire: test',
        escalationNotifiedAt: opts.escalationNotifiedAt ?? null,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function ticketById(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row
  }

  async function seedAuditRows(action: string, count: number, createdAt: Date): Promise<void> {
    for (let i = 0; i < count; i++) {
      await db.insert(auditLog).values({ actor: 'system', action, detail: {}, createdAt })
    }
  }

  function makeDeps(overrides: Partial<EscalateDeps> = {}): EscalateDeps {
    return {
      db,
      notify: vi.fn(async () => true),
      alert: vi.fn(async () => {}),
      adminBaseUrl: ADMIN_BASE_URL,
      now: () => FIXED_NOW,
      ...overrides,
    }
  }

  // (a)
  it('collapses two pending escalations into ONE notify call with both subjects + deep links; stamps both; writes one audit row', async () => {
    const idA = await seedTicket({ subject: 'Ticket A subject' })
    const idB = await seedTicket({ subject: 'Ticket B subject' })
    const deps = makeDeps()

    const result = await notifyPendingEscalations(deps)

    expect(result.notified).toBe(2)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const call = (deps.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { title: string; body: string }
    expect(call.title).toContain('2')
    expect(call.body).toContain('Ticket A subject')
    expect(call.body).toContain(`${ADMIN_BASE_URL}/admin/tickets/${idA}`)
    expect(call.body).toContain('Ticket B subject')
    expect(call.body).toContain(`${ADMIN_BASE_URL}/admin/tickets/${idB}`)

    expect((await ticketById(idA))?.escalationNotifiedAt).toEqual(FIXED_NOW)
    expect((await ticketById(idB))?.escalationNotifiedAt).toEqual(FIXED_NOW)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, NOTIFIED_ACTION))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toEqual({ ticketIds: expect.arrayContaining([idA, idB]), count: 2 })
  })

  // (b)
  it('notify() returning false stamps nothing, so the next call retries the same batch', async () => {
    const id = await seedTicket({ subject: 'Retry me' })
    const failingDeps = makeDeps({ notify: vi.fn(async () => false) })

    const firstResult = await notifyPendingEscalations(failingDeps)

    expect(firstResult.notified).toBe(0)
    expect((await ticketById(id))?.escalationNotifiedAt).toBeNull()
    expect(await db.select().from(auditLog).where(eq(auditLog.action, NOTIFIED_ACTION))).toHaveLength(0)

    const succeedingDeps = makeDeps({ notify: vi.fn(async () => true) })
    const secondResult = await notifyPendingEscalations(succeedingDeps)

    expect(secondResult.notified).toBe(1)
    expect((await ticketById(id))?.escalationNotifiedAt).toEqual(FIXED_NOW)
  })

  // (c)
  it('does not re-notify an already-stamped ticket', async () => {
    const alreadyDone = await seedTicket({ subject: 'Already notified', escalationNotifiedAt: new Date('2024-01-01T00:00:00Z') })
    const stillPending = await seedTicket({ subject: 'Still pending' })
    const deps = makeDeps()

    const result = await notifyPendingEscalations(deps)

    expect(result.notified).toBe(1)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const call = (deps.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string }
    expect(call.body).toContain('Still pending')
    expect(call.body).not.toContain('Already notified')
    expect((await ticketById(alreadyDone))?.escalationNotifiedAt).toEqual(new Date('2024-01-01T00:00:00Z'))
  })

  // (d)
  it('daily cap: at 10 already-audited batches today, skips notify and fires ONE capped warning per UTC day', async () => {
    await seedTicket({ subject: 'Capped out' })
    await seedAuditRows(NOTIFIED_ACTION, ESCALATION_NOTIFY_MAX_PER_DAY, FIXED_NOW)
    const deps = makeDeps()

    const result = await notifyPendingEscalations(deps)

    expect(result.notified).toBe(0)
    expect(deps.notify).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledTimes(1)
    expect(deps.alert).toHaveBeenCalledWith('warning', 'support_escalation_capped', expect.any(Object))
    expect(await db.select().from(auditLog).where(eq(auditLog.action, CAPPED_ACTION))).toHaveLength(1)

    // Second call the same day must not emit a second capped warning (guarded by the existing row).
    const secondResult = await notifyPendingEscalations(deps)
    expect(secondResult.notified).toBe(0)
    expect(deps.alert).toHaveBeenCalledTimes(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, CAPPED_ACTION))).toHaveLength(1)
  })

  // (d cont'd) — review fix: a rejecting alert() during the cap-warning path must not escape.
  it('daily cap: an alert() that rejects during the cap warning still lets notifyPendingEscalations resolve normally', async () => {
    await seedTicket({ subject: 'Capped out, alert throws' })
    await seedAuditRows(NOTIFIED_ACTION, ESCALATION_NOTIFY_MAX_PER_DAY, FIXED_NOW)
    const deps = makeDeps({
      alert: vi.fn(async () => {
        throw new Error('telegram alert boom')
      }),
    })

    await expect(notifyPendingEscalations(deps)).resolves.toEqual({ notified: 0 })
    expect(deps.notify).not.toHaveBeenCalled()
    expect(await db.select().from(auditLog).where(eq(auditLog.action, CAPPED_ACTION))).toHaveLength(1)
  })

  // (e)
  it('respects the UTC day boundary: batches audited yesterday 23:59 UTC do not count toward today', async () => {
    const id = await seedTicket({ subject: 'Fresh day' })
    const yesterday2359 = new Date('2024-06-14T23:59:00.000Z')
    await seedAuditRows(NOTIFIED_ACTION, ESCALATION_NOTIFY_MAX_PER_DAY, yesterday2359)
    const deps = makeDeps()

    const result = await notifyPendingEscalations(deps)

    expect(result.notified).toBe(1)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.alert).not.toHaveBeenCalled()
    expect((await ticketById(id))?.escalationNotifiedAt).toEqual(FIXED_NOW)
  })
})
