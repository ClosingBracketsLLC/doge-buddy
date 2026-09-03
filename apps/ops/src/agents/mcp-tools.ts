import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { z } from 'zod'
import { PointsAllowance, PointsAllowanceExceededError } from './points.ts'
import { MarketLookups, type MarketPriceProvider } from '../sourcing/market-price.ts'
import type { ReviewsSeen } from '../sourcing/decision-context.ts'

/** CJ points cost charged against the run's PointsAllowance for each tool call. */
export const TOOL_POINT_COSTS = {
  get_product_detail: 10,
  get_reviews: 10,
  get_stock: 10,
  quote_freight: 10,
} as const

const ALLOWANCE_EXHAUSTED_MESSAGE =
  'CJ points allowance exhausted for this run — conclude with the research you already have.'

const MARKET_LOOKUP_UNAVAILABLE_MESSAGE =
  'Market price lookup failed or the SerpApi budget is exhausted — proceed with the lookups you already have.'

export interface SourcingMcpDeps {
  adapter: Pick<SupplierAdapter, 'getProduct' | 'getProductReviews' | 'getVariantStock' | 'quoteShipping'>
  allowance: PointsAllowance
  /** Both present => the lookup_market_price tool is registered (SERPAPI_KEY configured);
   *  absent => the tool does not exist and the prompt says the gate is skipped (spec Decision 5). */
  marketPrice?: MarketPriceProvider | null
  marketLookups?: MarketLookups
  /** L1 (spec 2026-09-03 Decision 7): when present, page-1 get_reviews results are summarized
   *  into this run-scoped registry as they pass through — code-recorded provenance for the
   *  proposal demand block, zero extra CJ calls. Absent = no recording (existing callers). */
  reviewsSeen?: ReviewsSeen
}

function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Never serialize the whole error object (it may not be a plain Error, and CJ error bodies are
 * not vetted for secrets) — always coerce to its message string. */
function scrubMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
}

/** Spends `cost` from `allowance` first. Returns an isError CallToolResult (never throws) if the
 * allowance is exhausted; returns null when the spend succeeded and the caller should proceed. */
function trySpend(allowance: PointsAllowance, cost: number, name: string): CallToolResult | null {
  try {
    allowance.spend(cost, name)
    return null
  } catch (err) {
    if (err instanceof PointsAllowanceExceededError) {
      return errorResult(ALLOWANCE_EXHAUSTED_MESSAGE)
    }
    // Not expected from PointsAllowance, but stay loop-safe regardless.
    return errorResult(scrubMessage(err))
  }
}

/** Builds the five tool handlers as plain async functions, independent of any MCP server
 * wrapping — this is what tests call directly, and what createSourcingMcpServer wires into
 * `tool()` definitions below. The fifth (lookup_market_price) is always available on the
 * handlers object (for tests), but the MCP server only registers it when both market deps are
 * present. */
