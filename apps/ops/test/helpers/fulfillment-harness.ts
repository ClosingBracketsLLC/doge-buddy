import { createDb, orders, products, productVariants, supplierOrders, supplierVariantMappings, webhookEvents } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type { ShopifyOrderPaidPayload } from '../../src/fulfillment/order-upsert.ts'

export const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

type Db = ReturnType<typeof createDb>['db']

let uid = 0
/** Monotonic-within-process id, unique across repeated suite runs against the same shared test DB. */
export function uniqueId(prefix = ''): string {
  uid += 1
  return `${prefix}${Date.now()}${uid}`
}
export function orderGidFor(): string {
  return `gid://shopify/Order/${uniqueId()}`
}
export function variantGidFor(numericId: string): string {
  return `gid://shopify/ProductVariant/${numericId}`
}

/** A REST `shipping_address` with every field `shopifyRestAddressToAddress` requires, so
 * `upsertOrderFromPaidPayload` always stores a non-null normalized address. */
export const ADDRESS_REST = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  address1: '123 Analytical Engine Way',
  city: 'Springfield',
  province_code: 'IL',
  country_code: 'US',
  zip: '62701',
}

/** A realistic `orders/paid` REST payload. `total_price` (100.00) and the seeded mapping's cost
 * (620c product + 499c standard freight, see `seedMapping`'s callers) keep every scenario well
 * inside the default 6000bps margin floor unless a test deliberately overrides the spend cap. */
export function paidPayload(orderGid: string, overrides: Partial<ShopifyOrderPaidPayload> = {}): ShopifyOrderPaidPayload {
  return {
    admin_graphql_api_id: orderGid,
    test: false,
    total_price: '100.00',
    email: 'buyer@example.com',
    order_number: 4242,
    shipping_address: ADDRESS_REST,
    line_items: [],
    ...overrides,
  }
}

/** Seeds a product + variant + supplier_variant_mapping, mirroring fulfillment-place-order.test.ts's
 * own `seedMapping` — the mapping shape `executePlaceOrder` reads by (variantGid, supplier). */
export async function seedMapping(
  db: Db,
  opts: { variantGid: string; supplierVariantId: string; supplierCostCents: number; supplier?: 'mock' | 'cj' },
): Promise<void> {
  const [product] = await db.insert(products).values({ title: 'E2E product', status: 'active' }).returning({ id: products.id })
  const [variant] = await db
    .insert(productVariants)
    .values({
      productId: product!.id,
      shopifyVariantGid: opts.variantGid,
      sku: `sku-${uniqueId()}`,
      priceCents: 1999,
      supplierCostCents: opts.supplierCostCents,
    })
    .returning({ id: productVariants.id })
  await db.insert(supplierVariantMappings).values({
    variantId: variant!.id,
    supplier: opts.supplier ?? 'mock',
    supplierProductId: 'mock-p1',
    supplierVariantId: opts.supplierVariantId,
    warehouseCountry: 'US',
  })
}

/** Inserts a `webhook_events` row directly (bypassing the HTTP layer's HMAC/signature checks —
 * those are covered by webhooks.test.ts), the same shape `recordAndEnqueue` would have written. */
export async function insertWebhookEvent(
  db: Db,
  source: 'shopify' | 'cj',
  topic: string,
  payload: unknown,
): Promise<string> {
  const [row] = await db
    .insert(webhookEvents)
    .values({ source, externalEventId: uniqueId('wh-'), topic, payload: payload as object })
    .returning({ id: webhookEvents.id })
  return row!.id
}

/** Looks up the (order, supplier) pair created by the real pipeline for a given order gid —
 * `undefined` until both the `orders` upsert and the `supplier_orders` row exist. */
export async function loadSupplierOrderByOrderGid(
  db: Db,
  orderGid: string,
): Promise<typeof supplierOrders.$inferSelect | undefined> {
  const [orderRow] = await db.select().from(orders).where(eq(orders.shopifyOrderGid, orderGid))
  if (!orderRow) return undefined
  const [supplierOrderRow] = await db.select().from(supplierOrders).where(eq(supplierOrders.orderId, orderRow.id))
  return supplierOrderRow
}

/** Polls `check` until it returns a truthy value, or throws once `timeoutMs` elapses. Used
 * throughout the E2E suite in place of arbitrary sleeps: every wait here is "until the real
 * pg-boss pipeline has actually produced the DB state this scenario needs next." */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const result = await check()
    if (result) return result
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
