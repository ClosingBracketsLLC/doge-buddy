import { auditLog, createDb, proposals } from '@doge-buddy/db'
import type { DisputeStatus } from '@doge-buddy/supplier'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { cjDisputePollHandler, executeDisputePoll, type DisputePollDeps } from '../src/jobs/cj-dispute-poll.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

/** Exactly `executeDisputePoll`'s own selection predicate — used both to reset the table to a
 * clean baseline before each test and (indirectly) exercised by the function under test itself. */
function matchesSelection() {
  return and(
    eq(proposals.type, 'refund'),
    eq(proposals.status, 'applied'),
    isNotNull(sql`${proposals.payload} -> 'cjDispute' ->> 'id'`),
    isNull(sql`${proposals.payload} -> 'cjDispute' ->> 'status'`),
  )
}

describe('executeDisputePoll', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdIds: string[] = []

  // This test database is shared and persistent across the whole suite (same stance
  // `wallet-monitor.test.ts` documents for `awaiting_funds`), and `executeDisputePoll`'s selection
  // query is deliberately unscoped — a real run has to see the whole `proposals` table, not just
  // rows a test created. Resetting every row that currently matches the selection predicate before
  // each test establishes a clean baseline so this file's `result.polled`/`result.terminal`
  // assertions aren't at the mercy of leftover rows from an earlier crashed run.
  beforeEach(async () => {
    createdIds = []
    await db.delete(proposals).where(matchesSelection())
  })

  afterEach(async () => {
    if (createdIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdIds))
      await db.delete(proposals).where(inArray(proposals.id, createdIds))
    }
    vi.restoreAllMocks()
  })

  async function seedProposal(
    payload: Record<string, unknown>,
    opts: { status?: 'applied' | 'pending' | 'approved'; type?: 'refund' | 'support_reply' } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: opts.type ?? 'refund',
        status: opts.status ?? 'applied',
        summary: `dispute-poll test ${uid()}`,
        payload,
        sourceWorkflow: 'test',
      })
      .returning({ id: proposals.id })
    createdIds.push(row!.id)
    return row!.id
  }

  async function loadProposal(id: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    return row
  }

  function makeDeps(getDisputeImpl: (disputeId: string) => Promise<DisputeStatus>): {
    deps: DisputePollDeps
    alert: ReturnType<typeof vi.fn>
    getDispute: ReturnType<typeof vi.fn>
  } {
    const getDispute = vi.fn(getDisputeImpl)
    const alert = vi.fn(async () => {})
    const deps: DisputePollDeps = { db, adapter: { getDispute }, alert }
    return { deps, alert, getDispute }
  }

  async function auditRowsFor(proposalId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, proposalId), eq(auditLog.action, 'cj.dispute_terminal')))
  }

  it('terminal dispute gets the marker + is NOT selected (or re-alerted) on a second executeDisputePoll call', async () => {
    const proposalId = await seedProposal({ cjDispute: { id: 'cjd-1' }, unrelatedKey: 'untouched' })
    const { deps, alert, getDispute } = makeDeps(async () => ({ value: 'refunded' }))
    const fixedNow = new Date('2026-08-27T12:00:00.000Z')
    deps.now = () => fixedNow

    const first = await executeDisputePoll(deps)
    expect(first).toEqual({ polled: 1, terminal: 1 })
    expect(getDispute).toHaveBeenCalledWith('cjd-1')

    const afterFirst = await loadProposal(proposalId)
    // WHOLE object written — `id` survives (Task 16's shallow-merge WARNING at apply-refund.ts's
    // merge site: a partial `{ status }` write would destroy `id` and make the row unpollable).
    expect(afterFirst?.payload).toMatchObject({
      cjDispute: { id: 'cjd-1', status: 'refunded', closedAt: fixedNow.toISOString() },
      unrelatedKey: 'untouched', // sibling top-level payload keys survive the merge untouched
    })

    const audits = await auditRowsFor(proposalId)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ disputeId: 'cjd-1', status: 'refunded' })

    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('info', 'cj_dispute_terminal', {
      proposalId,
      disputeId: 'cjd-1',
      status: 'refunded',
    })

    // Second cycle: the terminal marker IS the once-guard. The row no longer matches the selection
    // predicate (payload->cjDispute->>status is no longer NULL), so it's never re-polled and the
    // info alert never fires a second time for the same dispute.
    const second = await executeDisputePoll(deps)
    expect(second).toEqual({ polled: 0, terminal: 0 })
    expect(getDispute).toHaveBeenCalledTimes(1) // still just the first cycle's call
    expect(alert).toHaveBeenCalledTimes(1) // no re-alert
    expect(await auditRowsFor(proposalId)).toHaveLength(1) // no second audit row either
  })

  it.each(['pending', 'unknown'] as const)(
    "'%s' is non-terminal: leaves the row unmarked for the next cycle, no audit row, no alert",
    async (value) => {
      const proposalId = await seedProposal({ cjDispute: { id: 'cjd-live' } })
      const { deps, alert, getDispute } = makeDeps(async () => ({ value }))

      const result = await executeDisputePoll(deps)

      expect(result).toEqual({ polled: 1, terminal: 0 })
      expect(getDispute).toHaveBeenCalledWith('cjd-live')

      const row = await loadProposal(proposalId)
      expect(row?.payload).toEqual({ cjDispute: { id: 'cjd-live' } }) // unchanged — still just { id }
      expect(row?.status).toBe('applied') // proposal status itself is never touched by the poll

      expect(await auditRowsFor(proposalId)).toHaveLength(0)
      expect(alert).not.toHaveBeenCalled()

      // Still selected next cycle — the row was never marked.
      const second = await executeDisputePoll(deps)
      expect(second).toEqual({ polled: 1, terminal: 0 })
      expect(getDispute).toHaveBeenCalledTimes(2)
    },
  )

  it("adapter throw on one row doesn't stop the rest of the batch: warning alert + continue", async () => {
    const failingId = await seedProposal({ cjDispute: { id: 'cjd-err' } })
    const okId = await seedProposal({ cjDispute: { id: 'cjd-ok' } })

    const getDispute = vi.fn(async (disputeId: string) => {
      if (disputeId === 'cjd-err') throw new Error('CJ API unreachable')
      return { value: 'refunded' as const }
    })
    const alert = vi.fn(async () => {})
    const deps: DisputePollDeps = { db, adapter: { getDispute }, alert }

    const result = await executeDisputePoll(deps)

    // Both rows attempted (order is oldest-created-first, so the failing row is row 1) — the throw
    // on row 1 does not stop row 2 from being polled and marked terminal.
    expect(result).toEqual({ polled: 2, terminal: 1 })
    expect(getDispute).toHaveBeenCalledWith('cjd-err')
    expect(getDispute).toHaveBeenCalledWith('cjd-ok')

    expect(alert).toHaveBeenCalledWith('warning', 'cj_dispute_poll_error', {
      proposalId: failingId,
      disputeId: 'cjd-err',
      error: 'CJ API unreachable',
    })
    expect(alert).toHaveBeenCalledWith('info', 'cj_dispute_terminal', {
      proposalId: okId,
      disputeId: 'cjd-ok',
      status: 'refunded',
    })

    // The failing row is left completely unmarked — its throw must not corrupt or partially write
    // anything.
    expect((await loadProposal(failingId))?.payload).toEqual({ cjDispute: { id: 'cjd-err' } })
    // The sibling row's terminal write landed normally despite its neighbour's failure.
    expect((await loadProposal(okId))?.payload).toMatchObject({ cjDispute: { id: 'cjd-ok', status: 'refunded' } })
  })

  it('selection ignores proposals with no cjDispute.id, a wrong type/status, or an already-terminal marker', async () => {
    await seedProposal({}) // no cjDispute at all
    await seedProposal({ cjDispute: {} }) // cjDispute present but no id
    await seedProposal({ cjDispute: { id: 'cjd-pending-status' } }, { status: 'pending' }) // wrong proposal status
    await seedProposal({ cjDispute: { id: 'cjd-wrong-type' } }, { type: 'support_reply' }) // wrong proposal type
    await seedProposal({ cjDispute: { id: 'cjd-already-done', status: 'refunded', closedAt: 'x' } }) // already marked

    const { deps, alert, getDispute } = makeDeps(async () => ({ value: 'refunded' }))

    const result = await executeDisputePoll(deps)

    expect(result).toEqual({ polled: 0, terminal: 0 })
    expect(getDispute).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })
})

