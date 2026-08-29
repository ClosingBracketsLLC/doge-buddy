import { usdToCents } from '@doge-buddy/core'
import { assertNoUserErrors, withIdempotencyKey, type ShopifyAdminClient } from './client.ts'
import { type ShopifyUserErrorEntry } from './errors.ts'

/**
 * Payload for `productSet`. Validated upstream by `@doge-buddy/core` schemas in later phases —
 * this operation is transport, not policy, so it accepts whatever shape the caller has already
 * validated.
 */
export type ProductSetInput = Record<string, unknown>

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
    userErrors: ShopifyUserErrorEntry[]
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
  publishablePublish: { userErrors: ShopifyUserErrorEntry[] }
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
// publishableUnpublish
// ---------------------------------------------------------------------------

// FIXTURE-ASSUMPTION (2026-07 API), verify on the first credential-gated run:
//  - The `publishableUnpublish` mutation shape is identical to `publishablePublish` except for
//    the operation name. Until a real deprecation run, the API version and field shapes are
//    unverified.
const PUBLISHABLE_UNPUBLISH_MUTATION = `#graphql
  mutation PublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`

interface PublishableUnpublishData {
  publishableUnpublish: { userErrors: ShopifyUserErrorEntry[] }
}

export async function publishableUnpublish(
  client: ShopifyAdminClient,
  publishableId: string,
  publicationId: string,
): Promise<void> {
  const data = await client.graphql<PublishableUnpublishData>(PUBLISHABLE_UNPUBLISH_MUTATION, {
    id: publishableId,
    input: [{ publicationId }],
  })
  assertNoUserErrors(data, 'publishableUnpublish')
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
  inventorySetQuantities: { userErrors: ShopifyUserErrorEntry[] }
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
  refundCreate: { refund: { id: string }; userErrors: ShopifyUserErrorEntry[] }
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
// orderRefundState
// ---------------------------------------------------------------------------

// FIXTURE-ASSUMPTION (2026-07 API), verify on the first credential-gated run:
//  - `Order.refunds` and `Order.transactions` are plain LISTS, not connections (no `nodes { … }`
//    wrapper). They were converted from connections to lists in the 2023-era Admin API and are
//    still lists as of the version this client pins.
//  - `Refund.totalRefundedSet.shopMoney.amount` is a decimal string in the SHOP's currency (the
//    store is USD-only, so no presentment/shop split matters here).
//  - `OrderTransaction.kind`/`.status` are the SCREAMING_CASE enums matched below.
const ORDER_REFUND_STATE_QUERY = `#graphql
  query OrderRefundState($id: ID!) {
    order(id: $id) {
      refunds {
        id
        note
        totalRefundedSet { shopMoney { amount } }
      }
      transactions(first: 20) {
        id
        kind
        status
        gateway
      }
    }
  }
`

interface OrderRefundStateData {
  order: {
    refunds: { id: string; note?: string | null; totalRefundedSet: { shopMoney: { amount: string } } }[]
    transactions: { id: string; kind: string; status: string; gateway?: string | null }[]
  } | null
}

/**
 * Everything `apps/ops`'s `refund` apply executor needs about an order's money, in ONE query.
 *
 * Two callers consume it and both are load-bearing for correctness:
 *  1. The **idempotency pre-check** — Shopify's `@idempotent` keys live only ~24h, so a re-entered
 *     apply proves whether its own refund already landed by looking for its `db-proposal-<id>` note
 *     in `refunds[]`. That is why `note` is selected at all.
 *  2. The **accumulation bound** — `amountCents <= total_cents - totalRefundedCents`, re-verified at
 *     apply time because sibling proposals (or a human in the Shopify admin) may have moved money
 *     since the agent's validator ran.
 */
export interface OrderRefundState {
  totalRefundedCents: number
  refunds: { id: string; note: string | null }[]
  /** First transaction with kind SALE|CAPTURE and status SUCCESS — `RefundInput.transactions[].parentId`. */
  parentTransactionId: string | null
  /** The parent transaction's gateway (null when there is no parent), for the same refund entry. */
  gateway: string | null
}

/** The only transaction kinds money can be refunded AGAINST (an AUTHORIZATION holds no funds). */
const REFUNDABLE_PARENT_KINDS = new Set(['SALE', 'CAPTURE'])

export async function orderRefundState(client: ShopifyAdminClient, orderGid: string): Promise<OrderRefundState> {
  const data = await client.graphql<OrderRefundStateData>(ORDER_REFUND_STATE_QUERY, { id: orderGid })
  const order = data.order
  if (!order) {
    // Loud and specific rather than a `TypeError: cannot read 'refunds' of null` — the caller
    // treats a throw as retryable, and a genuinely missing order will dead-letter with this message
    // instead of a stack trace nobody can read.
    throw new Error(`order not found: ${orderGid}`)
  }

  // `usdToCents` (the house money parser, and `centsToUsd`'s documented inverse) rather than the
  // obvious `Math.round(parseFloat(amount) * 100)`: it is half-up on the decimal STRING instead of
  // rounding a binary float ('10.005' * 100 is 1000.4999999999999, which rounds DOWN), and it
  // THROWS on a non-numeric/negative amount instead of yielding NaN. NaN matters here — the caller's
  // bound is `amountCents > totalCents - totalRefundedCents`, and every comparison against NaN is
  // false, so a single unparseable amount would wave an unbounded refund straight through.
  let totalRefundedCents = 0
  for (const refund of order.refunds) {
    totalRefundedCents += usdToCents(refund.totalRefundedSet.shopMoney.amount)
  }

  const parent = order.transactions.find((t) => REFUNDABLE_PARENT_KINDS.has(t.kind) && t.status === 'SUCCESS')

  return {
    totalRefundedCents,
    refunds: order.refunds.map((r) => ({ id: r.id, note: r.note ?? null })),
    parentTransactionId: parent?.id ?? null,
    // Read off the PARENT specifically: the gateway travels with the transaction being refunded, so
    // taking it from any other transaction (or the order) could name a gateway that never held
    // these funds.
    gateway: parent?.gateway ?? null,
  }
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
  fulfillmentCreate: { fulfillment: { id: string }; userErrors: ShopifyUserErrorEntry[] }
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
  fulfillmentTrackingInfoUpdate: { userErrors: ShopifyUserErrorEntry[] }
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
  webhookSubscriptionCreate: { webhookSubscription: { id: string }; userErrors: ShopifyUserErrorEntry[] }
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
  productDelete: { userErrors: ShopifyUserErrorEntry[] }
}

export async function productDelete(client: ShopifyAdminClient, productGid: string): Promise<void> {
  const data = await client.graphql<ProductDeleteData>(PRODUCT_DELETE_MUTATION, { input: { id: productGid } })
  assertNoUserErrors(data, 'productDelete')
}

// ---------------------------------------------------------------------------
// metafieldDefinitionCreate
// ---------------------------------------------------------------------------

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message }
    }
  }
