import { createHash } from 'node:crypto'
import type {
  DisputeOptions,
  DisputeStatus,
  PlaceOrderRequest,
  PlaceOrderResult,
  ShippingOption,
  SupplierAdapter,
  SupplierKey,
  SupplierOrderStatus,
  SupplierOrderStatusValue,
  SupplierProductDetail,
  SupplierProductReview,
  SupplierProductSummary,
  SupplierVariantDetail,
  SupplierWebhookEvent,
  TrackingInfo,
  WarehouseStock,
} from '../../types.ts'

export interface MockAdapterOptions {
  failPayInsufficientBalance?: boolean
  balanceCents?: number
  usStock?: Record<string, number>
  priceMultiplier?: number
  /**
   * 429-storm simulation: `placeOrder` throws a retryable error on each of the first N calls,
   * then succeeds normally (creating exactly one order) on call N+1 — mirrors a supplier rate
   * limit that clears after a few automatic retries. The counter is instance-wide (not scoped to
   * idempotencyKey), matching production: a retried job always resends the SAME idempotencyKey
   * for the SAME order, so by the time the counter reaches zero, no earlier call for that key has
   * ever succeeded — `placeOrder`'s existing idempotency check (above) still guarantees a second
   * call after that first success just returns the cached result, never a second order. Omitted
   * or `0` (default): `placeOrder` never fails this way.
   */
  failPlaceOrderTimes?: number
}

interface MockVariant {
  supplierVariantId: string
  productId: string
  name: string
  basePriceCents: number
}

interface MockProduct {
  supplierProductId: string
  title: string
}

interface MockOrder {
  supplierOrderId: string
  shipmentOrderId: string
  status: SupplierOrderStatusValue
  productAmountCents: number
  postageAmountCents: number
  totalAmountCents: number
  trackingNumber?: string
}

const MOCK_PRODUCTS: MockProduct[] = [
  { supplierProductId: 'mock-p1', title: 'Tug Rope Toy' },
  { supplierProductId: 'mock-p2', title: 'Slow Feeder Bowl' },
  { supplierProductId: 'mock-p3', title: 'Calming Dog Bed' },
]

const MOCK_VARIANTS: MockVariant[] = [
  { supplierVariantId: 'mock-v1', productId: 'mock-p1', name: 'Tug Rope Toy', basePriceCents: 620 },
  { supplierVariantId: 'mock-v2', productId: 'mock-p1', name: 'Tug Rope Toy - Large', basePriceCents: 710 },
  { supplierVariantId: 'mock-v3', productId: 'mock-p2', name: 'Slow Feeder Bowl', basePriceCents: 480 },
  { supplierVariantId: 'mock-v4', productId: 'mock-p3', name: 'Calming Dog Bed', basePriceCents: 1840 },
]

const STANDARD_BASE_CENTS = 499
const EXPRESS_BASE_CENTS = 1299

function findVariant(supplierVariantId: string): MockVariant | undefined {
  return MOCK_VARIANTS.find((v) => v.supplierVariantId === supplierVariantId)
}

/**
 * In-memory SupplierAdapter used for tests, local dev, and the ops sandbox.
 * No I/O, no timers — all state lives on the instance.
 */
export class MockSupplierAdapter implements SupplierAdapter {
  readonly key: SupplierKey = 'mock'
  readonly placedOrders: PlaceOrderResult[] = []
  /** Records every supplierProductId passed to subscribeProductWebhook, in call order
   * (duplicates included) — read by Task 16's tests to assert the post-listing subscribe call. */
  readonly subscribedProductIds: string[] = []

  private readonly opts: MockAdapterOptions
  private readonly priceMultiplier: number
  private readonly ordersById = new Map<string, MockOrder>()
  private readonly ordersByIdempotencyKey = new Map<string, PlaceOrderResult>()
  private readonly disputesByIdempotencyKey = new Map<string, string>()
  private readonly disputesById = new Set<string>()
  private orderCounter = 0
  private disputeCounter = 0
  private placeOrderFailuresRemaining: number
  /**
   * Per-instance nonce mixed into every `supplierOrderId`/`shipmentOrderId` this instance ever
   * produces, so two different `MockSupplierAdapter` instances (a fresh one per test, or the same
   * test file re-run against a dirty/never-reset shared DB) can never both mint the literal id
   * `mock-order-1` — the collision that used to trip the partial unique index on
   * `(supplier, supplier_order_id)` on a rerun. The counter below still starts at 0 and increments
   * per call WITHIN one instance, so ids stay deterministic (`mock-order-<nonce>-1`,
   * `mock-order-<nonce>-2`, ...) for tests that assert on call sequence — only the nonce varies
   * across instances.
   */
  private readonly instanceNonce = Math.random().toString(36).slice(2, 8)

