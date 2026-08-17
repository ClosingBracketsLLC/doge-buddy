import { describe, expect, it } from 'vitest'
import {
  ShopifyAdminClient, ShopifyGraphqlError, ShopifyHttpError, ShopifyTokenManager,
  ShopifyUserError, assertNoUserErrors, withIdempotencyKey,
} from '@doge-buddy/shopify-admin'

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 })
const gql = (data: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ data, ...extra }), { status: 200 })

function makeClient(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const route = (url: string, init?: RequestInit) =>
    url.endsWith('/admin/oauth/access_token') ? tokenOk() : handler(url, init)
  const fetchImpl = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return route(url, init) }
  const tokenManager = new ShopifyTokenManager({ shopDomain: 's.myshopify.com', clientId: 'a', clientSecret: 'b', fetchImpl })
  const client = new ShopifyAdminClient({ shopDomain: 's.myshopify.com', tokenManager, fetchImpl, sleep: async () => {} })
  return { client, calls }
}

describe('ShopifyAdminClient', () => {
  it('POSTs to the pinned 2026-07 endpoint with the token header', async () => {
    const { client, calls } = makeClient(() => gql({ shop: { name: 'Doge' } }))
    const data = await client.graphql<{ shop: { name: string } }>('query { shop { name } }')
    expect(data.shop.name).toBe('Doge')
    const call = calls.find((c) => c.url.includes('/graphql.json'))!
    expect(call.url).toBe('https://s.myshopify.com/admin/api/2026-07/graphql.json')
    expect((call.init!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok')
  })
  it('throws ShopifyGraphqlError on top-level errors', async () => {
    const { client } = makeClient(() => gql(null, { errors: [{ message: 'syntax' }] }))
    await expect(client.graphql('query { x }')).rejects.toThrow(ShopifyGraphqlError)
  })
  it('retries THROTTLED responses with backoff then succeeds', async () => {
    let n = 0
    const { client } = makeClient(() =>
      ++n < 3 ? gql(null, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }) : gql({ ok: true }))
    await expect(client.graphql('query { x }')).resolves.toEqual({ ok: true })
  })
  it('retries once on HTTP 401 after invalidating the token, then errors', async () => {
    const { client } = makeClient(() => new Response('unauthorized', { status: 401 }))
    await expect(client.graphql('query { x }')).rejects.toThrow(ShopifyHttpError)
  })
})

describe('helpers', () => {
  it('assertNoUserErrors throws with messages', () => {
    expect(() => assertNoUserErrors({ productSet: { userErrors: [{ message: 'bad title' }] } }, 'productSet'))
      .toThrow(ShopifyUserError)
    expect(() => assertNoUserErrors({ productSet: { userErrors: [] } }, 'productSet')).not.toThrow()
  })
  it('withIdempotencyKey injects the directive after the operation header', () => {
    const doc = withIdempotencyKey('mutation RefundCreate($input: RefundInput!) { refundCreate(input: $input) { userErrors { message } } }', 'prop-123')
    expect(doc).toContain('mutation RefundCreate($input: RefundInput!) @idempotent(key: "prop-123") {')
    expect(() => withIdempotencyKey('mutation X { y }', 'bad key!')).toThrow(RangeError)
  })
})
