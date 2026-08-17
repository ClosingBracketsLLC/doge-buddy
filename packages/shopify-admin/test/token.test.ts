import { describe, expect, it } from 'vitest'
import { ShopifyTokenManager } from '@doge-buddy/shopify-admin'

function makeManager(handler: (url: string, init?: RequestInit) => Response, nowRef: { t: number }) {
  const calls: { url: string; init?: RequestInit }[] = []
  const mgr = new ShopifyTokenManager({
    shopDomain: 'doge-test.myshopify.com', clientId: 'cid', clientSecret: 'csec',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init) },
    now: () => new Date(nowRef.t),
  })
  return { mgr, calls }
}
const tokenResponse = (token: string, expiresIn = 86399) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 })

describe('ShopifyTokenManager', () => {
  it('requests a client-credentials token on first use', async () => {
    const nowRef = { t: Date.parse('2026-08-17T00:00:00Z') }
    const { mgr, calls } = makeManager(() => tokenResponse('tok-1'), nowRef)
    expect(await mgr.getToken()).toBe('tok-1')
    expect(calls[0]!.url).toBe('https://doge-test.myshopify.com/admin/oauth/access_token')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ client_id: 'cid', client_secret: 'csec', grant_type: 'client_credentials' })
    expect(await mgr.getToken()).toBe('tok-1')
    expect(calls).toHaveLength(1) // cached
  })
  it('refreshes 5 minutes before expiry', async () => {
    const nowRef = { t: Date.parse('2026-08-17T00:00:00Z') }
    let n = 0
    const { mgr, calls } = makeManager(() => tokenResponse(`tok-${++n}`), nowRef)
    await mgr.getToken()
    nowRef.t += (86399 - 240) * 1000 // 4 minutes before expiry → within refresh window
    expect(await mgr.getToken()).toBe('tok-2')
    expect(calls).toHaveLength(2)
  })
  it('invalidate() forces a new token on next call', async () => {
    const nowRef = { t: 0 }
    let n = 0
    const { mgr } = makeManager(() => tokenResponse(`tok-${++n}`), nowRef)
    await mgr.getToken()
    mgr.invalidate()
    expect(await mgr.getToken()).toBe('tok-2')
  })
  it('throws a readable error on non-2xx', async () => {
    const nowRef = { t: 0 }
    const { mgr } = makeManager(() => new Response('{"errors":"invalid client"}', { status: 401 }), nowRef)
    await expect(mgr.getToken()).rejects.toThrow(/401/)
  })
})
