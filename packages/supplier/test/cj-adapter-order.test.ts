import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CjApiError,
  CJSupplierAdapter,
  CjHttpClient,
  InMemoryCjTokenStore,
  mapCjOrderStatus,
} from '@doge-buddy/supplier'
import type { Address } from '@doge-buddy/supplier'

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1'

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/cj/${name}.json`, import.meta.url), 'utf8'))
}

function envelope(
  data: unknown,
  over: Partial<{ code: number; result: boolean; message: string; requestId: string }> = {},
) {
  return JSON.stringify({ code: 200, result: true, message: 'success', data, requestId: 'req-1', ...over })
}
const ok = (data: unknown) => new Response(envelope(data), { status: 200 })

const TOKENS = {
  accessToken: 'AT-1', accessExpiresAt: '2026-09-01T00:00:00Z',
  refreshToken: 'RT-1', refreshExpiresAt: '2027-02-01T00:00:00Z',
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** Mirrors Task 5's makeAdapter, but accepts a URL-branching handler so a single test can
 * script multiple sequential CJ calls (pre-check + create, disputeProducts + disputeConfirmInfo). */
async function makeAdapter(handler: Handler, opts: { openId?: string; sandbox?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const store = new InMemoryCjTokenStore()
  await store.save(TOKENS)
  const client = new CjHttpClient({
    apiKey: 'test-key',
    tokenStore: store,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    },
    sleep: async () => {},
    now: () => new Date('2026-08-17T00:00:00Z'),
  })
  const adapter = new CJSupplierAdapter({ client, ...opts })
  return { adapter, client, calls }
}

function bodyOf(call: { init?: RequestInit }): unknown {
  return JSON.parse(call.init!.body as string)
}

const ADDRESS: Address = {
  name: 'Jane Doe',
  phone: '4045551234',
  email: 'jane@example.com',
  line1: '123 Main St',
  line2: 'Apt 4',
  city: 'Atlanta',
  state: 'GA',
  zip: '30301',
  country: 'US',
}

const PLACE_REQ = {
  idempotencyKey: 'DB-abc',
  shippingAddress: ADDRESS,
  items: [{ supplierVariantId: 'cjv-9', quantity: 2 }],
  logisticName: 'USPS+',
  fromCountry: 'US',
}

const EXPECTED_CREATE_ORDER_BODY = {
  orderNumber: 'DB-abc',
  shippingCountryCode: 'US',
  fromCountryCode: 'US',
  logisticName: 'USPS+',
  shopLogisticsType: 1,
  payType: 3,
  consigneeName: 'Jane Doe',
  phone: '4045551234',
  email: 'jane@example.com',
  addressLine1: '123 Main St',
  addressLine2: 'Apt 4',
  city: 'Atlanta',
  province: 'GA',
  zip: '30301',
  products: [{ vid: 'cjv-9', quantity: 2 }],
}

const EXPECTED_ORDER_RESULT = {
  supplierOrderId: 'cjo-1',
  shipmentOrderId: 'cjso-1',
  productAmountCents: 1330,
  postageAmountCents: 499,
  totalAmountCents: 1829,
}

describe('CJSupplierAdapter.placeOrder', () => {
  it('pre-checks order/list; posts createOrderV3 with the full body when no order exists', async () => {
    const { adapter, calls } = await makeAdapter((url) => {
      if (url.includes('/shopping/order/list')) return ok({ list: [] })
      return ok(loadFixture('order-create'))
    })
    const result = await adapter.placeOrder(PLACE_REQ)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/list?orderNumbers=DB-abc`)
    expect(calls[1]!.url).toBe(`${BASE}/shopping/order/createOrderV3`)
    expect(bodyOf(calls[1]!)).toEqual(EXPECTED_CREATE_ORDER_BODY)
    expect(bodyOf(calls[1]!)).toMatchObject({ payType: 3, shopLogisticsType: 1 })
    expect((bodyOf(calls[1]!) as { orderNumber: string }).orderNumber).toBe(PLACE_REQ.idempotencyKey)
    expect(result).toEqual(EXPECTED_ORDER_RESULT)
  })

  it('returns the existing order (mapped) without calling createOrderV3 when a match exists', async () => {
    const { adapter, calls } = await makeAdapter((url) => {
      if (url.includes('/shopping/order/list')) return ok(loadFixture('order-list-existing'))
      throw new Error(`unexpected call: ${url}`)
    })
    const result = await adapter.placeOrder(PLACE_REQ)

    expect(calls).toHaveLength(1) // no createOrderV3 call
    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/list?orderNumbers=DB-abc`)
    expect(result).toEqual(EXPECTED_ORDER_RESULT)
  })

  it('calls createOrderV3 when order/list returns an entry whose orderNumber does not match (CJ filter not trusted)', async () => {
    const { adapter, calls } = await makeAdapter((url) => {
      if (url.includes('/shopping/order/list')) return ok(loadFixture('order-list-nonmatching'))
      return ok(loadFixture('order-create'))
    })
    const result = await adapter.placeOrder(PLACE_REQ)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/list?orderNumbers=DB-abc`)
    expect(calls[1]!.url).toBe(`${BASE}/shopping/order/createOrderV3`)
    expect(bodyOf(calls[1]!)).toEqual(EXPECTED_CREATE_ORDER_BODY)
    expect(result).toEqual(EXPECTED_ORDER_RESULT)
  })

  it('includes sandbox: true in the createOrderV3 body when constructed with sandbox: true', async () => {
    const { adapter, calls } = await makeAdapter(
      (url) => {
        if (url.includes('/shopping/order/list')) return ok({ list: [] })
        return ok(loadFixture('order-create'))
      },
      { sandbox: true },
    )
    await adapter.placeOrder(PLACE_REQ)

    expect(bodyOf(calls[1]!)).toEqual({ ...EXPECTED_CREATE_ORDER_BODY, sandbox: true })
  })

  it('proceeds to createOrderV3 without crashing when the order-list response omits `list` entirely', async () => {
    const { adapter, calls } = await makeAdapter((url) => {
      if (url.includes('/shopping/order/list')) return ok({}) // no `list` key at all
      return ok(loadFixture('order-create'))
    })
    const result = await adapter.placeOrder(PLACE_REQ)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe(`${BASE}/shopping/order/createOrderV3`)
    expect(result).toEqual(EXPECTED_ORDER_RESULT)
  })
})

