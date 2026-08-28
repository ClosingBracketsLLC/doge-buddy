import { auditLog, createDb, orders, proposals, supplierOrders, supportMessages, supportTickets } from '@doge-buddy/db'
import type { DisputeOptions } from '@doge-buddy/supplier'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPPORT_AGENT_QUEUE } from '../src/jobs/support-agent-run.ts'
import { CJ_DISPUTE_SKIPPED_ALERT, applyRefund } from '../src/proposals/apply-refund.ts'
import {
  PROPOSAL_APPLIED_ACTION,
  PROPOSAL_APPLY_FAILED_ACTION,
  STALE_APPLY_ERROR,
  type ApplyProposalDeps,
  type OrderRefundState,
  type ProposalShopifyOps,
  type RefundOps,
} from '../src/proposals/apply-shared.ts'
import { executeApplyProposal } from '../src/proposals/run-apply.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const CUSTOMER = 'jane@example.com'
const SUBJECT = 'My order arrived broken'
const REFUND_REASON = 'arrived damaged'
const ORDER_TOTAL_CENTS = 10_000
const REFUND_CENTS = 2_500
const PARENT_TXN = 'gid://shopify/OrderTransaction/1'
const CJ_REASON_ID = 'cj-reason-7'
/** Every ticket/order this file creates carries this prefix — the afterEach hook's handle on
 * everything it must clean up (same convention as apply-support-reply.test.ts). */
const PREFIX = 'applyrefund-'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

