import { describe, expect, it } from 'vitest'
import { MockSupplierAdapter } from '@doge-buddy/supplier'
import { runAdapterContractTests } from '@doge-buddy/supplier/contract'

runAdapterContractTests('mock', async () => {
  const adapter = new MockSupplierAdapter()
  return {
    adapter,
    knownVariantId: 'mock-v1',
    searchKeyword: 'rope',
    address: { name: 'Test Dog', line1: '1 Bark St', city: 'Atlanta', state: 'GA', zip: '30301', country: 'US' },
    advanceToShipped: async (id) => adapter.advanceOrder(id, 'shipped'),
  }
})

describe('MockSupplierAdapter specifics', () => {
  it('simulates insufficient balance', async () => {
    const adapter = new MockSupplierAdapter({ failPayInsufficientBalance: true })
    const placed = await adapter.placeOrder({
      idempotencyKey: 'mock-fail-pay', logisticName: 'Standard', fromCountry: 'US',
      shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
      items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
    })
    const pay = await adapter.payOrder(placed.shipmentOrderId!)
    expect(pay).toEqual({ paid: false, failureReason: 'insufficient_balance' })
  })
  it('honors usStock overrides (0 stock)', async () => {
    const adapter = new MockSupplierAdapter({ usStock: { 'mock-v1': 0 } })
    const stock = await adapter.getVariantStock('mock-v1')
    expect(stock.find((s) => s.countryCode === 'US')?.quantity).toBe(0)
  })
  it('applies priceMultiplier to quotes and orders (price-drift simulation)', async () => {
    const base = new MockSupplierAdapter()
    const drifted = new MockSupplierAdapter({ priceMultiplier: 1.5 })
    const [b] = await base.searchProducts({ keyword: 'rope' })
    const [d] = await drifted.searchProducts({ keyword: 'rope' })
    expect(d!.sellPriceCents).toBe(Math.round(b!.sellPriceCents * 1.5))
  })
  it('throws on unknown variant in placeOrder', async () => {
    const adapter = new MockSupplierAdapter()
    await expect(adapter.placeOrder({
      idempotencyKey: 'mock-bad-variant', logisticName: 'Standard', fromCountry: 'US',
      shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
      items: [{ supplierVariantId: 'nope', quantity: 1 }],
    })).rejects.toThrow(/unknown variant/i)
  })

  describe('unknown-id strictness', () => {
    it('throws on unknown product in getProduct', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.getProduct('nope')).rejects.toThrow(/unknown product/i)
    })
    it('throws on unknown variant in quoteShipping', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.quoteShipping({
        fromCountry: 'US', toCountry: 'US', items: [{ supplierVariantId: 'nope', quantity: 1 }],
      })).rejects.toThrow(/unknown variant/i)
    })
    it('throws on unknown id in confirmOrder', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.confirmOrder('nope')).rejects.toThrow(/unknown order/i)
    })
    it('throws on unknown id in payOrder (checked by both supplierOrderId and shipmentOrderId)', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.payOrder('nope')).rejects.toThrow(/unknown order/i)
    })
    it('throws on unknown id in getOrderStatus', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.getOrderStatus('nope')).rejects.toThrow(/unknown order/i)
    })
    it('throws on unknown id in getTracking', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.getTracking('nope')).rejects.toThrow(/unknown order/i)
    })
    it('throws on unknown id in getDisputeOptions', async () => {
      const adapter = new MockSupplierAdapter()
      await expect(adapter.getDisputeOptions('nope')).rejects.toThrow(/unknown order/i)
    })
  })

  describe('failPlaceOrderTimes (429-storm simulation)', () => {
    it('throws N times then succeeds, creating exactly one order', async () => {
      const adapter = new MockSupplierAdapter({ failPlaceOrderTimes: 2 })
      const req = {
        idempotencyKey: 'retry-key', logisticName: 'Standard', fromCountry: 'US',
        shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
        items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      }
      await expect(adapter.placeOrder(req)).rejects.toThrow(/429|rate limit|retryable/i)
      await expect(adapter.placeOrder(req)).rejects.toThrow(/429|rate limit|retryable/i)
      const result = await adapter.placeOrder(req)

      expect(result.supplierOrderId).toBe('mock-order-1')
      expect(adapter.placedOrders).toHaveLength(1)

      // A further call with the SAME idempotencyKey (e.g. a spurious extra retry after the real
      // success) must still return the cached result, never fail or create a second order — the
      // failure counter is already exhausted, and the idempotency check runs first regardless.
      const again = await adapter.placeOrder(req)
      expect(again).toEqual(result)
      expect(adapter.placedOrders).toHaveLength(1)
    })

    it('omitted (default): never fails', async () => {
      const adapter = new MockSupplierAdapter()
      const result = await adapter.placeOrder({
        idempotencyKey: 'no-fail-key', logisticName: 'Standard', fromCountry: 'US',
        shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
        items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      })
      expect(result.supplierOrderId).toBe('mock-order-1')
    })

    it('0: never fails (explicit)', async () => {
      const adapter = new MockSupplierAdapter({ failPlaceOrderTimes: 0 })
      const result = await adapter.placeOrder({
        idempotencyKey: 'zero-fail-key', logisticName: 'Standard', fromCountry: 'US',
        shippingAddress: { name: 'T', line1: 'x', city: 'y', state: 'GA', zip: '1', country: 'US' },
        items: [{ supplierVariantId: 'mock-v1', quantity: 1 }],
      })
      expect(result.supplierOrderId).toBe('mock-order-1')
    })
  })
})