describe('CJSupplierAdapter.confirmOrder', () => {
  it('PATCHes /shopping/order/confirmOrder with { orderId } and resolves', async () => {
    const { adapter, calls } = await makeAdapter(() => ok({}))

    await expect(adapter.confirmOrder('cjo-1')).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.init!.method).toBe('PATCH')
    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/confirmOrder`)
    expect(bodyOf(calls[0]!)).toEqual({ orderId: 'cjo-1' })
  })

  it('propagates CjApiError on envelope failure', async () => {
    const { adapter } = await makeAdapter(() =>
      new Response(envelope(null, { code: 500, result: false, message: 'server error' }), { status: 200 }),
    )
    const err = await adapter.confirmOrder('cjo-1').catch((e) => e)
    expect(err).toBeInstanceOf(CjApiError)
    expect(err.code).toBe(500)
  })
})

describe('CJSupplierAdapter.payOrder', () => {
  it('returns { paid: true } on success and posts payBalanceV2 with shipmentOrderId', async () => {
    const { adapter, calls } = await makeAdapter(() => ok({}))
    const result = await adapter.payOrder('cjso-1')

    expect(calls[0]!.url).toBe(`${BASE}/shopping/pay/payBalanceV2`)
    expect(bodyOf(calls[0]!)).toEqual({ shipmentOrderId: 'cjso-1' })
    expect(result).toEqual({ paid: true })
  })

  it('catches CJ code 1600100 and returns insufficient_balance without throwing', async () => {
    const { adapter } = await makeAdapter(() =>
      new Response(envelope(null, { code: 1600100, result: false, message: 'insufficient balance' }), {
        status: 200,
      }),
    )
    const result = await adapter.payOrder('cjso-1')
    expect(result).toEqual({ paid: false, failureReason: 'insufficient_balance' })
  })

  it('rethrows CjApiError for other envelope error codes', async () => {
    const { adapter } = await makeAdapter(() =>
      new Response(envelope(null, { code: 500, result: false, message: 'server error' }), { status: 200 }),
    )
    const err = await adapter.payOrder('cjso-1').catch((e) => e)
    expect(err).toBeInstanceOf(CjApiError)
    expect(err.code).toBe(500)
  })
})

describe('CJSupplierAdapter.getOrderStatus / getTracking', () => {
  it('getOrderStatus maps orderStatus via mapCjOrderStatus', async () => {
    const { adapter, calls } = await makeAdapter(() => ok(loadFixture('order-detail')))
    const status = await adapter.getOrderStatus('cjo-1')

    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/getOrderDetail?orderId=cjo-1`)
    expect(status).toEqual({ value: 'shipped', raw: 'SHIPPED' })
  })

  it('getTracking maps trackNumber/logisticName/lastMileTrackNumber', async () => {
    const { adapter, calls } = await makeAdapter(() => ok(loadFixture('order-detail')))
    const tracking = await adapter.getTracking('cjo-1')

    expect(calls[0]!.url).toBe(`${BASE}/shopping/order/getOrderDetail?orderId=cjo-1`)
    expect(tracking).toEqual({
      trackingNumber: 'CJTRACK123',
      carrier: 'USPS+',
      lastMileTrackingNumber: '9400111899560000000000',
    })
  })

  it('getTracking returns null when the order detail has no trackNumber yet', async () => {
    const { adapter } = await makeAdapter(() => ok({ orderId: 'cjo-1', orderStatus: 'PENDING' }))
    expect(await adapter.getTracking('cjo-1')).toBeNull()
  })
})

