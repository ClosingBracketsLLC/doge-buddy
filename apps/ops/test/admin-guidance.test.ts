import { auditLog, createDb, settings as settingsTable } from '@doge-buddy/db'
import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { buildServer } from '../src/server.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('admin guidance edit page', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  afterEach(async () => {
    // Settings hygiene, same idiom as admin-settings.test.ts: delete the row (rather than
    // setting it back) so `get()` reverts to the code default regardless of what this file's
    // tests wrote — `settings` is a shared table across the whole test suite.
    await db.delete(settingsTable).where(eq(settingsTable.key, 'support.agent_guidance'))
    await db.delete(auditLog).where(eq(auditLog.action, 'settings.support_guidance_updated'))
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

  // Copied (not shared) per the sibling admin tests' own convention.
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

  it('GET renders the current guidance value inside a textarea', async () => {
    const deps = makeDeps()
    await deps.settings.set('support.agent_guidance', 'existing rule')
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/guidance', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<textarea')
    expect(res.body).toContain('existing rule')

    await app.close()
  })

  it('POST saves the new guidance and writes an audit row', async () => {
    const deps = makeDeps()
    await deps.settings.set('support.agent_guidance', 'old rule')
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/guidance',
      headers: { cookie, ...FORM_HEADERS },
      payload: `guidance=${encodeURIComponent('new rule')}`,
    })

    expect([200, 303]).toContain(res.statusCode)
    expect(await deps.settings.get('support.agent_guidance')).toBe('new rule')

    const [latest] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'settings.support_guidance_updated'))
      .orderBy(desc(auditLog.id))
      .limit(1)
    expect(latest).toBeDefined()
    expect(latest!.actor).toBe('owner')
    expect(latest!.detail).toMatchObject({ newLength: 'new rule'.length, previousLength: 'old rule'.length })

    await app.close()
  })

  it('POST over 8000 chars -> 400/readable page, value unchanged', async () => {
    const deps = makeDeps()
    await deps.settings.set('support.agent_guidance', 'unchanged')
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const tooLong = 'a'.repeat(8001)
    const res = await app.inject({
      method: 'POST',
      url: '/admin/guidance',
      headers: { cookie, ...FORM_HEADERS },
      payload: `guidance=${encodeURIComponent(tooLong)}`,
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('<')
    expect(await deps.settings.get('support.agent_guidance')).toBe('unchanged')

    await app.close()
  })
})
