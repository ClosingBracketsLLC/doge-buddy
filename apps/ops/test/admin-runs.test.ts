import { agentRunEvents, agentRuns, auditLog, createDb } from '@doge-buddy/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.ts'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('runs list + detail pages', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdRunIds: string[] = []

  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await db.delete(agentRunEvents).where(inArray(agentRunEvents.runId, createdRunIds))
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdRunIds))
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

  // Same idiom as admin-proposals-pages.test.ts's own copy — factored per-file, not shared.
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

  async function seedRun(
    overrides: Partial<{
      workflow: string
      status: 'running' | 'succeeded' | 'failed' | 'aborted'
      model: string | null
      sessionId: string | null
      totalCostUsd: string | null
      modelUsage: unknown
      numTurns: number | null
      finishedAt: Date | null
    }> = {},
  ) {
    const [row] = await db
      .insert(agentRuns)
      .values({
        workflow: overrides.workflow ?? 'sourcing.weekly',
        status: overrides.status ?? 'succeeded',
        model: overrides.model ?? 'claude-sonnet-5',
        sessionId: overrides.sessionId ?? 'sess-1',
        totalCostUsd: 'totalCostUsd' in overrides ? overrides.totalCostUsd : '1.23',
        modelUsage: 'modelUsage' in overrides ? overrides.modelUsage : { 'claude-sonnet-5': { costUSD: 1.23 } },
        numTurns: 'numTurns' in overrides ? overrides.numTurns : 4,
        finishedAt: 'finishedAt' in overrides ? overrides.finishedAt : new Date(),
      })
      .returning()
    createdRunIds.push(row!.id)
    return row!
  }

  async function seedEvents(runId: string, messages: unknown[]): Promise<void> {
    await db.insert(agentRunEvents).values(messages.map((message, seq) => ({ runId, seq, message })))
  }

  const INIT_MSG = { type: 'system', subtype: 'init', session_id: 'sess-1' }
  const ASSISTANT_MSG = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Researching candidates now.' }] },
  }
  const RESULT_MSG = { type: 'result', subtype: 'success', total_cost_usd: 1.23, num_turns: 4, session_id: 'sess-1' }

  it('1. unauthenticated GET /admin/runs/:id -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const run = await seedRun()

    const res = await app.inject({ method: 'GET', url: `/admin/runs/${run.id}` })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. list shows cost as $1.23, turns, and finished; id links to the detail page', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const run = await seedRun({ totalCostUsd: '1.23', numTurns: 4 })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('$1.23')
    expect(res.body).toContain('>4<')
    expect(res.body).toContain(run.finishedAt!.toISOString())
    expect(res.body).toContain(`href="/admin/runs/${run.id}"`)

    await app.close()
  })

  it('3. list marks an estimated cost with (est) when modelUsage.estimated === true', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    await seedRun({ totalCostUsd: '0.42', modelUsage: { 'claude-sonnet-5': { costUSD: 0.42 }, estimated: true }, status: 'aborted' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('$0.42 (est)')

    await app.close()
  })

  it('4. list renders numTurns/finishedAt as em-dash placeholders when absent', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    await seedRun({ numTurns: null, finishedAt: null, status: 'running', totalCostUsd: null, modelUsage: null })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('—')

    await app.close()
  })

  it('5. detail 200s and contains the seq lines for each seeded event', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const run = await seedRun()
    await seedEvents(run.id, [INIT_MSG, ASSISTANT_MSG, RESULT_MSG])
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/runs/${run.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('#0')
    expect(res.body).toContain('#1')
    expect(res.body).toContain('#2')
    expect(res.body).toContain('system/init')
    expect(res.body).toContain('result/success')
    expect(res.body).toContain('Researching candidates now.')

    await app.close()
  })

  it('6. detail header shows workflow, status, model, cost, turns, and sessionId', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const run = await seedRun({ workflow: 'sourcing.weekly', model: 'claude-sonnet-5', sessionId: 'sess-xyz' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/runs/${run.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('sourcing.weekly')
    expect(res.body).toContain('claude-sonnet-5')
    expect(res.body).toContain('sess-xyz')
    expect(res.body).toContain('$1.23')

    await app.close()
  })

  // THE REGRESSION ASSERTION: agent_run_events carry untrusted third-party content (CJ product
  // data, web-search results). A <script> payload embedded in an event message must arrive
  // escaped on the detail page, never as live markup.
  it('7. a <script> payload embedded in an event message arrives ESCAPED, never as live markup', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const run = await seedRun()
    const hostileMsg = {
      type: 'tool_result',
      content: [{ type: 'text', text: '<script>alert(document.cookie)</script>' }],
    }
    await seedEvents(run.id, [hostileMsg])
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: `/admin/runs/${run.id}`, headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;script&gt;')
    expect(res.body).not.toContain('<script>alert(document.cookie)</script>')

    await app.close()
  })

  it('8. a non-UUID :id does not 500 or leak SQL — degrades to the safeHandle error page', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs/not-a-uuid', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('invalid input syntax')
    expect(res.body).not.toContain('SELECT')

    await app.close()
  })

  it('9. an unknown (valid-uuid) :id renders Not found, not a 500', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/runs/00000000-0000-0000-0000-000000000000', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body.toLowerCase()).toContain('not found')

    await app.close()
  })
})
