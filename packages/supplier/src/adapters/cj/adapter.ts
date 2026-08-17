import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
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
import { CjApiError } from './errors.ts'
import type { CjHttpClient } from './http.ts'
import {
  mapDisputeOptions,
  mapDisputeStatusDetail,
  mapFreightOption,
  mapOrderAmounts,
  mapOrderStatusDetail,
  mapOrderTracking,
  mapProductDetail,
  mapProductSummary,
  mapStock,
} from './mapping.ts'

// FIXTURE-ASSUMPTION: CJ signs webhook payloads as base64(hmacSHA256(openId, rawBody)) and
// delivers the signature under one of these header names; we haven't confirmed the exact
// header against a live CJ webhook, so all three are checked in this priority order.
const CJ_SIGNATURE_HEADERS = ['cj-signature', 'x-cj-signature', 'signature'] as const

const CJ_WEBHOOK_TYPES: Record<string, SupplierWebhookEvent['type']> = {
  ORDER: 'order',
  LOGISTICS: 'logistics',
  STOCK: 'stock',
  PRODUCT: 'product',
}

const CJ_INSUFFICIENT_BALANCE_CODE = 1600100

function findSignatureHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  const lower = new Map<string, string | string[] | undefined>()
  for (const [key, value] of Object.entries(headers)) lower.set(key.toLowerCase(), value)

  for (const name of CJ_SIGNATURE_HEADERS) {
    const value = lower.get(name)
    if (value !== undefined) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

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
 * CJ Dropshipping SupplierAdapter. Read methods (searchProducts, getProduct, getVariantStock,
 * quoteShipping, getBalance) were implemented in Phase 1 Task 5; the order lifecycle, payment,
 * dispute, and webhook methods were wired up in Task 6.
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

  // --- Order lifecycle / payment / disputes / webhooks (Task 6) -------------------------

  /** Idempotent on idempotencyKey: pre-checks order/list for an existing order (by orderNumber)
   * before ever calling createOrderV3, so a repeated call never creates a second CJ order. */
  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const existing = await this.client.request<{ list: Parameters<typeof mapOrderAmounts>[0][] }>(
      'GET',
      '/shopping/order/list',
      { query: { orderNumbers: req.idempotencyKey }, points: 0, priority: true },
    )
    if (existing.list.length > 0) {
      return mapOrderAmounts(existing.list[0]!)
    }

    const body = {
      orderNumber: req.idempotencyKey,
      shippingCountryCode: req.shippingAddress.country,
      fromCountryCode: req.fromCountry,
      logisticName: req.logisticName,
      shopLogisticsType: 1,
      payType: 3,
      consigneeName: req.shippingAddress.name,
      phone: req.shippingAddress.phone,
      email: req.shippingAddress.email,
      addressLine1: req.shippingAddress.line1,
      addressLine2: req.shippingAddress.line2,
      city: req.shippingAddress.city,
      province: req.shippingAddress.state,
      zip: req.shippingAddress.zip,
      products: req.items.map((item) => ({ vid: item.supplierVariantId, quantity: item.quantity })),
      ...(this.sandbox ? { sandbox: true } : {}),
    }
    const created = await this.client.request<Parameters<typeof mapOrderAmounts>[0]>(
      'POST',
      '/shopping/order/createOrderV3',
      { body, points: 10, priority: true },
    )
    return mapOrderAmounts(created)
  }

  async confirmOrder(supplierOrderId: string): Promise<void> {
    await this.client.request('PATCH', '/shopping/order/confirmOrder', {
      body: { orderId: supplierOrderId },
      points: 10,
      priority: true,
    })
  }

  async payOrder(shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: string }> {
    try {
      await this.client.request('POST', '/shopping/pay/payBalanceV2', {
        body: { shipmentOrderId },
        points: 10,
        priority: true,
      })
      return { paid: true }
    } catch (err) {
      if (err instanceof CjApiError && err.code === CJ_INSUFFICIENT_BALANCE_CODE) {
        return { paid: false, failureReason: 'insufficient_balance' }
      }
      throw err
    }
  }

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus> {
    const data = await this.client.request<Parameters<typeof mapOrderStatusDetail>[0]>(
      'GET',
      '/shopping/order/getOrderDetail',
      { query: { orderId: supplierOrderId }, points: 10, priority: true },
    )
    return mapOrderStatusDetail(data)
  }

  async getTracking(supplierOrderId: string): Promise<TrackingInfo | null> {
    const data = await this.client.request<Parameters<typeof mapOrderTracking>[0]>(
      'GET',
      '/shopping/order/getOrderDetail',
      { query: { orderId: supplierOrderId }, points: 10, priority: true },
    )
    return mapOrderTracking(data)
  }

  async getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions> {
    const products = await this.client.request<Parameters<typeof mapDisputeOptions>[0]>(
      'GET',
      '/disputes/disputeProducts',
      { query: { orderId: supplierOrderId }, points: 10, priority: true },
    )
    const confirm = await this.client.request<Parameters<typeof mapDisputeOptions>[1]>(
      'POST',
      '/disputes/disputeConfirmInfo',
      {
        // FIXTURE-ASSUMPTION: disputeConfirmInfo takes the order + the disputable line items
        // returned by disputeProducts; the exact request shape is unconfirmed against a live
        // CJ response.
        body: { orderId: supplierOrderId, products: products.list.map((p) => ({ lineItemId: p.lineItemId, vid: p.vid })) },
        points: 10,
        priority: true,
      },
    )
    return mapDisputeOptions(products, confirm)
  }

  async openDispute(req: Parameters<SupplierAdapter['openDispute']>[0]): Promise<{ disputeId: string }> {
    const data = await this.client.request<{ disputeId: string }>('POST', '/disputes/create', {
      body: {
        businessDisputeId: req.idempotencyKey,
        orderId: req.supplierOrderId,
        reasonId: req.reasonId,
        expectResultOption: req.kind === 'refund' ? 1 : 2,
        refundAmount: req.amountCents / 100,
        message: req.message,
        imageUrls: req.evidenceUrls ?? [],
      },
      points: 10,
      priority: true,
    })
    return { disputeId: data.disputeId }
  }

  async getDispute(disputeId: string): Promise<DisputeStatus> {
    const data = await this.client.request<Parameters<typeof mapDisputeStatusDetail>[0]>(
      'GET',
      '/disputes/getDisputeDetail',
      { query: { disputeId }, points: 10, priority: true },
    )
    return mapDisputeStatusDetail(data)
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.openId) return false

    const received = findSignatureHeader(headers)
    if (received === undefined) return false

    const expected = createHmac('sha256', this.openId).update(rawBody).digest('base64')
    const expectedBuf = Buffer.from(expected, 'utf8')
    const receivedBuf = Buffer.from(received, 'utf8')
    if (expectedBuf.length !== receivedBuf.length) return false
    return timingSafeEqual(expectedBuf, receivedBuf)
  }

  parseWebhook(rawBody: Buffer): SupplierWebhookEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      type?: string
      messageId?: string
      requestId?: string
      orderId?: string
      [key: string]: unknown
    }
    const type = CJ_WEBHOOK_TYPES[(body.type ?? '').toUpperCase()] ?? 'other'
    const externalEventId = body.messageId ?? body.requestId ?? createHash('sha256').update(rawBody).digest('hex')
    return {
      type,
      externalEventId,
      supplierOrderId: body.orderId,
      payload: body,
    }
  }
}
