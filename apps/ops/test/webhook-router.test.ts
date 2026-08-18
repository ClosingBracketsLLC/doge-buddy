import { auditLog, createDb, orders, webhookEvents } from '@doge-buddy/db'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createAlerter } from '../src/alerts.ts'
import {
  decimalStringToCents,
  shopifyRestAddressToAddress,
  type ShopifyOrderPaidPayload,
  upsertOrderFromPaidPayload,
} from '../src/fulfillment/order-upsert.ts'
import { webhookProcessHandler, type WebhookProcessDeps } from '../src/jobs/webhook-process.ts'
import type { SendOpts } from '../src/fulfillment/types.ts'
import { startQueue } from '../src/queue.ts'
import { createSettings } from '../src/settings.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

let uid = 0
function unique(prefix: string): string {
  uid += 1
  return `${prefix}-${Date.now()}-${uid}`
}

function paidPayload(overrides: Partial<ShopifyOrderPaidPayload> = {}): ShopifyOrderPaidPayload {
  return {
    admin_graphql_api_id: `gid://shopify/Order/${unique('order')}`,
    test: false,
    total_price: '19.99',
    email: 'buyer@example.com',
    order_number: 1001,
    shipping_address: { address1: '123 Main St', city: 'Springfield' },
    line_items: [{ variant_id: 555, quantity: 2 }],
    ...overrides,
  }
}

function makeJob(
  webhookEventId: string,
  name = 'webhook.shopify.process',
): PgBoss.Job<{ webhookEventId: string }> {
  return { id: unique('job'), name, data: { webhookEventId }, expireInSeconds: 900 }
}

describe('decimalStringToCents', () => {
  it.each([
    ['19.99', 1999],
    ['5', 500],
    ['0.05', 5],
    ['100.00', 10000],
    ['19.9', 1990],
    ['-4.50', -450],
    ['0', 0],
    ['0.00', 0],
  ])('%s -> %i cents (no float rounding drift)', (input, expected) => {
    expect(decimalStringToCents(input)).toBe(expected)
  })

  it('rejects malformed input instead of silently coercing it', () => {
    expect(() => decimalStringToCents('not-a-number')).toThrow(RangeError)
    expect(() => decimalStringToCents('1.2.3')).toThrow(RangeError)
    expect(() => decimalStringToCents('')).toThrow(RangeError)
  })
})

describe('shopifyRestAddressToAddress', () => {
  it('maps a full REST shipping_address (name, province_code, country_code, address2, phone) into the Address shape', () => {
    expect(
      shopifyRestAddressToAddress({
        first_name: 'Ada',
        last_name: 'Lovelace',
        name: 'Ada Lovelace',
        address1: '123 Analytical Engine Way',
        address2: 'Suite 2',
        city: 'Springfield',
        province: 'Illinois',
        province_code: 'IL',
        country: 'United States',
        country_code: 'US',
        zip: '62701',
        phone: '555-1234',
      }),
    ).toEqual({
      name: 'Ada Lovelace',
      line1: '123 Analytical Engine Way',
      line2: 'Suite 2',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
      phone: '555-1234',
    })
  })

  it('falls back to first_name + last_name when name is absent', () => {
    expect(
      shopifyRestAddressToAddress({
        first_name: 'Ada',
        last_name: 'Lovelace',
        address1: '123 Analytical Engine Way',
        city: 'Springfield',
        province_code: 'IL',
        country_code: 'US',
        zip: '62701',
      }),
    ).toMatchObject({ name: 'Ada Lovelace' })
  })

  it('falls back to province when province_code is absent', () => {
    expect(
      shopifyRestAddressToAddress({
        name: 'Ada Lovelace',
        address1: '123 Analytical Engine Way',
        city: 'Springfield',
        province: 'Illinois',
        country_code: 'US',
        zip: '62701',
      }),
    ).toMatchObject({ state: 'Illinois' })
  })

  it.each([
    ['name (and no first/last name)', { first_name: null, last_name: null }],
    ['address1', { address1: null }],
    ['city', { city: null }],
    ['state (no province or province_code)', { province: null, province_code: null }],
    ['zip', { zip: null }],
    ['country_code', { country_code: null }],
  ])('returns null when %s is missing', (_label, overrides) => {
    const full = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      address1: '123 Analytical Engine Way',
      city: 'Springfield',
      province_code: 'IL',
      country_code: 'US',
      zip: '62701',
    }
    expect(shopifyRestAddressToAddress({ ...full, ...overrides })).toBeNull()
  })

  it('returns null for null, undefined, and non-object input', () => {
    expect(shopifyRestAddressToAddress(null)).toBeNull()
    expect(shopifyRestAddressToAddress(undefined)).toBeNull()
    expect(shopifyRestAddressToAddress('not an object')).toBeNull()
  })

  it('uppercases country_code and omits line2/phone when absent', () => {
    const address = shopifyRestAddressToAddress({
      name: 'Ada Lovelace',
      address1: '123 Analytical Engine Way',
      city: 'Springfield',
      province_code: 'il',
      country_code: 'us',
      zip: '62701',
    })
    expect(address?.country).toBe('US')
    expect(address).not.toHaveProperty('line2')
    expect(address).not.toHaveProperty('phone')
  })
})

