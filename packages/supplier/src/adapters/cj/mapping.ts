import { usdToCents } from '@doge-buddy/core'
import type {
  DisputeOptions,
  DisputeStatus,
  PlaceOrderResult,
  ShippingOption,
  SupplierOrderStatus,
  SupplierOrderStatusValue,
  SupplierProductDetail,
  SupplierProductSummary,
  SupplierVariantDetail,
  TrackingInfo,
  WarehouseStock,
} from '../../types.ts'

/**
 * Pure mappers from CJ Dropshipping API response shapes (as documented + observed in sample
 * payloads) to Doge Buddy's supplier-domain types. Fixtures under test/fixtures/cj/ pin the
 * exact field names these mappers read. Fields flagged FIXTURE-ASSUMPTION are our best-effort
 * read of the CJ docs/samples and have not been confirmed against a live CJ response — verify
 * against the sandbox before Task 6 depends on any sibling fields we have not yet mapped.
 */

// FIXTURE-ASSUMPTION: productNameEn is CJ's English product name field on listV2 list items.
interface CjProductListItem {
  pid: string
  productNameEn: string
  productImage?: string
  sellPrice: number | string
  listedNum?: number
  categoryName?: string
}

export function mapProductSummary(item: CjProductListItem): SupplierProductSummary {
  return {
    supplierProductId: item.pid,
    title: item.productNameEn,
    imageUrl: item.productImage,
    sellPriceCents: usdToCents(item.sellPrice),
    listedCount: item.listedNum,
    categoryName: item.categoryName,
  }
}

// FIXTURE-ASSUMPTION: variantSellPrice/variantWeight(grams)/variantImage are CJ's per-variant
// fields on product/query; variantImage is nullable when a variant has no dedicated image.
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

// FIXTURE-ASSUMPTION: storageNum (per-warehouse quantity) and verifiedWarehouse (1/0 flag) are
// CJ's field names on product/stock/queryByVid.
interface CjStockEntry {
  countryCode: string
  storageNum: number
  verifiedWarehouse: number
}

export function mapStock(entry: CjStockEntry): WarehouseStock {
  return {
    countryCode: entry.countryCode,
    quantity: entry.storageNum,
    verified: entry.verifiedWarehouse === 1,
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

// FIXTURE-ASSUMPTION: logisticAging is CJ's free-text delivery estimate on
// logistic/freightCalculate, observed as either a "min-max" day range (e.g. "3-7") or a single
// day count (e.g. "2"), sometimes with trailing units text (e.g. "10-15 days"). There is no
// documented fixed grammar, so this defensively strips everything but digits and dashes and
// falls back to a wide {1, 30} range on anything it can't parse — it must never throw.
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

/** Shared shape of createOrderV3's response and each entry of order/list's `list` array —
 * both carry the same order-identity + amount fields, so one mapper covers both call sites. */
interface CjOrderAmounts {
  orderId: string
  shipmentOrderId: string
  productAmount: number | string
  postageAmount: number | string
  orderAmount: number | string
}

export function mapOrderAmounts(o: CjOrderAmounts): PlaceOrderResult {
  return {
    supplierOrderId: o.orderId,
    shipmentOrderId: o.shipmentOrderId,
    productAmountCents: usdToCents(o.productAmount),
    postageAmountCents: usdToCents(o.postageAmount),
    totalAmountCents: usdToCents(o.orderAmount),
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

// FIXTURE-ASSUMPTION: trackNumber/logisticName/lastMileTrackNumber are CJ's field names on
// shopping/order/getOrderDetail; trackNumber is absent until the order actually ships.
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

// FIXTURE-ASSUMPTION: disputes/disputeProducts returns the order's disputable line items
// (lineItemId/vid/maxRefundAmount); a non-empty list is our signal the order is disputable.
interface CjDisputeProductsResponse {
  list: { lineItemId: string; vid: string; maxRefundAmount: number | string }[]
}

// FIXTURE-ASSUMPTION: disputes/disputeConfirmInfo returns the overall maxRefundAmount, the
// numeric expectResultOptions CJ allows (1 = refund, 2 = reissue), and the reason catalog.
interface CjDisputeConfirmInfo {
  maxRefundAmount: number | string
  expectResultOptions: number[]
  reasons: { reasonId: string; reasonNameEn: string }[]
}

const DISPUTE_RESULT_OPTIONS: Record<number, 'refund' | 'reissue'> = { 1: 'refund', 2: 'reissue' }

export function mapDisputeOptions(
  products: CjDisputeProductsResponse,
  confirm: CjDisputeConfirmInfo,
): DisputeOptions {
  return {
    disputable: products.list.length > 0,
    maxRefundCents: usdToCents(confirm.maxRefundAmount),
    reasons: confirm.reasons.map((r) => ({ id: r.reasonId, label: r.reasonNameEn })),
    allowedKinds: confirm.expectResultOptions
      .map((o) => DISPUTE_RESULT_OPTIONS[o])
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
