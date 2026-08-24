import { auditLog, createDb, orders, supplierOrders } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminDeps } from '../src/http/admin/routes.ts'
import { FULFILLMENT_RETRY_OPTS } from '../src/fulfillment/run-place-order.ts'
import type { SupplierOrderStatusDb } from '../src/fulfillment/transitions.ts'
import { createCaptureNotifier } from '../src/notify/capture.ts'
import type { OwnerNotification } from '../src/notify/notify.ts'
import { createSettings } from '../src/settings.ts'
import { buildServer } from '../src/server.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

interface TestDeps extends AdminDeps {
  sent: OwnerNotification[]
}

describe('orders view + recovery actions', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdOrderIds: string[] = []
  let createdSupplierOrderIds: string[] = []

  afterEach(async () => {
    if (createdSupplierOrderIds.length > 0) {
      await db
        .delete(auditLog)
        .where(and(eq(auditLog.entityType, 'supplier_order'), inArray(auditLog.entityId, createdSupplierOrderIds)))
      await db.delete(supplierOrders).where(inArray(supplierOrders.id, createdSupplierOrderIds))
      createdSupplierOrderIds = []
    }
    if (createdOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, createdOrderIds))
      createdOrderIds = []
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

  // Same idiom as admin-proposals-pages.test.ts's own copy (which itself notes it mirrors
  // admin-decisions.test.ts) — factored per-file, not shared, per the task brief's instruction
  // not to modify those files.
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

  async function seedOrder(): Promise<typeof orders.$inferSelect> {
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`, isTest: false, totalCents: 5000 })
      .returning()
    createdOrderIds.push(row!.id)
    return row!
  }

  async function seedSupplierOrder(opts: {
    orderId: string
    status: SupplierOrderStatusDb
    lastError?: string | null
  }): Promise<typeof supplierOrders.$inferSelect> {
    const [row] = await db
      .insert(supplierOrders)
      .values({
        orderId: opts.orderId,
        supplier: 'mock',
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: opts.status,
        lastError: opts.lastError ?? null,
      })
      .returning()
    createdSupplierOrderIds.push(row!.id)
    return row!
  }

  it('1. unauthenticated GET /admin/orders -> 303 to login', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })

    const res = await app.inject({ method: 'GET', url: '/admin/orders' })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/login')

    await app.close()
  })

  it('2. a needs_attention row renders pinned on top, with lastError escaped and a recovery form', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({
      orderId: order.id,
      status: 'needs_attention',
      lastError: 'stockout: <b>x</b>',
    })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/orders', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(parked.id)
    expect(res.body).toContain('stockout: &lt;b&gt;x&lt;/b&gt;')
    expect(res.body).not.toContain('stockout: <b>x</b>')
    expect(res.body).toContain(`action="/admin/orders/${parked.id}/recover"`)
    expect(res.body).toContain('<select name="target">')
    expect(res.body).toContain('<option value="pending">pending</option>')
    expect(res.body).toContain('<option value="confirmed">confirmed</option>')
    expect(res.body).toContain('<option value="cancelled">cancelled</option>')

    const pinnedIdx = res.body.indexOf(parked.id)
    const otherHeadingIdx = res.body.indexOf('Other orders')
    expect(pinnedIdx).toBeGreaterThanOrEqual(0)
    expect(otherHeadingIdx).toBeGreaterThanOrEqual(0)
    expect(pinnedIdx).toBeLessThan(otherHeadingIdx)

    await app.close()
  })

  it('3. a paid row renders in the lower section without a recovery form', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const paid = await seedSupplierOrder({ orderId: order.id, status: 'paid' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({ method: 'GET', url: '/admin/orders', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(paid.id)
    expect(res.body).not.toContain(`action="/admin/orders/${paid.id}/recover"`)

    const otherHeadingIdx = res.body.indexOf('Other orders')
    const paidIdx = res.body.indexOf(paid.id)
    expect(paidIdx).toBeGreaterThan(otherHeadingIdx)

    await app.close()
  })

  it('4. recover -> pending flips the row, audits owner, and enqueues place-order with the exact shape', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/orders')

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('pending')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'supplier_order'), eq(auditLog.entityId, parked.id)))
    const match = auditRows.find((r) => r.action === 'supplier_order.recovered')
    expect(match).toBeDefined()
    expect(match!.actor).toBe('owner')
    expect(match!.detail).toMatchObject({ from: 'needs_attention', to: 'pending' })

    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'fulfillment.place-order',
      { orderGid: order.shopifyOrderGid },
      { singletonKey: order.shopifyOrderGid, ...FULFILLMENT_RETRY_OPTS },
    )

    await app.close()
  })

  it('5. recover -> cancelled flips the row and does NOT enqueue', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=cancelled',
    })

    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin/orders')

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('cancelled')

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'supplier_order'), eq(auditLog.entityId, parked.id)))
    const match = auditRows.find((r) => r.action === 'supplier_order.recovered')
    expect(match).toBeDefined()
    expect(match!.detail).toMatchObject({ from: 'needs_attention', to: 'cancelled' })

    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('6. recovering an already-recovered row (plain double-submit, first send succeeded) -> idempotent re-send, not the not-recoverable page', async () => {
    // A resubmit of the exact same form, once the row is already AT the requested target, is
    // indistinguishable at the DB layer from "the first send's enqueue failed" (tests 8/9 below)
    // — both look like "row already at target, operator submitted again". The ruled fix treats
    // both the same way: re-send rather than render not-recoverable, relying on pg-boss's
    // singletonKey to dedupe the now-doubled place-order job. See the idempotent re-send path's
    // comment in routes.ts for why repeating the send is safe even when the first one already
    // succeeded.
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const first = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })
    expect(first.statusCode).toBe(303)
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    ;(deps.enqueue as ReturnType<typeof vi.fn>).mockClear()

    const second = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })

    expect(second.statusCode).toBe(303)
    expect(second.headers.location).toBe('/admin/orders')
    expect(second.body).not.toContain('Row was not recoverable')
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(
      'fulfillment.place-order',
      { orderGid: order.shopifyOrderGid },
      { singletonKey: order.shopifyOrderGid, ...FULFILLMENT_RETRY_OPTS },
    )

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'supplier_order'), eq(auditLog.entityId, parked.id)))
    expect(auditRows.some((r) => r.action === 'supplier_order.resent')).toBe(true)

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('pending') // unchanged by the second attempt — only re-sent, not re-transitioned

    await app.close()
  })

  it('7. target=paid -> 400', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=paid',
    })

    expect(res.statusCode).toBe(400)

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('needs_attention') // untouched

    expect(deps.enqueue).not.toHaveBeenCalled()

    await app.close()
  })

  it('8. enqueue failure on fresh recovery -> 200 explicit re-send-FAILED page, transition still committed, alerts recovery_enqueue_failed', async () => {
    const deps = makeDeps({ enqueue: vi.fn(async () => { throw new Error('boom') }) })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Recovered to pending, but the re-send FAILED — submit this form again to retry the re-send.')
    expect(res.body).not.toContain('Row was not recoverable')

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('pending') // transition committed even though the re-send failed

    expect(deps.alert).toHaveBeenCalledWith('critical', 'recovery_enqueue_failed', {
      supplierOrderRowId: parked.id,
      target: 'pending',
    })

    await app.close()
  })

  it('9. resubmitting the same form after an enqueue failure re-sends without a second transition attempt', async () => {
    const enqueue = vi.fn(async () => {})
    enqueue.mockRejectedValueOnce(new Error('boom'))
    enqueue.mockResolvedValue(undefined)
    const deps = makeDeps({ enqueue })
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const parked = await seedSupplierOrder({ orderId: order.id, status: 'needs_attention' })
    const cookie = await loginAndGetCookie(app, deps)

    const first = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })
    expect(first.statusCode).toBe(200)
    expect(first.body).toContain('the re-send FAILED')

    const second = await app.inject({
      method: 'POST',
      url: `/admin/orders/${parked.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })

    expect(second.statusCode).toBe(303)
    expect(second.headers.location).toBe('/admin/orders')

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenNthCalledWith(
      2,
      'fulfillment.place-order',
      { orderGid: order.shopifyOrderGid },
      { singletonKey: order.shopifyOrderGid, ...FULFILLMENT_RETRY_OPTS },
    )

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'supplier_order'), eq(auditLog.entityId, parked.id)))
    const resentRow = auditRows.find((r) => r.action === 'supplier_order.resent')
    expect(resentRow).toBeDefined()
    expect(resentRow!.actor).toBe('owner')
    expect(resentRow!.detail).toMatchObject({ status: 'pending' })

    // Only one 'recovered' audit row (from the first, transition-attempting call) — the resubmit
    // took the idempotent re-send path and never attempted a second transition.
    const recoveredRows = auditRows.filter((r) => r.action === 'supplier_order.recovered')
    expect(recoveredRows).toHaveLength(1)

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, parked.id))
    expect(after!.status).toBe('pending')

    await app.close()
  })

  it('10. recovering a row whose current status is neither needs_attention nor the target -> not-recoverable page, no enqueue', async () => {
    const deps = makeDeps()
    const app = buildServer({ pool, isQueueReady: () => true, admin: deps })
    const order = await seedOrder()
    const paidRow = await seedSupplierOrder({ orderId: order.id, status: 'paid' })
    const cookie = await loginAndGetCookie(app, deps)

    const res = await app.inject({
      method: 'POST',
      url: `/admin/orders/${paidRow.id}/recover`,
      headers: { cookie, ...FORM_HEADERS },
      payload: 'target=pending',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Row was not recoverable (state changed?)')
    expect(deps.enqueue).not.toHaveBeenCalled()

    const [after] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, paidRow.id))
    expect(after!.status).toBe('paid') // untouched

    await app.close()
  })
})
