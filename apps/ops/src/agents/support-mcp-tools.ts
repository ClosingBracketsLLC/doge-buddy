import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createDb, orders, supplierOrders, supportMessages, supportTickets } from '@doge-buddy/db'
import type { SupplierAdapter } from '@doge-buddy/supplier'
import { asc, eq } from 'drizzle-orm'

type Db = ReturnType<typeof createDb>['db']

export interface SupportMcpDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getDisputeOptions'>
  /** The server (and every handler it wraps) is created PER RUN, pinned to one ticket — there is
   * no `ticketId` argument on any tool because there is only ever one ticket in scope. */
  ticketId: string
}

function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Never serialize the whole error object (it may not be a plain Error, and adapter error bodies
 * are not vetted for secrets) — always coerce to its message string. */
function scrubMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
}

/** Reads the ticket's `order_id` — shared by `get_order` and `get_dispute_options`, both of which
 * treat a NULL order link identically (spec §3): `{ verifiedOrder: false }`, not an error. */
async function loadLinkedOrderId(db: Db, ticketId: string): Promise<string | null> {
  const [ticket] = await db
    .select({ orderId: supportTickets.orderId })
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId))
    .limit(1)
  return ticket?.orderId ?? null
}

const VERIFIED_ORDER_FALSE = { verifiedOrder: false as const }

/** Builds the three tool handlers as plain async functions, independent of any MCP server
 * wrapping — this is what tests call directly, and what createSupportMcpServer wires into
 * `tool()` definitions below. */
export function createSupportToolHandlers(deps: SupportMcpDeps) {
  const { db, adapter, ticketId } = deps

  return {
    // Second `_extra` param is unused but kept so these handlers structurally match the SDK's
    // `tool()` handler type — createSupportMcpServer passes them straight through below, and
    // tests call them the same way the SDK would.
    async get_ticket_thread(_args: Record<string, never>, _extra?: unknown): Promise<CallToolResult> {
      try {
        const rows = await db
          .select({
            direction: supportMessages.direction,
            fromEmail: supportMessages.fromEmail,
            sentAt: supportMessages.sentAt,
            bodyText: supportMessages.bodyText,
          })
          .from(supportMessages)
          .where(eq(supportMessages.ticketId, ticketId))
          .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt), asc(supportMessages.id))

        return ok(
          rows.map((m) => ({
            direction: m.direction,
            fromEmail: m.fromEmail,
            sentAt: m.sentAt ? m.sentAt.toISOString() : null,
            bodyText: m.bodyText,
          })),
        )
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    /** DATA-LEAK rule (spec §3): this projection is customer-safe fields ONLY. It must NEVER
     * include supplier cost/amount fields, CJ/supplier ids, `raw_payload`, or anyone's email —
     * those all live on `orders`/`supplier_orders` but are deliberately not selected below. */
    async get_order(_args: Record<string, never>, _extra?: unknown): Promise<CallToolResult> {
      try {
        const orderId = await loadLinkedOrderId(db, ticketId)
        if (!orderId) return ok(VERIFIED_ORDER_FALSE)

        const [order] = await db
          .select({
            shopifyOrderNumber: orders.shopifyOrderNumber,
            financialStatus: orders.financialStatus,
            fulfillmentStatus: orders.fulfillmentStatus,
            totalCents: orders.totalCents,
            createdAt: orders.createdAt,
          })
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1)
        if (!order) return ok(VERIFIED_ORDER_FALSE)

        const [supplierOrder] = await db
          .select({ status: supplierOrders.status, trackingNumber: supplierOrders.trackingNumber })
          .from(supplierOrders)
          .where(eq(supplierOrders.orderId, orderId))
          .limit(1)

        return ok({
          orderNumber: order.shopifyOrderNumber,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          totalCents: order.totalCents,
          createdAt: order.createdAt ? order.createdAt.toISOString() : null,
          trackingNumber: supplierOrder?.trackingNumber ?? null,
          // v1 stores no tracking URL — pass tracking number only (Task 8's validateReplyBody
          // `trackingUrl` opt keeps the parameter so a stored URL can flow through later).
          trackingUrl: null,
          supplierStatus: supplierOrder?.status ?? null,
        })
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },

    async get_dispute_options(_args: Record<string, never>, _extra?: unknown): Promise<CallToolResult> {
      try {
        const orderId = await loadLinkedOrderId(db, ticketId)
        if (!orderId) return ok(VERIFIED_ORDER_FALSE)

        const [supplierOrder] = await db
          .select({ supplierOrderId: supplierOrders.supplierOrderId })
          .from(supplierOrders)
          .where(eq(supplierOrders.orderId, orderId))
          .limit(1)
        if (!supplierOrder?.supplierOrderId) return ok(VERIFIED_ORDER_FALSE)

        // The supplier order id is passed to the adapter but never itself serialized into the
        // result — only whatever shape the adapter's DisputeOptions response carries comes back.
        const result = await adapter.getDisputeOptions(supplierOrder.supplierOrderId)
        return ok(result)
      } catch (err) {
        return errorResult(scrubMessage(err))
      }
    },
  }
}

/** Read-only, in-process MCP server exposing the support agent's three ticket/order/dispute
 * lookup tools. Created PER RUN, pinned to `deps.ticketId` — none of the tools take arguments, so
 * there is no way for the agent to ask about a ticket/order other than the one it was launched
 * for. `deps.adapter` is narrowed to `getDisputeOptions` only: no mutation methods (openDispute,
 * placeOrder, etc.) are reachable through this server by construction. */
export function createSupportMcpServer(deps: SupportMcpDeps): ReturnType<typeof createSdkMcpServer> {
  const handlers = createSupportToolHandlers(deps)

  return createSdkMcpServer({
    name: 'support',
    version: '1.0.0',
    tools: [
      tool(
        'get_ticket_thread',
        "This ticket's full message thread: direction, fromEmail, sentAt (ISO), bodyText.",
        {},
        handlers.get_ticket_thread,
      ),
      tool(
        'get_order',
        "The ticket's linked order, projected to customer-safe fields only. { verifiedOrder: false } if the ticket has no linked order.",
        {},
        handlers.get_order,
      ),
      tool(
        'get_dispute_options',
        "Supplier dispute options (refund/reissue eligibility and reasons) for the ticket's linked order. { verifiedOrder: false } if there is no linked, placed supplier order.",
        {},
        handlers.get_dispute_options,
      ),
    ],
  })
}
