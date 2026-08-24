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

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' })
function countryDisplayName(isoCode: string): string {
  return countryNames.of(isoCode) ?? isoCode
}

// Observed live 2026-08-23: CJ's /webhook/set registration probe delivers its signature under
// the plain `sign` header (base64, 32 bytes decoded — consistent with the documented
// base64(hmacSHA256(openId, rawBody)) scheme). The original three guessed names are kept as
// fallbacks; `sign` leads because it is the one CJ actually sends.
const CJ_SIGNATURE_HEADERS = ['sign', 'cj-signature', 'x-cj-signature', 'signature'] as const

const CJ_WEBHOOK_TYPES: Record<string, SupplierWebhookEvent['type']> = {
  ORDER: 'order',
  // Observed live 2026-08-23: CJ delivers `LOGISTIC` (singular) — the plural is kept as a
  // defensive alias since the docs spell it that way.
  LOGISTIC: 'logistics',
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

// Verified against live CJ 2026-08-23: shopping/pay/getBalance reports the available balance as
// `amount` and the frozen portion as `freezeAmount`. noWithdrawalAmount is present in sample
// payloads but not surfaced by SupplierAdapter#getBalance today.
interface CjBalance {
  amount: number | string
  freezeAmount: number | string
}

// Verified against live CJ 2026-08-23: order/list entries echo the client-supplied order number
// as `orderNum` (NOT `orderNumber` — that name appears only on the createOrderV3 response), and
// the `orderNumbers` query param does filter server-side. placeOrder still re-checks the field
// itself rather than trusting the filter alone.
type CjOrderListEntry = Parameters<typeof mapOrderAmounts>[0] & { orderNum: string }

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
    // Verified against live CJ 2026-08-23: listV2 nests its results two levels deep as
    // { content: [{ productList: [...] }] } — not the flat { list: [...] } the other list
    // endpoints (e.g. order/list) return.
    const data = await this.client.request<{
      content?: { productList?: Parameters<typeof mapProductSummary>[0][] }[]
    }>('GET', '/product/listV2', { query, points: 50 })
    return (data.content ?? []).flatMap((group) => group.productList ?? []).map(mapProductSummary)
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

  /** Idempotent on idempotencyKey: pre-checks order/list for an existing order before ever
   * calling createOrderV3, so a repeated call never creates a second (chargeable) CJ order. The
   * match is re-verified client-side against each entry's `orderNum` rather than trusting CJ's
   * `orderNumbers` query filter alone. */
  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const existing = await this.client.request<{ list?: CjOrderListEntry[] }>(
      'GET',
      '/shopping/order/list',
      { query: { orderNumbers: req.idempotencyKey }, points: 0, priority: true },
    )
    const existingList = existing.list ?? []
    const match = existingList.find((o) => o.orderNum === req.idempotencyKey)
    if (match) {
      return mapOrderAmounts(match)
    }

    const body = {
      orderNumber: req.idempotencyKey,
      shippingCountryCode: req.shippingAddress.country,
      // CJ's createOrderV3 requires the country's display name (shippingCountry) in addition to
      // its ISO code (shippingCountryCode) — derived via Intl rather than a hand-maintained table.
      shippingCountry: countryDisplayName(req.shippingAddress.country),
      fromCountryCode: req.fromCountry,
      logisticName: req.logisticName,
      // shopLogisticsType 1 ("platform shipping mode") additionally demands a storageId, which
      // pins the order to one specific CJ warehouse; 2 is CJ's documented default and lets CJ
      // route it. Verified live: 1 fails with `5030 Storage ID cannot be empty`, 2 succeeds.
      shopLogisticsType: 2,
      payType: 3,
      // Docs describe `platform` as optional ("Default: Api"), but live CJ rejects both an absent
      // one (`5027 Platform null not support`) and every casing of "api" (`Platform api not
      // support`) — the API is not itself an accepted order-origin platform. Doge Buddy's orders
      // genuinely originate from a Shopify store, which is the accurate value here anyway.
      platform: 'shopify',
      shippingCustomerName: req.shippingAddress.name,
      shippingPhone: req.shippingAddress.phone,
      email: req.shippingAddress.email,
      shippingAddress: req.shippingAddress.line1,
      shippingAddress2: req.shippingAddress.line2,
      shippingCity: req.shippingAddress.city,
      shippingProvince: req.shippingAddress.state,
      shippingZip: req.shippingAddress.zip,
      products: req.items.map((item) => ({ vid: item.supplierVariantId, quantity: item.quantity })),
      // isSandbox: 1 is CJ's documented way to mark a test order — it simulates payment and
      // skips real charges/logistics entirely. The previous `sandbox: true` field name/type was
      // unverified and wrong (CJ doesn't recognize it), which would have sent real, chargeable
      // orders to CJ even when this adapter was constructed with sandbox: true.
      ...(this.sandbox ? { isSandbox: 1 } : {}),
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
      if (this.sandbox) {
        // Sandbox orders are not payable through the real balance rail — payBalanceV2 rejects
        // them outright (HTTP 400). simulatePay is CJ's sandbox-only stand-in, and moves the
        // order to UNSHIPPED exactly as a real payment would.
        await this.client.simulatePay(shipmentOrderId)
        return { paid: true }
      }
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

  // Disputes are post-shipment and lower urgency than the money-path calls above, so — unlike
  // placeOrder/confirmOrder/payOrder/getOrderDetail — these respect the daily points budget
  // instead of bypassing it with priority: true.
  async getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions> {
    const products = await this.client.request<Parameters<typeof mapDisputeOptions>[0]>(
      'GET',
      '/disputes/disputeProducts',
      { query: { orderId: supplierOrderId }, points: 10 },
    )
    const productInfoList = products.productInfoList ?? []
    const confirm = await this.client.request<Parameters<typeof mapDisputeOptions>[1]>(
      'POST',
      '/disputes/disputeConfirmInfo',
      {
        // Verified live: disputeConfirmInfo wants disputeProducts' `productInfoList` entries
        // passed straight back through. Reshaping them into {lineItemId, vid} pairs — the shape
        // this previously sent — is rejected with HTTP 400.
        body: { orderId: supplierOrderId, productInfoList },
        points: 10,
      },
    )
    return mapDisputeOptions({ productInfoList }, confirm)
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
    })
    return { disputeId: data.disputeId }
  }

  async getDispute(disputeId: string): Promise<DisputeStatus> {
    const data = await this.client.request<Parameters<typeof mapDisputeStatusDetail>[0]>(
      'GET',
      '/disputes/getDisputeDetail',
      { query: { disputeId }, points: 10 },
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
