import { createDb, proposals, supportTickets } from '@doge-buddy/db'
import { inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { loadNavCounts } from '../src/http/admin/nav.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('loadNavCounts', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  let proposalIds: string[] = []
  let ticketIds: string[] = []
  afterEach(async () => {
    if (proposalIds.length) await db.delete(proposals).where(inArray(proposals.id, proposalIds))
    if (ticketIds.length) await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    proposalIds = []; ticketIds = []
  })

  it('counts pending proposals and escalated tickets (deltas against whatever else is in the DB)', async () => {
    const before = await loadNavCounts(db)
    const [p1, p2, p3] = await db.insert(proposals).values([
      { type: 'new_listing', status: 'pending', summary: 'nav a', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
      { type: 'new_listing', status: 'pending', summary: 'nav b', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
      { type: 'new_listing', status: 'rejected', summary: 'nav c', payload: {}, sourceWorkflow: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
    ]).returning({ id: proposals.id })
    proposalIds = [p1!.id, p2!.id, p3!.id]
    const [t1, t2] = await db.insert(supportTickets).values([
      { gmailThreadId: `nav1-${crypto.randomUUID()}`, customerEmail: 'nav1@example.com', subject: 'nav', status: 'escalated' },
      { gmailThreadId: `nav2-${crypto.randomUUID()}`, customerEmail: 'nav2@example.com', subject: 'nav', status: 'triaged' },
    ]).returning({ id: supportTickets.id })
    ticketIds = [t1!.id, t2!.id]

    const after = await loadNavCounts(db)
    expect(after.pendingProposals - before.pendingProposals).toBe(2)
    expect(after.escalatedTickets - before.escalatedTickets).toBe(1)
  })

  it('never throws: a broken db yields zeros', async () => {
    const broken = { select: () => { throw new Error('boom') } } as unknown as Parameters<typeof loadNavCounts>[0]
    await expect(loadNavCounts(broken)).resolves.toEqual({ pendingProposals: 0, escalatedTickets: 0 })
  })
})
