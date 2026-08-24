import { auditLog, createDb, proposals } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { proposalExpireSweepHandler } from '../src/jobs/proposal-expire-sweep.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('proposalExpireSweepHandler', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProposalIds: string[] = []

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
    }
  })

  async function seedProposal(
    status: 'pending' | 'approved',
    expiresAt: Date,
  ): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status,
        summary: `Test proposal ${crypto.randomUUID()}`,
        payload: {},
        sourceWorkflow: 'test',
        expiresAt,
      })
      .returning({ id: proposals.id })
    createdProposalIds.push(row!.id)
    return row!.id
  }

  async function countAuditRowsForProposal(proposalId: string): Promise<number> {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'proposal.expired'),
          eq(auditLog.entityId, proposalId),
        ),
      )
    return rows.length
  }

  it('expires pending proposals with past expiresAt, leaves pending/fresh and approved/past untouched', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 1 day ago
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 1 day from now

    const expiredId = await seedProposal('pending', past)
    const freshId = await seedProposal('pending', future)
    const approvedId = await seedProposal('approved', past)

    // Run the handler
    await proposalExpireSweepHandler(db)([
      { id: 'j1', name: 'proposal.expire-sweep', data: {} },
    ] as never)

    // Check expired proposal transitioned to 'expired' status
    const [expiredRow] = await db.select().from(proposals).where(eq(proposals.id, expiredId))
    expect(expiredRow!.status).toBe('expired')

    // Check audit log has entry for expired proposal
    const expiredAuditCount = await countAuditRowsForProposal(expiredId)
    expect(expiredAuditCount).toBe(1)

    // Check the audit row details
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'proposal.expired'),
          eq(auditLog.entityId, expiredId),
        ),
      )
    expect(auditRow!.actor).toBe('system')
    expect(auditRow!.entityType).toBe('proposal')
    // Audit parity with the lazy-expiry path in actions.ts (which stamps { via: 'lazy-expiry' })
    // — the sweep's own rows must be distinguishable the same way, not left detail-less.
    expect(auditRow!.detail).toMatchObject({ via: 'sweep' })

    // Check fresh pending proposal is still pending
    const [freshRow] = await db.select().from(proposals).where(eq(proposals.id, freshId))
    expect(freshRow!.status).toBe('pending')

    // Check approved proposal is still approved (decided rows never expire)
    const [approvedRow] = await db.select().from(proposals).where(eq(proposals.id, approvedId))
    expect(approvedRow!.status).toBe('approved')
  })

  it('is idempotent: second run does not create new audit rows for already-expired proposals', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const expiredId = await seedProposal('pending', past)

    // First run
    await proposalExpireSweepHandler(db)([
      { id: 'j1', name: 'proposal.expire-sweep', data: {} },
    ] as never)

    const countAfterFirstRun = await countAuditRowsForProposal(expiredId)
    expect(countAfterFirstRun).toBe(1)

    // Second run
    await proposalExpireSweepHandler(db)([
      { id: 'j1', name: 'proposal.expire-sweep', data: {} },
    ] as never)

    // Should still be only 1 audit row (idempotent)
    const countAfterSecondRun = await countAuditRowsForProposal(expiredId)
    expect(countAfterSecondRun).toBe(1)
  })
})