export function createSourcingToolHandlers(deps: SourcingMcpDeps) {
  const { adapter, allowance, marketPrice, marketLookups, reviewsSeen } = deps

  return {
    // Second `_extra` param is unused but kept so these handlers structurally match the SDK's
    // `tool()` handler type — createSourcingMcpServer passes them straight through below, and
    // tests call them the same way the SDK would.
    async get_product_detail(args: { supplierProductId: string }, _extra?: unknown): Promise<CallToolResult> {
      const exhausted = trySpend(allowance, TOOL_POINT_COSTS.get_product_detail, 'get_product_detail')
      if (exhausted) return exhausted
      try {
        const result = await adapter.getProduct(args.supplierProductId)
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    async get_reviews(args: { supplierProductId: string; page?: number }, _extra?: unknown): Promise<CallToolResult> {
      const exhausted = trySpend(allowance, TOOL_POINT_COSTS.get_reviews, 'get_reviews')
      if (exhausted) return exhausted
      try {
        const result = await adapter.getProductReviews(args.supplierProductId, { page: args.page })
        if (args.page === undefined || args.page === 1) {
          reviewsSeen?.record(args.supplierProductId, result)
        }
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    async get_stock(args: { supplierVariantId: string }, _extra?: unknown): Promise<CallToolResult> {
      const exhausted = trySpend(allowance, TOOL_POINT_COSTS.get_stock, 'get_stock')
      if (exhausted) return exhausted
      try {
        const result = await adapter.getVariantStock(args.supplierVariantId)
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    async quote_freight(args: { supplierVariantId: string }, _extra?: unknown): Promise<CallToolResult> {
      const exhausted = trySpend(allowance, TOOL_POINT_COSTS.quote_freight, 'quote_freight')
      if (exhausted) return exhausted
      try {
        const result = await adapter.quoteShipping({
          // US-origin freight, mirroring the order-time gate in run-place-order.ts and Stage 4.6's
          // re-quote: these listings ship from US, so a CN quote would return China-origin options
          // that fail the delivery window and mislead the agent's margin math (FIX C5).
          fromCountry: 'US',
          toCountry: 'US',
          items: [{ supplierVariantId: args.supplierVariantId, quantity: 1 }],
        })
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    async lookup_market_price(args: { supplierProductId: string; query: string }, _extra?: unknown): Promise<CallToolResult> {
      if (!marketPrice || !marketLookups) {
        return errorResult(MARKET_LOOKUP_UNAVAILABLE_MESSAGE)
      }
      const cached = marketLookups.find(args.supplierProductId, args.query)
      if (cached) {
        const { snapshot: _snapshot, ...body } = cached
        return ok(body)
      }
      try {
        const offers = await marketPrice.fetchOffers(args.query)
        if (offers === null) return errorResult(MARKET_LOOKUP_UNAVAILABLE_MESSAGE)
        const lookup = marketLookups.record({ supplierProductId: args.supplierProductId, query: args.query, offers })
        const { snapshot: _snapshot, ...body } = lookup
        return ok(body)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },
  }
}

/** Read-only, in-process MCP server exposing CJ lookup tools to the sourcing agent, each
 * metered against `deps.allowance`. Four tools (product, reviews, stock, freight) are always
 * registered. A fifth tool (lookup_market_price) is registered only when a MarketPriceProvider
 * is wired. No mutation methods (placeOrder, payOrder, etc.) are reachable through this server
 * by construction — `deps.adapter` is narrowed to read-only SupplierAdapter methods above. */
export function createSourcingMcpServer(deps: SourcingMcpDeps): ReturnType<typeof createSdkMcpServer> {
  const handlers = createSourcingToolHandlers(deps)

  // Explicitly typed (rather than inferred from the array literal): the fifth tool pushed below
  // has a different Zod shape, and TS would otherwise narrow `tools` to the union of only the
  // first four tools' types and reject the `push` on contravariant `handler` grounds.
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'get_product_detail',
      'Full CJ product detail: title, description, variants with costs, images.',
      { supplierProductId: z.string().min(1) },
      handlers.get_product_detail,
    ),
    tool(
      'get_reviews',
      'Buyer reviews for a CJ product (rating 1-5 + text).',
      { supplierProductId: z.string().min(1), page: z.number().int().min(1).optional() },
      handlers.get_reviews,
    ),
    tool(
      'get_stock',
      'Per-warehouse stock for a CJ variant.',
      { supplierVariantId: z.string().min(1) },
      handlers.get_stock,
    ),
    tool(
      'quote_freight',
      'US shipping options (price cents + day range) for a CJ variant, qty 1.',
      { supplierVariantId: z.string().min(1) },
      handlers.quote_freight,
    ),
  ]
  if (deps.marketPrice && deps.marketLookups) {
    tools.push(
      tool(
        'lookup_market_price',
        'Google Shopping offers for a query: median/p25/p75 price in cents, offer count, the 5 cheapest offers. ' +
          'Query as a US shopper would type it ("orthopedic dog bed large"), never a CJ title. ' +
          '>= 5 offers = conclusive; fewer -> broaden the query once. Returns a lookupId you MUST put ' +
          'on the winner as marketLookupId (its supplierProductId must match the winner).',
        { supplierProductId: z.string().min(1), query: z.string().min(2).max(120) },
        handlers.lookup_market_price,
      ),
    )
  }
  return createSdkMcpServer({ name: 'sourcing', version: '1.0.0', tools })
}