describe('applyRefund', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let notify: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>
  let enqueue: ReturnType<typeof vi.fn>

  beforeEach(() => {
    notify = vi.fn(async () => true)
    alert = vi.fn(async () => {})
    enqueue = vi.fn(async () => {})
  })

  afterEach(async () => {
    const ticketRows = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(like(supportTickets.gmailThreadId, `${PREFIX}%`))
    const orderRows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(like(orders.shopifyOrderGid, `%${PREFIX}%`))
    const ticketIds = ticketRows.map((r) => r.id)
    const orderIds = orderRows.map((r) => r.id)

    const proposalRows = [
      ...(ticketIds.length > 0
        ? await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.ticketId, ticketIds))
        : []),
      ...(orderIds.length > 0
        ? await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.orderId, orderIds))
        : []),
    ]
    const proposalIds = [...new Set(proposalRows.map((r) => r.id))]

    if (ticketIds.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ticketIds))
    }
    if (proposalIds.length > 0) {
      await db.delete(proposals).where(inArray(proposals.id, proposalIds))
      await db.delete(auditLog).where(inArray(auditLog.entityId, proposalIds))
    }
    if (ticketIds.length > 0) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, ticketIds))
    }
    if (orderIds.length > 0) {
      await db.delete(supplierOrders).where(inArray(supplierOrders.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Fakes
  // -------------------------------------------------------------------------

  interface FakeRefundOps extends RefundOps {
    /** Every `refundCreate` call, in order: the raw input plus the idempotency key it carried. */
    refundCalls: { input: Record<string, unknown>; idempotencyKey: string }[]
    state: OrderRefundState
    /** When set, the next `refundCreate` rejects with this instead of recording a refund. */
    failNext: Error | null
  }

  /**
   * Stands in for Shopify. `refundCreate` mutates `state` the way a real refund would — the note
   * lands in `refunds[]` and the amount lands in `totalRefundedCents` — so a second call into the
   * executor sees exactly what a re-entry against the live store would see.
   */
  function fakeRefundOps(overrides: Partial<OrderRefundState> = {}): FakeRefundOps {
    const ops: FakeRefundOps = {
      refundCalls: [],
      failNext: null,
      state: {
        totalRefundedCents: 0,
        refunds: [],
        parentTransactionId: PARENT_TXN,
        gateway: 'bogus',
        ...overrides,
      },
      orderRefundState: async () => ({ ...ops.state, refunds: [...ops.state.refunds] }),
      refundCreate: async (input, idempotencyKey) => {
        if (ops.failNext) {
          const err = ops.failNext
          ops.failNext = null
          throw err
        }
        ops.refundCalls.push({ input, idempotencyKey })
        const note = (input as { note?: string }).note ?? null
        const amount = ((input as { transactions?: { amount?: string }[] }).transactions ?? [])[0]?.amount ?? '0'
        ops.state.refunds.push({ id: `gid://shopify/Refund/${ops.refundCalls.length}`, note })
        ops.state.totalRefundedCents += Math.round(Number.parseFloat(amount) * 100)
        return { refundId: `gid://shopify/Refund/${ops.refundCalls.length}` }
      },
    }
    return ops
  }

  function fakeAdapter(opts: { options?: DisputeOptions; openDisputeId?: string } = {}) {
    const getDisputeOptions = vi.fn(
      async (): Promise<DisputeOptions> =>
        opts.options ?? {
          disputable: true,
          maxRefundCents: ORDER_TOTAL_CENTS,
          reasons: [{ id: CJ_REASON_ID, label: 'damaged' }],
          allowedKinds: ['refund'],
        },
    )
    const openDispute = vi.fn(async () => ({ disputeId: opts.openDisputeId ?? 'cj-dispute-1' }))
    return { subscribeProductWebhook: async () => {}, getDisputeOptions, openDispute }
  }

  /** `ApplyProposalDeps` with everything this executor never touches stubbed to throw loudly. */
  function makeDeps(overrides: Partial<ApplyProposalDeps> = {}): ApplyProposalDeps {
    const shopifyUnused = new Proxy({} as ProposalShopifyOps, {
      get: (_t, prop) => () => {
        throw new Error(`applyRefund must not touch the new_listing shopify ops (called ${String(prop)})`)
      },
    })
    return {
      db,
      alert: alert as unknown as ApplyProposalDeps['alert'],
      shopify: shopifyUnused,
      adapter: fakeAdapter() as unknown as ApplyProposalDeps['adapter'],
      gmail: null,
      refundOps: fakeRefundOps(),
      supportAddress: 'support@dogebuddy.test',
      notify: notify as unknown as ApplyProposalDeps['notify'],
      enqueue: enqueue as unknown as ApplyProposalDeps['enqueue'],
      adminBaseUrl: 'https://admin.test',
      ...overrides,
    }
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  interface Seeded {
    ticketId: string
    orderId: string
    shopifyOrderGid: string
    snapshotAt: Date
    inboundAt: Date
  }

  async function seed(
    opts: {
      totalCents?: number | null
      ticketStatus?: (typeof supportTickets.$inferInsert)['status']
      supplierOrderId?: string | null
      withSupplierOrder?: boolean
    } = {},
  ): Promise<Seeded> {
    const tag = `${PREFIX}${uid()}`
    const shopifyOrderGid = `gid://shopify/Order/${tag}`
    const inboundAt = new Date(Date.now() - 60_000)

    const [order] = await db
      .insert(orders)
      .values({
        shopifyOrderGid,
        shopifyOrderNumber: '#1001',
        email: CUSTOMER,
        isTest: true,
        financialStatus: 'PAID',
        totalCents: opts.totalCents === undefined ? ORDER_TOTAL_CENTS : opts.totalCents,
      })
      .returning({ id: orders.id })

    if (opts.withSupplierOrder !== false) {
      await db.insert(supplierOrders).values({
        orderId: order!.id,
        supplier: 'cj',
        idempotencyKey: `idem-${tag}`,
        status: 'shipped',
        supplierOrderId: opts.supplierOrderId === undefined ? `cjo-${tag}` : opts.supplierOrderId,
      })
    }

    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: tag,
        customerEmail: CUSTOMER,
        subject: SUBJECT,
        status: opts.ticketStatus ?? 'awaiting_approval',
        orderId: order!.id,
        lastInboundAt: inboundAt,
        lastAgentRunAt: new Date(inboundAt.getTime() + 30_000),
      })
      .returning({ id: supportTickets.id })

    await db.insert(supportMessages).values({
      ticketId: ticket!.id,
      gmailMessageId: `${tag}-in-0`,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'it arrived broken',
      rfcMessageId: `<${tag}-in-0@mock.gmail>`,
      sentAt: inboundAt,
    })

    return { ticketId: ticket!.id, orderId: order!.id, shopifyOrderGid, snapshotAt: inboundAt, inboundAt }
  }

  /** Adds a customer message NEWER than the proposal's snapshot — the staleness trigger. */
  async function addNewerInbound(s: Seeded, offsetMs = 1_000): Promise<Date> {
    const sentAt = new Date(s.snapshotAt.getTime() + offsetMs)
    await db.insert(supportMessages).values({
      ticketId: s.ticketId,
      gmailMessageId: `${PREFIX}${uid()}-newer`,
      direction: 'inbound',
      fromEmail: CUSTOMER,
      bodyText: 'never mind, the package turned up',
      rfcMessageId: `<${PREFIX}${uid()}-newer@mock.gmail>`,
      sentAt,
    })
    await db.update(supportTickets).set({ lastInboundAt: sentAt }).where(eq(supportTickets.id, s.ticketId))
    return sentAt
  }

  function payloadFor(s: Seeded, over: Partial<Record<string, unknown>> = {}) {
    return {
      type: 'refund',
      orderId: s.orderId,
      shopifyOrderGid: s.shopifyOrderGid,
      amountCents: REFUND_CENTS,
      reason: REFUND_REASON,
      openCjDispute: false,
      threadSnapshotAt: s.snapshotAt.toISOString(),
      ...over,
    }
  }

  /** Seeds an `applying` refund proposal — the state the shell hands the executor. */
  async function seedProposal(s: Seeded, payloadOverrides: Partial<Record<string, unknown>> = {}, status: 'applying' | 'approved' = 'applying') {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'refund',
        status,
        summary: `Refund $25.00 order #1001 — ${REFUND_REASON}`,
        payload: payloadFor(s, payloadOverrides),
        sourceWorkflow: 'support',
        ticketId: s.ticketId,
        orderId: s.orderId,
      })
      .returning()
    return row!
  }

  async function readProposal(id: string) {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    return row!
  }

  async function readTicket(id: string) {
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    return row!
  }

  async function auditActions(proposalId: string) {
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, proposalId))
    return rows.map((r) => r.action)
  }

  // -------------------------------------------------------------------------
  // Happy path + idempotency
  // -------------------------------------------------------------------------

  it('happy path: ONE refundCreate keyed on the proposal id, carrying the marker note and the dollar amount', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    const call = refundOps.refundCalls[0]!
    expect(call.idempotencyKey).toBe(proposal.id)
    expect(call.input).toEqual({
      orderId: s.shopifyOrderGid,
      note: `db-proposal-${proposal.id}`,
      notify: true,
      transactions: [{ parentId: PARENT_TXN, amount: '25.00', kind: 'REFUND', gateway: 'bogus' }],
    })

    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).not.toBeNull()
    expect(applied.applyError).toBeNull()
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLIED_ACTION)
    // The paired reply owns the customer communication — a successful refund leaves the ticket be.
    expect((await readTicket(s.ticketId)).status).toBe('awaiting_approval')
    expect(notify).not.toHaveBeenCalled()
  })

  it('run-apply dispatches refund to this executor', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, {}, 'approved')
    const refundOps = fakeRefundOps()

    await executeApplyProposal(makeDeps({ refundOps }), proposal.id)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('double delivery: two sequential proposal.apply runs issue exactly ONE refund', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, {}, 'approved')
    const refundOps = fakeRefundOps()

    await executeApplyProposal(makeDeps({ refundOps }), proposal.id)
    // A sequential redelivery (retry after a completed-but-unacked run) still reaches the shell,
    // which must refuse it — no second call into Shopify.
    await executeApplyProposal(makeDeps({ refundOps }), proposal.id)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('re-entry in applying with the marker note already on the order does NOT refund again', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    // A prior attempt's refund landed, then the process died before the applied transition.
    const refundOps = fakeRefundOps({
      totalRefundedCents: REFUND_CENTS,
      refunds: [{ id: 'gid://shopify/Refund/prior', note: `db-proposal-${proposal.id}` }],
    })

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.applyError).toBeNull()
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLIED_ACTION)
    expect(notify).not.toHaveBeenCalled()
  })

  it("another proposal's refund note on the same order does NOT satisfy this proposal's pre-check", async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps({
      totalRefundedCents: 1_000,
      refunds: [{ id: 'gid://shopify/Refund/other', note: 'db-proposal-00000000-0000-0000-0000-000000000000' }],
    })

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('the marker-note pre-check runs BEFORE the staleness guard: a crashed-after-refund re-entry completes instead of refusing', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    // The prior attempt's refund is already sitting on the order...
    const refundOps = fakeRefundOps({
      totalRefundedCents: REFUND_CENTS,
      refunds: [{ id: 'gid://shopify/Refund/prior', note: `db-proposal-${proposal.id}` }],
    })
    // ...and in the retry window the customer wrote again. Refusing here as "stale" would fail a
    // proposal whose money already moved — and the re-drafted refund that follows would be a
    // SECOND payout: the validator's accumulation bound counts only LIVE proposals
    // (`LIVE_REFUND_PROPOSAL_STATUSES` = pending/approved/applying/applied), and a `failed` one is
    // excluded from that set, so the crashed attempt's money is invisible to it.
    await addNewerInbound(s)

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    expect((await readProposal(proposal.id)).status).toBe('applied')
    expect(notify).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    // The ticket is left exactly as the apply found it — no stale hand-back.
    expect((await readTicket(s.ticketId)).status).toBe('awaiting_approval')
  })

  // -------------------------------------------------------------------------
  // Staleness
  // -------------------------------------------------------------------------

  it('stale: a newer inbound than the snapshot fails the proposal, re-triages the ticket, clears the claim stamp, re-enqueues — and refunds NOTHING', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()
    await addNewerInbound(s)

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe(STALE_APPLY_ERROR)

    const ticket = await readTicket(s.ticketId)
    expect(ticket.status).toBe('triaged')
    // Without this clear the re-run's claim CAS finds a claim stamp NEWER than the stale message's
    // own timestamp and no-ops for 20 minutes.
    expect(ticket.lastAgentRunAt).toBeNull()

    expect(enqueue).toHaveBeenCalledWith(
      SUPPORT_AGENT_QUEUE,
      { ticketId: s.ticketId },
      expect.objectContaining({ singletonKey: s.ticketId }),
    )
    expect(notify).toHaveBeenCalledTimes(1)
    // Ruling: the stale notify is a continuation, not an error — the agent re-drafts and the owner
    // re-approves.
    expect(notify.mock.calls[0]![0]).toMatchObject({
      body: expect.stringContaining('re-approve after the agent re-drafts'),
    })
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)
  })

  it('stale: a best-effort enqueue failure alerts but still leaves the proposal failed and the ticket triaged', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()
    await addNewerInbound(s)
    const failingEnqueue = vi.fn(async () => {
      throw new Error('boss down')
    })

    await applyRefund(
      makeDeps({ refundOps, enqueue: failingEnqueue as unknown as ApplyProposalDeps['enqueue'] }),
      proposal,
    )

    expect((await readProposal(proposal.id)).status).toBe('failed')
    expect((await readTicket(s.ticketId)).status).toBe('triaged')
    expect(alert).toHaveBeenCalled()
    expect(refundOps.refundCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Terminal refusals
  // -------------------------------------------------------------------------

  it('bound: an amount exceeding total minus already-refunded fails terminally and notifies, refunding nothing', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { amountCents: 8_000 })
    // 8000 requested, 10000 total, 2500 already refunded -> only 7500 left.
    const refundOps = fakeRefundOps({ totalRefundedCents: 2_500 })

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('refund exceeds remaining refundable')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)
  })

  it('bound: an amount exactly equal to the remaining refundable is allowed', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { amountCents: 7_500 })
    const refundOps = fakeRefundOps({ totalRefundedCents: 2_500 })

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('terminal: refundOps unconfigured fails the proposal and notifies', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)

    await applyRefund(makeDeps({ refundOps: null }), proposal)

    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('refund ops not configured')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('terminal: a missing order row fails the proposal and notifies', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    await db.update(supportTickets).set({ orderId: null }).where(eq(supportTickets.id, s.ticketId))
    await db.update(proposals).set({ orderId: null }).where(eq(proposals.id, proposal.id))
    await db.delete(supplierOrders).where(eq(supplierOrders.orderId, s.orderId))
    await db.delete(orders).where(eq(orders.id, s.orderId))
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('order not found')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('terminal: a NULL total_cents fails the proposal — there is no bound to check against', async () => {
    const s = await seed({ totalCents: null })
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('order has no total')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('terminal: no successful SALE/CAPTURE transaction to refund against fails the proposal', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps({ parentTransactionId: null, gateway: null })

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('no refundable parent transaction')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('terminal: a proposal whose ticket vanished fails rather than refunding without a staleness gate', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    await db.delete(supportMessages).where(eq(supportMessages.ticketId, s.ticketId))
    await db.update(proposals).set({ ticketId: null }).where(eq(proposals.id, proposal.id))
    await db.delete(supportTickets).where(eq(supportTickets.id, s.ticketId))
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), await readProposal(proposal.id))

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('ticket not found')
  })

  // -------------------------------------------------------------------------
  // FR4: ticket-status gate — money must not move once the ticket left the refund flow
  // -------------------------------------------------------------------------

  it('FR4: a refund approved on a since-ESCALATED ticket terminal-fails, refunds NOTHING, notifies', async () => {
    const s = await seed({ ticketStatus: 'escalated' })
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(0)
    const failed = await readProposal(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.applyError).toBe('ticket no longer accepting refund')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await auditActions(proposal.id)).toContain(PROPOSAL_APPLY_FAILED_ACTION)
  })

  it('FR4: a refund on a waiting_on_customer ticket STILL applies (the reply shipped first, this honors it)', async () => {
    const s = await seed({ ticketStatus: 'waiting_on_customer' })
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()

    await applyRefund(makeDeps({ refundOps }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('FR4: an already-issued refund (note present) on an escalated ticket recovers to applied (never strand real money)', async () => {
    const s = await seed({ ticketStatus: 'escalated' })
    const proposal = await seedProposal(s)
    // The refund already moved on a prior attempt — its marker note is on the order.
    const refundOps = fakeRefundOps({
      refunds: [{ id: 'gid://shopify/Refund/prior', note: `db-proposal-${proposal.id}` }],
      totalRefundedCents: REFUND_CENTS,
    })

    await applyRefund(makeDeps({ refundOps }), proposal)

    // Recovery runs BEFORE the status gate: no new refund, but the proposal completes to applied.
    expect(refundOps.refundCalls).toHaveLength(0)
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  // -------------------------------------------------------------------------
  // Retryable failure
  // -------------------------------------------------------------------------

  it('a refundCreate userError THROWS (pg-boss retries, then dead-letters) and leaves the proposal applying', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()
    refundOps.failNext = new Error('refundCreate userErrors: Refund amount is too large')

    await expect(applyRefund(makeDeps({ refundOps }), proposal)).rejects.toThrow(/too large/)

    // Unresolved rather than refused: the retry re-enters, re-runs the note pre-check, and either
    // finds the refund landed or tries again.
    expect((await readProposal(proposal.id)).status).toBe('applying')
    expect(notify).not.toHaveBeenCalled()
  })

  it('writes proposal.refund_issued the instant refundCreate returns — the money-moved receipt survives a crash on any later step', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()
    // The refund lands, then the process dies before the bookkeeping. Simulated by breaking the
    // `applying -> applied` UPDATE, the very next write after the receipt. Without the receipt this
    // state is indistinguishable from "nothing happened": the owner gets a "FAILED to apply" page
    // while the customer has the cash, and only the Shopify admin can tell them apart.
    const failingDb = new Proxy(db, {
      get: (target, prop, receiver) =>
        prop === 'update'
          ? () => {
              throw new Error('db gone')
            }
          : Reflect.get(target, prop, receiver),
    })

    await expect(
      applyRefund(makeDeps({ refundOps, db: failingDb as typeof db }), proposal),
    ).rejects.toThrow('db gone')

    // Money moved exactly once...
    expect(refundOps.refundCalls).toHaveLength(1)
    // ...and the receipt is on the audit trail even though the proposal never reached `applied`.
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, proposal.id))
    const issued = rows.find((r) => r.action === 'proposal.refund_issued')
    expect(issued).toBeDefined()
    expect(issued!.detail).toMatchObject({
      refundId: 'gid://shopify/Refund/1',
      amountCents: REFUND_CENTS,
      orderGid: s.shopifyOrderGid,
    })
    expect(rows.map((r) => r.action)).not.toContain(PROPOSAL_APPLIED_ACTION)
    expect((await readProposal(proposal.id)).status).toBe('applying')
  })

  // -------------------------------------------------------------------------
  // CJ dispute
  // -------------------------------------------------------------------------

  it('dispute: a valid reason opens the CJ dispute keyed on the proposal id and writes cjDispute.id into the payload', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter({ openDisputeId: 'cjd-99' })

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect(adapter.openDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        supplierOrderId: expect.stringContaining('cjo-'),
        idempotencyKey: proposal.id,
        reasonId: CJ_REASON_ID,
        kind: 'refund',
        amountCents: REFUND_CENTS,
        message: REFUND_REASON,
      }),
    )

    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    // `threadSnapshotAt` is asserted deliberately: jsonb `||` is a SHALLOW merge, so every sibling
    // key must survive the `cjDispute` write. If a future change deep-merges or rebuilds the
    // payload, the staleness guard would silently lose its watermark.
    expect(applied.payload).toMatchObject({
      type: 'refund',
      amountCents: REFUND_CENTS,
      threadSnapshotAt: s.snapshotAt.toISOString(),
      cjDispute: { id: 'cjd-99' },
    })
  })

  it('dispute: a kind CJ does not allow for this order skips the dispute, alerts, and STILL applies the refund', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    // CJ offers only a reissue here — but the customer already has cash back, so a reissue is not
    // a substitute for the refund dispute we asked for.
    const adapter = fakeAdapter({
      options: {
        disputable: true,
        maxRefundCents: ORDER_TOTAL_CENTS,
        reasons: [{ id: CJ_REASON_ID, label: 'damaged' }],
        allowedKinds: ['reissue'],
      },
    })

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith(
      'warning',
      CJ_DISPUTE_SKIPPED_ALERT,
      expect.objectContaining({ reason: 'kind_not_allowed' }),
    )
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('dispute: a cjDispute.id already in the payload blocks a second open — read fresh, not off the row snapshot', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter()
    // A concurrent apply (or a re-entry after the merge committed) already opened it. `row` in hand
    // is the pre-refund snapshot and does NOT carry this — only a fresh read does.
    await db
      .update(proposals)
      .set({ payload: { ...payloadFor(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID }), cjDispute: { id: 'cjd-existing' } } })
      .where(eq(proposals.id, proposal.id))

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    // `openDispute` promises idempotency nowhere in SupplierAdapter's contract, so this guard is
    // the only thing standing between a race and two disputes on one supplier order.
    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect(adapter.getDisputeOptions).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith(
      'warning',
      CJ_DISPUTE_SKIPPED_ALERT,
      expect.objectContaining({ reason: 'already_open', disputeId: 'cjd-existing' }),
    )
    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.payload).toMatchObject({ cjDispute: { id: 'cjd-existing' } })
  })

  it('dispute: an invalid reason id skips the dispute, alerts, and STILL applies the refund', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: 'gone-stale' })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter()

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith(
      'warning',
      CJ_DISPUTE_SKIPPED_ALERT,
      expect.objectContaining({ proposalId: proposal.id, reason: 'reason_not_available' }),
    )
    const applied = await readProposal(proposal.id)
    expect(applied.status).toBe('applied')
    expect(applied.payload).not.toHaveProperty('cjDispute')
  })

  it('dispute: an amount above CJ maxRefundCents skips the dispute, alerts, and STILL applies the refund', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter({
      options: { disputable: true, maxRefundCents: 100, reasons: [{ id: CJ_REASON_ID, label: 'damaged' }], allowedKinds: ['refund'] },
    })

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', CJ_DISPUTE_SKIPPED_ALERT, expect.objectContaining({ reason: 'amount_above_max' }))
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('dispute: no linked CJ supplier order skips the dispute, alerts, and STILL applies the refund', async () => {
    const s = await seed({ withSupplierOrder: false })
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter()

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(adapter.getDisputeOptions).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', CJ_DISPUTE_SKIPPED_ALERT, expect.objectContaining({ reason: 'no_supplier_order' }))
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('dispute: a no-longer-disputable order skips the dispute, alerts, and STILL applies the refund', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter({
      options: { disputable: false, reasons: [{ id: CJ_REASON_ID, label: 'damaged' }], allowedKinds: ['refund'] },
    })

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', CJ_DISPUTE_SKIPPED_ALERT, expect.objectContaining({ reason: 'not_disputable' }))
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('dispute: a CJ failure never un-does the customer refund — the proposal still applies', async () => {
    const s = await seed()
    const proposal = await seedProposal(s, { openCjDispute: true, cjDisputeReasonId: CJ_REASON_ID })
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter()
    adapter.openDispute = vi.fn(async () => {
      throw new Error('CJ 503')
    }) as unknown as typeof adapter.openDispute

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(refundOps.refundCalls).toHaveLength(1)
    expect(alert).toHaveBeenCalledWith(
      'warning',
      CJ_DISPUTE_SKIPPED_ALERT,
      expect.objectContaining({ reason: 'cj_error' }),
    )
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })

  it('dispute: openCjDispute false never calls CJ at all', async () => {
    const s = await seed()
    const proposal = await seedProposal(s)
    const refundOps = fakeRefundOps()
    const adapter = fakeAdapter()

    await applyRefund(makeDeps({ refundOps, adapter: adapter as unknown as ApplyProposalDeps['adapter'] }), proposal)

    expect(adapter.getDisputeOptions).not.toHaveBeenCalled()
    expect(adapter.openDispute).not.toHaveBeenCalled()
    expect((await readProposal(proposal.id)).status).toBe('applied')
  })
})
