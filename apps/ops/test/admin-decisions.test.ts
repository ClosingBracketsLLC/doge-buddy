import { auditLog, createDb, orders, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import type { ActionRouteDeps } from '../src/http/actions.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
import { generateActionToken } from '../src/proposals/tokens.ts'
import { SUPPORT_REDRAFT_MAX } from '../src/support/redraft.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

const VALID_NEW_LISTING_PAYLOAD = {
  type: 'new_listing' as const,
  title: 'Squeaky Widget',
  descriptionHtml: '<p>A fine widget.</p>',
  categoryTag: 'toys' as const,
  imageUrls: ['https://example.com/a.png'],
  shipsFrom: 'US' as const,
  deliveryMinDays: 3,
  deliveryMaxDays: 7,
  variants: [
    {
      sku: 'SKU-1',
      priceCents: 999,
      supplierCostCents: 500,
      supplier: 'mock' as const,
      supplierProductId: 'p1',
      supplierVariantId: 'v1',
    },
  ],
}

// A TestDeps is an AdminDeps whose `notify` is wired to a capture notifier, with the captured
// array attached alongside — so `loginAndGetCookie` below can pull the login link's token back
// out without every test having to thread its own capture notifier through separately.
interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('session-authed proposal decisions (+ edit-then-approve)', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  // Task 9: support_reply/refund fixtures create real supportTickets/orders rows — clean those up
  // (unlike bare `proposals` rows, which this file has never bothered to clean up: they never
  // collide, being randomUUID-keyed and never queried except by their own id). Same idiom as
  // action-routes.test.ts's own copy.
  let createdTicketIds: string[] = []
  let createdOrderIds: string[] = []

  afterEach(async () => {
    if (createdTicketIds.length > 0) {
      // supportMessages.ticketId has no ON DELETE CASCADE — messages must go first.
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, createdTicketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
      createdTicketIds = []
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
      createdOrderIds = []
    }
  })

  function makeDeps(overrides: Partial<AdminDeps> = {}): TestDeps {
    const { notify, sent } = createCaptureNotifier()
    return {
      db,
      settings: createSettings(db),
      notify,
      enqueue: vi.fn(async () => {}),
      alert: vi.fn(async () => {}),
      adminBaseUrl: 'http://ops.test',
      ...overrides,
      sent,
    }
  }

  // Hourly-cap hygiene: `admin.login_link_sent` rows count toward a shared cap
  // (LOGIN_SENDS_HOURLY_CAP), so every login this file performs must remove the row it created
  // before the next test runs — same idiom admin-login.test.ts uses.
  async function cleanupLoginSends(): Promise<void> {
    await db.delete(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
  }

  function extractToken(sentUrl: string): string {
    const m = sentUrl.match(/[?&]t=([^&]+)/)
    if (!m) throw new Error(`no token in ${sentUrl}`)
    return m[1]!
  }

  /** Runs the Task-3 login flow once (send link, extract token, consume it) and returns the
   * `db_admin=...` cookie pair ready to attach to a subsequent request. Cleans up the
   * `admin.login_link_sent` audit row it creates before returning. */
  async function loginAndGetCookie(app: FastifyInstance, deps: TestDeps): Promise<string> {
    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const token = extractToken(deps.sent[deps.sent.length - 1]!.actions![0]!.url)

    const consumeRes = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    const setCookie = consumeRes.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)

    await cleanupLoginSends()
    return cookieHeader.split(';')[0]!
  }

  async function seedPending(
    overrides: Partial<{ type: 'new_listing'; payload: unknown; expiresAt: Date }> = {},
  ) {
    const { hash } = generateActionToken()
    const [row] = await db
      .insert(proposals)
      .values({
        type: overrides.type ?? 'new_listing',
        status: 'pending',
        summary: 'Test proposal',
        payload: overrides.payload ?? VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        actionTokenHash: hash,
        ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      })
      .returning()
    return row!
  }

  async function auditRowsFor(proposalId: string, action: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, proposalId), eq(auditLog.action, action)))
  }

  function formBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString()
  }

  // -- Task 9: support_reply fixtures (mirrors action-routes.test.ts's own copy) -----------------

  async function seedTicket(overrides: Partial<{ agentSessionId: string }> = {}) {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `t9-${crypto.randomUUID()}`,
        customerEmail: 'buyer@example.com',
        subject: 'Where is my order',
        status: 'awaiting_approval',
        agentSessionId: overrides.agentSessionId ?? 'sess-abc',
      })
      .returning()
    createdTicketIds.push(ticket!.id)
    return ticket!
  }

  async function seedSupportProposal(overrides: { type: 'support_reply' | 'refund'; ticketId: string; orderId?: string; payload: unknown }) {
    const [row] = await db
      .insert(proposals)
      .values({
        type: overrides.type,
        status: 'pending',
        summary: `Test ${overrides.type} ${crypto.randomUUID()}`,
        payload: overrides.payload,
        sourceWorkflow: 'test',
        ticketId: overrides.ticketId,
        orderId: overrides.orderId,
      })
      .returning()
    return row!
  }

  function supportReplyPayload(ticketId: string, body: string) {
    return { type: 'support_reply' as const, ticketId, body, threadSnapshotAt: new Date().toISOString() }
  }

  it('1. unauthenticated POST approve -> 303 to login, row untouched, nothing enqueued', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()

    const res = await app.inject({ method: 'POST', url: `/admin/proposals/${row.id}/approve` })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')
    expect(after!.actionTokenHash).not.toBeNull()
    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('2. authed approve, no payload field -> 303, approved, token cleared, enqueued once, audited edited:false', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/proposals/${row.id}`)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()

    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'proposal.apply',
      { proposalId: row.id },
      { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600, singletonKey: row.id },
    )

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('owner')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: false })

    await app.close()
  })

  it('3. edit-then-approve: valid JSON with changed title -> approved with new payload, audited edited:true', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const editedPayload = { ...VALID_NEW_LISTING_PAYLOAD, title: 'Edited Title' }
    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ payload: JSON.stringify(editedPayload) }),
    })

    expect(res.statusCode).toBe(303)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect((after!.payload as { title: string }).title).toBe('Edited Title')

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: true })

    expect(deps.enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('4. edit with schema-breaking JSON -> 400, issues listed, row still pending, token intact, no enqueue', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ payload: JSON.stringify({ type: 'new_listing' }) }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('title')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')
    expect(after!.actionTokenHash).not.toBeNull()

    expect(deps.enqueue).not.toHaveBeenCalled()

    const auditRows = await auditRowsFor(row.id, 'proposal.approve')
    expect(auditRows).toHaveLength(0)

    await app.close()
  })

  it('5. edit with unparseable JSON -> 400, row untouched', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ payload: '{not valid json' }),
    })

    expect(res.statusCode).toBe(400)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')
    expect(after!.actionTokenHash).not.toBeNull()
    expect(after!.updatedAt.getTime()).toBe(row.updatedAt.getTime())

    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('6. authed reject -> rejected, no enqueue, audited via:admin edited:false', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/proposals/${row.id}`)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('rejected')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()

    expect(deps.enqueue).not.toHaveBeenCalled()

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('owner')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: false })

    await app.close()
  })

  it('7. race: /a/ approve and admin approve fired concurrently -> exactly one enqueue, final status approved', async () => {
    const adminDeps = makeDeps()
    const enqueue = vi.fn(async () => {})
    const alert = vi.fn(async () => {})
    adminDeps.enqueue = enqueue
    const actionsDeps: ActionRouteDeps = { db, enqueue, alert }
    const app = buildServer({ pool, isQueueReady: () => true, admin: adminDeps, actions: actionsDeps })

    const { token, hash } = generateActionToken()
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'pending',
        summary: 'Race test',
        payload: VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        actionTokenHash: hash,
      })
      .returning()

    const cookie = await loginAndGetCookie(app, adminDeps)

    const [adminRes, linkRes] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/admin/proposals/${row!.id}/approve`,
        headers: { ...FORM_HEADERS, cookie },
        payload: '',
      }),
      app.inject({ method: 'POST', url: `/a/${row!.id}/approve?t=${token}` }),
    ])

    expect([200, 303]).toContain(adminRes.statusCode)
    expect(linkRes.statusCode).toBe(200)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row!.id))
    expect(after!.status).toBe('approved')

    expect(enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('8. expired pending row -> 200 already handled or expired, flips to expired via system audit', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending({ expiresAt: new Date(Date.now() - 1000) })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Already handled or expired')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('expired')

    const auditRows = await auditRowsFor(row.id, 'proposal.expired')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('system')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'lazy-expiry' })

    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('9. malformed (non-UUID) proposalId on authed approve -> 200 generic error page, no 500, no SQL leak, alerted', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/proposals/not-a-uuid/approve',
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Something went wrong.')
    expect(res.body.toLowerCase()).not.toContain('select')
    expect(res.body.toLowerCase()).not.toContain('invalid input syntax')

    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledWith(
      'warning',
      'admin_route_error',
      expect.objectContaining({ proposalId: 'not-a-uuid' }),
    )

    await app.close()
  })

  it('10. malformed (non-UUID) proposalId on authed reject -> 200 generic error page, no 500, no SQL leak, alerted', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/proposals/not-a-uuid/reject',
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Something went wrong.')
    expect(res.body.toLowerCase()).not.toContain('select')
    expect(res.body.toLowerCase()).not.toContain('invalid input syntax')

    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledWith(
      'warning',
      'admin_route_error',
      expect.objectContaining({ proposalId: 'not-a-uuid' }),
    )

    await app.close()
  })

  // Item 1: enqueue failure after a committed approve must never strand the row with no way
  // forward — the transition already committed, so this must never un-approve, and the operator
  // must see an explicit signal (not the normal 303-to-detail a healthy approve gives).
  it('11. throwing enqueue on authed approve -> row STAYS approved, explicit re-send copy, critical alert, no 303', async () => {
    const deps = makeDeps({ enqueue: vi.fn(async () => { throw new Error('queue down') }) })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Approved, but queueing the apply FAILED')
    expect(res.body).toContain('Re-send')

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

  it('12. resend-apply on an approved row enqueues the exact Plan-A shape and audits proposal.apply_resent', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'approved',
        summary: 'Stranded approval',
        payload: VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        actionTokenHash: null,
        decidedBy: 'owner',
        decidedAt: new Date(),
      })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row!.id}/resend-apply`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/proposals/${row!.id}`)

    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'proposal.apply',
      { proposalId: row!.id },
      { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600, singletonKey: row!.id },
    )

    const auditRows = await auditRowsFor(row!.id, 'proposal.apply_resent')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('owner')

    await app.close()
  })

  it("13. resend-apply on an 'applied' row -> already-handled page, no enqueue", async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'applied',
        summary: 'Already applied',
        payload: VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        actionTokenHash: null,
        decidedBy: 'owner',
        decidedAt: new Date(),
        appliedAt: new Date(),
      })
      .returning()

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row!.id}/resend-apply`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Already handled.')

    expect(deps.enqueue).not.toHaveBeenCalled()

    const auditRows = await auditRowsFor(row!.id, 'proposal.apply_resent')
    expect(auditRows).toHaveLength(0)

    await app.close()
  })

  // -- Task 9: admin reject form — reason capture + re-draft dispatch (mirrors Task 8's public
  // /a/ route exactly — same resolveRejectAction dispatch, same atomic fallback) ------------------

  it('14. admin reject action=redraft on an awaiting_approval ticket re-arms it: triaged, feedback stored, count+1, session kept, proposal rejected, audited resolution:redraft', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ reason: 'please mention our 30-day return policy', action: 'redraft' }),
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/proposals/${row.id}`)

    const [proposalAfter] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(proposalAfter!.status).toBe('rejected')

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('triaged')
    expect(ticketAfter!.ownerRedraftFeedback).toBe('please mention our 30-day return policy')
    expect(ticketAfter!.redraftCount).toBe(1)
    // Redraft is a resume, not a fresh escalation — must not clobber the resumable session.
    expect(ticketAfter!.agentSessionId).toBe('sess-abc')

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: false, resolution: 'redraft' })

    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('15. admin reject action=escalate -> ticket escalated (terminal), audited resolution:escalate_terminal, notified silently', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ reason: 'not a good fit for this ticket', action: 'escalate' }),
    })

    expect(res.statusCode).toBe(303)

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')
    expect(ticketAfter!.escalationReason).toBe('owner_rejected_draft')
    expect(ticketAfter!.escalationNotifiedAt).not.toBeNull() // pre-stamped silent, same as today

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', resolution: 'escalate_terminal' })

    await app.close()
  })

  it('16. admin reject with no body at all -> also terminal escalate, as today (confirms the existing no-reason reject still escalates)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')
    expect(ticketAfter!.escalationReason).toBe('owner_rejected_draft')

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', resolution: 'escalate_terminal' })

    await app.close()
  })

  it('17. admin reject action=redraft when ticket is already at SUPPORT_REDRAFT_MAX -> escalates with redraft_limit_reached and PAGES (not silent)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    await db.update(supportTickets).set({ redraftCount: SUPPORT_REDRAFT_MAX }).where(eq(supportTickets.id, ticket.id))
    const row = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ reason: 'still not right', action: 'redraft' }),
    })

    expect(res.statusCode).toBe(303)

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')
    expect(ticketAfter!.escalationReason).toBe('redraft_limit_reached')
    expect(ticketAfter!.escalationNotifiedAt).toBeNull() // not pre-stamped -> the poller pages

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', resolution: 'escalate_limit' })

    await app.close()
  })

  it('18. admin reject with a reason over 2000 chars -> readable 400, no state change, token/status untouched', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedSupportProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)
    const longReason = 'x'.repeat(2001)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ reason: longReason, action: 'redraft' }),
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('too long')

    const [proposalAfter] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(proposalAfter!.status).toBe('pending')

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('awaiting_approval')
    expect(ticketAfter!.redraftCount).toBe(0)

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows).toHaveLength(0)

    await app.close()
  })

  it('19. admin reject of a non-support (new_listing) proposal is unaffected by the new dispatch: still a plain terminal reject, no resolution key', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedPending()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: formBody({ reason: 'irrelevant for sourcing', action: 'redraft' }),
    })

    expect(res.statusCode).toBe(303)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('rejected')

    const auditRows = await auditRowsFor(row.id, 'proposal.reject')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: false })
    expect(auditRows[0]!.detail).not.toHaveProperty('resolution')

    await app.close()
  })
})
