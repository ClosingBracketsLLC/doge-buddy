import {
  agentRuns,
  auditLog,
  createDb,
  gmailSyncState,
  orders,
  products,
  productScores,
  productVariants,
  proposals,
  settings,
  supplierOrders,
  supportTickets,
} from '@doge-buddy/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import { AGENT_RUN_AUDIT_ACTION, SUPPORT_AGENT_MAX_RUNS_PER_DAY } from '../src/jobs/support-agent-run.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
import type { SupplierOrderStatusDb } from '../src/fulfillment/transitions.ts'

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

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('admin dashboard health strip + tickets/runs pages', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdProposalIds: string[] = []
  let createdRunIds: string[] = []
  let createdAuditLogIds: bigint[] = []
  let createdProductIds: string[] = []
  let createdTicketIds: string[] = []
  let createdOrderIds: string[] = []
  let createdSupplierOrderIds: string[] = []

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
    }
    if (createdRunIds.length > 0) {
      await db.delete(agentRuns).where(inArray(agentRuns.id, createdRunIds))
      createdRunIds = []
    }
    if (createdAuditLogIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.id, createdAuditLogIds))
      createdAuditLogIds = []
    }
    if (createdTicketIds.length > 0) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
      createdTicketIds = []
    }
    if (createdSupplierOrderIds.length > 0) {
      await db
        .delete(auditLog)
        .where(and(eq(auditLog.entityType, 'supplier_order'), inArray(auditLog.entityId, createdSupplierOrderIds)))
      await db.delete(supplierOrders).where(inArray(supplierOrders.id, createdSupplierOrderIds))
      createdSupplierOrderIds = []
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
      createdOrderIds = []
    }
    if (createdProductIds.length > 0) {
      // product_variants and product_scores have no ON DELETE CASCADE off products — both go first.
      await db.delete(productVariants).where(inArray(productVariants.productId, createdProductIds))
      await db.delete(productScores).where(inArray(productScores.productId, createdProductIds))
      await db.delete(products).where(inArray(products.id, createdProductIds))
      createdProductIds = []
    }
    // Restore the killswitch setting to its code default so later tests (in this file or any
    // other) never observe a row this file left behind.
    await db.delete(settings).where(eq(settings.key, 'killswitch.global'))
    // gmail_sync_state is a singleton row (id=1) shared with support-poll-gmail.ts's own tests —
    // clean up whatever this file seeded so no row leaks into another suite's expectations.
    await db.delete(gmailSyncState).where(eq(gmailSyncState.id, 1))
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

  // Same idiom as admin-decisions.test.ts's own copy (per the task brief: copy it rather than
  // share it), cleaning up the `admin.login_link_sent` audit row it creates before returning —
  // that action counts toward a shared hourly cap.
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

  async function seedPendingProposal() {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'pending',
        summary: `Test proposal ${crypto.randomUUID()}`,
        payload: VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  async function pendingProposalCount(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(proposals).where(eq(proposals.status, 'pending'))
    return row!.value
  }

  async function seedAgentRun(workflow: string, status: 'running' | 'succeeded' | 'failed' | 'aborted' = 'running') {
    const [row] = await db.insert(agentRuns).values({ workflow, status }).returning()
    createdRunIds.push(row!.id)
    return row!
  }

  // Seeds a `support.agent_run` audit row (the spend row Task 11's global cap counts), optionally
  // backdated — used to prove the health row counts only rows since UTC midnight, mirroring
  // jobs/support-agent-run.ts's own `AGENT_RUN_AUDIT_ACTION` spend-row shape.
  async function seedAgentRunAuditRow(overrides: Partial<{ createdAt: Date }> = {}) {
    const [row] = await db
      .insert(auditLog)
      .values({
        actor: 'system',
        action: AGENT_RUN_AUDIT_ACTION,
        entityType: 'ticket',
        entityId: crypto.randomUUID(),
        detail: { model: 'test' },
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      })
      .returning({ id: auditLog.id })
    createdAuditLogIds.push(row!.id)
    return row!
  }

  async function seedProduct(title = 'Test Product') {
    const [row] = await db
      .insert(products)
      .values({
        shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
        handle: `h-${crypto.randomUUID()}`,
        title,
        status: 'active',
      })
      .returning()
    createdProductIds.push(row!.id)
    return row!
  }

  async function seedScoreRow(productId: string, scoreDate: string) {
    await db.insert(productScores).values({ productId, scoreDate })
  }

  // control-center helpers, copied from admin-orders.test.ts (lines ~80-107) and adapted for this
  // file's own createdOrderIds/createdSupplierOrderIds cleanup lists.
  async function seedTicket(status: 'escalated' | 'triaged') {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `cc-${crypto.randomUUID()}`,
        customerEmail: `cc-${crypto.randomUUID()}@example.com`,
        subject: 'cc',
        status,
      })
      .returning({ id: supportTickets.id })
    createdTicketIds.push(row!.id)
    return row!.id
  }

  async function seedOrder(): Promise<typeof orders.$inferSelect> {
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`, isTest: false, totalCents: 5000 })
      .returning()
    createdOrderIds.push(row!.id)
    return row!
  }

  async function seedSupplierOrder(opts: {
    orderId: string
    status: SupplierOrderStatusDb
    lastError?: string | null
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderId,
        supplier: 'mock',
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: opts.status,
        lastError: opts.lastError ?? null,
      })
      .returning()
    createdSupplierOrderIds.push(row!.id)
    return row!
  }

  it('1. unauthenticated GET /admin -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. unauthenticated GET /admin/tickets -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/tickets' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('3. unauthenticated GET /admin/runs -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/runs' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('4. authed dashboard with a stubbed getWalletBalance shows the formatted balance and the pending count matches seeded rows', async () => {
    const getWalletBalance = vi.fn(async () => ({ availableCents: 12345, frozenCents: 0 }))
    const deps = makeDeps({ getWalletBalance })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    await seedPendingProposal()
    await seedPendingProposal()
    const expectedPending = await pendingProposalCount()

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('$123.45')
    expect(res.body).toContain(`Pending proposals: ${expectedPending}`)

    await app.close()
  })

  it('5. authed dashboard without getWalletBalance dep shows n/a', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('n/a')

    await app.close()
  })

  it('6. authed dashboard with a REJECTING getWalletBalance still 200s and shows n/a', async () => {
    const getWalletBalance = vi.fn(async () => {
      throw new Error('CJ API down')
    })
    const deps = makeDeps({ getWalletBalance })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('n/a')

    await app.close()
  })

  // Item 6: the strip must call out a wallet balance below the configured alert threshold
  // visibly, not just leave the operator to eyeball the raw number against the settings page.
  it('6b. wallet below fulfillment.wallet_alert_threshold_cents renders a visible BELOW ALERT THRESHOLD indicator', async () => {
    const getWalletBalance = vi.fn(async () => ({ availableCents: 500, frozenCents: 0 }))
    const deps = makeDeps({ getWalletBalance })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('BELOW ALERT THRESHOLD')
    expect(res.body).toContain('$5.00') // availableCents = 500
    expect(res.body).toContain('$20.00') // code default fulfillment.wallet_alert_threshold_cents = 2000

    await app.close()
  })

  it('6c. wallet AT/above the alert threshold shows no indicator', async () => {
    const getWalletBalance = vi.fn(async () => ({ availableCents: 2000, frozenCents: 0 }))
    const deps = makeDeps({ getWalletBalance })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('BELOW ALERT THRESHOLD')

    await app.close()
  })

  it('7. killswitch ON renders visibly on the dashboard', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    await deps.settings.set('killswitch.global', true)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body.toLowerCase()).toContain('killswitch')
    expect(res.body).toContain('Killswitch: ON')

    await app.close()
  })

  it('7b. dashboard shows "never" for the support poll line when gmail_sync_state has no row', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('support poll: last ok never (0 consecutive failures)')

    await app.close()
  })

  it('7c. dashboard shows the real last-success timestamp and failure count once gmail_sync_state is seeded', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    const lastSuccessAt = new Date('2026-08-20T12:00:00.000Z')
    await db.insert(gmailSyncState).values({ id: 1, consecutiveFailures: 3, lastSuccessAt })

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`support poll: last ok ${lastSuccessAt.toISOString()} (3 consecutive failures)`)

    await app.close()
  })

  it('8. tickets page with no rows shows the empty state', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/tickets', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No tickets.')

    await app.close()
  })

  it('9. runs page with no rows shows the Phase 5 empty state', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No agent runs yet — Phase 5.')

    await app.close()
  })

  it('10. runs page shows a seeded agent_runs row\'s workflow name, escaped', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    const row = await seedAgentRun('<sourcing> "run"')

    const res = await app.inject({ method: 'GET', url: '/admin/runs', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(row.id)
    expect(res.body).toContain('&lt;sourcing&gt; &quot;run&quot;')
    expect(res.body).not.toContain('<sourcing>')

    await app.close()
  })

  it('11. support agent health row shows 0 runs today / cap and "none" last run when nothing seeded', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`support agent: 0 runs today / ${SUPPORT_AGENT_MAX_RUNS_PER_DAY}`)
    expect(res.body).toContain('support agent last run: none')

    await app.close()
  })

  it("12. support agent health row counts only today's support.agent_run audit rows and shows the newest support-workflow agent_runs row's status", async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    await seedAgentRunAuditRow()
    await seedAgentRunAuditRow()
    await seedAgentRunAuditRow()
    // Exactly 24h ago is always strictly before today's UTC midnight — must not count toward "today".
    await seedAgentRunAuditRow({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    // A non-support-workflow run must not be picked as the "last run" — proves the workflow filter.
    await seedAgentRun('sourcing', 'failed')
    const run = await seedAgentRun('support', 'succeeded')

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`support agent: 3 runs today / ${SUPPORT_AGENT_MAX_RUNS_PER_DAY}`)
    expect(res.body).toContain('support agent last run: succeeded')
    void run

    await app.close()
  })

  // A fixed FAR-FUTURE score_date, not "today" — this environment's shared test DB can carry
  // pre-existing `product_scores` residue from an interrupted prior run of scoring-nightly/
  // scoring-weekly-digest's own suites (their own afterEach/afterAll do clean up, so this is
  // leftover from something not exiting cleanly, not a design gap in this file). Anchoring on a
  // date years past any real or leftover row keeps this test's "newest" assertion deterministic
  // regardless of that residue, without this file reaching in to truncate a table it doesn't own.
  const FAR_FUTURE_SCORE_DATE = '2099-12-31'

  it('13. scoring health row shows the newest score_date and the count of products scored that day', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const p1 = await seedProduct('Product One')
    const p2 = await seedProduct('Product Two')
    const p3 = await seedProduct('Product Three')
    // Older date — must not be counted toward "newest".
    await seedScoreRow(p3.id, '2026-08-01')
    await seedScoreRow(p1.id, FAR_FUTURE_SCORE_DATE)
    await seedScoreRow(p2.id, FAR_FUTURE_SCORE_DATE)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`scoring: last run ${FAR_FUTURE_SCORE_DATE}, 2 products scored`)

    await app.close()
  })

  it('control center: Needs-you cards link to the filtered lists with live counts', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    const [pending] = await db
      .insert(proposals)
      .values({
        type: 'new_listing',
        status: 'pending',
        summary: 'cc pending',
        payload: VALID_NEW_LISTING_PAYLOAD,
        sourceWorkflow: 'test',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: proposals.id })
    createdProposalIds.push(pending!.id)
    await seedTicket('escalated')
    const order = await seedOrder()
    await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<a class="card" href="/admin/proposals?status=pending">')
    expect(res.body).toMatch(/Pending proposals<\/div><div class="stat bad">[1-9]\d*</)
    expect(res.body).toContain('<a class="card" href="/admin/tickets?status=escalated">')
    expect(res.body).toMatch(/Escalated tickets<\/div><div class="stat bad">[1-9]\d*</)
    expect(res.body).toContain('<a class="card" href="/admin/orders">')
    expect(res.body).toMatch(/Orders needing attention<\/div><div class="stat bad">[1-9]\d*</)
    // the verbatim strip survives inside the details block
    expect(res.body).toContain('<summary>System status (text)</summary>')
    expect(res.body).toContain('Pending proposals: ')
    await app.close()
  })

  it('control center: switches post to /admin/settings with returnTo=/admin, the kill switch asks first, modes are segmented', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.body).toContain('<input type="hidden" name="key" value="killswitch.global">')
    expect(res.body).toContain('<input type="hidden" name="returnTo" value="/admin">')
    expect(res.body).toContain('data-confirm="Turn the global kill switch ON? Every workflow stops."')
    expect(res.body).toContain('<input type="hidden" name="key" value="workflow.sourcing.mode">')
    expect(res.body).toContain('<button type="submit" name="value" value="manual" aria-pressed="true">manual</button>')
    expect(res.body).toContain('<button type="submit" name="value" value="auto" aria-pressed="false">auto</button>')
    await app.close()
  })

  it('control center: wallet bar tone — bad below threshold, warn under 2x, plain otherwise', async () => {
    for (const [cents, cls] of [
      [500, 'bar bad'],
      [3000, 'bar warn'],
      [9000, 'bar '],
    ] as const) {
      const deps = makeDeps({ getWalletBalance: async () => ({ availableCents: cents, frozenCents: 0 }) })
      const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
      const cookie = await loginAndGetCookie(app, deps)
      const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
      expect(res.body).toContain(`<div class="${cls}">`)
      await app.close()
    }
  })

  it('control center: agents & jobs + catalog rows, without and with data', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)
    // The DB may hold other rows; assert on the rows this test controls via distinctive seeds.
    const [product] = await db
      .insert(products)
      .values({ title: 'CC Latest Widget', handle: 'cc-latest-widget-abc12345', status: 'active' })
      .returning({ id: products.id })
    createdProductIds.push(product!.id)
    await db
      .insert(productVariants)
      .values({ productId: product!.id, sku: `CC-${crypto.randomUUID()}`, priceCents: 1999, shopifyInventoryItemGid: 'gid://shopify/InventoryItem/1' })
    await seedAgentRun('sourcing.weekly', 'succeeded')
    const [synced] = await db
      .insert(auditLog)
      .values({ actor: 'system', action: 'inventory.synced', entityType: 'product', entityId: product!.id, detail: {} })
      .returning({ id: auditLog.id })
    createdAuditLogIds.push(synced!.id)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.body).toContain('<span>Sourcing last run</span>')
    expect(res.body).toContain('<span class="chip chip-ok">succeeded</span>')
    expect(res.body).toContain('<span>Inventory sync</span>')
    expect(res.body).toContain('just now')
    expect(res.body).not.toContain('DEGRADED')
    expect(res.body).toContain('<a href="https://dogebuddy.com/products/cc-latest-widget-abc12345">CC Latest Widget</a>')
    expect(res.body).toContain('<div class="label">Tracked variants</div>')

    // a degraded alert newer than the last sync flips the chip on
    const [degraded] = await db
      .insert(auditLog)
      .values({ actor: 'system', action: 'alert.inventory_sync_degraded', entityType: 'alert', detail: { severity: 'warning', failed: 3, attempted: 4 } })
      .returning({ id: auditLog.id })
    createdAuditLogIds.push(degraded!.id)
    const res2 = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res2.body).toContain('<span class="chip chip-bad">DEGRADED</span>')
    await app.close()
  })
})
