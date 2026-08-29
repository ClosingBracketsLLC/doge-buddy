import { describe, expect, it } from 'vitest'
import type { Address, SupplierAdapter } from '../types.ts'

export interface AdapterContractContext {
  adapter: SupplierAdapter
  knownVariantId: string
  searchKeyword: string
  address: Address
  advanceToShipped?: (supplierOrderId: string) => Promise<void>
}

/**
 * Behavioral contract every SupplierAdapter must satisfy.
 * Runs against MockSupplierAdapter always; against the CJ adapter in sandbox
 * mode when CJ_CONTRACT=1 (Task 6).
 */
export function runAdapterContractTests(name: string, setup: () => Promise<AdapterContractContext>): void {
  // Idempotency keys must be unique PER RUN. Against a real supplier the orders these tests place
  // outlive the run, so a fixed key makes the second run reuse the first run's order — which by
  // then has advanced past the state the test expects ("Only order in CREATED or IN_CART status
  // can be confirmed"). Within a single run the key stays stable, which is what the idempotency
  // case actually exercises.
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const key = (purpose: string) => `contract-${name}-${purpose}-${runId}`

  describe(`SupplierAdapter contract: ${name}`, () => {
    it('searches products and returns well-formed summaries', async () => {
      const { adapter, searchKeyword } = await setup()
      const results = await adapter.searchProducts({ keyword: searchKeyword, countryCode: 'US', pageSize: 10 })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.supplierProductId).toBeTruthy()
        expect(r.title).toBeTruthy()
        expect(Number.isSafeInteger(r.sellPriceCents)).toBe(true)
        expect(r.sellPriceCents).toBeGreaterThan(0)
      }
    })

    it('returns product detail with at least one variant', async () => {
      const { adapter, searchKeyword } = await setup()
      const [first] = await adapter.searchProducts({ keyword: searchKeyword, countryCode: 'US', pageSize: 1 })
      const detail = await adapter.getProduct(first!.supplierProductId)
      expect(detail.variants.length).toBeGreaterThan(0)
      expect(Number.isSafeInteger(detail.variants[0]!.priceCents)).toBe(true)
    })

    it('returns product reviews with defensive mapping (CJ_CONTRACT only)', async () => {
      if (process.env.CJ_CONTRACT !== '1') return
      const { adapter } = await setup()
      const pid = process.env.CJ_CONTRACT_PID ?? '1952308304475578369'
      const reviews = await adapter.getProductReviews(pid)
      expect(Array.isArray(reviews)).toBe(true)
    })

    it('subscribes a product to webhooks without throwing (CJ_CONTRACT only; wire shape unverified)', async () => {
      if (process.env.CJ_CONTRACT !== '1') return
      const { adapter } = await setup()
      const pid = process.env.CJ_CONTRACT_PID ?? '1952308304475578369'
      await expect(adapter.subscribeProductWebhook(pid)).resolves.toBeUndefined()
    })

    it('unsubscribeProductWebhook resolves after subscribeProductWebhook (mock record cleared when exposed)', async () => {
      const { adapter } = await setup()
      await adapter.subscribeProductWebhook('x')
      await expect(adapter.unsubscribeProductWebhook('x')).resolves.toBeUndefined()
      // MockSupplierAdapter exposes `subscribedProductIds` (not part of SupplierAdapter itself);
      // when present, assert the id is actually gone rather than just that the call didn't throw.
      const recorded = (adapter as unknown as { subscribedProductIds?: string[] }).subscribedProductIds
      if (recorded) expect(recorded).not.toContain('x')
    })

    it('unsubscribeProductWebhook resolves without throwing for an id that was never subscribed', async () => {
      const { adapter } = await setup()
      await expect(adapter.unsubscribeProductWebhook('never-subscribed')).resolves.toBeUndefined()
    })

    it('reports per-warehouse stock for a known variant', async () => {
      const { adapter, knownVariantId } = await setup()
      const stock = await adapter.getVariantStock(knownVariantId)
      expect(stock.length).toBeGreaterThan(0)
      for (const s of stock) {
        expect(s.countryCode).toMatch(/^[A-Z]{2}$/)
        expect(Number.isSafeInteger(s.quantity)).toBe(true)
      }
    })

    it('quotes shipping with integer cents and sane day ranges', async () => {
      const { adapter, knownVariantId } = await setup()
      const options = await adapter.quoteShipping({
        fromCountry: 'US', toCountry: 'US', toZip: '30301',
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
      })
      expect(options.length).toBeGreaterThan(0)
      for (const o of options) {
        expect(Number.isSafeInteger(o.priceCents)).toBe(true)
        expect(o.priceCents).toBeGreaterThanOrEqual(0)
        expect(o.minDays).toBeGreaterThan(0)
        expect(o.minDays).toBeLessThanOrEqual(o.maxDays)
      }
    })

    it('placeOrder is idempotent on idempotencyKey', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const req = {
        idempotencyKey: key('idem'),
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      }
      const first = await adapter.placeOrder(req)
      const second = await adapter.placeOrder(req)
      expect(second.supplierOrderId).toBe(first.supplierOrderId)
      expect(second.totalAmountCents).toBe(first.totalAmountCents)
      expect(Number.isSafeInteger(first.totalAmountCents)).toBe(true)
      expect(first.totalAmountCents).toBe(first.productAmountCents + first.postageAmountCents)
    })

    it('runs the confirm → pay → status lifecycle', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const placed = await adapter.placeOrder({
        idempotencyKey: key('life'),
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      await adapter.confirmOrder(placed.supplierOrderId)
      const pay = await adapter.payOrder(placed.shipmentOrderId ?? placed.supplierOrderId)
      expect(pay.paid).toBe(true)
      const status = await adapter.getOrderStatus(placed.supplierOrderId)
      expect(['created', 'unpaid', 'pending', 'processing', 'shipped', 'delivered']).toContain(status.value)
    })

    it('exposes tracking once shipped (when the harness can advance state)', async () => {
      const ctx = await setup()
      if (!ctx.advanceToShipped) return
      const placed = await ctx.adapter.placeOrder({
        idempotencyKey: key('track'),
        shippingAddress: ctx.address,
        items: [{ supplierVariantId: ctx.knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      expect(await ctx.adapter.getTracking(placed.supplierOrderId)).toBeNull()
      // A supplier will not ship what it has not been paid for: CJ rejects a status advance on an
      // unpaid order ("current status CREATED(100) can only be updated to none").
      await ctx.adapter.confirmOrder(placed.supplierOrderId)
      await ctx.adapter.payOrder(placed.shipmentOrderId ?? placed.supplierOrderId)
      await ctx.advanceToShipped(placed.supplierOrderId)
      const tracking = await ctx.adapter.getTracking(placed.supplierOrderId)
      expect(tracking?.trackingNumber).toBeTruthy()
    })

    it('reports balance in integer cents', async () => {
      const { adapter } = await setup()
      const b = await adapter.getBalance()
      expect(Number.isSafeInteger(b.availableCents)).toBe(true)
      expect(Number.isSafeInteger(b.frozenCents)).toBe(true)
    })

    it('offers dispute options for an order', async () => {
      const { adapter, knownVariantId, address } = await setup()
      const placed = await adapter.placeOrder({
        idempotencyKey: key('disp'),
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      // Disputes only exist against an order the supplier has actually been paid for — CJ answers
      // "Order cannot be disputed" for one still sitting unpaid.
      await adapter.confirmOrder(placed.supplierOrderId)
      await adapter.payOrder(placed.shipmentOrderId ?? placed.supplierOrderId)
      const options = await adapter.getDisputeOptions(placed.supplierOrderId)
      expect(typeof options.disputable).toBe('boolean')
      expect(Array.isArray(options.reasons)).toBe(true)
    })
  })
}
