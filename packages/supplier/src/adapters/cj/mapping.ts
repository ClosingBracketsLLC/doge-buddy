import { usdToCents } from '@doge-buddy/core'
import type {
  DisputeOptions,
  DisputeStatus,
  PlaceOrderResult,
  ShippingOption,
  SupplierOrderStatus,
  SupplierOrderStatusValue,
  SupplierProductDetail,
  SupplierProductReview,
  SupplierProductSummary,
  SupplierVariantDetail,
  TrackingInfo,
  WarehouseStock,
} from '../../types.ts'

/**
 * Pure mappers from CJ Dropshipping API response shapes to Doge Buddy's supplier-domain types.
 * Fixtures under test/fixtures/cj/ pin the exact field names these mappers read, and were
 * re-recorded from real CJ responses on 2026-08-23 — CJ's docs disagree with its own wire format
 * in several places, so the fixtures (not the docs) are authoritative here. Anything still
 * flagged FIXTURE-ASSUMPTION has NOT been seen on a live response yet.
 */

/**
 * CJ reports a product's list price as a RANGE string (observed live: `"15.16 -- 15.17"`) when
 * its variants are priced differently, and as a plain number/numeric string when they aren't.
 * `SupplierProductSummary.sellPriceCents` is a single value, so a range collapses to its low
 * end — the conventional "from" price for a listing. Anything with no leading numeric token
 * still falls through to `usdToCents`, which rejects it loudly rather than silently zeroing.
 */
function cjSellPriceToCents(value: number | string): number {
  if (typeof value === 'number') return usdToCents(value)
  const [firstNumber] = value.trim().match(/\d+(?:\.\d+)?/) ?? []
  return usdToCents(firstNumber ?? value)
}

/** Verified against live CJ 2026-08-23: listV2 items use `id`/`nameEn`/`bigImage` (NOT the
 * `pid`/`productNameEn`/`productImage` names product/query uses for the same concepts), and
 * carry no flat `categoryName` — only the one/two/threeCategoryName hierarchy, each nullable. */
interface CjProductListItem {
  id: string
  nameEn: string
  bigImage?: string
  sellPrice: number | string
  listedNum?: number
  oneCategoryName?: string | null
  twoCategoryName?: string | null
  threeCategoryName?: string | null
}

export function mapProductSummary(item: CjProductListItem): SupplierProductSummary {
  return {
    supplierProductId: item.id,
    title: item.nameEn,
    imageUrl: item.bigImage,
    sellPriceCents: cjSellPriceToCents(item.sellPrice),
    listedCount: item.listedNum,
    categoryName: item.threeCategoryName ?? item.twoCategoryName ?? item.oneCategoryName ?? undefined,
  }
}

// Verified against live CJ 2026-08-23: product/query nests variants under `variants`, priced via
// variantSellPrice with variantWeight in grams; variantImage is nullable when a variant has no
// dedicated image, and variantNameEn can be an empty string on single-variant products.
interface CjVariant {
  vid: string
  variantSku?: string
  variantNameEn?: string
  variantSellPrice: number | string
  variantWeight?: number
  variantImage?: string | null
}

function mapVariantDetail(v: CjVariant): SupplierVariantDetail {
  return {
    supplierVariantId: v.vid,
    sku: v.variantSku,
    name: v.variantNameEn,
    priceCents: usdToCents(v.variantSellPrice),
    weightGrams: v.variantWeight,
    imageUrl: v.variantImage ?? undefined,
  }
}

interface CjProductDetail {
  pid: string
  productNameEn: string
  description?: string
  productImageSet?: string[]
  categoryName?: string
  variants: CjVariant[]
}

export function mapProductDetail(detail: CjProductDetail): SupplierProductDetail {
  return {
    supplierProductId: detail.pid,
    title: detail.productNameEn,
    descriptionHtml: detail.description,
    imageUrls: detail.productImageSet ?? [],
    categoryName: detail.categoryName,
    variants: detail.variants.map(mapVariantDetail),
  }
}

/**
 * CJ's product/productComments response wire shape is UNVERIFIED (used under CJ_CONTRACT gating).
 * Defensive mapping accepts multiple field name variations for score, content, and date;
 * clamps rating to 1-5 when a score field parses to a finite number, and otherwise leaves
 * `rating` UNDEFINED — never defaulted. Fail-safe stance (panel 2026-09-01): if CJ's real score
 * field has a third name, a review must degrade to unrated (dropped downstream), never to a
 * fabricated 5-star rating. Defaults content to '' and reviewDate/countryCode to undefined.
 */
