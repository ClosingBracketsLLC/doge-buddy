import { auditLog, createDb, proposals } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'

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

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
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
        ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
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

  it('6. detail for an applied row shows no decision forms', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const row = await seedProposal({ status: 'applied' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/proposals/${row.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<form')
    expect(res.body).not.toContain('name="payload"')

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
})