describe('upsertOrderFromPaidPayload', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  it('creates an order row with is_test=false, integer total_cents, and the raw payload stored', async () => {
    const payload = paidPayload({ test: false, total_price: '42.37' })
    const result = await upsertOrderFromPaidPayload(db, payload)
    expect(result.isTest).toBe(false)
    expect(result.orderGid).toBe(payload.admin_graphql_api_id)

    const [row] = await db.select().from(orders).where(eq(orders.id, result.orderRowId))
    expect(row!.isTest).toBe(false)
    expect(row!.totalCents).toBe(4237)
    expect(row!.shopifyOrderGid).toBe(payload.admin_graphql_api_id)
    expect(row!.email).toBe(payload.email)
    expect(row!.shopifyOrderNumber).toBe('1001')
    expect(row!.rawPayload).toEqual(payload)
  })

  it('stores shipping_address ALREADY-NORMALIZED into the Address shape, not the raw REST shape', async () => {
    const payload = paidPayload({
      shipping_address: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        address1: '123 Analytical Engine Way',
        address2: 'Suite 2',
        city: 'Springfield',
        province_code: 'IL',
        country_code: 'US',
        zip: '62701',
        phone: '555-1234',
      },
    })
    const result = await upsertOrderFromPaidPayload(db, payload)

    const [row] = await db.select().from(orders).where(eq(orders.id, result.orderRowId))
    expect(row!.shippingAddress).toEqual({
      name: 'Ada Lovelace',
      line1: '123 Analytical Engine Way',
      line2: 'Suite 2',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
      phone: '555-1234',
    })
    // The raw REST shape is still preserved verbatim in raw_payload.
    expect((row!.rawPayload as ShopifyOrderPaidPayload).shipping_address).toEqual(payload.shipping_address)
  })

  it('stores a null shipping_address when the REST payload is missing required Address fields (the default fixture only has address1/city)', async () => {
    const payload = paidPayload() // default fixture's shipping_address lacks name/state/zip/country
    const result = await upsertOrderFromPaidPayload(db, payload)

    const [row] = await db.select().from(orders).where(eq(orders.id, result.orderRowId))
    expect(row!.shippingAddress).toBeNull()
  })

  it('creates an order row with is_test=true', async () => {
    const payload = paidPayload({ test: true })
    const result = await upsertOrderFromPaidPayload(db, payload)
    expect(result.isTest).toBe(true)

    const [row] = await db.select().from(orders).where(eq(orders.id, result.orderRowId))
    expect(row!.isTest).toBe(true)
  })

  it('upserts on shopify_order_gid: calling it again with the same gid updates the same row, never duplicates it', async () => {
    const payload = paidPayload()
    const first = await upsertOrderFromPaidPayload(db, payload)
    const second = await upsertOrderFromPaidPayload(db, { ...payload, total_price: '99.00' })
    expect(second.orderRowId).toBe(first.orderRowId)

    const rows = await db.select().from(orders).where(eq(orders.shopifyOrderGid, payload.admin_graphql_api_id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.totalCents).toBe(9900)
  })
})