`

interface MetafieldDefinitionCreateData {
  metafieldDefinitionCreate: { createdDefinition: { id: string }; userErrors: ShopifyUserErrorEntry[] }
}

export async function metafieldDefinitionCreate(
  client: ShopifyAdminClient,
  def: { name: string; namespace: string; key: string; type: string; ownerType: 'PRODUCT' },
): Promise<{ id: string }> {
  const definition = { ...def, access: { storefront: 'PUBLIC_READ' } }
  const data = await client.graphql<MetafieldDefinitionCreateData>(METAFIELD_DEFINITION_CREATE_MUTATION, { definition })
  assertNoUserErrors(data, 'metafieldDefinitionCreate')
  return { id: data.metafieldDefinitionCreate.createdDefinition.id }
}

// ---------------------------------------------------------------------------
// listMetafieldDefinitions
// ---------------------------------------------------------------------------

const LIST_METAFIELD_DEFINITIONS_QUERY = `#graphql
  query ListMetafieldDefinitions($namespace: String) {
    metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: $namespace) {
      nodes { id key }
    }
  }
`

interface ListMetafieldDefinitionsData {
  metafieldDefinitions: { nodes: { id: string; key: string }[] }
}

export async function listMetafieldDefinitions(
  client: ShopifyAdminClient,
  namespace: string,
): Promise<{ id: string; key: string }[]> {
  const data = await client.graphql<ListMetafieldDefinitionsData>(LIST_METAFIELD_DEFINITIONS_QUERY, { namespace })
  return data.metafieldDefinitions.nodes.map((n) => ({ id: n.id, key: n.key }))
}

// ---------------------------------------------------------------------------
// collectionCreate
// ---------------------------------------------------------------------------

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id }
      userErrors { field message }
    }
  }
`

interface CollectionCreateData {
  collectionCreate: { collection: { id: string }; userErrors: ShopifyUserErrorEntry[] }
}

