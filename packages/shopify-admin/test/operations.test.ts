import { describe, expect, it } from 'vitest'
import {
  ShopifyAdminClient, ShopifyTokenManager, ShopifyUserError,
  fulfillmentCreate, fulfillmentTrackingInfoUpdate, inventorySetQuantities, listPublications,
  listWebhookSubscriptions, orderFulfillmentOrders, productDelete, productSet, publishablePublish,
  refundCreate, webhookSubscriptionCreate,
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

function lastGraphqlCall(calls: { url: string; init?: RequestInit }[]): { query: string; variables?: Record<string, unknown> } {
  const call = calls.find((c) => c.url.includes('/graphql.json'))
  if (!call) throw new Error('no graphql.json call was made')
  return JSON.parse(call.init!.body as string)
}

describe('listPublications', () => {
  it('maps publications and sends no variables', async () => {
    const { client, calls } = makeClient(() =>
      gql({ publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Hydrogen' }] } }))
    const result = await listPublications(client)
    expect(result).toEqual([{ id: 'gid://shopify/Publication/1', name: 'Hydrogen' }])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*publications/)
    expect(variables).toBeUndefined()
  })
})

describe('productSet', () => {
  const input = { title: 'DogeShirt' }
  it('sends the input, maps product + variants', async () => {
    const { client, calls } = makeClient(() =>
      gql({
        productSet: {
          product: { id: 'gid://shopify/Product/9', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/91', sku: 'DB-1' }] } },
          userErrors: [],
        },
      }))
    const result = await productSet(client, input)
    expect(result).toEqual({ productId: 'gid://shopify/Product/9', variants: [{ id: 'gid://shopify/ProductVariant/91', sku: 'DB-1' }] })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*productSet/)
    expect(variables).toEqual({ input })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ productSet: { product: null, userErrors: [{ field: ['title'], message: 'Title cant be blank' }] } }))
    await expect(productSet(client, input)).rejects.toThrow(ShopifyUserError)
  })
})

describe('publishablePublish', () => {
  it('sends id + publicationId input, resolves void', async () => {
    const { client, calls } = makeClient(() => gql({ publishablePublish: { userErrors: [] } }))
    await expect(publishablePublish(client, 'gid://shopify/Product/9', 'gid://shopify/Publication/1')).resolves.toBeUndefined()
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*publishablePublish/)
    expect(variables).toEqual({ id: 'gid://shopify/Product/9', input: [{ publicationId: 'gid://shopify/Publication/1' }] })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() => gql({ publishablePublish: { userErrors: [{ message: 'not allowed' }] } }))
    await expect(publishablePublish(client, 'gid://shopify/Product/9', 'gid://shopify/Publication/1')).rejects.toThrow(ShopifyUserError)
  })
})

describe('inventorySetQuantities', () => {
  const input = { quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', quantity: 5 }] }
  it('routes through withIdempotencyKey, sends input, resolves void', async () => {
    const { client, calls } = makeClient(() => gql({ inventorySetQuantities: { userErrors: [] } }))
    await expect(inventorySetQuantities(client, input, 'prop-1')).resolves.toBeUndefined()
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*inventorySetQuantities/)
    expect(query).toContain('@idempotent(key: "prop-1")')
    expect(variables).toEqual({ input })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() => gql({ inventorySetQuantities: { userErrors: [{ message: 'bad location' }] } }))
    await expect(inventorySetQuantities(client, input, 'prop-1')).rejects.toThrow(ShopifyUserError)
  })
})

describe('refundCreate', () => {
  const input = { orderId: 'gid://shopify/Order/123', notify: true }
  it('routes through withIdempotencyKey, sends input, maps refund id', async () => {
    const { client, calls } = makeClient(() =>
      gql({ refundCreate: { refund: { id: 'gid://shopify/Refund/5' }, userErrors: [] } }))
    const result = await refundCreate(client, input, 'prop-1')
    expect(result).toEqual({ refundId: 'gid://shopify/Refund/5' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*refundCreate/)
    expect(query).toContain('@idempotent(key: "prop-1")')
    expect(variables).toEqual({ input })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ refundCreate: { refund: null, userErrors: [{ message: 'already refunded' }] } }))
    await expect(refundCreate(client, input, 'prop-1')).rejects.toThrow(ShopifyUserError)
  })
})

