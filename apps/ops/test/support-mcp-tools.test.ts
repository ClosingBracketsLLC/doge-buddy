import { createDb, orders, supplierOrders, supportMessages, supportTickets } from '@doge-buddy/db'
import type { DisputeOptions, SupplierAdapter } from '@doge-buddy/supplier'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSupportMcpServer,
  createSupportToolHandlers,
  type SupportMcpDeps,
} from '../src/agents/support-mcp-tools.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

// Leak-check markers — every DATA-LEAK assertion below greps the tool's serialized JSON for these
// exact tokens, so each one must be distinctive enough that it can't coincidentally appear inside
// an allowed field (order number, status strings, an ISO timestamp, etc.).
const SUPPLIER_COST_CENTS = 733199
const SUPPLIER_POSTAGE_CENTS = 51199
const SUPPLIER_TOTAL_CENTS = 784398
const CJ_ORDER_ID = 'CJ-ORDER-9988776655-LEAK-CHECK'
const RAW_PAYLOAD_MARKER = 'RAW-PAYLOAD-SECRET-MARKER-9f8e7d6c5b4a'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

describe('agents/support-mcp-tools', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  // Everything this file creates is reachable from the 'mcp-tools-' gmailThreadId/shopifyOrderGid
  // prefixes, so the sweep is both complete and scoped to this file.
  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, 'mcp-tools-%'))
    const ticketIds = ticketRows.map((r) => r.id)
    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    const orderRows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(like(orders.shopifyOrderGid, 'mcp-tools-%'))
    const orderIds = orderRows.map((r) => r.id)
    if (orderIds.length > 0) {
      await db.delete(supplierOrders).where(inArray(supplierOrders.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
  })

  async function seedTicket(opts: { orderId?: string | null } = {}): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `mcp-tools-${uid()}`,
        customerEmail: 'jane@example.com',
        subject: 'Where is my order?',
        status: 'triaged',
        orderId: opts.orderId ?? null,
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedMessage(
    ticketId: string,
    opts: { direction?: 'inbound' | 'outbound'; fromEmail?: string; sentAt?: Date; bodyText?: string } = {},
  ): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: `mcp-tools-msg-${uid()}`,
      direction: opts.direction ?? 'inbound',
      fromEmail: opts.fromEmail ?? 'jane@example.com',
      bodyText: opts.bodyText ?? 'It has been three weeks.',
      sentAt: opts.sentAt ?? new Date('2024-06-15T11:00:00.000Z'),
    })
  }

  async function seedOrder(overrides: Partial<typeof orders.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({
        shopifyOrderGid: `mcp-tools-order-${uid()}`,
        shopifyOrderNumber: '#1042',
        email: 'jane@example.com',
        isTest: false,
        financialStatus: 'paid',
        fulfillmentStatus: 'fulfilled',
        totalCents: 5999,
        rawPayload: { note: RAW_PAYLOAD_MARKER, negotiatedCostCents: SUPPLIER_COST_CENTS },
        ...overrides,
      })
      .returning({ id: orders.id })
    return row!.id
  }

  async function seedSupplierOrder(
    orderId: string,
    overrides: Partial<typeof supplierOrders.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(supplierOrders).values({
      orderId,
      supplier: 'mock',
      idempotencyKey: `mcp-tools-so-${uid()}`,
      status: 'shipped',
      supplierOrderId: CJ_ORDER_ID,
      trackingNumber: '1Z999AA10123456784',
      productAmountCents: SUPPLIER_COST_CENTS,
      postageAmountCents: SUPPLIER_POSTAGE_CENTS,
      totalAmountCents: SUPPLIER_TOTAL_CENTS,
      ...overrides,
    })
  }

  function makeAdapter(overrides: Partial<Pick<SupplierAdapter, 'getDisputeOptions'>> = {}) {
    return {
      getDisputeOptions: vi.fn(async (): Promise<DisputeOptions> => ({
        disputable: true,
        maxRefundCents: 5999,
        reasons: [{ id: 'damaged', label: 'Damaged' }],
        allowedKinds: ['refund', 'reissue'],
      })),
      ...overrides,
    }
  }

  function makeDeps(ticketId: string, adapterOverrides: Partial<Pick<SupplierAdapter, 'getDisputeOptions'>> = {}): SupportMcpDeps {
    return { db, adapter: makeAdapter(adapterOverrides), ticketId }
  }

  describe('createSupportMcpServer', () => {
    it('builds an sdk mcp server named "support"', () => {
      const server = createSupportMcpServer(makeDeps('irrelevant'))
      expect(server.type).toBe('sdk')
      expect(server.name).toBe('support')
    })
  })

  describe('get_ticket_thread', () => {
    it("returns only this ticket's messages, in order, with direction/fromEmail/sentAt ISO/bodyText", async () => {
      const ticketA = await seedTicket()
      const ticketB = await seedTicket()
      await seedMessage(ticketA, {
        direction: 'inbound',
        fromEmail: 'jane@example.com',
        bodyText: 'Where is my package?',
        sentAt: new Date('2024-06-15T11:00:00.000Z'),
      })
      await seedMessage(ticketA, {
        direction: 'outbound',
        fromEmail: 'support@dogebuddy.com',
        bodyText: 'Looking into it now.',
        sentAt: new Date('2024-06-15T12:00:00.000Z'),
      })
      await seedMessage(ticketB, { bodyText: 'Unrelated ticket message.' })

      const handlers = createSupportToolHandlers(makeDeps(ticketA))
      const result = await handlers.get_ticket_thread({}, undefined)

      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { text: string }).text
      const parsed = JSON.parse(text)
      expect(parsed).toEqual([
        {
          direction: 'inbound',
          fromEmail: 'jane@example.com',
          sentAt: '2024-06-15T11:00:00.000Z',
          bodyText: 'Where is my package?',
        },
        {
          direction: 'outbound',
          fromEmail: 'support@dogebuddy.com',
          sentAt: '2024-06-15T12:00:00.000Z',
          bodyText: 'Looking into it now.',
        },
      ])
      expect(text).not.toContain('Unrelated ticket message.')
    })
  })

  describe('get_order', () => {
    it('returns the customer-safe projection and leaks NOTHING supplier-side', async () => {
      const orderId = await seedOrder()
      await seedSupplierOrder(orderId)
      const ticketId = await seedTicket({ orderId })

      const handlers = createSupportToolHandlers(makeDeps(ticketId))
      const result = await handlers.get_order({}, undefined)

      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { text: string }).text

      // DATA-LEAK rule: none of these supplier-side values may appear ANYWHERE in the serialized
      // result, regardless of how the projection is shaped.
      expect(text).not.toContain(String(SUPPLIER_COST_CENTS))
      expect(text).not.toContain(String(SUPPLIER_POSTAGE_CENTS))
      expect(text).not.toContain(String(SUPPLIER_TOTAL_CENTS))
      expect(text).not.toContain(CJ_ORDER_ID)
      expect(text).not.toContain(RAW_PAYLOAD_MARKER)

      const parsed = JSON.parse(text)
      expect(parsed).toEqual({
        orderNumber: '#1042',
        financialStatus: 'paid',
        fulfillmentStatus: 'fulfilled',
        totalCents: 5999,
        createdAt: parsed.createdAt, // presence + shape checked below
        trackingNumber: '1Z999AA10123456784',
        trackingUrl: null,
        supplierStatus: 'shipped',
      })
      expect(new Date(parsed.createdAt).toISOString()).toBe(parsed.createdAt)
    })

    it('returns { verifiedOrder: false } for a ticket with no linked order', async () => {
      const ticketId = await seedTicket({ orderId: null })

      const handlers = createSupportToolHandlers(makeDeps(ticketId))
      const result = await handlers.get_order({}, undefined)

      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { text: string }).text
      expect(JSON.parse(text)).toEqual({ verifiedOrder: false })
    })

    it('degrades gracefully (no crash, no leak) when the order has no supplier_orders row yet', async () => {
      const orderId = await seedOrder()
      const ticketId = await seedTicket({ orderId })

      const handlers = createSupportToolHandlers(makeDeps(ticketId))
      const result = await handlers.get_order({}, undefined)

      expect(result.isError).toBeUndefined()
      const parsed = JSON.parse((result.content[0] as { text: string }).text)
      expect(parsed.trackingNumber).toBeNull()
      expect(parsed.supplierStatus).toBeNull()
    })
  })

  describe('get_dispute_options', () => {
    it("calls the adapter with the linked order's supplier_order_id and returns its result as-is", async () => {
      const orderId = await seedOrder()
      await seedSupplierOrder(orderId)
      const ticketId = await seedTicket({ orderId })
      const adapter = makeAdapter()

      const handlers = createSupportToolHandlers({ db, adapter, ticketId })
      const result = await handlers.get_dispute_options({}, undefined)

      expect(adapter.getDisputeOptions).toHaveBeenCalledWith(CJ_ORDER_ID)
      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { text: string }).text
      expect(text).not.toContain(CJ_ORDER_ID)
      expect(JSON.parse(text)).toEqual({
        disputable: true,
        maxRefundCents: 5999,
        reasons: [{ id: 'damaged', label: 'Damaged' }],
        allowedKinds: ['refund', 'reissue'],
      })
    })

    it('returns { verifiedOrder: false } and never calls the adapter for a ticket with no linked order', async () => {
      const ticketId = await seedTicket({ orderId: null })
      const adapter = makeAdapter()

      const handlers = createSupportToolHandlers({ db, adapter, ticketId })
      const result = await handlers.get_dispute_options({}, undefined)

      expect(adapter.getDisputeOptions).not.toHaveBeenCalled()
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ verifiedOrder: false })
    })

    it('returns { verifiedOrder: false } when the order has no supplier_order_id yet', async () => {
      const orderId = await seedOrder()
      await seedSupplierOrder(orderId, { supplierOrderId: null })
      const ticketId = await seedTicket({ orderId })
      const adapter = makeAdapter()

      const handlers = createSupportToolHandlers({ db, adapter, ticketId })
      const result = await handlers.get_dispute_options({}, undefined)

      expect(adapter.getDisputeOptions).not.toHaveBeenCalled()
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ verifiedOrder: false })
    })

    it('returns isError:true with a scrubbed message when the adapter throws, never throwing out of the handler', async () => {
      const orderId = await seedOrder()
      await seedSupplierOrder(orderId)
      const ticketId = await seedTicket({ orderId })
      const adapter = makeAdapter({
        getDisputeOptions: vi.fn(async () => {
          throw new Error('CJ 500: upstream boom')
        }),
      })

      const handlers = createSupportToolHandlers({ db, adapter, ticketId })
      const result = await handlers.get_dispute_options({}, undefined)

      expect(result).toEqual({ content: [{ type: 'text', text: 'CJ 500: upstream boom' }], isError: true })
    })

    it('is loop-safe: a non-Error throw never escapes the handler', async () => {
      const orderId = await seedOrder()
      await seedSupplierOrder(orderId)
      const ticketId = await seedTicket({ orderId })
      const adapter = makeAdapter({
        getDisputeOptions: vi.fn(async () => {
          throw 'plain string failure'
        }),
      })

      const handlers = createSupportToolHandlers({ db, adapter, ticketId })
      await expect(handlers.get_dispute_options({}, undefined)).resolves.toEqual({
        content: [{ type: 'text', text: 'plain string failure' }],
        isError: true,
      })
    })
  })
})