describe('CJSupplierAdapter.getDisputeOptions', () => {
  it('combines disputeProducts + disputeConfirmInfo into DisputeOptions', async () => {
    const { adapter, calls } = await makeAdapter((url) => {
      if (url.includes('/disputes/disputeProducts')) return ok(loadFixture('dispute-products'))
      if (url.includes('/disputes/disputeConfirmInfo')) return ok(loadFixture('dispute-confirm-info'))
      throw new Error(`unexpected call: ${url}`)
    })
    const options = await adapter.getDisputeOptions('cjo-1')

    expect(calls[0]!.url).toBe(`${BASE}/disputes/disputeProducts?orderId=cjo-1`)
    expect(calls[1]!.url).toBe(`${BASE}/disputes/disputeConfirmInfo`)
    expect(options).toEqual({
      disputable: true,
      maxRefundCents: 1829,
      reasons: [
        { id: 'r-42', label: 'Damaged on arrival' },
        { id: 'r-43', label: 'Package lost' },
      ],
      allowedKinds: ['refund', 'reissue'],
    })
  })
})

describe('CJSupplierAdapter.openDispute / getDispute', () => {
  it('openDispute posts businessDisputeId = idempotencyKey, expectResultOption, refundAmount in dollars', async () => {
    const { adapter, calls } = await makeAdapter(() => ok(loadFixture('dispute-create')))
    const result = await adapter.openDispute({
      supplierOrderId: 'cjo-1',
      idempotencyKey: 'DB-disp-1',
      reasonId: 'r-42',
      kind: 'refund',
      amountCents: 1829,
      message: 'Item arrived damaged',
      evidenceUrls: ['https://example.com/photo.jpg'],
    })

    expect(calls[0]!.url).toBe(`${BASE}/disputes/create`)
    expect(bodyOf(calls[0]!)).toEqual({
      businessDisputeId: 'DB-disp-1',
      orderId: 'cjo-1',
      reasonId: 'r-42',
      expectResultOption: 1,
      refundAmount: 18.29,
      message: 'Item arrived damaged',
      imageUrls: ['https://example.com/photo.jpg'],
    })
    expect(result).toEqual({ disputeId: 'cjd-1' })
  })

  it('openDispute sets expectResultOption: 2 for kind "reissue"', async () => {
    const { adapter, calls } = await makeAdapter(() => ok(loadFixture('dispute-create')))
    await adapter.openDispute({
      supplierOrderId: 'cjo-1',
      idempotencyKey: 'DB-disp-2',
      reasonId: 'r-43',
      kind: 'reissue',
      amountCents: 1829,
      message: 'Package lost',
    })
    expect((bodyOf(calls[0]!) as { expectResultOption: number }).expectResultOption).toBe(2)
  })

  it('getDispute maps disputeStatus via the dispute status table', async () => {
    const { adapter, calls } = await makeAdapter(() => ok(loadFixture('dispute-detail')))
    const status = await adapter.getDispute('cjd-1')

    expect(calls[0]!.url).toBe(`${BASE}/disputes/getDisputeDetail?disputeId=cjd-1`)
    expect(status).toEqual({ value: 'pending', raw: 'processing' })
  })
})