describe('orderFulfillmentOrders', () => {
  it('sends the order gid, maps fulfillment orders', async () => {
    const { client, calls } = makeClient(() =>
      gql({ order: { fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/3', status: 'OPEN' }] } } }))
    const result = await orderFulfillmentOrders(client, 'gid://shopify/Order/123')
    expect(result).toEqual([{ id: 'gid://shopify/FulfillmentOrder/3', status: 'OPEN' }])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*fulfillmentOrders/)
    expect(variables).toEqual({ id: 'gid://shopify/Order/123' })
  })
})

describe('fulfillmentCreate', () => {
  it('includes trackingInfo when a tracking number is given', async () => {
    const { client, calls } = makeClient(() =>
      gql({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/7' }, userErrors: [] } }))
    const result = await fulfillmentCreate(client, {
      fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3',
      trackingNumber: '1Z999',
      trackingCompany: 'UPS',
      notifyCustomer: true,
    })
    expect(result).toEqual({ fulfillmentId: 'gid://shopify/Fulfillment/7' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*fulfillmentCreate/)
    expect(variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3' }],
        trackingInfo: { number: '1Z999', company: 'UPS' },
        notifyCustomer: true,
      },
    })
  })
  it('omits trackingInfo entirely when there is no tracking number', async () => {
    const { client, calls } = makeClient(() =>
      gql({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/7' }, userErrors: [] } }))
    await fulfillmentCreate(client, { fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3', notifyCustomer: false })
    const { variables } = lastGraphqlCall(calls)
    expect(variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3' }],
        notifyCustomer: false,
      },
    })
    expect(variables?.fulfillment).not.toHaveProperty('trackingInfo')
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ fulfillmentCreate: { fulfillment: null, userErrors: [{ message: 'already fulfilled' }] } }))
    await expect(fulfillmentCreate(client, { fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3', notifyCustomer: false }))
      .rejects.toThrow(ShopifyUserError)
  })
})

describe('fulfillmentTrackingInfoUpdate', () => {
  it('sends fulfillment gid + tracking info, resolves void', async () => {
    const { client, calls } = makeClient(() => gql({ fulfillmentTrackingInfoUpdate: { userErrors: [] } }))
    await expect(
      fulfillmentTrackingInfoUpdate(client, 'gid://shopify/Fulfillment/7', { number: '1Z999', company: 'UPS' }),
    ).resolves.toBeUndefined()
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*fulfillmentTrackingInfoUpdate/)
    expect(variables).toEqual({ fulfillmentId: 'gid://shopify/Fulfillment/7', trackingInfoInput: { number: '1Z999', company: 'UPS' } })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() => gql({ fulfillmentTrackingInfoUpdate: { userErrors: [{ message: 'bad fulfillment' }] } }))
    await expect(fulfillmentTrackingInfoUpdate(client, 'gid://shopify/Fulfillment/7', { number: '1Z999' }))
      .rejects.toThrow(ShopifyUserError)
  })
})

describe('listWebhookSubscriptions', () => {
  it('maps webhook subscriptions and sends no variables', async () => {
    const { client, calls } = makeClient(() =>
      gql({
        webhookSubscriptions: {
          nodes: [{ id: 'gid://shopify/WebhookSubscription/2', topic: 'ORDERS_PAID', endpoint: { callbackUrl: 'https://ops.example/webhooks/shopify' } }],
        },
      }))
    const result = await listWebhookSubscriptions(client)
    expect(result).toEqual([{ id: 'gid://shopify/WebhookSubscription/2', topic: 'ORDERS_PAID', callbackUrl: 'https://ops.example/webhooks/shopify' }])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*webhookSubscriptions/)
    expect(variables).toBeUndefined()
  })
})

describe('webhookSubscriptionCreate', () => {
  it('sends topic + uri (FIXTURE-ASSUMPTION), maps id', async () => {
    const { client, calls } = makeClient(() =>
      gql({ webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/4' }, userErrors: [] } }))
    const result = await webhookSubscriptionCreate(client, 'ORDERS_PAID', 'https://ops.example/webhooks/shopify')
    expect(result).toEqual({ id: 'gid://shopify/WebhookSubscription/4' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*webhookSubscriptionCreate/)
    expect(variables).toEqual({ topic: 'ORDERS_PAID', webhookSubscription: { uri: 'https://ops.example/webhooks/shopify' } })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'invalid topic' }] } }))
    await expect(webhookSubscriptionCreate(client, 'ORDERS_PAID', 'https://ops.example/webhooks/shopify')).rejects.toThrow(ShopifyUserError)
  })
})

describe('productDelete', () => {
  it('sends the product gid as input.id, resolves void', async () => {
    const { client, calls } = makeClient(() => gql({ productDelete: { userErrors: [] } }))
    await expect(productDelete(client, 'gid://shopify/Product/9')).resolves.toBeUndefined()
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*productDelete/)
    expect(variables).toEqual({ input: { id: 'gid://shopify/Product/9' } })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() => gql({ productDelete: { userErrors: [{ message: 'not found' }] } }))
    await expect(productDelete(client, 'gid://shopify/Product/9')).rejects.toThrow(ShopifyUserError)
  })
})