describe('cjDisputePollHandler', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdIds: string[] = []

  beforeEach(async () => {
    createdIds = []
    await db.delete(proposals).where(matchesSelection())
  })

  afterEach(async () => {
    if (createdIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdIds))
      await db.delete(proposals).where(inArray(proposals.id, createdIds))
    }
    vi.restoreAllMocks()
  })

  it('cron job wrapper: calls executeDisputePoll (via getDispute) once per job in the batch', async () => {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'refund',
        status: 'applied',
        summary: 'dispute-poll handler test',
        payload: { cjDispute: { id: 'cjd-handler' } },
        sourceWorkflow: 'test',
      })
      .returning({ id: proposals.id })
    createdIds.push(row!.id)

    // 'pending' never gets marked terminal, so the same row is still selected on every cycle —
    // exactly what lets this test observe one `getDispute` call per job the way
    // `cj-wallet-monitor.test.ts`'s equivalent handler test observes one `getBalance` call per job.
    const getDispute = vi.fn(async () => ({ value: 'pending' as const }))
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const deps: DisputePollDeps = { db, adapter: { getDispute }, alert: createAlerter(db, mockLog) }

    await cjDisputePollHandler(deps)([
      { id: 'job-1', name: 'cj.dispute-poll', data: {}, expireInSeconds: 900 },
      { id: 'job-2', name: 'cj.dispute-poll', data: {}, expireInSeconds: 900 },
    ])

    expect(getDispute).toHaveBeenCalledTimes(2)
  })
})
