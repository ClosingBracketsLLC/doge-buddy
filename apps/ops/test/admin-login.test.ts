import { auditLog, createDb } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

describe('admin login (magic link) + session gate', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  function makeDeps(overrides: Partial<AdminDeps> = {}): AdminDeps {
    return {
      db,
      settings: createSettings(db),
      notify: async () => true,
      enqueue: vi.fn(async () => {}),
      alert: vi.fn(async () => {}),
      adminBaseUrl: 'http://ops.test',
      ...overrides,
    }
  }

  // Hourly-cap hygiene: `admin.login_link_sent` rows count toward a shared cap
  // (LOGIN_SENDS_HOURLY_CAP), so every test that successfully sends a link must remove the row(s)
  // it created before the next test runs — same idiom webhooks.test.ts uses for its capture cap.
  async function cleanupLoginSends(): Promise<void> {
    await db.delete(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
  }

  function extractToken(sentUrl: string): string {
    const m = sentUrl.match(/[?&]t=([^&]+)/)
    if (!m) throw new Error(`no token in ${sentUrl}`)
    return m[1]!
  }

  it('1. unauthenticated GET to any authed route -> 303 to /admin/login, redirect body names no routes', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    for (const path of ['/admin', '/admin/settings']) {
      const res = await app.inject({ method: 'GET', url: path })
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe('/admin/login')
      expect(res.body).toBe('')
    }

    // Non-GET methods must be gated too: a GET-only placeholder would let an unauthenticated
    // POST to an unregistered admin path fall through to Fastify's default 404 without ever
    // hitting the session check — a method-shaped oracle for which admin routes exist.
    const postRes = await app.inject({ method: 'POST', url: '/admin/nonexistent' })
    expect(postRes.statusCode).toBe(303)
    expect(postRes.headers.location).toBe('/admin/login')
    expect(postRes.body).toBe('')

    await app.close()
  })

  it('2. GET /admin/login -> 200 with the send-link form, no auth needed', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/login' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<form method="post" action="/admin/login">')
    expect(res.body).toContain('Send me a login link')

    await app.close()
  })

  it('3. POST /admin/login (urlencoded, empty body) -> Link sent, one notification, one audit row', async () => {
    const { notify, sent } = createCaptureNotifier()
    const deps = makeDeps({ notify })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Link sent')

    expect(sent).toHaveLength(1)
    expect(sent[0]!.actions).toHaveLength(1)
    expect(sent[0]!.actions![0]!.url).toMatch(/^http:\/\/ops\.test\/admin\/login\/consume\?t=[A-Za-z0-9_-]{43}$/)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('system')
    expect(rows[0]!.entityType).toBe('admin')

    await cleanupLoginSends()
    await app.close()
  })

  it('4. rate cap: 5 sends in the last hour -> Try again later, no send, no new audit row', async () => {
    const { notify, sent } = createCaptureNotifier()
    const deps = makeDeps({ notify })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const seeded = await db
      .insert(auditLog)
      .values(
        Array.from({ length: 5 }, () => ({
          actor: 'system' as const,
          action: 'admin.login_link_sent',
          entityType: 'admin',
        })),
      )
      .returning()

    const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Try again later')
    expect(sent).toHaveLength(0)

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
    expect(rows).toHaveLength(5)

    await db.delete(auditLog).where(
      inArray(
        auditLog.id,
        seeded.map((r) => r.id),
      ),
    )
    await app.close()
  })

  it('5. notify resolves false -> Could not send, no admin.login_link_sent row', async () => {
    const deps = makeDeps({ notify: async () => false })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Could not send')

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.login_link_sent'))
    expect(rows).toHaveLength(0)

    await app.close()
  })

  it('6. full login: consume mints a session cookie, and the authed GET succeeds with it', async () => {
    const { notify, sent } = createCaptureNotifier()
    const deps = makeDeps({ notify })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const token = extractToken(sent[0]!.actions![0]!.url)

    // GET never mutates: the confirm page renders, and the login row is still consumable after.
    const getRes = await app.inject({ method: 'GET', url: `/admin/login/consume?t=${token}` })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.body).toContain(`<form method="post" action="/admin/login/consume?t=${token}"`)

    const postRes = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    expect(postRes.statusCode).toBe(303)
    expect(postRes.headers.location).toBe('/admin')
    const setCookie = postRes.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string)
    expect(cookieHeader).toMatch(/^db_admin=/)
    expect(cookieHeader).toContain('HttpOnly')

    const cookiePair = cookieHeader.split(';')[0]!
    const dashRes = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: cookiePair } })
    expect(dashRes.statusCode).toBe(200)
    expect(dashRes.body).toContain('<nav>')

    await cleanupLoginSends()
    await app.close()
  })

  it('7. burned link: a second POST consume with the same token -> friendly page, no new cookie', async () => {
    const { notify, sent } = createCaptureNotifier()
    const deps = makeDeps({ notify })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    await app.inject({ method: 'POST', url: '/admin/login', headers: FORM_HEADERS, payload: '' })
    const token = extractToken(sent[0]!.actions![0]!.url)

    const first = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    expect(first.statusCode).toBe(303)

    const second = await app.inject({ method: 'POST', url: `/admin/login/consume?t=${token}` })
    expect(second.statusCode).toBe(200)
    expect(second.headers['set-cookie']).toBeUndefined()
    expect(second.body).toContain('invalid or expired')

    await cleanupLoginSends()
    await app.close()
  })

  it('8. real browser content-type on POST /admin/login -> parses, 200, not 415 (Plan A regression)', async () => {
    const { notify, sent } = createCaptureNotifier()
    const deps = makeDeps({ notify })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    })

    expect(res.statusCode).not.toBe(415)
    expect(res.statusCode).toBe(200)
    expect(sent).toHaveLength(1)

    await cleanupLoginSends()
    await app.close()
  })
})
