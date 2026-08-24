import { createDb, proposals, auditLog } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.ts'
import type { ActionRouteDeps } from '../src/http/actions.ts'
import { generateActionToken } from '../src/proposals/tokens.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FRIENDLY_COPY = 'This link was already handled or has expired.'

describe('public action routes (/a/:proposalId/approve|reject)', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let enqueue: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>

  function makeDeps(): ActionRouteDeps {
    enqueue = vi.fn(async () => {})
    alert = vi.fn(async () => {})
    return { db, enqueue, alert }
  }

  beforeEach(() => {
    enqueue = vi.fn(async () => {})
    alert = vi.fn(async () => {})
  })

  async function seedPending(overrides: Partial<{ expiresAt: Date; summary: string }> = {}) {
    const { token, hash } = generateActionToken()
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'pending',
        summary: overrides.summary ?? 'Ship & Save <Widget> "Deluxe"',
        payload: { type: 'new_listing' },
        sourceWorkflow: 'test',
        actionTokenHash: hash,
        ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      })
      .returning()
    return { row: row!, token }
  }

  async function auditRowsFor(proposalId: string, action: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, proposalId), eq(auditLog.action, action)))
  }

  it('1. GET approve with valid token -> 200, HTML has summary + <form method="post" -- and no DB write', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const res = await app.inject({ method: 'GET', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Ship &amp; Save &lt;Widget&gt; &quot;Deluxe&quot;')
    expect(res.body).toContain('<form method="post"')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')
    expect(after!.updatedAt.getTime()).toBe(row.updatedAt.getTime())

    await app.close()
  })

  it('2. GET friendly page is identical for unknown id / wrong token / already-decided row', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })

    const unknownRes = await app.inject({ method: 'GET', url: `/a/${crypto.randomUUID()}/approve?t=whatever` })
    expect(unknownRes.statusCode).toBe(200)
    expect(unknownRes.body).toContain(FRIENDLY_COPY)

    const { row } = await seedPending()
    const wrongTokenRes = await app.inject({ method: 'GET', url: `/a/${row.id}/approve?t=not-the-real-token` })
    expect(wrongTokenRes.statusCode).toBe(200)

    const { token: decidedToken } = generateActionToken()
    const [decidedRow] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'approved',
        summary: 'Already decided',
        payload: { type: 'new_listing' },
        sourceWorkflow: 'test',
        actionTokenHash: null,
        decidedBy: 'owner',
        decidedAt: new Date(),
      })
      .returning()
    const decidedRes = await app.inject({
      method: 'GET',
      url: `/a/${decidedRow!.id}/approve?t=${decidedToken}`,
    })
    expect(decidedRes.statusCode).toBe(200)

    expect(unknownRes.body).toBe(wrongTokenRes.body)
    expect(wrongTokenRes.body).toBe(decidedRes.body)

    await app.close()
  })

  it('3. POST approve with valid token -> 200 body contains Approved; row approved, tokened cleared, audited, enqueued once', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const res = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Approved')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()
    expect(after!.decidedAt).not.toBeNull()

    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'proposal.apply',
      { proposalId: row.id },
      { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: row.id },
    )

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('owner')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'link' })

    await app.close()
  })

  it('4. second POST with the same token -> friendly page, still exactly one enqueue, row untouched', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const first = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })
    expect(first.statusCode).toBe(200)

    const [afterFirst] = await db.select().from(proposals).where(eq(proposals.id, row.id))

    const second = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })
    expect(second.statusCode).toBe(200)
    expect(second.body).toContain(FRIENDLY_COPY)

    const [afterSecond] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(afterSecond).toEqual(afterFirst)

    expect(deps.enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('5. concurrent double-POST: exactly one wins, one enqueue, both responses 200', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const [res1, res2] = await Promise.all([
      app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` }),
      app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` }),
    ])

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')

    expect(deps.enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('6. POST reject -> rejected, no enqueue, audit proposal.reject', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const res = await app.inject({ method: 'POST', url: `/a/${row.id}/reject?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Rejected')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('rejected')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()

    expect(deps.enqueue).not.toHaveBeenCalled()

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.detail).toMatchObject({ via: 'link' })

    await app.close()
  })

  it('7. expired pending row + POST -> flips to expired, audited as system, friendly page, no enqueue', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending({ expiresAt: new Date(Date.now() - 1000) })

    const res = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(FRIENDLY_COPY)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('expired')

    expect(deps.enqueue).not.toHaveBeenCalled()

    const auditRows = await auditRowsFor(row.id, 'proposal.expired')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('system')

    await app.close()
  })

  it('8. GET on an expired pending row -> friendly page and NO write (status stays pending)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending({ expiresAt: new Date(Date.now() - 1000) })

    const res = await app.inject({ method: 'GET', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(FRIENDLY_COPY)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })
})
