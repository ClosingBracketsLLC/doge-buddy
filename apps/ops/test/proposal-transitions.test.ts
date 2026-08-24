import { createDb, proposals } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyProposalTransition, canTransitionProposal,
  IllegalProposalTransitionError, StaleProposalStatusError,
} from '../src/proposals/transitions.ts'
import { generateActionToken, hashActionToken } from '../src/proposals/tokens.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('proposal transitions', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  async function seed(status: 'pending' | 'approved' | 'applying' = 'pending') {
    const [row] = await db.insert(proposals).values({
      type: 'new_listing', status, summary: 'test', payload: { type: 'new_listing' },
      sourceWorkflow: 'seed',
    }).returning()
    return row!
  }

  it('pending -> approved persists decidedBy/decidedAt and nulls the token hash', async () => {
    const row = await seed('pending')
    await applyProposalTransition(db, row.id, 'pending', 'approved', {
      decidedBy: 'owner', decidedAt: new Date(), actionTokenHash: null,
    })
    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()
  })

  it('guarded UPDATE: two concurrent pending->approved races produce exactly one winner', async () => {
    const row = await seed('pending')
    const race = await Promise.allSettled([
      applyProposalTransition(db, row.id, 'pending', 'approved', { decidedBy: 'owner' }),
      applyProposalTransition(db, row.id, 'pending', 'rejected', { decidedBy: 'owner' }),
    ])
    const rejected = race.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleProposalStatusError)
  })

  it('illegal pair throws before any DB write', async () => {
    const row = await seed('pending')
    await expect(applyProposalTransition(db, row.id, 'pending', 'applied')).rejects.toBeInstanceOf(
      IllegalProposalTransitionError,
    )
  })

  it('canTransitionProposal encodes the exact matrix', () => {
    expect(canTransitionProposal('pending', 'approved')).toBe(true)
    expect(canTransitionProposal('pending', 'rejected')).toBe(true)
    expect(canTransitionProposal('pending', 'expired')).toBe(true)
    expect(canTransitionProposal('approved', 'applying')).toBe(true)
    expect(canTransitionProposal('approved', 'failed')).toBe(true)
    expect(canTransitionProposal('applying', 'applied')).toBe(true)
    expect(canTransitionProposal('applying', 'failed')).toBe(true)
    expect(canTransitionProposal('approved', 'applied')).toBe(false)
    expect(canTransitionProposal('applied', 'pending')).toBe(false)
    expect(canTransitionProposal('pending', 'pending')).toBe(false)
  })
})

describe('action tokens', () => {
  it('generateActionToken returns a base64url token whose domain-separated hash matches', () => {
    const { token, hash } = generateActionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url, unpadded
    expect(hash).toBe(hashActionToken(token))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('a bare (undomained) sha256 of the token does NOT match — domain separation is real', () => {
    const { token, hash } = generateActionToken()
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(createHash('sha256').update(token).digest('hex')).not.toBe(hash)
  })
})
