import { createDb, auditLog } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import { startQueue, type Queue } from '../src/queue.ts'
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
})
