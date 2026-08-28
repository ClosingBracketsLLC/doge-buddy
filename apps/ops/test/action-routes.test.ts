import { createDb, proposals, auditLog, orders, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  // Task 18: support_reply/refund fixtures create real supportTickets/orders rows — clean those
  // up (unlike bare `proposals` rows, which this file has never bothered to clean up: they never
  // collide, being randomUUID-keyed and never queried except by their own id).
  let createdTicketIds: string[] = []
  let createdOrderIds: string[] = []

  afterEach(async () => {
    if (createdTicketIds.length > 0) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
      createdTicketIds = []
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
      createdOrderIds = []
    }
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

  // -- Task 18: support_reply/refund fixtures ----------------------------------------------------

  async function seedTicket(overrides: Partial<{ subject: string; customerEmail: string; agentSessionId: string }> = {}) {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `t18-${crypto.randomUUID()}`,
        customerEmail: overrides.customerEmail ?? 'buyer@example.com',
        subject: overrides.subject ?? 'Where is my order',
        status: 'awaiting_approval',
        agentSessionId: overrides.agentSessionId ?? 'sess-abc',
      })
      .returning()
    createdTicketIds.push(ticket!.id)
    return ticket!
  }

  async function seedOrder(number = '#5001') {
    const [order] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        shopifyOrderNumber: number,
        isTest: true,
      })
      .returning()
    createdOrderIds.push(order!.id)
    return order!
  }

  async function seedSupportProposal(overrides: {
    type: 'support_reply' | 'refund'
    ticketId: string
    orderId?: string
    payload: unknown
    status?: 'pending' | 'rejected' | 'expired'
  }) {
    const { token, hash } = generateActionToken()
    const [row] = await db
      .insert(proposals)
      .values({
        type: overrides.type,
        status: overrides.status ?? 'pending',
        summary: `Test ${overrides.type} ${crypto.randomUUID()}`,
        payload: overrides.payload,
        sourceWorkflow: 'test',
        ticketId: overrides.ticketId,
        orderId: overrides.orderId,
        actionTokenHash: hash,
      })
      .returning()
    return { row: row!, token }
  }

  function supportReplyPayload(ticketId: string, body: string) {
    return { type: 'support_reply' as const, ticketId, body, threadSnapshotAt: new Date().toISOString() }
  }

  function refundPayload(orderId: string, overrides: Partial<{ amountCents: number; reason: string; openCjDispute: boolean }> = {}) {
    return {
      type: 'refund' as const,
      orderId,
      shopifyOrderGid: 'gid://shopify/Order/999',
      amountCents: overrides.amountCents ?? 1500,
      reason: overrides.reason ?? 'damaged in transit',
      openCjDispute: overrides.openCjDispute ?? false,
      threadSnapshotAt: new Date().toISOString(),
    }
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
      { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600, singletonKey: row.id },
    )

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('owner')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'link' })

    await app.close()
  })

  it('3b. POST as a real browser form submit (application/x-www-form-urlencoded) -> 200 Approved, not 415', async () => {
    // Regression (found live, Tier-2): Fastify has no built-in parser for urlencoded bodies, so
    // the confirm page's own <form method="post"> submit — which every real browser sends with
    // Content-Type: application/x-www-form-urlencoded — was rejected 415
    // FST_ERR_CTP_INVALID_MEDIA_TYPE before the route ever ran. Tests and curl had no
    // Content-Type header, which is why the gap was invisible until a real phone tapped Approve.
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const res = await app.inject({
      method: 'POST',
      url: `/a/${row.id}/approve?t=${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Approved')
    expect(deps.enqueue).toHaveBeenCalledTimes(1)

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

  it('9. malformed (non-UUID) proposalId on GET -> 200 friendly page, identical body, no throw, alerted', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })

    // Known-bad-token friendly response, to compare byte-for-byte against.
    const { row } = await seedPending()
    const reference = await app.inject({ method: 'GET', url: `/a/${row.id}/approve?t=not-the-real-token` })
    expect(reference.statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: '/a/not-a-uuid/approve?t=x' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(reference.body)
    expect(res.body).toContain(FRIENDLY_COPY)

    // No pre-check regex: the malformed id reaches the DB lookup, Postgres throws on the bad
    // UUID literal, and the catch-all is what's actually degrading it here — so the alert fires.
    expect(deps.alert).toHaveBeenCalledWith(
      'warning',
      'action_route_error',
      expect.objectContaining({ proposalId: 'not-a-uuid' }),
    )

    await app.close()
  })

  // Item 1: same enqueue-failure recovery shape as the admin surface (admin-decisions.test.ts's
  // #11) — the transition already committed, so a failed enqueue must never un-approve, and the
  // clicker must see a distinct copy rather than the normal "will go live shortly" text.
  it('11. throwing enqueue on POST approve -> row STAYS approved, distinct re-send copy, critical alert', async () => {
    alert = vi.fn(async () => {})
    const deps: ActionRouteDeps = { db, enqueue: vi.fn(async () => { throw new Error('queue down') }), alert }
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const { row, token } = await seedPending()

    const res = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Approved ✓ — but queueing failed; the admin dashboard can re-send.')
    expect(res.body).not.toContain('the listing will go live shortly')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(after!.decidedBy).toBe('owner')

    expect(deps.alert).toHaveBeenCalledWith(
      'critical',
      'apply_enqueue_failed',
      expect.objectContaining({ proposalId: row.id }),
    )

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(1) // the decision itself still committed and was audited

    await app.close()
  })

  it('10. malformed (non-UUID) proposalId on POST -> 200 friendly page, identical body, no write, no throw, alerted', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })

    const { row } = await seedPending()
    const reference = await app.inject({ method: 'GET', url: `/a/${row.id}/approve?t=not-the-real-token` })
    expect(reference.statusCode).toBe(200)

    const res = await app.inject({ method: 'POST', url: '/a/not-a-uuid/approve?t=x' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(reference.body)
    expect(res.body).toContain(FRIENDLY_COPY)

    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledWith(
      'warning',
      'action_route_error',
      expect.objectContaining({ proposalId: 'not-a-uuid' }),
    )

    await app.close()
  })

  // -- Task 18: §3 validator on one-click approve, silent reject-escalation ----------------------

  it('12. one-click reject of a refund: sibling pending reply expires, ticket escalates SILENTLY (stamp set, session cleared) — a later one-click approve of that now-expired reply is "Already handled"', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const ticket = await seedTicket({ agentSessionId: 'sess-live' })
    const order = await seedOrder()
    const { row: refundRow, token: refundToken } = await seedSupportProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id),
    })
    const { row: replyRow, token: replyToken } = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })

    const rejectRes = await app.inject({ method: 'POST', url: `/a/${refundRow.id}/reject?t=${refundToken}` })
    expect(rejectRes.statusCode).toBe(200)
    expect(rejectRes.body).toContain('Rejected')

    const [refundAfter] = await db.select().from(proposals).where(eq(proposals.id, refundRow.id))
    expect(refundAfter!.status).toBe('rejected')

    const [replyAfter] = await db.select().from(proposals).where(eq(proposals.id, replyRow.id))
    expect(replyAfter!.status).toBe('expired')

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')
    expect(ticketAfter!.escalationReason).toBe('owner_rejected_draft')
    // PRE-STAMPED (silent): the owner's own reject tap caused this escalation, so it must not
    // read as an un-notified escalation waiting for the poller to page them about their own click.
    expect(ticketAfter!.escalationNotifiedAt).not.toBeNull()
    expect(ticketAfter!.agentSessionId).toBeNull()

    // No owner notification for THIS decision route (it has none to send — Telegram paging is a
    // notify()-owning concern elsewhere); what matters here is that no throw/500 occurred and the
    // DB ended up in the state above.
    expect(deps.alert).not.toHaveBeenCalledWith('critical', expect.anything(), expect.anything())

    const laterApproveRes = await app.inject({ method: 'POST', url: `/a/${replyRow.id}/approve?t=${replyToken}` })
    expect(laterApproveRes.statusCode).toBe(200)
    expect(laterApproveRes.body).toContain(FRIENDLY_COPY)

    const [replyStill] = await db.select().from(proposals).where(eq(proposals.id, replyRow.id))
    expect(replyStill!.status).toBe('expired')

    await app.close()
  })

  it('13. one-click reject of a support_reply: sibling pending refund expires too (symmetric direction)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const ticket = await seedTicket()
    const order = await seedOrder()
    const { row: replyRow, token: replyToken } = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const { row: refundRow } = await seedSupportProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id),
    })

    const res = await app.inject({ method: 'POST', url: `/a/${replyRow.id}/reject?t=${replyToken}` })
    expect(res.statusCode).toBe(200)

    const [refundAfter] = await db.select().from(proposals).where(eq(proposals.id, refundRow.id))
    expect(refundAfter!.status).toBe('expired')

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')

    await app.close()
  })

  it('14. one-click approve of a refund whose accumulation bound is now exceeded -> validation error page naming refund_exceeds_total, no transition', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, actions: deps })
    const ticket = await seedTicket()
    const order = await seedOrder()
    // Order total defaults to NULL on this fixture — validateRefundIntent refuses any refund
    // against an order whose total isn't known, which is the cheapest reliable way to force a §3
    // refusal on this route without faking a second live proposal to overflow the accumulation
    // bound.
    const { row, token } = await seedSupportProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id),
    })

    const res = await app.inject({ method: 'POST', url: `/a/${row.id}/approve?t=${token}` })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('refund_unverified_order')
    expect(deps.enqueue).not.toHaveBeenCalled()

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })
})
