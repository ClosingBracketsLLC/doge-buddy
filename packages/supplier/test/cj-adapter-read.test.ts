import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CJSupplierAdapter, CjHttpClient, InMemoryCjTokenStore, parseAgingDays } from '@doge-buddy/supplier'

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1'

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/cj/${name}.json`, import.meta.url), 'utf8'))
}

function envelope(data: unknown) {
  return JSON.stringify({ code: 200, result: true, message: 'success', data, requestId: 'req-1' })
}
const ok = (data: unknown) => new Response(envelope(data), { status: 200 })

const TOKENS = {
  accessToken: 'AT-1', accessExpiresAt: '2026-09-01T00:00:00Z',
  refreshToken: 'RT-1', refreshExpiresAt: '2027-02-01T00:00:00Z',
}

/** Mirrors Task 4's makeClient, but pre-seeds the token store so no auth round-trip happens,
 * and wraps the wired-up CjHttpClient in a CJSupplierAdapter for read-method testing. */
async function makeAdapter(data: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const store = new InMemoryCjTokenStore()
  await store.save(TOKENS)
  const client = new CjHttpClient({
    apiKey: 'test-key',
    tokenStore: store,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return ok(data) },
    sleep: async () => {},
    now: () => new Date('2026-08-17T00:00:00Z'),
  })
  const adapter = new CJSupplierAdapter({ client })
  return { adapter, client, calls }
}

describe('CJSupplierAdapter read methods', () => {
  it('searchProducts builds the listV2 query and maps summaries', async () => {
    const { adapter, client, calls } = await makeAdapter(loadFixture('product-listV2'))
    const result = await adapter.searchProducts({
      keyword: 'dog rope', countryCode: 'US', trending: true, pageSize: 10,
    })

    expect(calls).toHaveLength(1) // no auth round-trip
    expect(calls[0]!.url).toBe(
      `${BASE}/product/listV2?keyWord=dog%20rope&countryCode=US&page=1&size=10&productFlag=0&verifiedWarehouse=1`,
    )
    expect(result[0]).toEqual({
      supplierProductId: 'cjp-1',
      title: 'Interactive Dog Rope Toy',
      imageUrl: 'https://cdn.cj.example/rope.jpg',
      sellPriceCents: 620,
      listedCount: 1200,
      categoryName: 'Pet Toys',
    })
    expect(result[1]!.sellPriceCents).toBe(480) // string USD input
    expect(client.pointsSpentToday()).toBe(50)
  })

  it('getProduct fetches product/query and maps detail + variants', async () => {
    const { adapter, client, calls } = await makeAdapter(loadFixture('product-query'))
    const detail = await adapter.getProduct('cjp-1')

    expect(calls[0]!.url).toBe(`${BASE}/product/query?pid=cjp-1&features=enable_description`)
    expect(detail.descriptionHtml).toBe('<p>Durable cotton rope toy.</p>')
    expect(detail.imageUrls).toEqual([
      'https://cdn.cj.example/rope.jpg',
      'https://cdn.cj.example/rope2.jpg',
    ])
    expect(detail.variants).toHaveLength(2)
    expect(detail.variants[1]).toEqual({
      supplierVariantId: 'cjv-2',
      sku: 'CJ-ROPE-L',
      name: 'Large',
      priceCents: 710,
      weightGrams: 200,
      imageUrl: undefined, // null -> undefined
    })
    expect(client.pointsSpentToday()).toBe(10)
  })

  it('getVariantStock fetches stock/queryByVid and maps warehouse entries', async () => {
    const { adapter, client, calls } = await makeAdapter(loadFixture('stock-queryByVid'))
    const stock = await adapter.getVariantStock('cjv-1')

    expect(calls[0]!.url).toBe(`${BASE}/product/stock/queryByVid?vid=cjv-1`)
    expect(stock).toEqual([
      { countryCode: 'US', quantity: 42, verified: true },
      { countryCode: 'CN', quantity: 500, verified: false },
    ])
    expect(client.pointsSpentToday()).toBe(10)
  })

  it('quoteShipping posts freightCalculate and maps options', async () => {
    const { adapter, client, calls } = await makeAdapter(loadFixture('freight-calculate'))
    const options = await adapter.quoteShipping({
      fromCountry: 'US',
      toCountry: 'US',
      toZip: '30301',
      items: [{ supplierVariantId: 'cjv-1', quantity: 2 }],
    })

    expect(calls[0]!.url).toBe(`${BASE}/logistic/freightCalculate`)
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      startCountryCode: 'US',
      endCountryCode: 'US',
      zip: '30301',
      products: [{ vid: 'cjv-1', quantity: 2 }],
    })
    expect(options).toEqual([
      { name: 'USPS+', priceCents: 499, minDays: 3, maxDays: 7 },
      { name: 'CJPacket US', priceCents: 1250, minDays: 2, maxDays: 2 },
    ])
    expect(client.pointsSpentToday()).toBe(10)
  })

  it('getBalance converts amount/freeze to cents', async () => {
    const { adapter, client, calls } = await makeAdapter(loadFixture('balance'))
    const balance = await adapter.getBalance()

    expect(calls[0]!.url).toBe(`${BASE}/shopping/pay/getBalance`)
    expect(balance).toEqual({ availableCents: 15320, frozenCents: 1000 })
    expect(client.pointsSpentToday()).toBe(0) // 0 points, priority
  })

  it('write/order/dispute/webhook methods are not yet implemented', async () => {
    const { adapter } = await makeAdapter({})
    await expect(
      adapter.placeOrder({
        idempotencyKey: 'x',
        shippingAddress: { name: 'a', line1: 'b', city: 'c', state: 'd', zip: 'e', country: 'US' },
        items: [],
        logisticName: 'x',
        fromCountry: 'US',
      }),
    ).rejects.toThrow('implemented in Task 6')
  })
})

describe('parseAgingDays', () => {
  it.each([
    ['3-7', { minDays: 3, maxDays: 7 }],
    ['2', { minDays: 2, maxDays: 2 }],
    ['10-15 days', { minDays: 10, maxDays: 15 }],
    ['garbage', { minDays: 1, maxDays: 30 }],
  ])('parses %s', (input, expected) => {
    expect(parseAgingDays(input)).toEqual(expected)
  })

  it('never throws on unexpected input', () => {
    expect(() => parseAgingDays('' as string)).not.toThrow()
    expect(parseAgingDays('')).toEqual({ minDays: 1, maxDays: 30 })
  })
})
