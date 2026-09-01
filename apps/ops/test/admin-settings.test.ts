import { auditLog, createDb, settings as settingsTable, sourcingSignals } from '@doge-buddy/db'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings, SETTINGS_DEFAULTS } from '../src/settings.ts'
import { buildServer } from '../src/server.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('settings editor + manual-signal paste box', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdSignalIds: string[] = []

  afterEach(async () => {
    if (createdSignalIds.length > 0) {
      await db
        .delete(auditLog)
        .where(and(eq(auditLog.entityType, 'signal'), inArray(auditLog.entityId, createdSignalIds)))
      await db.delete(sourcingSignals).where(inArray(sourcingSignals.id, createdSignalIds))
      createdSignalIds = []
    }
    // Settings hygiene: `settings` is a shared table across the whole test suite. Deleting the
    // row (rather than setting it back) restores `get()` to the code default regardless of what
    // this file's tests wrote, and is safe to run unconditionally every time.
    await db.delete(settingsTable).where(eq(settingsTable.key, 'killswitch.global'))
    await db.delete(settingsTable).where(eq(settingsTable.key, 'workflow.sourcing.mode'))
    await db.delete(settingsTable).where(eq(settingsTable.key, 'fulfillment.spend_cap_per_order_cents'))
    await db.delete(settingsTable).where(eq(settingsTable.key, 'support.agent_guidance'))
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

  // Same idiom as admin-orders.test.ts's own copy (per the task brief: copy it rather than
  // share it).
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

  it('1. unauthenticated GET/POST /admin/settings and POST /admin/signals -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const getRes = await app.inject({ method: 'GET', url: '/admin/settings' })
    expect(getRes.statusCode).toBe(303)
    expect(getRes.headers.location).toBe('/admin/login')

    const postSettingsRes = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: FORM_HEADERS,
      payload: 'key=killswitch.global&value=on',
    })
    expect(postSettingsRes.statusCode).toBe(303)
    expect(postSettingsRes.headers.location).toBe('/admin/login')

    const postSignalsRes = await app.inject({
      method: 'POST',
      url: '/admin/signals',
      headers: FORM_HEADERS,
      payload: 'content=hi',
    })
    expect(postSignalsRes.statusCode).toBe(303)
    expect(postSignalsRes.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. GET renders every SETTINGS_DEFAULTS key with its current value, and the paste box', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      // support.agent_guidance is string-valued: excluded from this generic catalog (it's edited
      // only via its own dedicated page, /admin/guidance) — see the dedicated assertion below.
      if (key === 'support.agent_guidance') continue
      expect(res.body).toContain(key)
    }
    // String-valued settings must NOT get a control on the generic catalog page: a naive add
    // would otherwise render this as a number input, let a save coerce it to a number, and crash
    // every support run downstream.
    expect(res.body).not.toContain('support.agent_guidance')
    // Booleans render as an unchecked checkbox by default (killswitch.global defaults false), with
    // an id the row's <label for> can target so the tap area includes the label text.
    expect(res.body).toContain('<input type="checkbox" id="setting-killswitch-global" name="value">')
    // Confirm-before-danger: NEW state is the dangerous one. killswitch.global defaults false, so
    // turning it ON is the dangerous transition; workflow.fulfillment.enabled defaults true, so
    // turning it OFF is the dangerous transition. Same literal strings as the dashboard's cards
    // (DANGEROUS_SETTING_CONFIRMS in render-dashboard.ts), shared rather than duplicated.
    expect(res.body).toContain('data-confirm="Turn the global kill switch ON? Every workflow stops."')
    expect(res.body).toContain('data-confirm="Turn fulfillment OFF? New orders will not be placed with the supplier."')
    // Mode keys render as a manual/auto select, defaulted to manual.
    expect(res.body).toContain('<option value="manual" selected>manual</option>')
    expect(res.body).toContain('<option value="auto">auto</option>')
    // Number keys render as a number input with the current value.
    expect(res.body).toContain(`value="${SETTINGS_DEFAULTS['fulfillment.spend_cap_per_order_cents']}"`)
    // Catalog-build sourcing knobs (spec 2026-08-31 catalog-p0 §5): they are plain numeric
    // settings, so the generic catalog above already renders them — asserted explicitly here
    // because the owner drives the whole build week from this page.
    for (const key of ['sourcing.max_winners', 'sourcing.candidate_target', 'sourcing.max_pages', 'sourcing.max_budget_cents'] as const) {
      expect(res.body).toContain(key)
      expect(res.body).toContain(`value="${SETTINGS_DEFAULTS[key]}"`)
    }
    // The paste box.
    expect(res.body).toContain('action="/admin/signals"')
    expect(res.body).toContain('name="content"')
    expect(res.body).toContain('name="keyword"')

    await app.close()
  })

  it('3. POST flips killswitch.global on -> settings.get reads true, audits {from:false,to:true}', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=killswitch.global&value=on',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/settings')
    expect(await deps.settings.get('killswitch.global')).toBe(true)

    const [latest] = await db.select().from(auditLog).where(eq(auditLog.action, 'setting.updated')).orderBy(desc(auditLog.id)).limit(1)
    expect(latest).toBeDefined()
    expect(latest!.actor).toBe('owner')
    expect(latest!.detail).toMatchObject({ key: 'killswitch.global', from: false, to: true })

    await app.close()
  })

  it('4. POST workflow.sourcing.mode=auto round-trips through settings.get', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=workflow.sourcing.mode&value=auto',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/settings')
    expect(await deps.settings.get('workflow.sourcing.mode')).toBe('auto')

    const [latest] = await db.select().from(auditLog).where(eq(auditLog.action, 'setting.updated')).orderBy(desc(auditLog.id)).limit(1)
    expect(latest!.detail).toMatchObject({ key: 'workflow.sourcing.mode', from: 'manual', to: 'auto' })

    await app.close()
  })

  it('5. POST an invalid mode value -> 400, setting unchanged', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=workflow.sourcing.mode&value=bogus',
    })

    expect(res.statusCode).toBe(400)
    expect(await deps.settings.get('workflow.sourcing.mode')).toBe('manual')

    await app.close()
  })

  it('6. POST an unknown key -> 400', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=not.a.real.setting&value=on',
    })

    expect(res.statusCode).toBe(400)

    await app.close()
  })

  it('6b. POST key=support.agent_guidance (string-valued) -> 400, rejected by the generic catalog, value unchanged', async () => {
    // support.agent_guidance is edited only via its own dedicated page (/admin/guidance), never
    // through this generic boolean/mode/number path — the POST handler must reject it exactly
    // like an unknown key, not silently coerce the free-text guidance through Number().
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const before = await deps.settings.get('support.agent_guidance')

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: `key=support.agent_guidance&value=${encodeURIComponent('sneak this in through the numeric path')}`,
    })

    expect(res.statusCode).toBe(400)
    expect(await deps.settings.get('support.agent_guidance')).toBe(before)

    await app.close()
  })

  it('7. POST a non-numeric value for a number setting -> 400, setting unchanged', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=fulfillment.spend_cap_per_order_cents&value=not-a-number',
    })

    expect(res.statusCode).toBe(400)
    expect(await deps.settings.get('fulfillment.spend_cap_per_order_cents')).toBe(
      SETTINGS_DEFAULTS['fulfillment.spend_cap_per_order_cents'],
    )

    await app.close()
  })

  it('7b. POST a single space as a number value -> 400, setting unchanged (no silent zero write)', async () => {
    // Regression: Number(' ') === 0, which used to sail straight through the isSafeInteger/>=0
    // checks and silently zero out a real setting (e.g. the spend cap) from a blank/whitespace
    // form submission.
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=fulfillment.spend_cap_per_order_cents&value=%20',
    })

    expect(res.statusCode).toBe(400)
    expect(await deps.settings.get('fulfillment.spend_cap_per_order_cents')).toBe(
      SETTINGS_DEFAULTS['fulfillment.spend_cap_per_order_cents'],
    )

    await app.close()
  })

  it('7c. POST an empty-string number value -> 400, setting unchanged', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=fulfillment.spend_cap_per_order_cents&value=',
    })

    expect(res.statusCode).toBe(400)
    expect(await deps.settings.get('fulfillment.spend_cap_per_order_cents')).toBe(
      SETTINGS_DEFAULTS['fulfillment.spend_cap_per_order_cents'],
    )

    await app.close()
  })

  it('7d. POST an explicit 0 for a number setting -> succeeds and writes 0 (intentional zero still allowed)', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'key=fulfillment.spend_cap_per_order_cents&value=0',
    })

    expect(res.statusCode).toBe(303)
    expect(await deps.settings.get('fulfillment.spend_cap_per_order_cents')).toBe(0)

    await app.close()
  })

  it('8. signal paste inserts a sourcing_signals row (source owner_manual) and audits it', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: '/admin/signals',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'keyword=widgets&content=Trending+on+the+forums',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/settings')

    const [row] = await db
      .select()
      .from(sourcingSignals)
      .where(eq(sourcingSignals.source, 'owner_manual'))
      .orderBy(desc(sourcingSignals.fetchedAt))
      .limit(1)
    expect(row).toBeDefined()
    createdSignalIds.push(row!.id)
    expect(row!.keyword).toBe('widgets')
    expect(row!.snapshot).toMatchObject({ content: 'Trending on the forums' })

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'signal'), eq(auditLog.entityId, row!.id)))
    const match = auditRows.find((r) => r.action === 'signal.pasted')
    expect(match).toBeDefined()
    expect(match!.actor).toBe('owner')

    await app.close()
  })

  it('9. empty paste -> 400, no row inserted', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const beforeRows = await db.select().from(sourcingSignals).where(eq(sourcingSignals.source, 'owner_manual'))

    const res = await app.inject({
      method: 'POST',
      url: '/admin/signals',
      headers: { cookie, ...FORM_HEADERS },
      payload: 'keyword=widgets&content=',
    })

    expect(res.statusCode).toBe(400)

    const afterRows = await db.select().from(sourcingSignals).where(eq(sourcingSignals.source, 'owner_manual'))
    expect(afterRows.length).toBe(beforeRows.length)

    await app.close()
  })

  it('10. hostile pasted content renders escaped (not raw) in the last-10 list', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const hostile = '<script>alert(1)</script>'
    const pasteRes = await app.inject({
      method: 'POST',
      url: '/admin/signals',
      headers: { cookie, ...FORM_HEADERS },
      payload: `keyword=hostile&content=${encodeURIComponent(hostile)}`,
    })
    expect(pasteRes.statusCode).toBe(303)

    const [row] = await db
      .select()
      .from(sourcingSignals)
      .where(eq(sourcingSignals.source, 'owner_manual'))
      .orderBy(desc(sourcingSignals.fetchedAt))
      .limit(1)
    createdSignalIds.push(row!.id)

    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')

    await app.close()
  })

  it('POST /admin/settings honours returnTo=/admin and falls back to /admin/settings for anything else', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const home = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM_HEADERS, cookie }, payload: 'key=killswitch.global&value=on&returnTo=%2Fadmin' })
    expect(home.statusCode).toBe(303)
    expect(home.headers.location).toBe('/admin')
    const evil = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM_HEADERS, cookie }, payload: 'key=killswitch.global&returnTo=https%3A%2F%2Fevil.example' })
    expect(evil.statusCode).toBe(303)
    expect(evil.headers.location).toBe('/admin/settings')

    await app.close()
  })

  it('every authed page carries the tab shell with badge counts; login pages do not', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    expect(res.body).toContain('class="tabs"')
    expect(res.body).toMatch(/<a class="tab" href="\/admin\/settings" aria-current="page">/)
    const loginPage = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(loginPage.body).not.toContain('class="tabs"')
    expect(loginPage.body).toContain('<style>')

    await app.close()
  })
})
