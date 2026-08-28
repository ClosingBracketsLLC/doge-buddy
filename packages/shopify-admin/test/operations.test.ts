import { describe, expect, it } from 'vitest'
import {
  ShopifyAdminClient, ShopifyTokenManager, ShopifyUserError,
  collectionCreate, findProductByHandle, fulfillmentCreate, fulfillmentTrackingInfoUpdate,
  inventorySetQuantities, listCollections, listMetafieldDefinitions, listPublications,
  listWebhookSubscriptions, metafieldDefinitionCreate, orderFulfillmentOrders, orderRefundState,
  ordersUpdatedSince, productDelete,
  productSet, productVariantsByProductId, publishablePublish, refundCreate, webhookSubscriptionCreate,
  webhookSubscriptionDelete,
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

describe('orderRefundState', () => {
  it('sums refund cents, keeps notes, and picks the first SUCCESS SALE/CAPTURE as the parent', async () => {
    const { client, calls } = makeClient(() =>
      gql({
        order: {
          refunds: [
            { id: 'gid://shopify/Refund/1', note: 'db-proposal-abc', totalRefundedSet: { shopMoney: { amount: '10.00' } } },
            { id: 'gid://shopify/Refund/2', note: null, totalRefundedSet: { shopMoney: { amount: '2.50' } } },
          ],
          transactions: [
            // A failed SALE sits BEFORE the successful one: picking by kind alone would hand
            // refundCreate a parent transaction that never took any money.
            { id: 'gid://shopify/OrderTransaction/10', kind: 'SALE', status: 'FAILURE', gateway: 'bogus' },
            { id: 'gid://shopify/OrderTransaction/11', kind: 'AUTHORIZATION', status: 'SUCCESS', gateway: 'bogus' },
            { id: 'gid://shopify/OrderTransaction/12', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'shopify_payments' },
            { id: 'gid://shopify/OrderTransaction/13', kind: 'SALE', status: 'SUCCESS', gateway: 'other' },
          ],
        },
      }))
    const result = await orderRefundState(client, 'gid://shopify/Order/123')
    expect(result).toEqual({
      totalRefundedCents: 1250,
      refunds: [
        { id: 'gid://shopify/Refund/1', note: 'db-proposal-abc' },
        { id: 'gid://shopify/Refund/2', note: null },
      ],
      parentTransactionId: 'gid://shopify/OrderTransaction/12',
      gateway: 'shopify_payments',
    })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*refunds/)
    expect(query).toMatch(/transactions\(first: 20\)/)
    expect(variables).toEqual({ id: 'gid://shopify/Order/123' })
  })

  it('rounds fractional-cent amounts half-up rather than through a binary float', async () => {
    const { client } = makeClient(() =>
      gql({
        order: {
          refunds: [
            // 10.005 * 100 is 1000.4999999999999 in binary floating point, so a plain
            // Math.round(parseFloat(x) * 100) silently loses the half cent. usdToCents is half-up.
            { id: 'gid://shopify/Refund/1', note: null, totalRefundedSet: { shopMoney: { amount: '10.005' } } },
            { id: 'gid://shopify/Refund/2', note: null, totalRefundedSet: { shopMoney: { amount: '19.99' } } },
            { id: 'gid://shopify/Refund/3', note: null, totalRefundedSet: { shopMoney: { amount: '0.29' } } },
          ],
          transactions: [],
        },
      }))
    const result = await orderRefundState(client, 'gid://shopify/Order/123')
    expect(result.totalRefundedCents).toBe(1001 + 1999 + 29)
  })

  it('throws on a non-numeric amount rather than accumulating NaN', async () => {
    const { client } = makeClient(() =>
      gql({
        order: {
          refunds: [{ id: 'gid://shopify/Refund/1', note: null, totalRefundedSet: { shopMoney: { amount: 'n/a' } } }],
          transactions: [],
        },
      }))
    // A NaN total would make the caller's accumulation bound (`amount > total - refunded`) compare
    // false and let a refund through unchecked — this is money, so it must fail loudly instead.
    await expect(orderRefundState(client, 'gid://shopify/Order/123')).rejects.toThrow(RangeError)
  })

  it('returns zeros and a null parent for an order with no refunds and no usable transaction', async () => {
    const { client } = makeClient(() =>
      gql({
        order: {
          refunds: [],
          transactions: [{ id: 'gid://shopify/OrderTransaction/9', kind: 'AUTHORIZATION', status: 'SUCCESS', gateway: 'bogus' }],
        },
      }))
    const result = await orderRefundState(client, 'gid://shopify/Order/123')
    expect(result).toEqual({ totalRefundedCents: 0, refunds: [], parentTransactionId: null, gateway: null })
  })

  it('throws when the order does not exist', async () => {
    const { client } = makeClient(() => gql({ order: null }))
    await expect(orderRefundState(client, 'gid://shopify/Order/404')).rejects.toThrow(/order not found/)
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

describe('metafieldDefinitionCreate', () => {
  const def = { name: 'Ships from', namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', ownerType: 'PRODUCT' as const }
  it('creates with PUBLIC_READ storefront access', async () => {
    const { client, calls } = makeClient(() =>
      gql({ metafieldDefinitionCreate: { createdDefinition: { id: 'gid://shopify/MetafieldDefinition/1' }, userErrors: [] } }))
    const result = await metafieldDefinitionCreate(client, def)
    expect(result).toEqual({ id: 'gid://shopify/MetafieldDefinition/1' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*metafieldDefinitionCreate/)
    expect(variables).toEqual({ definition: { ...def, access: { storefront: 'PUBLIC_READ' } } })
    expect((variables as any).definition.access).toEqual({ storefront: 'PUBLIC_READ' })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ message: 'Key is in use' }] } }))
    await expect(metafieldDefinitionCreate(client, def)).rejects.toThrow(ShopifyUserError)
  })
})

