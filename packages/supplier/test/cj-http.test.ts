import { describe, expect, it, vi } from 'vitest'
import { CjApiError, CjHttpClient, CjPointsBudgetExceededError, InMemoryCjTokenStore } from '@doge-buddy/supplier'

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1'

function envelope(data: unknown, over: Partial<{ code: number; result: boolean; message: string; requestId: string }> = {}) {
  return JSON.stringify({ code: 200, result: true, message: 'success', data, requestId: 'req-1', ...over })
}
const ok = (data: unknown) => new Response(envelope(data), { status: 200 })

function makeClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, over: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = new CjHttpClient({
    apiKey: '123@api@secret',
    tokenStore: new InMemoryCjTokenStore(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init) },
    sleep: async () => {},
    now: () => new Date('2026-08-17T00:00:00Z'),
    ...over,
  })
  return { client, calls }
}

const TOKENS = {
  accessToken: 'AT-1', accessExpiresAt: '2026-09-01T00:00:00Z',
  refreshToken: 'RT-1', refreshExpiresAt: '2027-02-01T00:00:00Z',
}

describe('CjHttpClient auth', () => {
  it('fetches an access token on first request and persists it', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/authentication/getAccessToken')) return ok({
        accessToken: 'AT-1', accessTokenExpiryDate: '2026-09-01T00:00:00Z',
        refreshToken: 'RT-1', refreshTokenExpiryDate: '2027-02-01T00:00:00Z',
      })
      return ok({ pong: true })
    })
    await client.request('GET', '/product/ping', { points: 0 })
    expect(calls[0]!.url).toBe(`${BASE}/authentication/getAccessToken`)
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ apiKey: '123@api@secret' })
    // auth call carries no token header; the data call does
    expect((calls[1]!.init!.headers as Record<string, string>)['CJ-Access-Token']).toBe('AT-1')
  })

  it('reuses a stored, unexpired token without re-authenticating', async () => {
    const store = new InMemoryCjTokenStore()
    await store.save(TOKENS)
    const { client, calls } = makeClient(() => ok({}), { tokenStore: store })
    await client.request('GET', '/x', { points: 0 })
    expect(calls).toHaveLength(1) // no auth round-trip
  })

  it('refreshes when the access token is within 2 days of expiry', async () => {
    const store = new InMemoryCjTokenStore()
    await store.save({ ...TOKENS, accessExpiresAt: '2026-08-18T00:00:00Z' }) // expires tomorrow
    const { client, calls } = makeClient((url) => {
      if (url.endsWith('/authentication/refreshAccessToken')) return ok({
        accessToken: 'AT-2', accessTokenExpiryDate: '2026-09-15T00:00:00Z',
        refreshToken: 'RT-2', refreshTokenExpiryDate: '2027-03-01T00:00:00Z',
      })
      return ok({})
    }, { tokenStore: store })
    await client.request('GET', '/x', { points: 0 })
    expect(calls[0]!.url).toContain('refreshAccessToken')
    expect((await store.load())!.accessToken).toBe('AT-2')
  })
})

describe('CjHttpClient envelope + errors', () => {
  it('unwraps data on success and passes query params', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client, calls } = makeClient(() => ok({ hello: 'dog' }), { tokenStore: store })
    const data = await client.request<{ hello: string }>('GET', '/product/query', { query: { pid: 'p1', size: 5 }, points: 10 })
    expect(data).toEqual({ hello: 'dog' })
    expect(calls[0]!.url).toBe(`${BASE}/product/query?pid=p1&size=5`)
  })

  it('throws CjApiError with code and requestId on envelope failure', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client } = makeClient(() => new Response(envelope(null, { code: 1600100, result: false, message: 'insufficient balance' }), { status: 200 }), { tokenStore: store })
    const err = await client.request('POST', '/shopping/pay/payBalanceV2', { body: {}, points: 10, priority: true }).catch((e) => e)
    expect(err).toBeInstanceOf(CjApiError)
    expect(err.code).toBe(1600100)
    expect(err.requestId).toBe('req-1')
  })

  it('retries on HTTP 429 with backoff, then succeeds', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    let n = 0
    const sleeps: number[] = []
    const { client } = makeClient(() => (++n < 3 ? new Response('{}', { status: 429 }) : ok({ done: true })), {
      tokenStore: store, sleep: async (ms: number) => { sleeps.push(ms) },
    })
    const data = await client.request<{ done: boolean }>('GET', '/x', { points: 0 })
    expect(data).toEqual({ done: true })
    expect(sleeps.length).toBe(2)
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!)
  })
})

describe('CjHttpClient rate limit + points', () => {
  it('spaces consecutive requests to 1 rps via sleep', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const sleeps: number[] = []
    const { client } = makeClient(() => ok({}), { tokenStore: store, sleep: async (ms: number) => { sleeps.push(ms) } })
    await client.request('GET', '/a', { points: 0 })
    await client.request('GET', '/b', { points: 0 })
    expect(sleeps.some((ms) => ms > 0)).toBe(true) // second call waited
  })

  it('tracks points and blocks non-priority calls over budget, allows priority', async () => {
    const store = new InMemoryCjTokenStore(); await store.save(TOKENS)
    const { client } = makeClient(() => ok({}), { tokenStore: store, dailyPointsBudget: 60 })
    await client.request('GET', '/product/listV2', { points: 50 })
    expect(client.pointsSpentToday()).toBe(50)
    await expect(client.request('GET', '/product/listV2', { points: 50 })).rejects.toThrow(CjPointsBudgetExceededError)
    await expect(client.request('GET', '/shopping/order/getOrderDetail', { points: 50, priority: true })).resolves.toEqual({})
  })
})
