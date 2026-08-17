import { assertNoUserErrors, withIdempotencyKey, type ShopifyAdminClient } from './client.ts'

/**
 * Payload for `productSet`. Validated upstream by `@doge-buddy/core` schemas in later phases —
 * this operation is transport, not policy, so it accepts whatever shape the caller has already
 * validated.
 */
export type ProductSetInput = Record<string, unknown>

interface UserErrorEntry {
  field?: string[] | null
  message: string
}

// ---------------------------------------------------------------------------
// listPublications
// ---------------------------------------------------------------------------

const LIST_PUBLICATIONS_QUERY = `#graphql
  query ListPublications {
    publications(first: 250) {
      nodes { id name }
    }
  }
`

interface ListPublicationsData {
  publications: { nodes: { id: string; name: string }[] }
}

export async function listPublications(client: ShopifyAdminClient): Promise<{ id: string; name: string }[]> {
  const data = await client.graphql<ListPublicationsData>(LIST_PUBLICATIONS_QUERY)
  return data.publications.nodes.map((n) => ({ id: n.id, name: n.name }))
}

// ---------------------------------------------------------------------------
// productSet
// ---------------------------------------------------------------------------

const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product {
        id
        variants(first: 250) {
          nodes { id sku }
        }
      }
      userErrors { field message }
    }
  }
`

interface ProductSetData {
  productSet: {
    product: { id: string; variants: { nodes: { id: string; sku?: string | null }[] } }
    userErrors: UserErrorEntry[]
  }
}

export async function productSet(
  client: ShopifyAdminClient,
  input: ProductSetInput,
): Promise<{ productId: string; variants: { id: string; sku?: string }[] }> {
  const data = await client.graphql<ProductSetData>(PRODUCT_SET_MUTATION, { input })
  assertNoUserErrors(data, 'productSet')
  return {
    productId: data.productSet.product.id,
    variants: data.productSet.product.variants.nodes.map((v) => ({ id: v.id, sku: v.sku ?? undefined })),
  }
}

// ---------------------------------------------------------------------------
// publishablePublish
// ---------------------------------------------------------------------------

const PUBLISHABLE_PUBLISH_MUTATION = `#graphql
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`

interface PublishablePublishData {
  publishablePublish: { userErrors: UserErrorEntry[] }
}

export async function publishablePublish(
  client: ShopifyAdminClient,
  publishableId: string,
  publicationId: string,
): Promise<void> {
  const data = await client.graphql<PublishablePublishData>(PUBLISHABLE_PUBLISH_MUTATION, {
    id: publishableId,
    input: [{ publicationId }],
  })
  assertNoUserErrors(data, 'publishablePublish')
}

// ---------------------------------------------------------------------------
// inventorySetQuantities
// ---------------------------------------------------------------------------

// NOTE: no `#graphql` prefix on this raw document — withIdempotencyKey locates the operation
// header by anchoring to the very start of the string. The prefix is prepended after the
// directive is spliced in, below.
const INVENTORY_SET_QUANTITIES_MUTATION = `mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    userErrors { field message }
  }
}`

interface InventorySetQuantitiesData {
  inventorySetQuantities: { userErrors: UserErrorEntry[] }
}

export async function inventorySetQuantities(
  client: ShopifyAdminClient,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  const document = `#graphql\n${withIdempotencyKey(INVENTORY_SET_QUANTITIES_MUTATION, idempotencyKey)}`
  const data = await client.graphql<InventorySetQuantitiesData>(document, { input })
  assertNoUserErrors(data, 'inventorySetQuantities')
}

// ---------------------------------------------------------------------------
// refundCreate
// ---------------------------------------------------------------------------

// Same reasoning as INVENTORY_SET_QUANTITIES_MUTATION above: no `#graphql` prefix here.
const REFUND_CREATE_MUTATION = `mutation RefundCreate($input: RefundInput!) {
  refundCreate(input: $input) {
    refund { id }
    userErrors { field message }
  }
}`

interface RefundCreateData {
  refundCreate: { refund: { id: string }; userErrors: UserErrorEntry[] }
}

export async function refundCreate(
  client: ShopifyAdminClient,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ refundId: string }> {
  const document = `#graphql\n${withIdempotencyKey(REFUND_CREATE_MUTATION, idempotencyKey)}`
  const data = await client.graphql<RefundCreateData>(document, { input })
  assertNoUserErrors(data, 'refundCreate')
  return { refundId: data.refundCreate.refund.id }
}

// ---------------------------------------------------------------------------
// orderFulfillmentOrders
// ---------------------------------------------------------------------------

const ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 50) {
        nodes { id status }
      }
    }
  }