  constructor(opts: MockAdapterOptions = {}) {
    this.opts = opts
    this.priceMultiplier = opts.priceMultiplier ?? 1
    this.placeOrderFailuresRemaining = opts.failPlaceOrderTimes ?? 0
  }

  private priced(baseCents: number): number {
    return Math.round(baseCents * this.priceMultiplier)
  }

  private requireOrder(supplierOrderId: string): MockOrder {
    const order = this.ordersById.get(supplierOrderId)
    if (!order) throw new Error(`unknown order: ${supplierOrderId}`)
    return order
  }

  private findOrderByAnyId(id: string): MockOrder {
    const order = this.ordersById.get(id)
    if (order) return order
    const byShipment = [...this.ordersById.values()].find((o) => o.shipmentOrderId === id)
    if (byShipment) return byShipment
    throw new Error(`unknown order: ${id}`)
  }

  async searchProducts(q: Parameters<SupplierAdapter['searchProducts']>[0]): Promise<SupplierProductSummary[]> {
    const keyword = q.keyword?.toLowerCase()
    return MOCK_PRODUCTS.filter((p) => !keyword || p.title.toLowerCase().includes(keyword)).map((p) => {
      const firstVariant = MOCK_VARIANTS.find((v) => v.productId === p.supplierProductId)!
      return {
        supplierProductId: p.supplierProductId,
        title: p.title,
        sellPriceCents: this.priced(firstVariant.basePriceCents),
      }
    })
  }

  async getProduct(supplierProductId: string): Promise<SupplierProductDetail> {
    const product = MOCK_PRODUCTS.find((p) => p.supplierProductId === supplierProductId)
    if (!product) throw new Error(`unknown product: ${supplierProductId}`)
    const variants: SupplierVariantDetail[] = MOCK_VARIANTS.filter((v) => v.productId === supplierProductId).map(
      (v) => ({
        supplierVariantId: v.supplierVariantId,
        name: v.name,
        priceCents: this.priced(v.basePriceCents),
      }),
    )
    return {
      supplierProductId: product.supplierProductId,
      title: product.title,
      imageUrls: [],
      variants,
    }
  }

  async getProductReviews(supplierProductId: string, _q?: { page?: number; pageSize?: number }): Promise<SupplierProductReview[]> {
    // Return canned reviews only for known pids (in MOCK_PRODUCTS), [] otherwise
    const product = MOCK_PRODUCTS.find((p) => p.supplierProductId === supplierProductId)
    if (!product) return []
    return [
      { rating: 5, content: 'Excellent quality and fast shipping!', reviewDate: '2026-08-15', countryCode: 'US' },
      { rating: 4, content: 'Good value for the price', reviewDate: '2026-08-10', countryCode: 'US' },
    ]
  }

  async getVariantStock(supplierVariantId: string): Promise<WarehouseStock[]> {
    const quantity = this.opts.usStock?.[supplierVariantId] ?? 50
    return [
      { countryCode: 'US', quantity, verified: true },
      { countryCode: 'CN', quantity: 500, verified: false },
    ]
  }

  async quoteShipping(q: Parameters<SupplierAdapter['quoteShipping']>[0]): Promise<ShippingOption[]> {
    for (const item of q.items) {
      if (!findVariant(item.supplierVariantId)) {
        throw new Error(`unknown variant: ${item.supplierVariantId}`)
      }
    }
    return [
      { name: 'Standard', priceCents: this.priced(STANDARD_BASE_CENTS), minDays: 3, maxDays: 7 },
      { name: 'Express', priceCents: this.priced(EXPRESS_BASE_CENTS), minDays: 1, maxDays: 3 },
    ]
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const existing = this.ordersByIdempotencyKey.get(req.idempotencyKey)
    if (existing) return existing

    if (this.placeOrderFailuresRemaining > 0) {
      this.placeOrderFailuresRemaining -= 1
      throw new Error('mock: simulated 429 rate limit (retryable)')
    }

    let productAmountCents = 0
    for (const item of req.items) {
      const variant = findVariant(item.supplierVariantId)
      if (!variant) throw new Error(`unknown variant: ${item.supplierVariantId}`)
      productAmountCents += this.priced(variant.basePriceCents) * item.quantity
    }
    const postageAmountCents = this.priced(STANDARD_BASE_CENTS)
    const totalAmountCents = productAmountCents + postageAmountCents

    this.orderCounter += 1
    const supplierOrderId = `mock-order-${this.instanceNonce}-${this.orderCounter}`
    const shipmentOrderId = `mock-ship-${this.instanceNonce}-${this.orderCounter}`

    const result: PlaceOrderResult = {
      supplierOrderId,
      shipmentOrderId,
      productAmountCents,
      postageAmountCents,
      totalAmountCents,
    }

    this.ordersById.set(supplierOrderId, {
      supplierOrderId,
      shipmentOrderId,
      status: 'created',
      productAmountCents,
      postageAmountCents,
      totalAmountCents,
    })
    this.ordersByIdempotencyKey.set(req.idempotencyKey, result)
    this.placedOrders.push(result)

    return result
  }

