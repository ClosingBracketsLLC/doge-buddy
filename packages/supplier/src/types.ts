export type SupplierKey = 'cj' | 'mock'

export interface Address {
  name: string
  phone?: string
  email?: string
  line1: string
  line2?: string
  city: string
  state: string
  zip: string
  country: string // ISO-3166 alpha-2, 'US' at launch
}

export interface SupplierProductSummary {
  supplierProductId: string
  title: string
  imageUrl?: string
  sellPriceCents: number
  listedCount?: number
  categoryName?: string
}

export interface SupplierVariantDetail {
  supplierVariantId: string
  sku?: string
  name?: string
  priceCents: number
  weightGrams?: number
  imageUrl?: string
}

export interface SupplierProductDetail {
  supplierProductId: string
  title: string
  descriptionHtml?: string
  imageUrls: string[]
  categoryName?: string
  variants: SupplierVariantDetail[]
}

export interface WarehouseStock {
  countryCode: string
  quantity: number
  verified: boolean
}

export interface ShippingOption {
  name: string
  priceCents: number
  minDays: number
  maxDays: number
}

export type SupplierOrderStatusValue =
  | 'created' | 'unpaid' | 'pending' | 'processing'
  | 'shipped' | 'delivered' | 'cancelled' | 'unknown'

export interface SupplierOrderStatus {
  value: SupplierOrderStatusValue
  raw: string
}

export interface TrackingInfo {
  trackingNumber: string
  carrier?: string
  lastMileTrackingNumber?: string
}

export interface DisputeOptions {
  disputable: boolean
  maxRefundCents?: number
  reasons: { id: string; label: string }[]
  allowedKinds: ('refund' | 'reissue')[]
}

export interface DisputeStatus {
  value: 'pending' | 'refunded' | 'reissued' | 'rejected' | 'unknown'
  raw?: string
}

export interface SupplierWebhookEvent {
  type: 'order' | 'logistics' | 'stock' | 'product' | 'other'
  externalEventId: string
  supplierOrderId?: string
  payload: unknown
}

export interface PlaceOrderRequest {
  idempotencyKey: string
  shippingAddress: Address
  items: { supplierVariantId: string; quantity: number }[]
  logisticName: string
  fromCountry: string
}

export interface PlaceOrderResult {
  supplierOrderId: string
  shipmentOrderId?: string
  productAmountCents: number
  postageAmountCents: number
  totalAmountCents: number
}

export interface SupplierAdapter {
  readonly key: SupplierKey

  searchProducts(q: {
    keyword?: string
    categoryId?: string
    countryCode?: string
    flag?: 'trending' | 'new'
    page?: number
    pageSize?: number
    minPriceCents?: number
    maxPriceCents?: number
  }): Promise<SupplierProductSummary[]>
  getProduct(supplierProductId: string): Promise<SupplierProductDetail>

  getVariantStock(supplierVariantId: string): Promise<WarehouseStock[]>
  quoteShipping(q: {
    fromCountry: string
    toCountry: string
    toZip?: string
    items: { supplierVariantId: string; quantity: number }[]
  }): Promise<ShippingOption[]>

  /** MUST be idempotent on idempotencyKey: repeat call returns the existing order, never creates a second one. */
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>
  confirmOrder(supplierOrderId: string): Promise<void>
  payOrder(shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: 'insufficient_balance' | string }>
  getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus>
  getTracking(supplierOrderId: string): Promise<TrackingInfo | null>

  getBalance(): Promise<{ availableCents: number; frozenCents: number }>
  getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions>
  openDispute(req: {
    supplierOrderId: string
    idempotencyKey: string
    reasonId: string
    kind: 'refund' | 'reissue'
    amountCents: number
    message: string
    evidenceUrls?: string[]
  }): Promise<{ disputeId: string }>
  getDispute(disputeId: string): Promise<DisputeStatus>

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean
  parseWebhook(rawBody: Buffer): SupplierWebhookEvent
}
