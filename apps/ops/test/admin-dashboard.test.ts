import { agentRuns, auditLog, createDb, gmailSyncState, proposals, settings, supportTickets } from '@doge-buddy/db'
import { and, count, eq, inArray } from 'drizzle-orm'
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

  async function seedAgentRun(workflow: string) {
    const [row] = await db.insert(agentRuns).values({ workflow, status: 'running' }).returning()
    createdRunIds.push(row!.id)
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
})