export async function collectionCreate(
  client: ShopifyAdminClient,
  input: { title: string; handle: string; tagCondition: string },
): Promise<{ id: string }> {
  const collectionInput = {
    title: input.title,
    handle: input.handle,
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: 'TAG', relation: 'EQUALS', condition: input.tagCondition }],
    },
  }
  const data = await client.graphql<CollectionCreateData>(COLLECTION_CREATE_MUTATION, { input: collectionInput })
  assertNoUserErrors(data, 'collectionCreate')
  return { id: data.collectionCreate.collection.id }
}

// ---------------------------------------------------------------------------
// listCollections
// ---------------------------------------------------------------------------

const LIST_COLLECTIONS_QUERY = `#graphql
  query ListCollections {
    collections(first: 250) {
      nodes { id handle }
    }
  }
`

interface ListCollectionsData {
  collections: { nodes: { id: string; handle: string }[] }
}

export async function listCollections(client: ShopifyAdminClient): Promise<{ id: string; handle: string }[]> {
  const data = await client.graphql<ListCollectionsData>(LIST_COLLECTIONS_QUERY)
  return data.collections.nodes.map((n) => ({ id: n.id, handle: n.handle }))
}

// ---------------------------------------------------------------------------
// findProductByHandle
// ---------------------------------------------------------------------------

const FIND_PRODUCT_BY_HANDLE_QUERY = `#graphql
  query FindProductByHandle($query: String!) {
    products(first: 1, query: $query) {
      nodes { id }
    }
  }
`

interface FindProductByHandleData {
  products: { nodes: { id: string }[] }
}

export async function findProductByHandle(client: ShopifyAdminClient, handle: string): Promise<{ id: string } | null> {
  const query = `handle:'${handle}'`
  const data = await client.graphql<FindProductByHandleData>(FIND_PRODUCT_BY_HANDLE_QUERY, { query })
  const node = data.products.nodes[0]
  return node ? { id: node.id } : null
}

// ---------------------------------------------------------------------------
// productVariantsByProductId
// ---------------------------------------------------------------------------

const PRODUCT_VARIANTS_BY_PRODUCT_ID_QUERY = `#graphql
  query ProductVariantsByProductId($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        nodes { id sku }
      }
    }
  }
`

interface ProductVariantsByProductIdData {
  product: { variants: { nodes: { id: string; sku?: string | null }[] } }
}

export async function productVariantsByProductId(
  client: ShopifyAdminClient,
  productGid: string,
): Promise<{ id: string; sku?: string }[]> {
  const data = await client.graphql<ProductVariantsByProductIdData>(PRODUCT_VARIANTS_BY_PRODUCT_ID_QUERY, { id: productGid })
  return data.product.variants.nodes.map((n) => ({ id: n.id, sku: n.sku ?? undefined }))
}

// ---------------------------------------------------------------------------
// ordersUpdatedSince
// ---------------------------------------------------------------------------

const ORDERS_UPDATED_SINCE_QUERY = `#graphql
  query OrdersUpdatedSince($query: String!) {
    orders(first: 100, query: $query, sortKey: UPDATED_AT) {
      nodes { id name test displayFinancialStatus email updatedAt }
    }
  }
`

interface OrdersUpdatedSinceData {
  orders: { nodes: { id: string; name: string; test: boolean; displayFinancialStatus: string; email?: string | null; updatedAt: string }[] }
}

export async function ordersUpdatedSince(
  client: ShopifyAdminClient,
  sinceIso: string,
): Promise<{ id: string; name: string; test: boolean; displayFinancialStatus: string; email?: string; updatedAt: string }[]> {
  const query = `updated_at:>='${sinceIso}'`
  const data = await client.graphql<OrdersUpdatedSinceData>(ORDERS_UPDATED_SINCE_QUERY, { query })
  return data.orders.nodes.map((n) => ({ ...n, email: n.email ?? undefined }))
}

// ---------------------------------------------------------------------------
// webhookSubscriptionDelete
// ---------------------------------------------------------------------------

const WEBHOOK_SUBSCRIPTION_DELETE_MUTATION = `#graphql
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      userErrors { field message }
    }
  }
`

interface WebhookSubscriptionDeleteData {
  webhookSubscriptionDelete: { userErrors: ShopifyUserErrorEntry[] }
}

export async function webhookSubscriptionDelete(
  client: ShopifyAdminClient,
  id: string,
): Promise<void> {
  const data = await client.graphql<WebhookSubscriptionDeleteData>(WEBHOOK_SUBSCRIPTION_DELETE_MUTATION, { id })
  assertNoUserErrors(data, 'webhookSubscriptionDelete')
}
