import { auditLog, createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
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

describe('dashboard "Run sourcing now" (owner ask 2026-09-03)', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  afterEach(async () => {
    await db.delete(auditLog).where(eq(auditLog.action, 'sourcing.manual_run_requested'))
    await db.delete(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
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

  function extractToken(sentUrl: string): string {
    const m = sentUrl.match(/[?&]t=([^&]+)/)
    if (!m) throw new Error(`no token in ${sentUrl}`)
    return m[1]!
  }

  // Same login idiom as admin-settings.test.ts (copied per that file's own convention).
  async function login(app: FastifyInstance, deps: TestDeps): Promise<string> {
    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const token = extractToken(deps.sent.at(-1)!.actions![0]!.url)
    const consumeRes = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    const setCookie = consumeRes.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)
    return cookieHeader.split(';')[0]!
  }

  it('unauthenticated POST -> 303 to login, nothing enqueued', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const res = await app.inject({ method: 'POST', url: '/admin/sourcing/run', headers: FORM_HEADERS, payload: '' })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')
    expect(deps.enqueue).not.toHaveBeenCalled()
    await app.close()
  })

  it('blank form -> enqueues sourcing.manual with empty overrides, singleton key, 303 to /admin/runs, audit row', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await login(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/sourcing/run',
      headers: { ...FORM_HEADERS, cookie },
      payload: '',
    })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/runs')
    expect(deps.enqueue).toHaveBeenCalledWith(
      'sourcing.manual',
      { overrides: {} },
      { singletonKey: 'sourcing-manual', retryLimit: 0, expireInSeconds: 3600 },
    )
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'sourcing.manual_run_requested'))
    expect(audit).toBeDefined()
    expect(audit!.actor).toBe('owner')
    await app.close()
  })

  it('filled form -> overrides parsed (keywords normalized, numbers coerced)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await login(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/sourcing/run',
      headers: { ...FORM_HEADERS, cookie },
      payload: 'keywords=dog+toy%2C+dog+bed&maxWinners=8&candidates=40&pages=20&budget=4',
    })
    expect(res.statusCode).toBe(303)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'sourcing.manual',
      { overrides: { keywords: ['dog toy', 'dog bed'], maxWinners: 8, candidateTarget: 40, maxPages: 20, maxBudgetUsd: 4 } },
      { singletonKey: 'sourcing-manual', retryLimit: 0, expireInSeconds: 3600 },
    )
    await app.close()
  })

  it('out-of-range knob -> 400 naming the knob, nothing enqueued', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await login(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/sourcing/run',
      headers: { ...FORM_HEADERS, cookie },
      payload: 'maxWinners=99',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('maxWinners')
    expect(deps.enqueue).not.toHaveBeenCalled()
    await app.close()
  })

  it('dashboard renders the Run sourcing panel', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await login(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Run sourcing now')
    expect(res.body).toContain('action="/admin/sourcing/run"')
    await app.close()
  })
})
