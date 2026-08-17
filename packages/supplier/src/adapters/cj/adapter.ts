import { usdToCents } from '@doge-buddy/core'
import type {
  DisputeOptions,
  DisputeStatus,
  PlaceOrderRequest,
  PlaceOrderResult,
  ShippingOption,
  SupplierAdapter,
  SupplierKey,
  SupplierOrderStatus,
  SupplierProductDetail,
  SupplierProductSummary,
  SupplierWebhookEvent,
  TrackingInfo,
  WarehouseStock,
} from '../../types.ts'
import type { CjHttpClient } from './http.ts'
import { mapFreightOption, mapProductDetail, mapProductSummary, mapStock } from './mapping.ts'

export interface CJSupplierAdapterOptions {
  client: CjHttpClient
  openId?: string
  sandbox?: boolean
}

// FIXTURE-ASSUMPTION: amount / freezeAmount are CJ's available/frozen balance fields on
// shopping/pay/getBalance; noWithdrawalAmount is present in sample payloads but not surfaced
// by SupplierAdapter#getBalance today.
interface CjBalance {
  amount: number | string
  freezeAmount: number | string
}

/**
 * CJ Dropshipping SupplierAdapter. This task (Phase 1 Task 5) implements only the read
 * methods (searchProducts, getProduct, getVariantStock, quoteShipping, getBalance); the
 * write/order/dispute/webhook methods are declared to satisfy the interface but are wired up
 * in Task 6.
 */
export class CJSupplierAdapter implements SupplierAdapter {
  readonly key: SupplierKey = 'cj'

  private readonly client: CjHttpClient
  private readonly openId: string | undefined
  private readonly sandbox: boolean

  constructor(opts: CJSupplierAdapterOptions) {
    this.client = opts.client
    this.openId = opts.openId
    this.sandbox = opts.sandbox ?? false
  }

  async searchProducts(q: Parameters<SupplierAdapter['searchProducts']>[0]): Promise<SupplierProductSummary[]> {
    const query: Record<string, string | number | undefined> = {
      keyWord: q.keyword,
      categoryId: q.categoryId,
      countryCode: q.countryCode,
      page: q.page ?? 1,
      size: q.pageSize ?? 20,
      productFlag: q.trending ? 0 : undefined,
      verifiedWarehouse: q.countryCode ? 1 : undefined,
      startSellPrice: q.minPriceCents !== undefined ? q.minPriceCents / 100 : undefined,
      endSellPrice: q.maxPriceCents !== undefined ? q.maxPriceCents / 100 : undefined,
    }
    const data = await this.client.request<{ list: Parameters<typeof mapProductSummary>[0][] }>(
      'GET',
      '/product/listV2',
      { query, points: 50 },
    )
    return data.list.map(mapProductSummary)
  }

  async getProduct(supplierProductId: string): Promise<SupplierProductDetail> {
    const data = await this.client.request<Parameters<typeof mapProductDetail>[0]>('GET', '/product/query', {
      query: { pid: supplierProductId, features: 'enable_description' },
      points: 10,
    })
    return mapProductDetail(data)
  }

  async getVariantStock(supplierVariantId: string): Promise<WarehouseStock[]> {
    const data = await this.client.request<Parameters<typeof mapStock>[0][]>(
      'GET',
      '/product/stock/queryByVid',
      { query: { vid: supplierVariantId }, points: 10 },
    )
    return data.map(mapStock)
  }

  async quoteShipping(q: Parameters<SupplierAdapter['quoteShipping']>[0]): Promise<ShippingOption[]> {
    const data = await this.client.request<Parameters<typeof mapFreightOption>[0][]>(
      'POST',
      '/logistic/freightCalculate',
      {
        body: {
          startCountryCode: q.fromCountry,
          endCountryCode: q.toCountry,
          zip: q.toZip,
          products: q.items.map((item) => ({ vid: item.supplierVariantId, quantity: item.quantity })),
        },
        points: 10,
      },
    )
    return data.map(mapFreightOption)
  }

  async getBalance(): Promise<{ availableCents: number; frozenCents: number }> {
    const data = await this.client.request<CjBalance>('GET', '/shopping/pay/getBalance', {
      points: 0,
      priority: true,
    })
    return {
      availableCents: usdToCents(data.amount),
      frozenCents: usdToCents(data.freezeAmount),
    }
  }

  // --- Write / order / dispute / webhook methods: implemented in Task 6 -----------------

  async placeOrder(_req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    throw new Error('implemented in Task 6')
  }

  async confirmOrder(_supplierOrderId: string): Promise<void> {
    throw new Error('implemented in Task 6')
  }

  async payOrder(_shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: string }> {
    throw new Error('implemented in Task 6')
  }

  async getOrderStatus(_supplierOrderId: string): Promise<SupplierOrderStatus> {
    throw new Error('implemented in Task 6')
  }

  async getTracking(_supplierOrderId: string): Promise<TrackingInfo | null> {
    throw new Error('implemented in Task 6')
  }

  async getDisputeOptions(_supplierOrderId: string): Promise<DisputeOptions> {
    throw new Error('implemented in Task 6')
  }

  async openDispute(_req: Parameters<SupplierAdapter['openDispute']>[0]): Promise<{ disputeId: string }> {
    throw new Error('implemented in Task 6')
  }

  async getDispute(_disputeId: string): Promise<DisputeStatus> {
    throw new Error('implemented in Task 6')
  }

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): boolean {
    throw new Error('implemented in Task 6')
  }

  parseWebhook(_rawBody: Buffer): SupplierWebhookEvent {
    throw new Error('implemented in Task 6')
  }
}
