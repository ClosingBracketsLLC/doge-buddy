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
        idempotencyKey: `contract-${name}-idem-1`,
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
        idempotencyKey: `contract-${name}-life-1`,
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
        idempotencyKey: `contract-${name}-track-1`,
        shippingAddress: ctx.address,
        items: [{ supplierVariantId: ctx.knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      expect(await ctx.adapter.getTracking(placed.supplierOrderId)).toBeNull()
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
        idempotencyKey: `contract-${name}-disp-1`,
        shippingAddress: address,
        items: [{ supplierVariantId: knownVariantId, quantity: 1 }],
        logisticName: 'Standard', fromCountry: 'US',
      })
      const options = await adapter.getDisputeOptions(placed.supplierOrderId)
      expect(typeof options.disputable).toBe('boolean')
      expect(Array.isArray(options.reasons)).toBe(true)
    })
  })
}
