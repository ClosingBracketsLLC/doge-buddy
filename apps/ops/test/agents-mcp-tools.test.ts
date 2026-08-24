import { describe, it, expect, vi } from 'vitest'
import type {
  ShippingOption,
  SupplierAdapter,
  SupplierProductDetail,
  SupplierProductReview,
  WarehouseStock,
} from '@doge-buddy/supplier'
import { PointsAllowance, PointsAllowanceExceededError, SOURCING_POINTS_ALLOWANCE } from '../src/agents/points.ts'
import { TOOL_POINT_COSTS, createSourcingMcpServer, createSourcingToolHandlers } from '../src/agents/mcp-tools.ts'

type StubAdapter = Pick<SupplierAdapter, 'getProduct' | 'getProductReviews' | 'getVariantStock' | 'quoteShipping'>

function makeStubAdapter(overrides: Partial<StubAdapter> = {}): StubAdapter {
  return {
    getProduct: vi.fn(async (): Promise<SupplierProductDetail> => ({
      supplierProductId: 'p1',
      title: 'Widget',
      imageUrls: ['https://example.com/img.png'],
      variants: [{ supplierVariantId: 'v1', priceCents: 1000 }],
    })),
    getProductReviews: vi.fn(async (): Promise<SupplierProductReview[]> => [
      { rating: 5, content: 'Great!' },
    ]),
    getVariantStock: vi.fn(async (): Promise<WarehouseStock[]> => [
      { countryCode: 'US', quantity: 10, verified: true },
    ]),
    quoteShipping: vi.fn(async (): Promise<ShippingOption[]> => [
      { name: 'Standard', priceCents: 499, minDays: 5, maxDays: 10 },
    ]),
    ...overrides,
  }
}

describe('agents/points', () => {
  describe('SOURCING_POINTS_ALLOWANCE', () => {
    it('is 25,000', () => {
      expect(SOURCING_POINTS_ALLOWANCE).toBe(25_000)
    })
  })

  describe('PointsAllowance', () => {
    it('defaults total to SOURCING_POINTS_ALLOWANCE', () => {
      const allowance = new PointsAllowance()
      expect(allowance.remaining()).toBe(SOURCING_POINTS_ALLOWANCE)
      expect(allowance.spent()).toBe(0)
    })

    it('spend() decrements remaining and increments spent', () => {
      const allowance = new PointsAllowance(100)
      allowance.spend(10, 'get_stock')
      expect(allowance.spent()).toBe(10)
      expect(allowance.remaining()).toBe(90)
    })

    it('spend(10) at remaining 10 passes (exact boundary)', () => {
      const allowance = new PointsAllowance(10)
      expect(() => allowance.spend(10, 'get_stock')).not.toThrow()
      expect(allowance.remaining()).toBe(0)
    })

    it('spend(10) at remaining 9 throws PointsAllowanceExceededError', () => {
      const allowance = new PointsAllowance(9)
      expect(() => allowance.spend(10, 'get_stock')).toThrow(PointsAllowanceExceededError)
      // Failed spend must not partially consume the allowance.
      expect(allowance.remaining()).toBe(9)
      expect(allowance.spent()).toBe(0)
    })

    it('accumulates spend across multiple calls', () => {
      const allowance = new PointsAllowance(30)
      allowance.spend(10, 'a')
      allowance.spend(10, 'b')
      allowance.spend(10, 'c')
      expect(allowance.remaining()).toBe(0)
      expect(() => allowance.spend(1, 'd')).toThrow(PointsAllowanceExceededError)
    })
  })
})

