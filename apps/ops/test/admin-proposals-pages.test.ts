import { auditLog, createDb, orders, products, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { renderProposalDetail, type ProposalRow } from '../src/http/admin/render-proposal.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
import { SUPPORT_REDRAFT_MAX } from '../src/support/redraft.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

// Same shape as `validContext` in packages/core/test/proposals.test.ts — Task 2's schema fixture,
// reused here for Task 12's render tests.
const VALID_DECISION_CONTEXT = {
  version: 1,
  economics: {
    freight: { priceCents: 649, name: 'USPS Ground', minDays: 3, maxDays: 7 },
    variants: [{ sku: 'DB-1', priceCents: 2399, supplierCostCents: 612, landedCents: 1261, profitCents: 1138, marginBps: 4743 }],
    market: { query: 'dog water bottle', offerCount: 12, medianCents: 2199, typicalCents: 2399, ceilingCents: 2858, maxPriceToMarketBps: 13000 },
    usStockUnits: 214,
  },
  demand: {
    cjListedCount: 1200,
    cjReviews: { page1Count: 10, ratedCount: 8, avgRating: 4.6 },
    marketOfferCount: 12,
    trends: { keyword: 'dog leash', score: 62.1, momentum: 8 },
    amazon: { query: 'dog water bottle', resultsSampled: 10, medianPriceCents: 2199, medianReviews: 3400, totalReviews: 54000 },
  },
}

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
    // Task 4: responsive table cell — free-text summary wraps.
    expect(res.body).toContain('<td data-label="Summary" class="wrap">')
    // Fix round: the filter chip row exists and defaults to the 'all' chip active.
    expect(res.body).toContain('<nav class="chips" id="proposal-filters">')
    expect(res.body).toMatch(/<a href="\/admin\/proposals" aria-current="page">all<\/a>/)

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
    // Task 4: sticky actions bar + confirm-before-approve + primary approve button.
    expect(res.body).toContain('<div class="actions sticky">')
    expect(res.body).toContain('data-confirm="Approve this proposal?"')
    expect(res.body).toContain('<button type="submit" class="primary">Approve</button>')

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

  // Fix round 1 (Task 9 review, Important): `renderRejectForm`'s gate must match `actions.ts`'s
  // `handleGet` exactly — that public route additionally requires `row.ticketId !== null` before
  // rendering the reason form (no ticket, no redraft target). A support_reply/refund proposal with
  // a null ticketId is currently unreachable in practice (submit.ts always supplies a real
  // ticketId), so this is a render-level unit test (no DB, no HTTP) rather than a fixture-seeded
  // one: it calls `renderProposalDetail` directly against a synthetic row to prove the two
  // surfaces' gating logic stays identical even for a case the DB can't currently produce.
  function syntheticProposalRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
    const now = new Date()
    return {
      id: crypto.randomUUID(),
      type: 'support_reply',
      status: 'pending',
      summary: 'Synthetic test proposal',
      payload: supportReplyPayload('ignored-ticket-id', 'We will follow up shortly.'),
      decisionContext: null,
      sourceWorkflow: 'test',
      agentRunId: null,
      ticketId: null,
      productId: null,
      orderId: null,
      autoApproved: false,
      decidedBy: null,
      decidedAt: null,
      appliedAt: null,
      applyError: null,
      actionTokenHash: null,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  it('27. render-level: a support_reply proposal with a NULL ticketId falls back to the plain reject form — parity with actions.ts\'s handleGet gate', () => {
    const row = syntheticProposalRow({ type: 'support_reply', ticketId: null })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('<textarea name="reason"')
    expect(rendered).not.toContain('name="action" value="redraft"')
    expect(rendered).not.toContain('name="action" value="escalate"')
    expect(rendered).toContain('<button type="submit">Reject</button>')
  })

  it('28. render-level: a refund proposal with a NULL ticketId also falls back to the plain reject form', () => {
    const row = syntheticProposalRow({
      type: 'refund',
      ticketId: null,
      payload: refundPayload('ignored-order-id'),
    })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('<textarea name="reason"')
    expect(rendered).not.toContain('name="action" value="redraft"')
    expect(rendered).toContain('<button type="submit">Reject</button>')
  })

  // Task 4b: the human gate must see highlights/specs/whatsInBox before approving — otherwise
  // agent-authored page copy goes live sight-unseen. Render-level (no DB, no HTTP), same idiom as
  // tests 27/28: a synthetic new_listing row proves renderNewListingPreview's new sections escape
  // payload data exactly like every other interpolation in this file (never a live tag from
  // payload-controlled strings).
  it('29. render-level: a new_listing payload with highlights/specs/whatsInBox renders all three, escaped', () => {
    // status: 'rejected' (not 'pending') so renderDecisionForms's raw-JSON edit-payload textarea
    // is absent — it would otherwise also contain the (escaped) payload JSON and mask whether the
    // preview section itself renders anything.
    const row = syntheticProposalRow({
      type: 'new_listing',
      status: 'rejected',
      payload: {
        ...VALID_NEW_LISTING_PAYLOAD,
        highlights: ['Durable rope core', '<b>bold</b> bullet', 'Non-slip grip'],
        specs: [{ label: 'Material', value: 'Cotton & steel' }],
        whatsInBox: '1x rope toy',
      },
    })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('name="payload"') // sanity: the JSON edit-textarea isn't present to skew the assertions below

    expect(rendered).toContain('Durable rope core')
    expect(rendered).toContain('Material')
    expect(rendered).toContain('Cotton &amp; steel')
    expect(rendered).toContain('1x rope toy')
    expect(rendered).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(rendered).not.toContain('<b>bold</b>')
  })

  it('30. render-level: a legacy new_listing payload without highlights/specs/whatsInBox renders unchanged (no empty headings)', () => {
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('<h3>Highlights</h3>')
    expect(rendered).not.toContain('<h3>Specs</h3>')
    expect(rendered).not.toContain("What's in the box")
  })

  // Whole-branch review (Finding 3): a variant image reaching the live page unseen on a
  // non-Stage-6 (admin-edited) path is the same blind-spot shape as 29/30 above, one field later
  // — the variants table showed sku/price/cost but never `variants[].imageUrl`.
  it('31. render-level: a new_listing payload variant WITH imageUrl shows it in the variants table', () => {
    const row = syntheticProposalRow({
      type: 'new_listing',
      status: 'rejected',
      payload: {
        ...VALID_NEW_LISTING_PAYLOAD,
        variants: [{ ...VALID_NEW_LISTING_PAYLOAD.variants[0], imageUrl: 'https://cdn.example.com/variant-1.jpg' }],
      },
    })

    const rendered = renderProposalDetail(row).value

    expect(rendered).toContain('<img src="https://cdn.example.com/variant-1.jpg">')
  })

  it('32. render-level: a new_listing payload variant WITHOUT imageUrl stays clean (no broken <img>, no empty src)', () => {
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('<img src="">')
    // sanity: the top-of-section imageUrls gallery still renders its one <img> — this assertion
    // is specifically about the variants-table cell, not the gallery above it
    expect((rendered.match(/<img /g) ?? []).length).toBe(1)
  })

  // -- Task 12: "Decision numbers" section on new_listing proposals ------------------------------
  // Render-level (no DB, no HTTP), same idiom as 27-32: a synthetic new_listing row with
  // decisionContext set. `status: 'rejected'` keeps the raw-JSON edit-payload textarea out of the
  // way (per 29's own note) so it can't accidentally satisfy an assertion on its own.

  it('33. render-level: valid decision_context renders the Decision numbers section with formatted economics + demand estimates', () => {
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD, decisionContext: VALID_DECISION_CONTEXT })

    const rendered = renderProposalDetail(row).value

    expect(rendered).toContain('Decision numbers (as computed at submit)') // caption: owner can edit the payload before approving
    expect(rendered).toContain('Demand signals — ESTIMATES, not sales')
    expect(rendered).toContain('$12.61') // landed for variant DB-1 (1261)
    expect(rendered).toContain('47.4%') // 4743 bps
    expect(rendered).toContain('×1.09') // 2399/2199 typical/median ratio, 2dp
    expect(rendered).toContain('~3400 reviews') // amazon.medianReviews
  })

  it('34. render-level: decision_context null renders identically to today (no Decision numbers section)', () => {
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD, decisionContext: null })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('Decision numbers')
  })

  it('35. render-level: an unparseable decision_context is omitted (section absent) rather than crashing the page', () => {
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD, decisionContext: { version: 99 } })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('Decision numbers')
    expect(rendered).toContain('Squeaky Widget') // page still renders the rest of the preview
  })

  it('36. render-level: a null demand field is omitted rather than printed as 0', () => {
    const degraded = { ...VALID_DECISION_CONTEXT, demand: { ...VALID_DECISION_CONTEXT.demand, cjListedCount: null } }
    const row = syntheticProposalRow({ type: 'new_listing', status: 'rejected', payload: VALID_NEW_LISTING_PAYLOAD, decisionContext: degraded })

    const rendered = renderProposalDetail(row).value

    expect(rendered).not.toContain('CJ listings')
  })
})