`

interface OrderFulfillmentOrdersData {
  order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } }
}

export async function orderFulfillmentOrders(
  client: ShopifyAdminClient,
  orderGid: string,
): Promise<{ id: string; status: string }[]> {
  const data = await client.graphql<OrderFulfillmentOrdersData>(ORDER_FULFILLMENT_ORDERS_QUERY, { id: orderGid })
  return data.order.fulfillmentOrders.nodes.map((n) => ({ id: n.id, status: n.status }))
}

// ---------------------------------------------------------------------------
// fulfillmentCreate
// ---------------------------------------------------------------------------

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`

interface FulfillmentCreateData {
  fulfillmentCreate: { fulfillment: { id: string }; userErrors: UserErrorEntry[] }
}

export async function fulfillmentCreate(
  client: ShopifyAdminClient,
  args: { fulfillmentOrderId: string; trackingNumber?: string; trackingCompany?: string; notifyCustomer: boolean },
): Promise<{ fulfillmentId: string }> {
  const fulfillment: Record<string, unknown> = {
    lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: args.fulfillmentOrderId }],
  }
  if (args.trackingNumber) {
    fulfillment.trackingInfo = { number: args.trackingNumber, company: args.trackingCompany }
  }
  fulfillment.notifyCustomer = args.notifyCustomer

  const data = await client.graphql<FulfillmentCreateData>(FULFILLMENT_CREATE_MUTATION, { fulfillment })
  assertNoUserErrors(data, 'fulfillmentCreate')
  return { fulfillmentId: data.fulfillmentCreate.fulfillment.id }
}

// ---------------------------------------------------------------------------
// fulfillmentTrackingInfoUpdate
// ---------------------------------------------------------------------------

const FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION = `#graphql
  mutation FulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!) {
    fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput) {
      userErrors { field message }
    }
  }
`

interface FulfillmentTrackingInfoUpdateData {
  fulfillmentTrackingInfoUpdate: { userErrors: UserErrorEntry[] }
}

export async function fulfillmentTrackingInfoUpdate(
  client: ShopifyAdminClient,
  fulfillmentGid: string,
  tracking: { number: string; company?: string },
): Promise<void> {
  const data = await client.graphql<FulfillmentTrackingInfoUpdateData>(FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION, {
    fulfillmentId: fulfillmentGid,
    trackingInfoInput: tracking,
  })
  assertNoUserErrors(data, 'fulfillmentTrackingInfoUpdate')
}

// ---------------------------------------------------------------------------
// listWebhookSubscriptions
// ---------------------------------------------------------------------------

const LIST_WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query ListWebhookSubscriptions {
    webhookSubscriptions(first: 250) {
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
    }
  }
`

interface ListWebhookSubscriptionsData {
  webhookSubscriptions: { nodes: { id: string; topic: string; endpoint?: { callbackUrl?: string | null } | null }[] }
}

export async function listWebhookSubscriptions(
  client: ShopifyAdminClient,
): Promise<{ id: string; topic: string; callbackUrl?: string }[]> {
  const data = await client.graphql<ListWebhookSubscriptionsData>(LIST_WEBHOOK_SUBSCRIPTIONS_QUERY)
  return data.webhookSubscriptions.nodes.map((n) => ({
    id: n.id,
    topic: n.topic,
    callbackUrl: n.endpoint?.callbackUrl ?? undefined,
  }))
}

// ---------------------------------------------------------------------------
// webhookSubscriptionCreate
// ---------------------------------------------------------------------------

const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`

interface WebhookSubscriptionCreateData {
  webhookSubscriptionCreate: { webhookSubscription: { id: string }; userErrors: UserErrorEntry[] }
}

export async function webhookSubscriptionCreate(
  client: ShopifyAdminClient,
  topic: string,
  callbackUrl: string,
): Promise<{ id: string }> {
  const data = await client.graphql<WebhookSubscriptionCreateData>(WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
    topic,
    // FIXTURE-ASSUMPTION: Admin API 2026-07's WebhookSubscriptionInput field is `uri`. Older API
    // versions used `callbackUrl` on the same input type — confirm `uri` against the live 2026-07
    // schema before relying on this in production.
    webhookSubscription: { uri: callbackUrl },
  })
  assertNoUserErrors(data, 'webhookSubscriptionCreate')
  return { id: data.webhookSubscriptionCreate.webhookSubscription.id }
}

// ---------------------------------------------------------------------------
// productDelete
// ---------------------------------------------------------------------------

const PRODUCT_DELETE_MUTATION = `#graphql
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      userErrors { field message }
    }
  }
`

interface ProductDeleteData {
  productDelete: { userErrors: UserErrorEntry[] }
}

export async function productDelete(client: ShopifyAdminClient, productGid: string): Promise<void> {
  const data = await client.graphql<ProductDeleteData>(PRODUCT_DELETE_MUTATION, { input: { id: productGid } })
  assertNoUserErrors(data, 'productDelete')
}