describe('agents/mcp-tools', () => {
  describe('TOOL_POINT_COSTS', () => {
    it('costs 10 points per tool', () => {
      expect(TOOL_POINT_COSTS).toEqual({
        get_product_detail: 10,
        get_reviews: 10,
        get_stock: 10,
        quote_freight: 10,
      })
    })
  })

  describe('createSourcingMcpServer', () => {
    it('builds an sdk mcp server named "sourcing"', () => {
      const server = createSourcingMcpServer({ adapter: makeStubAdapter(), allowance: new PointsAllowance() })
      expect(server.type).toBe('sdk')
      expect(server.name).toBe('sourcing')
    })
  })

  describe('createSourcingToolHandlers — happy path', () => {
    it('get_product_detail round-trips JSON and decrements allowance by 10', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.get_product_detail({ supplierProductId: 'p1' }, undefined)

      expect(adapter.getProduct).toHaveBeenCalledWith('p1')
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify({
            supplierProductId: 'p1',
            title: 'Widget',
            imageUrls: ['https://example.com/img.png'],
            variants: [{ supplierVariantId: 'v1', priceCents: 1000 }],
          }),
        },
      ])
      expect(allowance.spent()).toBe(10)
    })

    it('get_reviews round-trips JSON and decrements allowance by 10', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.get_reviews({ supplierProductId: 'p1', page: 2 }, undefined)

      expect(adapter.getProductReviews).toHaveBeenCalledWith('p1', { page: 2 })
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify([{ rating: 5, content: 'Great!' }]) },
      ])
      expect(allowance.spent()).toBe(10)
    })

    it('get_reviews omits page when not provided', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      await handlers.get_reviews({ supplierProductId: 'p1' }, undefined)

      expect(adapter.getProductReviews).toHaveBeenCalledWith('p1', { page: undefined })
    })

    it('get_stock round-trips JSON and decrements allowance by 10', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.get_stock({ supplierVariantId: 'v1' }, undefined)

      expect(adapter.getVariantStock).toHaveBeenCalledWith('v1')
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify([{ countryCode: 'US', quantity: 10, verified: true }]) },
      ])
      expect(allowance.spent()).toBe(10)
    })

    it('quote_freight wraps quoteShipping with fromCountry CN, toCountry US, qty 1', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.quote_freight({ supplierVariantId: 'v1' }, undefined)

      expect(adapter.quoteShipping).toHaveBeenCalledWith({
        fromCountry: 'CN',
        toCountry: 'US',
        items: [{ supplierVariantId: 'v1', quantity: 1 }],
      })
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify([{ name: 'Standard', priceCents: 499, minDays: 5, maxDays: 10 }]) },
      ])
      expect(allowance.spent()).toBe(10)
    })
  })

  describe('createSourcingToolHandlers — exhausted allowance', () => {
    it('returns isError without calling the adapter, for every tool', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(5) // less than any tool's 10-point cost
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const productResult = await handlers.get_product_detail({ supplierProductId: 'p1' }, undefined)
      const reviewsResult = await handlers.get_reviews({ supplierProductId: 'p1' }, undefined)
      const stockResult = await handlers.get_stock({ supplierVariantId: 'v1' }, undefined)
      const freightResult = await handlers.quote_freight({ supplierVariantId: 'v1' }, undefined)

      for (const result of [productResult, reviewsResult, stockResult, freightResult]) {
        expect(result.isError).toBe(true)
        expect(result.content[0]).toMatchObject({ type: 'text' })
        const text = (result.content[0] as { text: string }).text
        expect(text.toLowerCase()).toContain('allowance')
      }

      expect(adapter.getProduct).not.toHaveBeenCalled()
      expect(adapter.getProductReviews).not.toHaveBeenCalled()
      expect(adapter.getVariantStock).not.toHaveBeenCalled()
      expect(adapter.quoteShipping).not.toHaveBeenCalled()
      // Allowance itself is untouched by a rejected spend.
      expect(allowance.spent()).toBe(0)
    })
  })

  describe('createSourcingToolHandlers — adapter throws', () => {
    it('get_product_detail returns isError with a scrubbed message, never throws', async () => {
      const adapter = makeStubAdapter({
        getProduct: vi.fn(async () => {
          throw new Error('CJ 500: upstream boom')
        }),
      })
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.get_product_detail({ supplierProductId: 'p1' }, undefined)

      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: 'CJ 500: upstream boom' }])
      // Points are still spent — the adapter call is what failed, not the metering.
      expect(allowance.spent()).toBe(10)
    })

    it('is loop-safe: adapter throwing a non-Error value never throws out of the handler', async () => {
      const adapter = makeStubAdapter({
        quoteShipping: vi.fn(async () => {
          throw 'plain string failure'
        }),
      })
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      await expect(handlers.quote_freight({ supplierVariantId: 'v1' }, undefined)).resolves.toEqual({
        content: [{ type: 'text', text: 'plain string failure' }],
        isError: true,
      })
    })

    it('get_stock adapter throw is caught and reported without crashing the caller loop', async () => {
      const adapter = makeStubAdapter({
        getVariantStock: vi.fn(async () => {
          throw new Error('timeout')
        }),
      })
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.get_stock({ supplierVariantId: 'v1' }, undefined)
      expect(result).toEqual({ content: [{ type: 'text', text: 'timeout' }], isError: true })
    })
  })
})
