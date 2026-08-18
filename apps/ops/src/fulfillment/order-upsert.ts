import { type createDb, orders } from '@doge-buddy/db'
import type { Address } from '@doge-buddy/supplier'

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

/** The subset of a Shopify REST `shipping_address` object this module reads. */
interface ShopifyRestAddress {
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  country?: string | null
  country_code?: string | null
  zip?: string | null
  phone?: string | null
  [key: string]: unknown
}

/**
 * Normalizes a Shopify REST `shipping_address` object into the supplier-facing `Address` shape
 * used by the planner and every `SupplierAdapter` call (`line1`/`line2`/`state`/`country` as an
 * ISO-2 code, etc.). The REST shape and the `Address` shape disagree on nearly every field name
 * (`address1` vs `line1`, `province_code` vs `state`, a full country name vs an ISO-2 code) —
 * this is the one place that reconciles them, so nothing downstream ever sees the raw REST shape.
 *
 * Returns `null` when `raw` is null/undefined, not an object, or any REQUIRED `Address` field
 * (`name`, `line1`, `city`, `state`, `zip`, `country`) is missing or empty after mapping — callers
 * must treat a `null` result as "no usable shipping address" rather than proceed with a
 * partially-populated one.
 */
export function shopifyRestAddressToAddress(raw: unknown): Address | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as ShopifyRestAddress

  const name = (r.name ?? [r.first_name, r.last_name].filter(Boolean).join(' ')).trim()
  const line1 = (r.address1 ?? '').trim()
  const line2 = (r.address2 ?? '').trim()
  const city = (r.city ?? '').trim()
  const state = (r.province_code ?? r.province ?? '').trim()
  const zip = (r.zip ?? '').trim()
  const country = (r.country_code ?? '').trim().toUpperCase()
  const phone = (r.phone ?? '').trim()

  if (!name || !line1 || !city || !state || !zip || !country) return null

  const address: Address = { name, line1, city, state, zip, country }
  if (line2) address.line2 = line2
  if (phone) address.phone = phone
  return address
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
 *
 * `shipping_address` is stored ALREADY-NORMALIZED into the supplier `Address` shape (via
 * `shopifyRestAddressToAddress`) — `orders.shipping_address` is the canonical shape every later
 * stage (the place-order executor, the planner, the adapter) reads directly, with no re-mapping
 * needed and no raw REST field names leaking past this function. The raw REST payload (including
 * the original `shipping_address`) is still preserved verbatim in `raw_payload`.
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
    shippingAddress: shopifyRestAddressToAddress(payload.shipping_address),
    rawPayload: payload,
  }

  const [row] = await db
    .insert(orders)
    .values(values)
    .onConflictDoUpdate({ target: orders.shopifyOrderGid, set: values })
    .returning({ id: orders.id })

  return { orderRowId: row!.id, orderGid, isTest }
}