describe('webhookProcessHandler', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  async function insertEvent(source: 'shopify' | 'cj', topic: string | null, payload: unknown): Promise<string> {
    const [row] = await db
      .insert(webhookEvents)
      .values({ source, externalEventId: unique('wh'), topic, payload: payload as object })
      .returning({ id: webhookEvents.id })
    return row!.id
  }

  it('orders/paid (is_test=false) upserts the order and enqueues fulfillment.place-order exactly once with singletonKey + retry opts', async () => {
    const payload = paidPayload({ test: false })
    const webhookEventId = await insertEvent('shopify', 'orders/paid', payload)
    const enqueue = vi.fn(async () => {})
    const deps: WebhookProcessDeps = { db, enqueue }

    await webhookProcessHandler(deps, 'shopify')([makeJob(webhookEventId)])

    const [orderRow] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, payload.admin_graphql_api_id))
    expect(orderRow).toBeDefined()
    expect(orderRow!.isTest).toBe(false)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'fulfillment.place-order',
      { orderGid: payload.admin_graphql_api_id },
      { singletonKey: payload.admin_graphql_api_id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
    )

    const [eventRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId))
    expect(eventRow!.processedAt).not.toBeNull()

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, webhookEventId)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.action).toBe('webhook.processed')
    expect(auditRows[0]!.detail).toEqual({
      source: 'shopify',
      topic: 'orders/paid',
      orderGid: payload.admin_graphql_api_id,
    })
  })

  it('orders/paid (is_test=true) still upserts + enqueues here — the test-order skip is the planner/executor\'s job, not the router\'s', async () => {
    const payload = paidPayload({ test: true })
    const webhookEventId = await insertEvent('shopify', 'orders/paid', payload)
    const enqueue = vi.fn(async () => {})

    await webhookProcessHandler({ db, enqueue }, 'shopify')([makeJob(webhookEventId)])

    const [orderRow] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, payload.admin_graphql_api_id))
    expect(orderRow!.isTest).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('cj topics are stubbed: marks processed + audits webhook.ignored, never enqueues (Task 12 fills in routing)', async () => {
    const webhookEventId = await insertEvent('cj', 'ORDER', { some: 'payload' })
    const enqueue = vi.fn(async () => {})

    await webhookProcessHandler({ db, enqueue }, 'cj')([makeJob(webhookEventId, 'webhook.cj.process')])

    expect(enqueue).not.toHaveBeenCalled()
    const [eventRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId))
    expect(eventRow!.processedAt).not.toBeNull()

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, webhookEventId)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.action).toBe('webhook.ignored')
  })

  it('shopify topics other than orders/paid fall through to webhook.ignored too', async () => {
    const webhookEventId = await insertEvent('shopify', 'orders/create', { id: 1 })
    const enqueue = vi.fn(async () => {})

    await webhookProcessHandler({ db, enqueue }, 'shopify')([makeJob(webhookEventId)])

    expect(enqueue).not.toHaveBeenCalled()
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, webhookEventId)))
    expect(auditRows[0]!.action).toBe('webhook.ignored')
  })

  it('replayed delivery under a NEW webhook event id (same order payload) does not duplicate the order row; enqueue is called again with the same singletonKey so pg-boss dedupes it', async () => {
    const payload = paidPayload()
    const enqueue = vi.fn(async (_name: string, _data: object, _opts?: SendOpts) => {})
    const deps: WebhookProcessDeps = { db, enqueue }

    const firstEventId = await insertEvent('shopify', 'orders/paid', payload)
    await webhookProcessHandler(deps, 'shopify')([makeJob(firstEventId)])

    const secondEventId = await insertEvent('shopify', 'orders/paid', payload)
    await webhookProcessHandler(deps, 'shopify')([makeJob(secondEventId)])

    const orderRows = await db.select().from(orders).where(eq(orders.shopifyOrderGid, payload.admin_graphql_api_id))
    expect(orderRows).toHaveLength(1)

    expect(enqueue).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = enqueue.mock.calls
    expect(firstCall![2]?.singletonKey).toBe(payload.admin_graphql_api_id)
    expect(secondCall![2]?.singletonKey).toBe(payload.admin_graphql_api_id)
  })

  it('a poison job (malformed total_price) fails alone: the second job in the same batch is still processed + audited, and the call rejects so pg-boss retries only the poisoned job', async () => {
    const poisonPayload = paidPayload({ total_price: 'not-a-number' })
    const poisonEventId = await insertEvent('shopify', 'orders/paid', poisonPayload)
    const goodEventId = await insertEvent('shopify', 'orders/create', { id: 42 })
    const enqueue = vi.fn(async () => {})
    const deps: WebhookProcessDeps = { db, enqueue }

    await expect(webhookProcessHandler(deps, 'shopify')([makeJob(poisonEventId), makeJob(goodEventId)])).rejects.toThrow()

    // Second job in the batch still got processed + audited despite the first one throwing.
    const [goodRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, goodEventId))
    expect(goodRow!.processedAt).not.toBeNull()
    const goodAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, goodEventId)))
    expect(goodAudit).toHaveLength(1)

    // The poisoned job never got marked processed and never got an audit row — it must retry.
    const [poisonRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, poisonEventId))
    expect(poisonRow!.processedAt).toBeNull()
    const poisonAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'webhook_event'), eq(auditLog.entityId, poisonEventId)))
    expect(poisonAudit).toHaveLength(0)

    // No order row should have been created from the poisoned payload.
    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderGid, poisonPayload.admin_graphql_api_id))
    expect(orderRows).toHaveLength(0)
  })
})