describe('CJSupplierAdapter.verifyWebhook', () => {
  const openId = 'cj-open-id-123'
  const rawBody = Buffer.from(JSON.stringify({ type: 'ORDER', orderId: 'cjo-1' }))

  function sign(body: Buffer): string {
    return createHmac('sha256', openId).update(body).digest('base64')
  }

  it('returns true for a correct signature under the cj-signature header', async () => {
    const { adapter } = await makeAdapter(() => ok({}), { openId })
    expect(adapter.verifyWebhook(rawBody, { 'cj-signature': sign(rawBody) })).toBe(true)
  })

  it('looks up the signature header case-insensitively', async () => {
    const { adapter } = await makeAdapter(() => ok({}), { openId })
    expect(adapter.verifyWebhook(rawBody, { 'CJ-Signature': sign(rawBody) })).toBe(true)
  })

  it('returns false when the body is tampered with', async () => {
    const { adapter } = await makeAdapter(() => ok({}), { openId })
    const tampered = Buffer.from(JSON.stringify({ type: 'ORDER', orderId: 'cjo-2' }))
    expect(adapter.verifyWebhook(tampered, { 'cj-signature': sign(rawBody) })).toBe(false)
  })

  it('returns false when no signature header is present', async () => {
    const { adapter } = await makeAdapter(() => ok({}), { openId })
    expect(adapter.verifyWebhook(rawBody, {})).toBe(false)
  })

  it('returns false when no openId is configured', async () => {
    const { adapter } = await makeAdapter(() => ok({}))
    expect(adapter.verifyWebhook(rawBody, { 'cj-signature': sign(rawBody) })).toBe(false)
  })
})

describe('CJSupplierAdapter.parseWebhook', () => {
  it('maps a LOGISTICS event using messageId as externalEventId', async () => {
    const { adapter } = await makeAdapter(() => ok({}))
    const body = { type: 'LOGISTICS', messageId: 'm-1', orderId: 'cjo-1' }
    const rawBody = Buffer.from(JSON.stringify(body))

    expect(adapter.parseWebhook(rawBody)).toEqual({
      type: 'logistics',
      externalEventId: 'm-1',
      supplierOrderId: 'cjo-1',
      payload: body,
    })
  })

  it('falls back to a sha256 hex digest when the body has no messageId/requestId', async () => {
    const { adapter } = await makeAdapter(() => ok({}))
    const rawBody = Buffer.from(JSON.stringify({ type: 'STOCK' }))
    const event = adapter.parseWebhook(rawBody)

    expect(event.type).toBe('stock')
    expect(event.externalEventId).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('mapCjOrderStatus', () => {
  it.each([
    ['CREATED', 'created'],
    ['created', 'created'],
    ['IN_CART', 'created'],
    ['in_cart', 'created'],
    ['UNPAID', 'unpaid'],
    ['PENDING', 'pending'],
    ['PROCESSING', 'processing'],
    ['SHIPPED', 'shipped'],
    ['DELIVERED', 'delivered'],
    ['CANCELLED', 'cancelled'],
    ['SOMETHING_ELSE', 'unknown'],
  ])('maps %s -> %s', (raw, expected) => {
    expect(mapCjOrderStatus(raw)).toBe(expected)
  })
})