interface CjProductComment {
  score?: number | string
  commentScore?: number | string
  comment?: string
  commentText?: string
  content?: string
  commentDate?: string
  createDate?: string
  countryCode?: string
}

export function mapProductReview(comment: CjProductComment): SupplierProductReview {
  const rating = (() => {
    const score = comment.score ?? comment.commentScore
    if (score === undefined || score === null) return undefined
    const n = Number(score)
    if (!Number.isFinite(n)) return undefined
    return Math.max(1, Math.min(5, n))
  })()

  const content = comment.comment ?? comment.commentText ?? comment.content ?? ''

  return {
    ...(rating !== undefined ? { rating } : {}),
    content,
    reviewDate: comment.commentDate ?? comment.createDate,
    countryCode: comment.countryCode,
  }
}

/** Verified against live CJ 2026-08-23: stock/queryByVid returns countryCode + storageNum, and
 * splits the same total across cjInventoryNum (held in a CJ warehouse) and factoryInventoryNum
 * (still at the supplier). There is no `verifiedWarehouse` flag on this response — that field
 * exists only on listV2 items — so "verified" maps to CJ physically holding the stock. */
interface CjStockEntry {
  countryCode: string
  storageNum: number
  cjInventoryNum?: number
}

export function mapStock(entry: CjStockEntry): WarehouseStock {
  return {
    countryCode: entry.countryCode,
    quantity: entry.storageNum,
    verified: (entry.cjInventoryNum ?? 0) > 0,
  }
}

interface CjFreightOption {
  logisticName: string
  logisticPrice: number | string
  logisticAging: string
}

export function mapFreightOption(opt: CjFreightOption): ShippingOption {
  const { minDays, maxDays } = parseAgingDays(opt.logisticAging)
  return {
    name: opt.logisticName,
    priceCents: usdToCents(opt.logisticPrice),
    minDays,
    maxDays,
  }
}

const AGING_FALLBACK = { minDays: 1, maxDays: 30 }

// logisticAging is CJ's free-text delivery estimate on logistic/freightCalculate — confirmed
// live 2026-08-23 as a "min-max" day range ("3-5"), though a single day count and trailing units
// text ("10-15 days") are both plausible and cost nothing to accept. There is no documented fixed
// grammar, so this defensively strips everything but digits and dashes and falls back to a wide
// {1, 30} range on anything it can't parse — it must never throw.
export function parseAgingDays(aging: string): { minDays: number; maxDays: number } {
  try {
    const cleaned = (aging ?? '').replace(/[^0-9-]/g, '')
    const parts = cleaned.split('-').filter((p) => p.length > 0)

    if (parts.length === 1) {
      const n = parseInt(parts[0]!, 10)
      if (Number.isFinite(n)) return { minDays: n, maxDays: n }
    } else if (parts.length >= 2) {
      const min = parseInt(parts[0]!, 10)
      const max = parseInt(parts[1]!, 10)
      if (Number.isFinite(min) && Number.isFinite(max)) return { minDays: min, maxDays: max }
    }
  } catch {
    // fall through to the fallback below
  }
  return AGING_FALLBACK
}

// --- Order lifecycle (Task 6) -----------------------------------------------------------

/**
 * Shared shape of createOrderV3's response and each entry of order/list's `list` array. Verified
 * against live CJ 2026-08-23 — the two disagree in ways that matter:
 *
 * - `orderId` means DIFFERENT things. On createOrderV3 it is the `SD…` CJ order code; on
 *   order/list it is an internal numeric id, and the `SD…` code lives in `cjOrderId`. Every other
 *   endpoint (getOrderDetail, confirmOrder, simulatePay) is keyed by the `SD…` code — the numeric
 *   id is rejected with "Order not found" — so `cjOrderId` wins whenever it is present.
 * - `shipmentOrderId` comes back null on createOrderV3 (CJ assigns it later, at shipment).
 * - `orderAmount` is null on createOrderV3 and populated on order/list, so the total falls back
 *   to product + postage, which is how CJ itself computes it.
 */
interface CjOrderAmounts {
  orderId: string
  cjOrderId?: string | null
  shipmentOrderId?: string | null
  productAmount: number | string
  postageAmount: number | string
  orderAmount?: number | string | null
}

export function mapOrderAmounts(o: CjOrderAmounts): PlaceOrderResult {
  const productAmountCents = usdToCents(o.productAmount)
  const postageAmountCents = usdToCents(o.postageAmount)
  return {
    supplierOrderId: o.cjOrderId ?? o.orderId,
    shipmentOrderId: o.shipmentOrderId ?? undefined,
    productAmountCents,
    postageAmountCents,
    totalAmountCents:
      o.orderAmount === null || o.orderAmount === undefined
        ? productAmountCents + postageAmountCents
        : usdToCents(o.orderAmount),
  }
}

