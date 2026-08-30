import { auditLog, createDb, orders, products, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
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
      priceCents: 2999,
      supplierCostCents: 500,
      supplier: 'mock' as const,
      supplierProductId: 'p1',
      supplierVariantId: 'v1',
    },
  ],
}

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('proposals queue + detail pages', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProposalIds: string[] = []
  let createdTicketIds: string[] = []
  let createdOrderIds: string[] = []
  let createdProductIds: string[] = []

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
    }
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
    if (createdProductIds.length > 0) {
      await db.delete(products).where(inArray(products.id, createdProductIds))
      createdProductIds = []
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

  // Same idiom as admin-decisions.test.ts's own copy — factored per-file, not shared, per the
  // task brief's instruction not to modify that file.
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

  async function seedProposal(
    overrides: Partial<{
      type: 'new_listing' | 'support_reply' | 'refund' | 'deprecate_product'
      status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
      summary: string
      payload: unknown
      expiresAt: Date
      ticketId: string
      orderId: string
      productId: string
    }> = {},
  ) {
    const [row] = await db
      .insert(proposals)
      .values({
        type: overrides.type ?? 'new_listing',
        status: overrides.status ?? 'pending',
        summary: overrides.summary ?? `Test proposal ${crypto.randomUUID()}`,
        payload: overrides.payload ?? VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        ticketId: overrides.ticketId,
        orderId: overrides.orderId,
        productId: overrides.productId,
        ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  // -- Task 18: support_reply/refund fixtures --------------------------------------------------

  async function seedTicket(overrides: Partial<{ subject: string; customerEmail: string }> = {}) {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `t18-${crypto.randomUUID()}`,
        customerEmail: overrides.customerEmail ?? 'buyer@example.com',
        subject: overrides.subject ?? 'Where is my order',
        status: 'awaiting_approval',
      })
      .returning()
    createdTicketIds.push(ticket!.id)
    return ticket!
  }

  async function seedOrder(number = '#4001', totalCents?: number) {
    const [order] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        shopifyOrderNumber: number,
        isTest: true,
        ...(totalCents !== undefined ? { totalCents } : {}),
      })
      .returning()
    createdOrderIds.push(order!.id)
    return order!
  }

  /** A dmarc=pass-authenticated inbound message on the ticket — `validateRefundIntent`'s
   * sender-authentication check needs one before it will ever reach the accumulation bound. */
  async function seedAuthenticatedInbound(ticketId: string): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: `t18-msg-${crypto.randomUUID()}`,
      direction: 'inbound',
      fromEmail: 'buyer@example.com',
      bodyText: 'please refund me',
      authResults: 'dkim=pass; dmarc=pass; spf=pass',
      sentAt: new Date(),
    })
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

  // -- Task 11 (scoring): deprecate_product fixtures --------------------------------------------

  async function seedProduct(title = 'Squeaky Dead Widget') {
    const [product] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
        handle: `h-${crypto.randomUUID()}`,
        title,
        status: 'active',
      })
      .returning()
    createdProductIds.push(product!.id)
    return product!
  }

  function deprecateProductPayload(
    productId: string,
    overrides: Partial<{ unitsSold28d: number; refundCount28d: number; ticketCount28d: number; daysLive: number; reasoning: string }> = {},
  ) {
    return {
      type: 'deprecate_product' as const,
      productId,
      evidence: {
        unitsSold28d: overrides.unitsSold28d ?? 2,
        refundCount28d: overrides.refundCount28d ?? 1,
        ticketCount28d: overrides.ticketCount28d ?? 3,
        daysLive: overrides.daysLive ?? 45,
        reasoning: overrides.reasoning ?? 'low sales, high refund/ticket load',
      },
    }
  }

  it('1. unauthenticated GET /admin/proposals -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/proposals' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. list shows a seeded pending row\'s summary, escaped', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal({ summary: '<Widget> "X"' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/proposals', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(row.id)
    expect(res.body).toContain('&lt;Widget&gt; &quot;X&quot;')
    expect(res.body).not.toContain('<Widget>')

    await app.close()
  })

  it('3. ?status=pending filter excludes an applied row', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const pendingRow = await seedProposal({ status: 'pending' })
    const appliedRow = await seedProposal({ status: 'applied' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/proposals?status=pending', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(pendingRow.id)
    expect(res.body).not.toContain(appliedRow.id)

    await app.close()
  })

  it('4. pending-past-expiry row renders as expired after list load, and DB row flips with admin-load audit', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal({ expiresAt: new Date(Date.now() - 1000) })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/proposals', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(row.id)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('expired')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, 'proposal.expired')))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.actor).toBe('system')
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin-load' })

    await app.close()
  })

  it('5. detail for a pending new_listing shows title, formatted price, an escaped <img>, and the three decision forms', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal()
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Squeaky Widget')
    expect(res.body).toContain('$29.99')
    expect(res.body).toContain('<img src="https://example.com/a.png">')

    expect(res.body).toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/reject"`)
    expect(res.body).toContain('name="payload"')
    const approveFormCount = res.body.split(`action="/admin/proposals/${row.id}/approve"`).length - 1
    expect(approveFormCount).toBe(2) // plain approve + edit-then-approve

    await app.close()
  })

  it('6. detail for an applied row shows no decision or resend forms (only the layout\'s own logout form)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal({ status: 'applied' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    // Item 4 adds one always-present logout form to every authed page's nav, so this can no
    // longer assert zero `<form` tags on the page — it asserts the proposal itself offers none.
    expect(res.body).not.toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).not.toContain(`action="/admin/proposals/${row.id}/reject"`)
    expect(res.body).not.toContain(`action="/admin/proposals/${row.id}/resend-apply"`)
    expect(res.body).not.toContain('name="payload"')

    await app.close()
  })

  it('6b. detail for an approved row shows exactly one resend-apply form, not the pending decision forms', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal({ status: 'approved' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/resend-apply"`)
    expect(res.body).not.toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).not.toContain(`action="/admin/proposals/${row.id}/reject"`)
    const resendFormCount = res.body.split(`action="/admin/proposals/${row.id}/resend-apply"`).length - 1
    expect(resendFormCount).toBe(1)

    await app.close()
  })

  it('7. detail for a hostile payload title contains no unescaped <img onerror sequence', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const hostilePayload = { ...VALID_NEW_LISTING_PAYLOAD, title: '<img onerror=x>' }
    const row = await seedProposal({ payload: hostilePayload })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<img onerror=x>')
    expect(res.body).toContain('&lt;img onerror=x&gt;')

    await app.close()
  })

  // Task 15: the "Description (as it will appear)" section. A descriptionHtml that passes the
  // Task 6 allowlist (validateDescriptionHtml re-run at render time) renders raw — an approver
  // needs to see real formatting, not escaped tag soup.
  it('8. a valid allowlisted descriptionHtml renders its <strong> tag RAW', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const payload = { ...VALID_NEW_LISTING_PAYLOAD, descriptionHtml: '<p>A <strong>fine</strong> widget.</p>' }
    const row = await seedProposal({ payload })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Description (as it will appear)')
    expect(res.body).toContain('<strong>fine</strong>')

    await app.close()
  })

  // THE REGRESSION ASSERTION: a descriptionHtml that does NOT pass the allowlist (e.g. a
  // Phase-4-era proposal that never validated at submit, or an outright <script> injection) must
  // NEVER reach raw() — it renders escaped, inside a <pre>, with a visible failure note. This is
  // the only new raw() call this task adds, and re-validating here at render time is what keeps
  // it unreachable for anything the allowlist wouldn't pass.
  it('9. a <script> descriptionHtml renders ESCAPED with the failed-validation note, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const payload = { ...VALID_NEW_LISTING_PAYLOAD, descriptionHtml: '<script>alert(document.cookie)</script>' }
    const row = await seedProposal({ payload })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('failed HTML validation — showing source')
    expect(res.body).toContain('&lt;script&gt;')
    expect(res.body).not.toContain('<script>alert(document.cookie)</script>')

    await app.close()
  })

  // -- Task 18: per-type rendering, §3 validator on approve, silent reject-escalation -----------

  it('10. support_reply pending detail: XSS body renders escaped, and the raw-JSON payload textarea is ABSENT (body textarea present instead)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, '<script>alert(1)</script>'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).not.toContain('name="payload"')
    expect(res.body).toContain('name="body"')
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/reject"`)

    await app.close()
  })

  it('11. refund pending detail: human summary (amount, order #, reason, dispute flag) and NO edit form of any kind', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder('#4077')
    const row = await seedProposal({
      type: 'refund',
      orderId: order.id,
      payload: refundPayload(order.id, { amountCents: 2500, reason: 'wrong size', openCjDispute: true }),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('$25.00')
    expect(res.body).toContain('#4077')
    expect(res.body).toContain('wrong size')
    expect(res.body).toContain('CJ dispute: yes')
    expect(res.body).not.toContain('name="payload"')
    expect(res.body).not.toContain('name="body"')
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/reject"`)

    await app.close()
  })

  // Task 16 note (ruling 7): the refund detail page surfaces the `proposal.refund_issued` audit
  // row when present — it exists exactly when money moved, so this must render regardless of the
  // proposal's current status.
  it('12. refund detail surfaces a proposal.refund_issued audit row when present', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder('#4088')
    const row = await seedProposal({
      type: 'refund',
      status: 'applied',
      orderId: order.id,
      payload: refundPayload(order.id),
    })
    await db.insert(auditLog).values({
      actor: 'system',
      action: 'proposal.refund_issued',
      entityType: 'proposal',
      entityId: row.id,
      detail: { refundId: 'gid://shopify/Refund/555', amountCents: 1500, orderGid: order.shopifyOrderGid },
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('refund WAS issued')
    expect(res.body).toContain('gid://shopify/Refund/555')

    await app.close()
  })

  it('13. body-edit approve of support_reply with an off-domain URL -> 400 naming url_not_allowed, proposal stays pending', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'Original body.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: new URLSearchParams({ body: 'Check this out: https://evil.example.com/track' }).toString(),
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('url_not_allowed')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })

  // Covers the §5 bypass: a promised-refund reply that was legitimate when drafted (a live sibling
  // refund proposal backed it) must be re-screened at approve time, not trusted from submit time —
  // if the sibling has since been rejected, the promise is no longer backed by anything.
  it('14. unedited approve of a support_reply whose sibling refund was meanwhile rejected -> 400 promised_action, proposal stays pending', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const order = await seedOrder()
    await seedProposal({ type: 'refund', status: 'rejected', ticketId: ticket.id, orderId: order.id, payload: refundPayload(order.id) })
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'Good news — your refund has been issued and is on its way.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('promised_action')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })

  it('15. valid body-edit approve of support_reply: 303, payload body updated to the normalized edited text, audited edited:true', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'Original body.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: new URLSearchParams({ body: 'Edited reply text, safe and plain.' }).toString(),
    })

    expect(res.statusCode).toBe(303)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect((after!.payload as { body: string }).body).toBe('Edited reply text, safe and plain.')
    expect((after!.payload as { ticketId: string }).ticketId).toBe(ticket.id)

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, 'proposal.approve')))
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: true })

    await app.close()
  })

  it('16. unedited approve of a clean support_reply: 303, approved, audited edited:false (validator pass does not count as an edit)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'A perfectly ordinary reply.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, 'proposal.approve')))
    expect(auditRows[0]!.detail).toMatchObject({ via: 'admin', edited: false })

    await app.close()
  })

  it('17. admin reject of a refund: sibling pending support_reply expires, ticket escalates silently (stamp set), agentSessionId cleared', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    await db.update(supportTickets).set({ agentSessionId: 'sess-123' }).where(eq(supportTickets.id, ticket.id))
    const order = await seedOrder()
    const refundRow = await seedProposal({ type: 'refund', ticketId: ticket.id, orderId: order.id, payload: refundPayload(order.id) })
    const replyRow = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${refundRow.id}/reject`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)

    const [refundAfter] = await db.select().from(proposals).where(eq(proposals.id, refundRow.id))
    expect(refundAfter!.status).toBe('rejected')

    const [replyAfter] = await db.select().from(proposals).where(eq(proposals.id, replyRow.id))
    expect(replyAfter!.status).toBe('expired')

    const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
    expect(ticketAfter!.status).toBe('escalated')
    expect(ticketAfter!.escalationReason).toBe('owner_rejected_draft')
    expect(ticketAfter!.escalationNotifiedAt).not.toBeNull()
    expect(ticketAfter!.agentSessionId).toBeNull()

    const siblingAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, replyRow.id), eq(auditLog.action, 'proposal.sibling_rejected')))
    expect(siblingAudit).toHaveLength(1)

    await app.close()
  })

  // -- Fix round 1 (Task 18 review) ---------------------------------------------------------------

  // CRITICAL 1: the accumulation bound must not count the row being approved against its own
  // total — before the fix, `pending` (the row's own status while approving) was itself one of the
  // LIVE statuses summed, so a 100%-of-total refund always failed `refund_exceeds_total` (reported
  // remaining as 0 on a $50-on-$50 refund).
  it('18. approve of a 100%-of-total refund succeeds: the row being approved is excluded from its own accumulation bound', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    await seedAuthenticatedInbound(ticket.id)
    const order = await seedOrder('#4200', 5000)
    const row = await seedProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id, { amountCents: 5000 }),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(303)
    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(deps.enqueue).toHaveBeenCalledTimes(1)

    await app.close()
  })

  // The self-exclusion must be exactly that — self only. A GENUINE second live refund proposal on
  // the same order still counts against the bound.
  it('19. approve of a refund still blocks on a GENUINE prior live refund proposal on the same order (exclusion is only of self)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    await seedAuthenticatedInbound(ticket.id)
    const order = await seedOrder('#4201', 5000)
    // A genuine, DIFFERENT, already-approved refund proposal on the same order — 1000c live.
    await seedProposal({
      type: 'refund',
      status: 'approved',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id, { amountCents: 1000 }),
    })
    const row = await seedProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id, { amountCents: 4500 }), // 1000 + 4500 > 5000
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('refund_exceeds_total')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })

  // IMPORTANT 2: a refund proposal with a null ticketId must fail with a readable validation
  // code, not `''` coerced into a uuid comparison (which made Postgres throw and rendered a
  // misleading "already handled" page instead of a diagnosable error).
  it('20. approve of a refund with a null ticketId -> 400 refund_unverified_order (readable error, not "already handled"), stays pending', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const row = await seedProposal({
      type: 'refund',
      orderId: order.id,
      payload: refundPayload(order.id),
      // ticketId deliberately omitted -> NULL
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/proposals/${row.id}/approve`,
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('refund_unverified_order')
    expect(res.body).not.toContain('Already handled')

    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })

  // Task 11 (scoring): deprecate_product currently falls through renderDecisionForms' generic
  // branch, which exposes a raw-JSON `payload` textarea — wrong for a proposal type whose only
  // sane owner actions are approve/reject. This proves the detail page renders the evidence +
  // product, offers approve/reject only, and has NO editable payload textarea.
  it('21. deprecate_product pending detail: evidence + product render, approve/reject only, NO raw-JSON payload textarea', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const product = await seedProduct('Squeaky Dead Widget')
    const row = await seedProposal({
      type: 'deprecate_product',
      productId: product.id,
      payload: deprecateProductPayload(product.id, {
        unitsSold28d: 2,
        refundCount28d: 1,
        ticketCount28d: 3,
        daysLive: 45,
        reasoning: 'low sales, high refund/ticket load',
      }),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Squeaky Dead Widget')
    expect(res.body).toContain(product.id)
    expect(res.body).toContain('2') // unitsSold28d
    expect(res.body).toContain('45') // daysLive
    expect(res.body).toContain('low sales, high refund/ticket load')

    expect(res.body).toContain(`action="/admin/proposals/${row.id}/approve"`)
    expect(res.body).toContain(`action="/admin/proposals/${row.id}/reject"`)
    expect(res.body).not.toContain('name="payload"')
    expect(res.body).not.toContain('name="body"')
    const approveFormCount = res.body.split(`action="/admin/proposals/${row.id}/approve"`).length - 1
    expect(approveFormCount).toBe(1) // plain approve only — no edit-then-approve form

    await app.close()
  })

  it('22. deprecate_product XSS: a <script> reasoning renders escaped, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const product = await seedProduct()
    const row = await seedProposal({
      type: 'deprecate_product',
      productId: product.id,
      payload: deprecateProductPayload(product.id, { reasoning: '<script>alert(1)</script>' }),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')

    await app.close()
  })

  // -- Task 9: admin reject reason form + redraftCount threading ---------------------------------
  // `loadProposalDetailExtras` now also fetches the linked ticket's redraftCount (for BOTH
  // support_reply and refund — it used to return `{}` for support_reply entirely) so the reject
  // form can gate its redraft button the same way the public /a/ route already does.

  it('23. support_reply pending detail: reject form has the reason textarea + redraft/escalate buttons', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<textarea name="reason"')
    expect(res.body).toContain('name="action" value="redraft"')
    expect(res.body).toContain('name="action" value="escalate"')

    await app.close()
  })

  it('24. refund pending detail: reject form ALSO has the reason textarea + redraft/escalate buttons', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    const order = await seedOrder('#4300')
    const row = await seedProposal({
      type: 'refund',
      ticketId: ticket.id,
      orderId: order.id,
      payload: refundPayload(order.id),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<textarea name="reason"')
    expect(res.body).toContain('name="action" value="redraft"')
    expect(res.body).toContain('name="action" value="escalate"')

    await app.close()
  })

  it('25. deprecate_product pending detail: reject form stays a plain single button — no reason box (no ticket to redraft against)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const product = await seedProduct()
    const row = await seedProposal({
      type: 'deprecate_product',
      productId: product.id,
      payload: deprecateProductPayload(product.id),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<textarea name="reason"')
    expect(res.body).not.toContain('name="action" value="redraft"')
    expect(res.body).toContain('<button type="submit">Reject</button>')

    await app.close()
  })

  it('26. support_reply detail at SUPPORT_REDRAFT_MAX: the redraft button is gone (escalate-only), textarea stays', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const ticket = await seedTicket()
    await db.update(supportTickets).set({ redraftCount: SUPPORT_REDRAFT_MAX }).where(eq(supportTickets.id, ticket.id))
    const row = await seedProposal({
      type: 'support_reply',
      ticketId: ticket.id,
      payload: supportReplyPayload(ticket.id, 'We will follow up shortly.'),
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<textarea name="reason"')
    expect(res.body).not.toContain('name="action" value="redraft"')
    expect(res.body).toContain('name="action" value="escalate"')

    await app.close()
  })
})