describe('listMetafieldDefinitions', () => {
  it('sends the namespace and PRODUCT ownerType, maps id + key', async () => {
    const { client, calls } = makeClient(() =>
      gql({ metafieldDefinitions: { nodes: [{ id: 'gid://shopify/MetafieldDefinition/1', key: 'ships_from' }] } }))
    const result = await listMetafieldDefinitions(client, 'dogebuddy')
    expect(result).toEqual([{ id: 'gid://shopify/MetafieldDefinition/1', key: 'ships_from' }])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*metafieldDefinitions/)
    expect(query).toContain('ownerType: PRODUCT')
    expect(variables).toEqual({ namespace: 'dogebuddy' })
  })
})

describe('collectionCreate', () => {
  const input = { title: 'Doge Tees', handle: 'doge-tees', tagCondition: 'doge-tees' }
  it('builds a smart collection ruleSet, maps id', async () => {
    const { client, calls } = makeClient(() =>
      gql({ collectionCreate: { collection: { id: 'gid://shopify/Collection/1' }, userErrors: [] } }))
    const result = await collectionCreate(client, input)
    expect(result).toEqual({ id: 'gid://shopify/Collection/1' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*collectionCreate/)
    expect(variables).toEqual({
      input: {
        title: 'Doge Tees',
        handle: 'doge-tees',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'doge-tees' }],
        },
      },
    })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ collectionCreate: { collection: null, userErrors: [{ message: 'Handle already in use' }] } }))
    await expect(collectionCreate(client, input)).rejects.toThrow(ShopifyUserError)
  })
})

describe('listCollections', () => {
  it('maps collections and sends no variables', async () => {
    const { client, calls } = makeClient(() =>
      gql({ collections: { nodes: [{ id: 'gid://shopify/Collection/1', handle: 'doge-tees' }] } }))
    const result = await listCollections(client)
    expect(result).toEqual([{ id: 'gid://shopify/Collection/1', handle: 'doge-tees' }])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*collections/)
    expect(variables).toBeUndefined()
  })
})

describe('findProductByHandle', () => {
  it("sends handle:'<handle>' as the query variable, maps the first node", async () => {
    const { client, calls } = makeClient(() =>
      gql({ products: { nodes: [{ id: 'gid://shopify/Product/9' }] } }))
    const result = await findProductByHandle(client, 'doge-tee')
    expect(result).toEqual({ id: 'gid://shopify/Product/9' })
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*products/)
    expect(variables).toEqual({ query: "handle:'doge-tee'" })
  })
  it('returns null when there are no matching nodes', async () => {
    const { client } = makeClient(() => gql({ products: { nodes: [] } }))
    const result = await findProductByHandle(client, 'missing-handle')
    expect(result).toBeNull()
  })
})

describe('productVariantsByProductId', () => {
  it('sends the product gid, maps variant id + sku', async () => {
    const { client, calls } = makeClient(() =>
      gql({
        product: {
          variants: {
            nodes: [
              { id: 'gid://shopify/ProductVariant/91', sku: 'DB-1' },
              { id: 'gid://shopify/ProductVariant/92', sku: null },
            ],
          },
        },
      }))
    const result = await productVariantsByProductId(client, 'gid://shopify/Product/9')
    expect(result).toEqual([
      { id: 'gid://shopify/ProductVariant/91', sku: 'DB-1' },
      { id: 'gid://shopify/ProductVariant/92', sku: undefined },
    ])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*variants/)
    expect(variables).toEqual({ id: 'gid://shopify/Product/9' })
  })
})

describe('ordersUpdatedSince', () => {
  it('sends query string with updated_at filter and sortKey UPDATED_AT, maps orders', async () => {
    const sinceIso = '2026-08-18T12:00:00Z'
    const { client, calls } = makeClient(() =>
      gql({
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              test: false,
              displayFinancialStatus: 'PAID',
              email: 'customer@example.com',
              updatedAt: '2026-08-18T12:30:00Z',
            },
          ],
        },
      }))
    const result = await ordersUpdatedSince(client, sinceIso)
    expect(result).toEqual([
      {
        id: 'gid://shopify/Order/1',
        name: '#1001',
        test: false,
        displayFinancialStatus: 'PAID',
        email: 'customer@example.com',
        updatedAt: '2026-08-18T12:30:00Z',
      },
    ])
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/query[\s\S]*orders/)
    expect(query).toContain('sortKey: UPDATED_AT')
    expect(variables).toEqual({ query: `updated_at:>='${sinceIso}'` })
  })
})

describe('webhookSubscriptionDelete', () => {
  it('sends the webhook subscription id, resolves void', async () => {
    const { client, calls } = makeClient(() => gql({ webhookSubscriptionDelete: { userErrors: [] } }))
    await expect(webhookSubscriptionDelete(client, 'gid://shopify/WebhookSubscription/2')).resolves.toBeUndefined()
    const { query, variables } = lastGraphqlCall(calls)
    expect(query).toMatch(/mutation[\s\S]*webhookSubscriptionDelete/)
    expect(variables).toEqual({ id: 'gid://shopify/WebhookSubscription/2' })
  })
  it('throws ShopifyUserError on userErrors', async () => {
    const { client } = makeClient(() =>
      gql({ webhookSubscriptionDelete: { userErrors: [{ message: 'not found' }] } }))
    await expect(webhookSubscriptionDelete(client, 'gid://shopify/WebhookSubscription/2')).rejects.toThrow(ShopifyUserError)
  })
})
