import { createDb, auditLog } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { registerCron, startQueue, type Queue } from '../src/queue.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('queue', () => {
  let q: Queue
  const { db, pool } = createDb(url)

  beforeAll(async () => {
    const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
    q = await startQueue(url, {
      adapter: new MockSupplierAdapter(),
      settings: createSettings(db),
      alert: createAlerter(db, mockLog),
    })
  })
  afterAll(async () => {
    await q.stop()
    await pool.end()
  })

  it('reports ready after start', () => {
    expect(q.ready()).toBe(true)
  })

  it('processes a demo.ping job into audit_log', async () => {
    const note = `test-${Date.now()}`
    await q.boss.send('demo.ping', { note })
    // poll audit_log up to 10s for the worker to process
    let rows: (typeof auditLog.$inferSelect)[] = []
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200))
      rows = await db.select().from(auditLog).where(eq(auditLog.action, 'demo.ping'))
      rows = rows.filter((r) => (r.detail as { note?: string })?.note === note)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('system')
  })

  it('registerCron with options pins retryLimit and expiration on the queue', async () => {
    await registerCron(q.boss, 'test.cron-opts', '0 13 * * 1', async () => {}, { retryLimit: 0, expireInSeconds: 3600 })
    const queue = await q.boss.getQueue('test.cron-opts')
    expect(queue?.retryLimit).toBe(0)
    expect(queue?.expireInSeconds).toBe(3600)
  })

  // Covers the path `createQueueRetrying`'s idempotent create alone can't reach: a queue that
  // already exists (created here with pg-boss's defaults, same as any queue `startQueue` or an
  // earlier no-opts `registerCron` call already stood up) must still pick up `opts` via
  // `registerCron`'s `updateQueue` follow-up call. Queue name includes `Date.now()` (same pattern
  // as `note` in the `demo.ping` test above) so reruns against this suite's real, persistent
  // Postgres instance never see a queue mutated by a previous run.
  it('registerCron with options updates retryLimit/expiration on a pre-existing queue', async () => {
    const name = `test.cron-opts-preexisting-${Date.now()}`
    await q.boss.createQueue(name)
    const before = await q.boss.getQueue(name)
    expect(before?.retryLimit).not.toBe(0)

    await registerCron(q.boss, name, '0 13 * * 1', async () => {}, {
      retryLimit: 0,
      expireInSeconds: 3600,
    })
    const after = await q.boss.getQueue(name)
    expect(after?.retryLimit).toBe(0)
    expect(after?.expireInSeconds).toBe(3600)
    expect(after?.policy).toBe(before?.policy)
  })

  // The regression this whole fix is about: pg-boss's `updateQueue` resets an omitted `policy` to
  // 'standard' (see queue.ts's doc comment on `registerCron`), so a queue that was deliberately
  // created with a non-standard policy must keep it after `registerCron(..., opts)` runs. Same
  // per-run-unique naming as the test above, for the same reason.
  it('registerCron with options preserves a pre-existing singleton policy', async () => {
    const name = `test.cron-opts-singleton-${Date.now()}`
    await q.boss.createQueue(name, { name, policy: 'singleton' })
    const before = await q.boss.getQueue(name)
    expect(before?.policy).toBe('singleton')

    await registerCron(q.boss, name, '0 13 * * 1', async () => {}, {
      retryLimit: 0,
      expireInSeconds: 3600,
    })
    const after = await q.boss.getQueue(name)
    expect(after?.retryLimit).toBe(0)
    expect(after?.expireInSeconds).toBe(3600)
    expect(after?.policy).toBe('singleton')
  })
})