describe('webhookProcessHandler — per-job isolation under the real pg-boss registration', () => {
  const { db, pool } = createDb(url)
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined

  afterAll(async () => {
    await queue?.stop()
    await pool.end()
  })

  it(
    'a poison job sent to the real webhook.shopify.process queue does not block a sibling job (queue.ts registers batchSize 1, pg-boss default)',
    async () => {
      const mockLog = { info: () => {}, warn: () => {}, error: () => {} }
      queue = await startQueue(url, {
        adapter: new MockSupplierAdapter(),
        settings: createSettings(db),
        alert: createAlerter(db, mockLog),
      })

      const poisonPayload = paidPayload({ total_price: 'not-a-number' })
      const [poisonEvent] = await db
        .insert(webhookEvents)
        .values({
          source: 'shopify',
          externalEventId: unique('wh-real-poison'),
          topic: 'orders/paid',
          payload: poisonPayload,
        })
        .returning({ id: webhookEvents.id })
      const [goodEvent] = await db
        .insert(webhookEvents)
        .values({
          source: 'shopify',
          externalEventId: unique('wh-real-good'),
          topic: 'orders/create',
          payload: { id: 1 },
        })
        .returning({ id: webhookEvents.id })

      // Poison sent first, good second: if the batch handler ever received both together and
      // isolation depended solely on internal try/catch, this would still pass — the point of
      // this test is that it also passes when routed through the ACTUAL worker registration in
      // queue.ts, where pg-boss's own batchSize=1 default fetches (and completes/fails) them
      // one at a time.
      await queue.boss.send('webhook.shopify.process', { webhookEventId: poisonEvent!.id })
      await queue.boss.send('webhook.shopify.process', { webhookEventId: goodEvent!.id })

      let processed = false
      for (let i = 0; i < 50 && !processed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, goodEvent!.id))
        processed = row?.processedAt != null
      }
      expect(processed).toBe(true)

      // The poisoned job was never marked processed — its failure never propagated to (nor was
      // masked by) the good job's success.
      const [poisonRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, poisonEvent!.id))
      expect(poisonRow!.processedAt).toBeNull()
    },
    15000,
  )
})
