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
import { MarketLookups, type MarketOffer, type MarketPriceProvider } from '../src/sourcing/market-price.ts'

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

    it('quote_freight wraps quoteShipping with fromCountry US, toCountry US, qty 1', async () => {
      const adapter = makeStubAdapter()
      const allowance = new PointsAllowance(100)
      const handlers = createSourcingToolHandlers({ adapter, allowance })

      const result = await handlers.quote_freight({ supplierVariantId: 'v1' }, undefined)

      // FIX C5: US-origin freight, mirroring run-place-order.ts's order-time gate — these listings
      // are shipsFrom:'US' and Stage 4.6 verifies US stock before freight, so a CN quote would
      // return China-origin options that fail the delivery window.
      expect(adapter.quoteShipping).toHaveBeenCalledWith({
        fromCountry: 'US',
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

  describe('lookup_market_price tool', () => {
    function offers(...cents: number[]): MarketOffer[] {
      return cents.map((c, i) => ({ title: `o${i}`, priceCents: c, merchant: null, url: null }))
    }
    function makeMarketDeps(fetchOffers: MarketPriceProvider['fetchOffers']) {
      const marketLookups = new MarketLookups()
      const marketPrice: MarketPriceProvider = { key: 'serpapi_google_shopping', fetchOffers }
      const handlers = createSourcingToolHandlers({
        adapter: makeStubAdapter(), allowance: new PointsAllowance(), marketPrice, marketLookups,
      })
      return { handlers, marketLookups }
    }

    it('records the lookup and returns it (id + stats + offers, no snapshot); spends NO CJ points', async () => {
      const allowance = new PointsAllowance()
      const marketLookups = new MarketLookups()
      const handlers = createSourcingToolHandlers({
        adapter: makeStubAdapter(), allowance,
        marketPrice: { key: 'serpapi_google_shopping', fetchOffers: vi.fn(async () => offers(100, 200, 300, 400, 500)) },
        marketLookups,
      })

      const result = await handlers.lookup_market_price({ supplierProductId: 'cjp-1', query: 'dog bed' })

      expect(result.isError).toBeUndefined()
      const body = JSON.parse((result.content[0] as { text: string }).text)
      expect(body).toEqual({
        lookupId: 'mkt_1', supplierProductId: 'cjp-1', query: 'dog bed', offerCount: 5,
        medianCents: 300, p25Cents: 200, p75Cents: 400,
        offers: offers(100, 200, 300, 400, 500),
      })
      expect(marketLookups.get('mkt_1')?.medianCents).toBe(300)
      expect(allowance.spent()).toBe(0)
    })

    it('identical (pid, query modulo case/whitespace) repeat returns the SAME lookup, no second fetch', async () => {
      const fetchOffers = vi.fn(async () => offers(1, 2, 3, 4, 5))
      const { handlers } = makeMarketDeps(fetchOffers)

      const first = JSON.parse(((await handlers.lookup_market_price({ supplierProductId: 'p', query: 'Dog  Bed' })).content[0] as { text: string }).text)
      const second = JSON.parse(((await handlers.lookup_market_price({ supplierProductId: 'p', query: ' dog bed ' })).content[0] as { text: string }).text)

      expect(fetchOffers).toHaveBeenCalledTimes(1)
      expect(second.lookupId).toBe(first.lookupId)
    })

    it('null from the provider (cap/HTTP) -> isError, nothing recorded', async () => {
      const { handlers, marketLookups } = makeMarketDeps(vi.fn(async () => null))
      const result = await handlers.lookup_market_price({ supplierProductId: 'p', query: 'q' })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('proceed with the lookups you already have')
      expect(marketLookups.all()).toEqual([])
    })

    it('server registers the tool only when a provider is wired', () => {
      const base = { adapter: makeStubAdapter(), allowance: new PointsAllowance() }

      const without = createSourcingMcpServer(base) as unknown as Record<string, unknown>
      const withMarket = createSourcingMcpServer({
        ...base,
        marketPrice: { key: 'serpapi_google_shopping', fetchOffers: async () => [] },
        marketLookups: new MarketLookups(),
      }) as unknown as Record<string, unknown>

      // The SDK server exposes registered tools through instance._registeredTools (object keyed by tool name)
      const getToolNames = (server: Record<string, unknown>): string[] => {
        const inst = server.instance as Record<string, unknown> | undefined
        const registeredTools = inst?._registeredTools as Record<string, unknown> | undefined
        return Object.keys(registeredTools ?? {})
      }

      // Without market deps: exactly four CJ tools (no lookup_market_price)
      const withoutToolNames = getToolNames(without).sort()
      expect(withoutToolNames).toEqual([
        'get_product_detail', 'get_reviews', 'get_stock', 'quote_freight'
      ].sort())
      expect(withoutToolNames).not.toContain('lookup_market_price')

      // With market deps: five tools including lookup_market_price
      const withMarketToolNames = getToolNames(withMarket).sort()
      expect(withMarketToolNames).toEqual([
        'get_product_detail', 'get_reviews', 'get_stock', 'quote_freight', 'lookup_market_price'
      ].sort())
      expect(withMarketToolNames).toContain('lookup_market_price')

      // Handler is always available on the handlers object (for tests), but returns error if deps missing
      const bareHandlers = createSourcingToolHandlers(base)
      expect(bareHandlers.lookup_market_price).toBeDefined()
      const bareResult = bareHandlers.lookup_market_price({ supplierProductId: 'p', query: 'q' })
      return expect(bareResult).resolves.toMatchObject({ isError: true })
    })
  })
})