/** Status normalization table for order/getOrderDetail's `orderStatus` (case-insensitive). */
export function mapCjOrderStatus(raw: string): SupplierOrderStatusValue {
  switch ((raw ?? '').toUpperCase()) {
    case 'CREATED':
    case 'IN_CART':
      return 'created'
    case 'UNPAID':
      return 'unpaid'
    case 'PENDING':
      return 'pending'
    // UNSHIPPED is CJ's real post-payment/pre-shipment state (observed live); PROCESSING is not
    // in CJ's documented enum but is kept as a defensive synonym.
    case 'UNSHIPPED':
    case 'PROCESSING':
      return 'processing'
    case 'SHIPPED':
      return 'shipped'
    case 'DELIVERED':
      return 'delivered'
    case 'CANCELLED':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

// Verified against live CJ 2026-08-23: getOrderDetail carries trackNumber (null until the order
// actually ships) and logisticName. FIXTURE-ASSUMPTION: lastMileTrackNumber did not appear on the
// sandbox order observed — it is presumably carrier-dependent, so it stays optional.
interface CjOrderDetail {
  orderId: string
  orderStatus: string
  trackNumber?: string
  logisticName?: string
  lastMileTrackNumber?: string
}

export function mapOrderStatusDetail(detail: CjOrderDetail): SupplierOrderStatus {
  return { value: mapCjOrderStatus(detail.orderStatus), raw: detail.orderStatus }
}

export function mapOrderTracking(detail: CjOrderDetail): TrackingInfo | null {
  if (!detail.trackNumber) return null
  return {
    trackingNumber: detail.trackNumber,
    carrier: detail.logisticName,
    lastMileTrackingNumber: detail.lastMileTrackNumber,
  }
}

// --- Disputes (Task 6) -------------------------------------------------------------------

/** Verified against live CJ 2026-08-23: disputes/disputeProducts returns the order's line items
 * under `productInfoList`, each carrying a `canChoose` flag for whether THAT item may be
 * disputed right now (CJ clears it outside the dispute window). */
export interface CjDisputeProductsResponse {
  productInfoList?: { lineItemId: string; cjVariantId: string; canChoose?: boolean }[]
}

/** Verified against live CJ 2026-08-23: disputeConfirmInfo returns the refund ceiling as
 * `maxAmount`, the allowed outcomes as `expectResultOptionList` (STRING "1"/"2", not ints), and
 * the reason catalog as `disputeReasonList` with numeric ids. */
interface CjDisputeConfirmInfo {
  maxAmount?: number | string
  expectResultOptionList?: (string | number)[]
  disputeReasonList?: { disputeReasonId: string | number; reasonName: string }[]
}

const DISPUTE_RESULT_OPTIONS: Record<string, 'refund' | 'reissue'> = { '1': 'refund', '2': 'reissue' }

export function mapDisputeOptions(
  products: CjDisputeProductsResponse,
  confirm: CjDisputeConfirmInfo,
): DisputeOptions {
  const items = products.productInfoList ?? []
  return {
    disputable: items.some((item) => item.canChoose === true),
    maxRefundCents: confirm.maxAmount === undefined ? undefined : usdToCents(confirm.maxAmount),
    reasons: (confirm.disputeReasonList ?? []).map((r) => ({
      id: String(r.disputeReasonId),
      label: r.reasonName,
    })),
    allowedKinds: (confirm.expectResultOptionList ?? [])
      .map((o) => DISPUTE_RESULT_OPTIONS[String(o)])
      .filter((k): k is 'refund' | 'reissue' => k !== undefined),
  }
}

/** Dispute status normalization table for disputes/getDisputeDetail's `disputeStatus`
 * (case-insensitive). */
export function mapCjDisputeStatus(raw: string): DisputeStatus['value'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'pending':
    case 'processing':
      return 'pending'
    case 'refunded':
      return 'refunded'
    case 'reissued':
      return 'reissued'
    case 'rejected':
    case 'closed':
      return 'rejected'
    default:
      return 'unknown'
  }
}

interface CjDisputeDetail {
  disputeId: string
  disputeStatus: string
}

export function mapDisputeStatusDetail(detail: CjDisputeDetail): DisputeStatus {
  return { value: mapCjDisputeStatus(detail.disputeStatus), raw: detail.disputeStatus }
}
