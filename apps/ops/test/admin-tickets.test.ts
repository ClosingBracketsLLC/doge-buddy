import { agentRuns, auditLog, createDb, orders, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
import { buildServer } from '../src/server.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

type TicketStatus = 'new' | 'triaged' | 'awaiting_approval' | 'waiting_on_customer' | 'resolved' | 'escalated'

describe('tickets view, thread, and guarded actions', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdTicketIds: string[] = []
  let createdOrderIds: string[] = []
  let createdProposalIds: string[] = []
  let createdRunIds: string[] = []

  afterEach(async () => {
    if (createdTicketIds.length > 0) {
      await db.delete(auditLog).where(and(eq(auditLog.entityType, 'support_ticket'), inArray(auditLog.entityId, createdTicketIds)))
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, createdTicketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
      createdTicketIds = []
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
      createdOrderIds = []
    }
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
    }
    if (createdRunIds.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds))
      createdRunIds = []
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

  // Same idiom as admin-orders.test.ts's own copy — factored per-file, not shared, per the task
  // brief's instruction not to modify existing test files.
  async function cleanupLoginSends(): Promise<void> {
    await db.delete(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
  }

  function extractToken(sentUrl: string): string {
    const m = sentUrl.match(/[?&]t=([^&]+)/)
    if (!m) throw new Error(`no token in ${sentUrl}`)
    return m[1]!
  }

  async function loginAndGetCookie(app: FastifyInstance, deps: TestDeps): Promise<string> {
    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const token = extractToken(deps.sent[deps.sent.length - 1]!.actions![0]!.url)

    const consumeRes = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    const setCookie = consumeRes.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)

    await cleanupLoginSends()
    return cookieHeader.split(';')[0]!
  }

  async function seedTicket(overrides: Partial<{
    status: TicketStatus
    subject: string | null
    customerEmail: string | null
    isSpam: boolean | null
    orderId: string | null
    claimedOrderNumber: string | null
    lastInboundAt: Date | null
    createdAt: Date
    category: string | null
    sentiment: string | null
    escalationReason: string | null
  }> = {}): Promise<typeof supportTickets.$inferSelect> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `test-thread-${crypto.randomUUID()}`,
        status: overrides.status ?? 'new',
        subject: overrides.subject ?? 'Where is my order',
        customerEmail: overrides.customerEmail ?? 'customer@example.com',
        isSpam: overrides.isSpam ?? null,
        orderId: overrides.orderId ?? null,
        claimedOrderNumber: overrides.claimedOrderNumber ?? null,
        // `??` would coerce an explicit `lastInboundAt: null` (a ticket that has never had an
        // inbound message — outbound-first, per ingest.ts's own comments) back into `new Date()`,
        // since `null` is nullish too. `'lastInboundAt' in overrides` distinguishes "not passed"
        // (default to now) from "passed as null" (leave it null).
        lastInboundAt: 'lastInboundAt' in overrides ? overrides.lastInboundAt : new Date(),
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
        category: overrides.category ?? null,
        sentiment: overrides.sentiment ?? null,
        escalationReason: overrides.escalationReason ?? null,
      })
      .returning()
    createdTicketIds.push(row!.id)
    return row!
  }

  async function seedMessage(
    ticketId: string,
    overrides: Partial<{ direction: 'inbound' | 'outbound'; bodyText: string | null; sentAt: Date }> = {},
  ): Promise<typeof supportMessages.$inferSelect> {
    const [row] = await db
      .insert(supportMessages)
      .values({
        ticketId,
        gmailMessageId: `test-msg-${crypto.randomUUID()}`,
        direction: overrides.direction ?? 'inbound',
        fromEmail: 'customer@example.com',
        bodyText: overrides.bodyText ?? 'Hello, help please.',
        sentAt: overrides.sentAt ?? new Date(),
      })
      .returning()
    return row!
  }

  async function seedOrder(overrides: Partial<{ shopifyOrderNumber: string; email: string }> = {}): Promise<typeof orders.$inferSelect> {
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        shopifyOrderNumber: overrides.shopifyOrderNumber ?? '1001',
        email: overrides.email ?? 'customer@example.com',
        isTest: false,
        totalCents: 4200,
      })
      .returning()
    createdOrderIds.push(row!.id)
    return row!
  }

  async function seedProposal(
    ticketId: string,
    overrides: Partial<{
      type: 'new_listing' | 'support_reply' | 'refund' | 'deprecate_product'
      status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
      summary: string
      createdAt: Date
    }> = {},
  ): Promise<typeof proposals.$inferSelect> {
    const type = overrides.type ?? 'support_reply'
    const [row] = await db
      .insert(proposals)
      .values({
        type,
        status: overrides.status ?? 'pending',
        summary: overrides.summary ?? 'Test proposal summary',
        payload: { type },
        sourceWorkflow: 'test',
        ticketId,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  async function seedAgentRun(
    overrides: Partial<{
      workflow: string
      triggerRef: string | null
      status: 'running' | 'succeeded' | 'failed' | 'aborted'
      startedAt: Date
    }> = {},
  ): Promise<typeof agentRuns.$inferSelect> {
    const [row] = await db
      .insert(agentRuns)
      .values({
        workflow: overrides.workflow ?? 'support',
        triggerRef: 'triggerRef' in overrides ? overrides.triggerRef! : null,
        status: overrides.status ?? 'succeeded',
        ...(overrides.startedAt ? { startedAt: overrides.startedAt } : {}),
      })
      .returning()
    createdRunIds.push(row!.id)
    return row!
  }

  it('1. unauthenticated GET /admin/tickets -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/tickets' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. unauthenticated GET /admin/tickets/:id -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/tickets/00000000-0000-0000-0000-000000000000' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('3. unauthenticated POST /admin/tickets/:id/escalate -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tickets/00000000-0000-0000-0000-000000000000/escalate',
      headers: FORM_HEADERS,
      payload: 'expectedStatus=new',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('4. list: an escalated ticket renders pinned above newer non-escalated tickets', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const now = Date.now()
    const escalated = await seedTicket({ status: 'escalated', lastInboundAt: new Date(now - 100_000) })
    const newer = await seedTicket({ status: 'new', lastInboundAt: new Date(now) })
    const older = await seedTicket({ status: 'new', lastInboundAt: new Date(now - 50_000) })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    const escalatedIdx = res.body.indexOf(escalated.id)
    const newerIdx = res.body.indexOf(newer.id)
    const olderIdx = res.body.indexOf(older.id)
    expect(escalatedIdx).toBeGreaterThanOrEqual(0)
    expect(newerIdx).toBeGreaterThanOrEqual(0)
    expect(olderIdx).toBeGreaterThanOrEqual(0)
    // Escalated pinned first, then last_inbound_at DESC among the rest.
    expect(escalatedIdx).toBeLessThan(newerIdx)
    expect(newerIdx).toBeLessThan(olderIdx)

    await app.close()
  })

  it('4b. list: a NULL last_inbound_at ticket (never had an inbound message) sorts LAST among its status bucket, by its createdAt fallback — not first via Postgres\'s NULLS FIRST default for DESC', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const now = Date.now()
    // Same status bucket for all three (no escalated pinning in play) so this isolates the
    // last_inbound_at ordering itself. The NULL ticket's createdAt is set far in the past — if
    // the ordering correctly falls back to createdAt for a NULL last_inbound_at (matching the
    // display fallback in render-tickets.ts), it sorts LAST, behind both dated tickets. Under the
    // bug (bare `desc(lastInboundAt)`, Postgres's NULLS FIRST default for DESC), it would
    // wrongly sort FIRST instead.
    const nullOld = await seedTicket({
      status: 'new',
      lastInboundAt: null,
      createdAt: new Date(now - 300_000),
    })
    const recentContact = await seedTicket({ status: 'new', lastInboundAt: new Date(now) })
    const olderContact = await seedTicket({ status: 'new', lastInboundAt: new Date(now - 100_000) })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    const nullIdx = res.body.indexOf(nullOld.id)
    const recentIdx = res.body.indexOf(recentContact.id)
    const olderIdx = res.body.indexOf(olderContact.id)
    expect(nullIdx).toBeGreaterThanOrEqual(0)
    expect(recentIdx).toBeGreaterThanOrEqual(0)
    expect(olderIdx).toBeGreaterThanOrEqual(0)
    expect(recentIdx).toBeLessThan(olderIdx)
    expect(olderIdx).toBeLessThan(nullIdx)

    await app.close()
  })

  it('5. ?status= filter shows only matching-status tickets', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const triaged = await seedTicket({ status: 'triaged' })
    const waiting = await seedTicket({ status: 'waiting_on_customer' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets?status=triaged', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(triaged.id)
    expect(res.body).not.toContain(waiting.id)

    await app.close()
  })

  it('6. ?status=spam maps to is_spam=true, not the literal status column', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const spam = await seedTicket({ status: 'resolved', isSpam: true })
    const resolvedNotSpam = await seedTicket({ status: 'resolved', isSpam: false })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets?status=spam', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(spam.id)
    expect(res.body).not.toContain(resolvedNotSpam.id)

    await app.close()
  })

  it('7. XSS: a ticket with a <script> subject renders escaped in the list, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const hostile = await seedTicket({ subject: '<script>alert(1)</script>' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(hostile.id)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')

    await app.close()
  })

  it('8. XSS: a hostile message body renders escaped in the thread view, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket({ subject: '<script>alert(1)</script>' })
    await seedMessage(ticket.id, { bodyText: '<img onerror=x>' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).toContain('&lt;img onerror=x&gt;')
    expect(res.body).not.toContain('<img onerror=x>')

    await app.close()
  })

  it('9. thread view shows messages chronologically and a claimed-unverified order marker', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket({ claimedOrderNumber: '4242' })
    const first = await seedMessage(ticket.id, { bodyText: 'first message', sentAt: new Date(Date.now() - 60_000) })
    const second = await seedMessage(ticket.id, { bodyText: 'second message', sentAt: new Date() })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('first message')
    expect(res.body).toContain('second message')
    expect(res.body.indexOf('first message')).toBeLessThan(res.body.indexOf('second message'))
    expect(res.body).toContain('claimed #4242 (unverified)')
    void first
    void second

    await app.close()
  })

  it('10. thread view for a verified linked order shows the order summary, not the unverified marker', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder({ shopifyOrderNumber: '5555' })
    const ticket = await seedTicket({ orderId: order.id })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('5555')
    expect(res.body).not.toContain('(unverified)')

    await app.close()
  })

  it('11. escalate POST flips status and audits owner/support.ticket_escalated', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket({ status: 'new' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tickets/${ticket.id}/escalate`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'expectedStatus=new',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/tickets/${ticket.id}`)

    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(after!.status).toBe('escalated')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'support_ticket'), eq(auditLog.entityId, ticket.id)))
    const match = auditRows.find((r) => r.action === 'support.ticket_escalated')
    expect(match).toBeDefined()
    expect(match!.actor).toBe('owner')

    await app.close()
  })

  it('12. resolve POST flips status and audits owner/support.ticket_resolved', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket({ status: 'triaged' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tickets/${ticket.id}/resolve`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'expectedStatus=triaged',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/tickets/${ticket.id}`)

    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(after!.status).toBe('resolved')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'support_ticket'), eq(auditLog.entityId, ticket.id)))
    const match = auditRows.find((r) => r.action === 'support.ticket_resolved')
    expect(match).toBeDefined()
    expect(match!.actor).toBe('owner')

    await app.close()
  })

  it('13. resolve POST with a stale expectedStatus (row already resolved by someone else) no-ops and still redirects', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    // Simulates: the thread view was rendered while the ticket was 'escalated', but by the time
    // the owner submits Resolve, some other writer (triage, a second admin tab) already resolved
    // it. The form still carries the page's original 'escalated' as expectedStatus.
    const ticket = await seedTicket({ status: 'resolved' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tickets/${ticket.id}/resolve`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'expectedStatus=escalated',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/admin/tickets/${ticket.id}`)

    const [after] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(after!.status).toBe('resolved') // unchanged

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'support_ticket'), eq(auditLog.entityId, ticket.id)))
    expect(auditRows.find((r) => r.action === 'support.ticket_resolved')).toBeUndefined()

    await app.close()
  })

  it('14. thread view lists the ticket\'s support proposals newest-first, id-linked, with type/status/summary', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const older = await seedProposal(ticket.id, {
      type: 'refund',
      status: 'pending',
      summary: 'Refund for damaged item',
      createdAt: new Date(Date.now() - 60_000),
    })
    const newer = await seedProposal(ticket.id, {
      type: 'support_reply',
      status: 'approved',
      summary: 'Reply draft to customer',
      createdAt: new Date(),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`/admin/proposals/${older.id}`)
    expect(res.body).toContain(`/admin/proposals/${newer.id}`)
    expect(res.body).toContain('refund')
    expect(res.body).toContain('support_reply')
    expect(res.body).toContain('Refund for damaged item')
    expect(res.body).toContain('Reply draft to customer')
    // newest proposal (by createdAt) renders first
    expect(res.body.indexOf(newer.id)).toBeLessThan(res.body.indexOf(older.id))

    await app.close()
  })

  it('15. XSS: a proposal summary containing <script> in the ticket thread renders escaped, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const hostile = await seedProposal(ticket.id, { summary: '<script>alert(1)</script>' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`/admin/proposals/${hostile.id}`)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')

    await app.close()
  })

  it('16. thread view lists up to 5 support-workflow agent_runs for this ticket, newest first, id-linked to /admin/runs/:id — filtered by workflow and trigger_ref', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const otherTicket = await seedTicket()
    const older = await seedAgentRun({
      workflow: 'support',
      triggerRef: ticket.id,
      status: 'failed',
      startedAt: new Date(Date.now() - 120_000),
    })
    const newer = await seedAgentRun({
      workflow: 'support',
      triggerRef: ticket.id,
      status: 'succeeded',
      startedAt: new Date(),
    })
    const wrongWorkflow = await seedAgentRun({ workflow: 'sourcing', triggerRef: ticket.id, status: 'succeeded' })
    const wrongTicket = await seedAgentRun({ workflow: 'support', triggerRef: otherTicket.id, status: 'succeeded' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`/admin/runs/${newer.id}`)
    expect(res.body).toContain(`/admin/runs/${older.id}`)
    expect(res.body).not.toContain(wrongWorkflow.id)
    expect(res.body).not.toContain(wrongTicket.id)
    // newest run (by startedAt) renders first
    expect(res.body.indexOf(newer.id)).toBeLessThan(res.body.indexOf(older.id))

    await app.close()
  })

  it('17. thread view with no proposals and no agent runs shows both empty states', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/tickets/${ticket.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No proposals.')
    expect(res.body).toContain('No agent runs.')

    await app.close()
  })
})
