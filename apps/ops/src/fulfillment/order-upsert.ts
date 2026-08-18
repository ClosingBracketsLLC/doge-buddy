import { type createDb, orders } from '@doge-buddy/db'

type Db = ReturnType<typeof createDb>['db']

/**
 * The subset of a Shopify `orders/paid` REST webhook payload this module reads. The payload
 * has many more fields than this (and the whole thing is stored verbatim in `raw_payload`) —
 * this interface only names what `upsertOrderFromPaidPayload` actually maps into columns.
 */
export interface ShopifyOrderPaidPayload {
  admin_graphql_api_id: string
  test?: boolean | null
  total_price: string
  email?: string | null
  order_number?: number | string | null
  shipping_address?: unknown
  line_items?: { variant_id: number | string; quantity: number }[]
  [key: string]: unknown
}

export interface UpsertedOrder {
  orderRowId: string
  orderGid: string
  isTest: boolean
}

/**
 * Converts a decimal USD amount string (e.g. "19.99", "5", "0.05") to integer cents without
 * any floating-point arithmetic: split on '.', pad/truncate the fractional part to exactly 2
 * digits, then `parseInt` both halves as plain digit strings. Shopify's `total_price` is
 * always a well-formed decimal string with at most 2 fractional digits in practice; any extra
 * digits are truncated rather than rounded (there's never a third digit to round from).
 */
export function decimalStringToCents(value: string): number {
  const trimmed = value.trim()
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const parts = unsigned.split('.')

  if (parts.length > 2) {
    throw new RangeError(`invalid decimal amount: ${value}`)
  }
  const [wholePart = '0', fracPart = ''] = parts
  if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fracPart)) {
    throw new RangeError(`invalid decimal amount: ${value}`)
  }

  const cents = parseInt(wholePart, 10) * 100 + parseInt(fracPart.slice(0, 2).padEnd(2, '0'), 10)
  return negative ? -cents : cents
}

/**
 * Maps a Shopify `orders/paid` REST webhook payload into the `orders` table. Upserts on
 * `shopify_order_gid` (not on the webhook_events row that triggered the call), so a replayed
 * delivery under a *new* webhook event id — same order — updates the same order row instead of
 * duplicating it. Stores the entire payload verbatim in `raw_payload` for later stages (e.g.
 * line-item/variant parsing at place-order time) that need fields this mapping doesn't surface.
 */
export async function upsertOrderFromPaidPayload(db: Db, payload: ShopifyOrderPaidPayload): Promise<UpsertedOrder> {
  const orderGid = payload.admin_graphql_api_id
  const isTest = payload.test === true

  const values = {
    shopifyOrderGid: orderGid,
    shopifyOrderNumber: payload.order_number == null ? null : String(payload.order_number),
    email: payload.email ?? null,
    isTest,
    totalCents: decimalStringToCents(payload.total_price),
    shippingAddress: payload.shipping_address ?? null,
    rawPayload: payload,
  }

  const [row] = await db
    .insert(orders)
    .values(values)
    .onConflictDoUpdate({ target: orders.shopifyOrderGid, set: values })
    .returning({ id: orders.id })

  return { orderRowId: row!.id, orderGid, isTest }
}