  async confirmOrder(supplierOrderId: string): Promise<void> {
    const order = this.requireOrder(supplierOrderId)
    order.status = 'pending'
  }

  async payOrder(shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: 'insufficient_balance' | string }> {
    const order = this.findOrderByAnyId(shipmentOrderId)
    if (this.opts.failPayInsufficientBalance) {
      return { paid: false, failureReason: 'insufficient_balance' }
    }
    order.status = 'processing'
    return { paid: true }
  }

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus> {
    const order = this.requireOrder(supplierOrderId)
    return { value: order.status, raw: order.status }
  }

  async getTracking(supplierOrderId: string): Promise<TrackingInfo | null> {
    const order = this.requireOrder(supplierOrderId)
    if (!order.trackingNumber) return null
    return { trackingNumber: order.trackingNumber }
  }

  /** Test helper: force an order to a given status. Auto-assigns tracking on 'shipped'. */
  advanceOrder(supplierOrderId: string, status: SupplierOrderStatusValue): void {
    const order = this.requireOrder(supplierOrderId)
    order.status = status
    if (status === 'shipped') {
      order.trackingNumber = `MOCK-TRACK-${supplierOrderId}`
    }
  }

  async getBalance(): Promise<{ availableCents: number; frozenCents: number }> {
    return { availableCents: this.opts.balanceCents ?? 100_000, frozenCents: 0 }
  }

  async getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions> {
    const order = this.requireOrder(supplierOrderId)
    return {
      disputable: true,
      maxRefundCents: order.totalAmountCents,
      reasons: [
        { id: 'mock-damaged', label: 'Damaged' },
        { id: 'mock-not-delivered', label: 'Not delivered' },
      ],
      allowedKinds: ['refund', 'reissue'],
    }
  }

  async openDispute(req: Parameters<SupplierAdapter['openDispute']>[0]): Promise<{ disputeId: string }> {
    const existing = this.disputesByIdempotencyKey.get(req.idempotencyKey)
    if (existing) return { disputeId: existing }

    this.disputeCounter += 1
    const disputeId = `mock-dispute-${this.disputeCounter}`
    this.disputesByIdempotencyKey.set(req.idempotencyKey, disputeId)
    this.disputesById.add(disputeId)
    return { disputeId }
  }

  async getDispute(disputeId: string): Promise<DisputeStatus> {
    return { value: this.disputesById.has(disputeId) ? 'pending' : 'unknown' }
  }

  async subscribeProductWebhook(supplierProductId: string): Promise<void> {
    this.subscribedProductIds.push(supplierProductId)
  }

  /** Removes one recorded occurrence of `supplierProductId` if present; a no-op (never throws)
   * for an id that was never subscribed — mirrors subscribeProductWebhook's best-effort
   * semantics on the way in. */
  async unsubscribeProductWebhook(supplierProductId: string): Promise<void> {
    const index = this.subscribedProductIds.indexOf(supplierProductId)
    if (index !== -1) this.subscribedProductIds.splice(index, 1)
  }

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): boolean {
    return true
  }

  parseWebhook(rawBody: Buffer): SupplierWebhookEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      type?: string
      id?: string
      orderId?: string
      [key: string]: unknown
    }
    const knownTypes = ['order', 'logistics', 'stock', 'product', 'other']
    const type = (knownTypes.includes(body.type ?? '') ? body.type : 'other') as SupplierWebhookEvent['type']
    const externalEventId = body.id ?? createHash('sha256').update(rawBody).digest('hex')
    return {
      type,
      externalEventId,
      supplierOrderId: body.orderId,
      payload: body,
    }
  }
}
