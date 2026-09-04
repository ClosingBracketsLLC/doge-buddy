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

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `ProductVariant.inventoryItem { id }` is a valid, selectable field.
//  - `ProductSetInput` confirmed to carry `tags`, `productType`, `seo`, `handle`, among others —
//    the same fields `productUpdate` below exposes individually.
//  - `ProductVariantSetInput` (the shape of each entry in `productSet`'s `input.variants`)
//    confirmed to carry `inventoryQuantities`, `inventoryItem`, `inventoryPolicy`, among others.
//  Non-null-ness of `inventoryItem` itself was not separately probed by the introspection run;
//  the mapping below still assumes every variant has one (every product variant does track
//  exactly one inventory item in practice), so `v.inventoryItem.id` needs no null-guard.
const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product {
        id
        variants(first: 250) {
          nodes { id sku inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`

interface ProductSetData {
  productSet: {
    product: { id: string; variants: { nodes: { id: string; sku?: string | null; inventoryItem: { id: string } }[] } }
    userErrors: ShopifyUserErrorEntry[]
  }
}

export async function productSet(
  client: ShopifyAdminClient,
  input: ProductSetInput,
): Promise<{ productId: string; variants: { id: string; sku?: string; inventoryItemId: string }[] }> {
  const data = await client.graphql<ProductSetData>(PRODUCT_SET_MUTATION, { input })
  assertNoUserErrors(data, 'productSet')
  return {
    productId: data.productSet.product.id,
    variants: data.productSet.product.variants.nodes.map((v) => ({
      id: v.id,
      sku: v.sku ?? undefined,
      inventoryItemId: v.inventoryItem.id,
    })),
  }
}

// ---------------------------------------------------------------------------
// publishablePublish
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `Mutation.publishablePublish(id: ID!, input: [PublicationInput!]!)` confirmed, where
//    `PublicationInput { publicationId, publishDate }` — this op only ever sends `publicationId`.
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

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema AND by a live call:
//  - `InventorySetQuantitiesInput { reason!, name! ('available'|'on_hand'), quantities:
//    [{ inventoryItemId!, locationId!, quantity!, changeFromQuantity? }]!, referenceDocumentUri? }`
//    — there is NO `ignoreCompareQuantity` field (the pre-2026 opt-out is gone from this
//    version), and although the schema types `changeFromQuantity` as optional, the API REJECTS
//    an entry that omits it at runtime: "InventoryQuantityInput must include the following
//    argument: changeFromQuantity" (INVALID_FIELD_ARGUMENTS — seen live on the first backfill
//    run). Every set is therefore a compare-and-swap against Shopify's CURRENT `available` at
//    that location; a mismatch comes back as a userError (code CHANGE_FROM_QUANTITY_STALE).
//    Callers read that current value with `inventoryAvailableAt` immediately before the set —
//    never from a local cache of a SUPPLIER reading, which stops matching Shopify the moment a
//    customer buys one — and treat a stale reply as "failed this cycle, retry next".
//
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
// inventoryAvailableAt
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-08-31 (introspection + live read): `InventoryItem.inventoryLevel(locationId:
// ID!)` returns the level at that location or `null` when the item is not stocked there;
// `InventoryLevel.quantities(names: [String!]!)` returns `[{ name, quantity }]`. Needs only
// `read_inventory` — NOT `read_locations` (which this app does not hold; even `Location.name`
// is denied without it, `Location.id` is not).
const INVENTORY_AVAILABLE_AT_QUERY = `#graphql
  query InventoryAvailableAt($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
`

interface InventoryAvailableAtData {
  inventoryItem: { inventoryLevel: { quantities: { name: string; quantity: number }[] } | null } | null
}

/**
 * Shopify's CURRENT `available` quantity for one inventory item at one location — the value an
 * `inventorySetQuantities` entry must carry as `changeFromQuantity` (see the note above that
 * mutation). Resolves `null` when the item has no inventory level at that location yet; throws
 * when the inventory item itself does not exist.
 */
export async function inventoryAvailableAt(
  client: ShopifyAdminClient,
  inventoryItemId: string,
  locationId: string,
): Promise<number | null> {
  const data = await client.graphql<InventoryAvailableAtData>(INVENTORY_AVAILABLE_AT_QUERY, { inventoryItemId, locationId })
  if (!data.inventoryItem) throw new Error(`inventoryAvailableAt: no inventory item ${inventoryItemId}`)
  const level = data.inventoryItem.inventoryLevel
  if (!level) return null
  return level.quantities.find((q) => q.name === 'available')?.quantity ?? null
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

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `Mutation.collectionCreate(collection: CollectionCreateInput)` — the argument is named
//    `collection`, NOT `input` (this op previously sent `input:` and silently created zero
//    collections against the live store).
//  - `CollectionCreateInput { title!, handle, descriptionHtml, image: ImageInput, seo, sortOrder,
//    metafields, sources: [CollectionCreateSourceTargetInput!] }` — there is NO `ruleSet` field.
//    Automated ("smart") membership is expressed as a `sources` entry instead:
//    `CollectionCreateSourceTargetInput { source: CollectionCreateConditionsSourceInput { title!,
//    description, inclusion, exclusion, targetType } }`, where `inclusion` is a
//    `CollectionCreateSourceInclusionInput { matchType: ANY|ALL,
//    conditions: [CollectionSourceInclusionConditionInput], selections }`, and a tag condition is
//    `{ productTag: { relation: TAGGED_WITH|NOT_TAGGED_WITH, values: [String!]!, matchType: ANY|ALL } }`.
const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CollectionCreate($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
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
  input: { title: string; handle: string; tagValue: string; descriptionHtml?: string },
): Promise<{ id: string }> {
  const collectionInput: Record<string, unknown> = {
    title: input.title,
    handle: input.handle,
    sources: [
      {
        source: {
          title: `Tagged ${input.tagValue}`,
          targetType: 'PRODUCTS',
          inclusion: {
            matchType: 'ALL',
            conditions: [{ productTag: { relation: 'TAGGED_WITH', values: [input.tagValue], matchType: 'ANY' } }],
          },
        },
      },
    ],
  }
  if (input.descriptionHtml !== undefined) {
    collectionInput.descriptionHtml = input.descriptionHtml
  }
  const data = await client.graphql<CollectionCreateData>(COLLECTION_CREATE_MUTATION, { collection: collectionInput })
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

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema: same
// `ProductVariant.inventoryItem { id }` selectability as PRODUCT_SET_MUTATION above (same
// non-null-ness caveat: the introspection run didn't separately probe nullability, so the mapping
// below still assumes every variant has one).
const PRODUCT_VARIANTS_BY_PRODUCT_ID_QUERY = `#graphql
  query ProductVariantsByProductId($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        nodes { id sku inventoryItem { id } }
      }
    }
  }
`

interface ProductVariantsByProductIdData {
  product: { variants: { nodes: { id: string; sku?: string | null; inventoryItem: { id: string } }[] } }
}

export async function productVariantsByProductId(
  client: ShopifyAdminClient,
  productGid: string,
): Promise<{ id: string; sku?: string; inventoryItemId: string }[]> {
  const data = await client.graphql<ProductVariantsByProductIdData>(PRODUCT_VARIANTS_BY_PRODUCT_ID_QUERY, { id: productGid })
  return data.product.variants.nodes.map((n) => ({ id: n.id, sku: n.sku ?? undefined, inventoryItemId: n.inventoryItem.id }))
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

// ---------------------------------------------------------------------------
// primaryLocationId
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `Query.locations(first:, query:, …)` confirmed, and `query: "active:true"` is a valid search
//    filter that returns only active locations.
//  Still a DESIGN assumption, not something introspection confirms: taking `first: 1`'s result as
//  "the" primary location only holds for stores (like this one) with exactly one active location.
//  A store with several active locations would need a real "is this the primary location" signal
//  instead of just taking the first result — out of scope here.
const PRIMARY_LOCATION_QUERY = `#graphql
  query PrimaryLocation {
    locations(first: 1, query: "active:true") {
      nodes { id }
    }
  }
`

interface PrimaryLocationData {
  locations: { nodes: { id: string }[] }
}

export async function primaryLocationId(client: ShopifyAdminClient): Promise<string> {
  const data = await client.graphql<PrimaryLocationData>(PRIMARY_LOCATION_QUERY)
  const id = data.locations.nodes[0]?.id
  if (!id) throw new Error('primaryLocationId: the store has no active location')
  return id
}

// ---------------------------------------------------------------------------
// productDescriptionHtml
// ---------------------------------------------------------------------------

// The `backfill-listings` repair script's one read: a product's `seo.description` is derived from
// its description HTML, and for a product created under the OLD scheme that HTML lives ONLY on
// Shopify (the local `products` row never stored it — only the proposal payload did, and a
// hand-created product has no proposal). `Product.descriptionHtml` is a nullable `HTML` field on
// the 2026-07 Admin API, so an empty description reads back as `null` and is normalized to `''`
// here; a gid that resolves to no product at all is a real problem and throws.
const PRODUCT_DESCRIPTION_HTML_QUERY = `#graphql
  query ProductDescriptionHtml($id: ID!) {
    product(id: $id) {
      descriptionHtml
    }
  }
`

interface ProductDescriptionHtmlData {
  product: { descriptionHtml: string | null } | null
}

export async function productDescriptionHtml(client: ShopifyAdminClient, productGid: string): Promise<string> {
  const data = await client.graphql<ProductDescriptionHtmlData>(PRODUCT_DESCRIPTION_HTML_QUERY, { id: productGid })
  if (!data.product) throw new Error(`productDescriptionHtml: no product ${productGid}`)
  return data.product.descriptionHtml ?? ''
}

// ---------------------------------------------------------------------------
// productUpdate
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `Mutation.productUpdate(product: ProductUpdateInput, media: [CreateMediaInput!],
//    identifier: ProductUpdateIdentifiers)` — the `input:` argument from older API versions is
//    GONE; the argument is named `product` (this op previously sent `input:` and would have
//    failed validation against the live store).
//  - `ProductUpdateInput` fields confirmed present: `id`, `handle`, `tags`, `productType`,
//    `seo` (`SEOInput { title description }`), `title`, `descriptionHtml`, `status`, `vendor`,
//    `category`, `redirectNewHandle`, among others. Only the subset this op's callers need
//    (`id`/`handle`/`tags`/`productType`/`seo`) is exposed on the function signature.
const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation ProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`

interface ProductUpdateData {
  productUpdate: { product: { id: string } | null; userErrors: ShopifyUserErrorEntry[] }
}

export async function productUpdate(
  client: ShopifyAdminClient,
  input: {
    id: string
    handle?: string
    /** Ask Shopify to leave a redirect from the OLD handle to the new one. Off by default on
     * Shopify's side, so renaming a live product's handle without it 404s every existing link to
     * it — which is exactly what the `backfill-listings` repair would otherwise do to two products
     * already on the storefront. */
    redirectNewHandle?: boolean
    tags?: string[]
    productType?: string
    seo?: { title?: string; description?: string }
  },
): Promise<void> {
  const data = await client.graphql<ProductUpdateData>(PRODUCT_UPDATE_MUTATION, { product: input })
  assertNoUserErrors(data, 'productUpdate')
}

// ---------------------------------------------------------------------------
// inventoryItemUpdate
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-08-31 by introspection of the 2026-07 Admin schema:
//  - `Mutation.inventoryItemUpdate(id: ID!, input: InventoryItemInput!)` confirmed, where
//    `InventoryItemInput` carries a boolean `tracked` field (among others), and the mutation
//    returns the updated `inventoryItem { id }` alongside `userErrors` — same shape family as
//    every other `*Update` mutation in this file.
const INVENTORY_ITEM_UPDATE_MUTATION = `#graphql
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`

interface InventoryItemUpdateData {
  inventoryItemUpdate: { inventoryItem: { id: string } | null; userErrors: ShopifyUserErrorEntry[] }
}

export async function inventoryItemUpdate(
  client: ShopifyAdminClient,
  inventoryItemId: string,
  input: { tracked: boolean },
): Promise<void> {
  const data = await client.graphql<InventoryItemUpdateData>(INVENTORY_ITEM_UPDATE_MUTATION, { id: inventoryItemId, input })
  assertNoUserErrors(data, 'inventoryItemUpdate')
}

// ---------------------------------------------------------------------------
// productAppendMedia
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-09-01 by introspection of the live 2026-07 Admin schema (probe run outside
// this sandbox — a worktree-isolation guard blocked the agent from sourcing shell env for a
// credentialed call; the controller ran the probe and handed back these facts, see
// task-8-report.md fix-round section):
//  - `Mutation.productCreateMedia` is ABSENT from the schema — its `ProductCreateMediaPayload`
//    type still exists, but nothing in `Mutation` exposes it. Media creation is folded into
//    `Mutation.productUpdate(product: ProductUpdateInput!, media: [CreateMediaInput!],
//    identifier: ProductUpdateIdentifiers)` instead.
//  - `CreateMediaInput { originalSource: String!, alt: String, mediaContentType: MediaContentType! }`,
//    `MediaContentType` includes `IMAGE`.
//  - `ProductUpdatePayload { product, userErrors }` — plain `userErrors` (no `mediaUserErrors` on
//    this payload), so `assertNoUserErrors` applies directly.
//  - `product: { id: productGid }` is sent and NOTHING else — the house flip/no-resend rule
//    (apply-new-listing.ts:125-133): resending any other product field here would silently
//    overwrite it on every backfill rerun, since `productUpdate` treats every field it receives as
//    an authoritative write, not a partial patch.
//  - The mutation's response has no "here are the media you just created" shape — it only offers
//    the product's FULL `media(first: 250)` list (old + new). The newly created media is picked
//    out client-side as "not in `knownMediaIds`" (the caller's prior `productMediaState(...)
//    .mediaIds` snapshot); there is no other signal in the schema to distinguish them.
//  Runtime behavior (actual async processing timing, `media(first: 250)`'s node ordering) is first
//  exercised by the backfill run.
const PRODUCT_UPDATE_APPEND_MEDIA_MUTATION = `#graphql
  mutation ProductUpdateAppendMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]!) {
    productUpdate(product: $product, media: $media) {
      product {
        media(first: 250) {
          nodes { id ... on MediaImage { status } }
        }
      }
      userErrors { field message }
    }
  }
`

interface ProductUpdateAppendMediaData {
  productUpdate: {
    product: { media: { nodes: { id: string; status?: string }[] } } | null
    userErrors: ShopifyUserErrorEntry[]
  }
}

/** Creates media on a product via `productUpdate`'s `media` argument — `productCreateMedia` does
 * NOT exist on the live 2026-07 schema (probe-confirmed, see the comment above). Returns only the
 * newly created media: nodes whose id is not already in `knownMediaIds` (typically a prior
 * `productMediaState(...).mediaIds` read), since the mutation echoes the product's FULL media
 * list rather than just what it created. */
export async function productAppendMedia(
  client: ShopifyAdminClient,
  productGid: string,
  media: { originalSource: string; alt?: string }[],
  knownMediaIds: string[],
): Promise<{ id: string; status: string }[]> {
  const data = await client.graphql<ProductUpdateAppendMediaData>(PRODUCT_UPDATE_APPEND_MEDIA_MUTATION, {
    product: { id: productGid },
    media: media.map((m) => ({ originalSource: m.originalSource, mediaContentType: 'IMAGE', ...(m.alt ? { alt: m.alt } : {}) })),
  })
  assertNoUserErrors(data, 'productUpdate')
  const known = new Set(knownMediaIds)
  const nodes = data.productUpdate.product?.media.nodes ?? []
  return nodes.filter((n) => !known.has(n.id)).map((n) => ({ id: n.id, status: n.status ?? 'UNKNOWN' }))
}

// ---------------------------------------------------------------------------
// productVariantAppendMedia
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-09-01 by introspection of the live 2026-07 Admin schema (see the fix-round
// note above PRODUCT_UPDATE_APPEND_MEDIA_MUTATION for how the probe was run):
//  - `Mutation.productVariantAppendMedia(productId: ID!, variantMedia:
//    [ProductVariantAppendMediaInput!]!)` confirmed present, with `ProductVariantAppendMediaPayload
//    { product, productVariants, userErrors }` — plain `userErrors` (not `mediaUserErrors`), so
//    `assertNoUserErrors` applies directly.
//  - Media processing is ASYNC: `MediaImage.status` is a `MediaStatus` enum (UPLOADED |
//    PROCESSING | READY | FAILED); media must reach READY before this mutation accepts it —
//    callers poll `mediaImageStatus` below. The actual READY-before-accept enforcement is first
//    exercised by the backfill run.
const PRODUCT_VARIANT_APPEND_MEDIA_MUTATION = `#graphql
  mutation ProductVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      productVariants { id }
      userErrors { field message }
    }
  }
`

interface ProductVariantAppendMediaData {
  productVariantAppendMedia: { productVariants: { id: string }[] | null; userErrors: ShopifyUserErrorEntry[] }
}

export async function productVariantAppendMedia(
  client: ShopifyAdminClient,
  productGid: string,
  variantMedia: { variantId: string; mediaIds: string[] }[],
): Promise<void> {
  const data = await client.graphql<ProductVariantAppendMediaData>(PRODUCT_VARIANT_APPEND_MEDIA_MUTATION, {
    productId: productGid,
    variantMedia,
  })
  assertNoUserErrors(data, 'productVariantAppendMedia')
}

// ---------------------------------------------------------------------------
// productMediaState
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-09-01 by introspection of the live 2026-07 Admin schema (see the fix-round
// note above PRODUCT_UPDATE_APPEND_MEDIA_MUTATION for how the probe was run): `Product.media`
// and `ProductVariant.media` both confirmed present. `media(first: 1)` on the variant, not the
// deprecated `image` field. One query combines two reads:
//  - The product-level media inventory, which feeds `productAppendMedia`'s `knownMediaIds` — the
//    only way that op can tell an old media node from one it just created (see its comment above).
//  - The per-variant idempotency read for the backfill: a variant that already shows media is
//    SKIPPED (spec 2026-09-01 §A5).
const PRODUCT_MEDIA_STATE_QUERY = `#graphql
  query ProductMediaState($id: ID!) {
    product(id: $id) {
      media(first: 250) {
        nodes { id }
      }
      variants(first: 250) {
        nodes { id sku media(first: 1) { nodes { id } } }
      }
    }
  }
`

interface ProductMediaStateData {
  product: {
    media: { nodes: { id: string }[] }
    variants: { nodes: { id: string; sku: string | null; media: { nodes: { id: string }[] } }[] }
  } | null
}

export async function productMediaState(
  client: ShopifyAdminClient,
  productGid: string,
): Promise<{ mediaIds: string[]; variants: { id: string; sku?: string; mediaId: string | null }[] }> {
  const data = await client.graphql<ProductMediaStateData>(PRODUCT_MEDIA_STATE_QUERY, { id: productGid })
  return {
    mediaIds: data.product?.media.nodes.map((n) => n.id) ?? [],
    variants: (data.product?.variants.nodes ?? []).map((v) => ({
      id: v.id,
      sku: v.sku ?? undefined,
      mediaId: v.media.nodes[0]?.id ?? null,
    })),
  }
}

// ---------------------------------------------------------------------------
// mediaImageStatus
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-09-01 by introspection: `MediaImage.status` confirmed present, typed as the
// `MediaStatus` enum (UPLOADED | PROCESSING | READY | FAILED).
const MEDIA_IMAGE_STATUS_QUERY = `#graphql
  query MediaImageStatus($id: ID!) {
    node(id: $id) { ... on MediaImage { status } }
  }
`

interface MediaImageStatusData {
  node: { status?: string } | null
}

/** Media processing status (UPLOADED → PROCESSING → READY | FAILED) — poll before append. */
export async function mediaImageStatus(client: ShopifyAdminClient, mediaGid: string): Promise<string> {
  const data = await client.graphql<MediaImageStatusData>(MEDIA_IMAGE_STATUS_QUERY, { id: mediaGid })
  return data.node?.status ?? 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// mediaDelete
// ---------------------------------------------------------------------------

// Probe-confirmed 2026-09-01 (see the fix-round note above PRODUCT_UPDATE_APPEND_MEDIA_MUTATION):
// `Mutation.productDeleteMedia` is ABSENT from the live 2026-07 schema — its
// `ProductDeleteMediaPayload` type still exists, but nothing in `Mutation` exposes it. Media
// deletion goes through the generic Files API instead: `Mutation.fileDelete(fileIds: [ID!]!)`,
// `FileDeletePayload { deletedFileIds, userErrors }` (both confirmed present by introspection).
// FIXTURE-ASSUMPTION (verify on the first backfill run): MediaImage gids are accepted as
// `fileIds` — media are files on this API version, but that has not been exercised against a real
// MediaImage yet. Callers treat this as best-effort cleanup, matching the original
// `productDeleteMedia`'s purpose: removing an orphaned created-but-never-appended MediaImage on
// the backfill's give-up path (leaving it would stack a duplicate gallery image on every rerun).
const FILE_DELETE_MUTATION = `#graphql
  mutation FileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message }
    }
  }
`

interface FileDeleteData {
  fileDelete: { deletedFileIds: string[] | null; userErrors: ShopifyUserErrorEntry[] }
}

/** Best-effort cleanup for the backfill's give-up paths — see the FIXTURE-ASSUMPTION note above:
 * `fileDelete` is probe-confirmed to exist, but accepting MediaImage gids as `fileIds` is not yet
 * exercised live. */
export async function mediaDelete(client: ShopifyAdminClient, mediaIds: string[]): Promise<void> {
  const data = await client.graphql<FileDeleteData>(FILE_DELETE_MUTATION, { fileIds: mediaIds })
  assertNoUserErrors(data, 'fileDelete')
}

// ---------------------------------------------------------------------------
// metafieldsSet
// ---------------------------------------------------------------------------

// LIVE-VERIFIED 2026-09-01 by introspection: `MetafieldsSetInput { ownerId, namespace, key, value,
// compareDigest, type }` confirmed present — this op sends `ownerId`/`namespace`/`key`/`type`/
// `value` (not `compareDigest`, which is for optimistic-concurrency checks this caller doesn't
// need). `Mutation.metafieldsSet(metafields:)` returns plain `userErrors`, so `assertNoUserErrors`
// applies directly.
const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`

interface MetafieldsSetData {
  metafieldsSet: { metafields: { id: string }[] | null; userErrors: ShopifyUserErrorEntry[] }
}

/** Upserts metafields on existing owners — the backfill's write path for `supplier_reviews`
 * (a full `productSet` on an existing product is forbidden — apply-new-listing.ts:125-133). */
export async function metafieldsSet(
  client: ShopifyAdminClient,
  metafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[],
): Promise<void> {
  const data = await client.graphql<MetafieldsSetData>(METAFIELDS_SET_MUTATION, { metafields })
  assertNoUserErrors(data, 'metafieldsSet')
}

// ---------------------------------------------------------------------------
// productVariantsBulkUpdatePrice
// ---------------------------------------------------------------------------

// Mutation shape from the 2026-07 Admin schema (`productVariantsBulkUpdate(productId,
// variants: [ProductVariantsBulkInput!]!)`); house rule applies — introspection is not
// live-verification for a mutation, so the FIRST live `reprice` run is the verifying call
// (userErrors surface loudly through assertNoUserErrors, nothing is retried blindly).
const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`

interface ProductVariantsBulkUpdateData {
  productVariantsBulkUpdate: {
    productVariants: { id: string }[]
    userErrors: ShopifyUserErrorEntry[]
  }
}

/** Updates one variant's price (and optionally compareAtPrice; null CLEARS it). Amounts are
 *  decimal strings ("16.99") per the Admin API's Money conventions. */
export async function productVariantsBulkUpdatePrice(
  client: ShopifyAdminClient,
  productGid: string,
  variant: { id: string; price: string; compareAtPrice?: string | null },
): Promise<void> {
  const data = await client.graphql<ProductVariantsBulkUpdateData>(PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
    productId: productGid,
    variants: [variant],
  })
  assertNoUserErrors(data, 'productVariantsBulkUpdate')
}
