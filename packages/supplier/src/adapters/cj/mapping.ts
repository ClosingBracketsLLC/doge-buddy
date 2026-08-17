import { usdToCents } from '@doge-buddy/core'
import type {
  ShippingOption,
  SupplierProductDetail,
  SupplierProductSummary,
  SupplierVariantDetail,
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
