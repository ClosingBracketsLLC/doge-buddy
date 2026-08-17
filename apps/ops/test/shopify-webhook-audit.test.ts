import { ShopifyAdminClient, ShopifyTokenManager } from '@doge-buddy/shopify-admin'
import { describe, expect, it } from 'vitest'
import { shopifyWebhookAudit } from '../src/jobs/shopify-webhook-audit.ts'

const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 })
const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })

interface GraphqlCall {
  query: string
  variables?: Record<string, unknown>
}

// Reuses the fake-fetch harness pattern from packages/shopify-admin/test/operations.test.ts,
// but branches per-call on the operation name since a single audit run makes several
// distinct graphql calls (one list, N creates).
function makeClient(handler: (call: GraphqlCall) => Response) {
  const calls: GraphqlCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/admin/oauth/access_token')) return tokenOk()
    const body = JSON.parse(init!.body as string) as GraphqlCall
    calls.push(body)
    return handler(body)
  }
  const tokenManager = new ShopifyTokenManager({ shopDomain: 's.myshopify.com', clientId: 'a', clientSecret: 'b', fetchImpl })
  const client = new ShopifyAdminClient({ shopDomain: 's.myshopify.com', tokenManager, fetchImpl, sleep: async () => {} })
  return { client, calls }
}

const ADMIN_BASE_URL = 'https://ops.example'
const CALLBACK_URL = 'https://ops.example/webhooks/shopify'

describe('shopifyWebhookAudit', () => {
  it('creates only the missing required-topic subscriptions', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.query.includes('webhookSubscriptionCreate')) {
        return gql({
          webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/new' }, userErrors: [] },
        })
      }
      return gql({
        webhookSubscriptions: {
          nodes: [{ id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } }],
        },
      })
    })

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL })

    expect(result).toEqual({ created: ['ORDERS_CANCELLED', 'REFUNDS_CREATE'] })

    const createCalls = calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))
    expect(createCalls).toHaveLength(2)
    for (const call of createCalls) {
      expect(call.variables?.webhookSubscription).toEqual({ uri: CALLBACK_URL })
    }
    expect(createCalls.map((c) => c.variables?.topic).sort()).toEqual(['ORDERS_CANCELLED', 'REFUNDS_CREATE'])
  })

  it('creates nothing when all required topics are already correctly subscribed', async () => {
    const { client, calls } = makeClient(() =>
      gql({
        webhookSubscriptions: {
          nodes: [
            { id: '1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
            { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: CALLBACK_URL } },
            { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
          ],
        },
      }),
    )

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL })

    expect(result).toEqual({ created: [] })
    expect(calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))).toHaveLength(0)
  })

  it('recreates a subscription that points at the wrong URL', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.query.includes('webhookSubscriptionCreate')) {
        return gql({
          webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/new' }, userErrors: [] },
        })
      }
      return gql({
        webhookSubscriptions: {
          nodes: [
            { id: '1', topic: 'ORDERS_PAID', endpoint: { callbackUrl: CALLBACK_URL } },
            { id: '2', topic: 'ORDERS_CANCELLED', endpoint: { callbackUrl: 'https://stale.example/webhooks/shopify' } },
            { id: '3', topic: 'REFUNDS_CREATE', endpoint: { callbackUrl: CALLBACK_URL } },
          ],
        },
      })
    })

    const result = await shopifyWebhookAudit({ client, adminBaseUrl: ADMIN_BASE_URL })

    expect(result).toEqual({ created: ['ORDERS_CANCELLED'] })
    const createCalls = calls.filter((c) => c.query.includes('webhookSubscriptionCreate'))
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]!.variables).toEqual({ topic: 'ORDERS_CANCELLED', webhookSubscription: { uri: CALLBACK_URL } })
  })
})
