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
  // `registerCron` (via `boss.schedule`) writes a durable row to pg-boss's own `schedule` table,
  // on top of the queue row itself — neither is torn down by anything in this suite, so without
  // explicit cleanup every run of these `registerCron`-with-opts tests below would permanently
  // grow `pgboss.queue`/`pgboss.schedule` with dead weekly schedules in the shared, persistent
  // test Postgres instance. Each test that calls `registerCron` pushes its queue name here;
  // `afterAll` unschedules + deletes every one of them.
  const cronTestQueueNames: string[] = []

  beforeAll(async () => {
    const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
    q = await startQueue(url, {
      adapter: new MockSupplierAdapter(),
      settings: createSettings(db),
      alert: createAlerter(db, mockLog),
    })
  })
  afterAll(async () => {
    for (const name of cronTestQueueNames) {
      await q.boss.unschedule(name)
      await q.boss.deleteQueue(name)
    }
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
    cronTestQueueNames.push('test.cron-opts')
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
    cronTestQueueNames.push(name)
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
    cronTestQueueNames.push(name)
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

  // CRITICAL-1a (support.agent-run fix round 1): `index.ts` doesn't call `registerCron` for
  // `support.agent-run` (it's a producer-driven queue, not a cron), so it hand-rolls the exact same
  // create-then-force-update sequence `registerCron` uses above, inline. This proves that inline
  // sequence actually forces `'stately'` onto a queue that pre-exists with a DIFFERENT policy (the
  // state every real deploy that predates this fix is in — the queue was created with `'singleton'`
  // by an earlier boot) — `createQueueRetrying`'s `createQueue` call alone is a silent no-op there.
  describe('CRITICAL-1a: forcing policy onto a pre-existing support.agent-run-shaped queue', () => {
    it('createQueueRetrying + an explicit updateQueue upgrades a pre-existing singleton queue to stately', async () => {
      const name = `test.agent-run-shaped-${Date.now()}`
      try {
        await q.boss.createQueue(name, { name, policy: 'singleton' })
        expect((await q.boss.getQueue(name))?.policy).toBe('singleton')

        // The exact two-call sequence index.ts uses for SUPPORT_AGENT_QUEUE.
        await q.boss.createQueue(name, { name, policy: 'stately' }) // createQueueRetrying's own call, inlined — no-ops, queue already exists
        await q.boss.updateQueue(name, { name, policy: 'stately' })

        expect((await q.boss.getQueue(name))?.policy).toBe('stately')
      } finally {
        await q.boss.deleteQueue(name)
      }
    })
  })

  // Empirical proof of the CRITICAL-1a claim itself: pg-boss's `'singleton'` policy only indexes
  // (and therefore only dedupes) the ACTIVE state — two sends with the same key while the FIRST is
  // merely `created` (queued, no worker registered on either test queue below to promote it) both
  // succeed, so a burst of selection cycles really can stack up more than one pending job per
  // ticket under `'singleton'`. `'stately'` additionally indexes the `created` state (pg-boss's
  // `job_i3`, `WHERE state <= 'active' AND policy = 'stately'`), so the second send is rejected
  // (pg-boss returns a `null` id on a dedup collision, same as its documented 'short'/'singleton'
  // behavior) even though nothing has started running yet. No gated handler or timing wait needed
  // here (unlike `queue-fulfillment.test.ts`'s active-state dedupe test) — neither queue below has
  // a registered worker at all, so both jobs are guaranteed to still be sitting `created`.
  describe('CRITICAL-1a: stately dedupes a queued (not yet active) duplicate; singleton does not', () => {
    it("policy 'singleton' does NOT dedupe two sends with the same key while both are merely queued", async () => {
      const name = `test.policy-singleton-created-dedupe-${Date.now()}`
      try {
        await q.boss.createQueue(name, { name, policy: 'singleton' })
        const opts = { singletonKey: 'ticket-a' }

        const firstId = await q.boss.send(name, {}, opts)
        const secondId = await q.boss.send(name, {}, opts)

        expect(firstId).not.toBeNull()
        expect(secondId).not.toBeNull() // the bug: a second queued duplicate is NOT rejected
      } finally {
        // `deleteQueue` fails on a foreign-key violation while any job row still references the
        // queue (the two `send()`s above left at least one) — purge first.
        await q.boss.purgeQueue(name)
        await q.boss.deleteQueue(name)
      }
    })

    it("policy 'stately' DOES dedupe two sends with the same key while the first is still merely queued", async () => {
      const name = `test.policy-stately-created-dedupe-${Date.now()}`
      try {
        await q.boss.createQueue(name, { name, policy: 'stately' })
        const opts = { singletonKey: 'ticket-a' }

        const firstId = await q.boss.send(name, {}, opts)
        const secondId = await q.boss.send(name, {}, opts)

        expect(firstId).not.toBeNull()
        expect(secondId).toBeNull() // the fix: a queued duplicate is rejected outright
      } finally {
        await q.boss.purgeQueue(name)
        await q.boss.deleteQueue(name)
      }
    })
  })
})
