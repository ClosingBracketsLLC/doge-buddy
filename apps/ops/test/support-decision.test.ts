import { auditLog, createDb, proposals, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { onSupportProposalRejected, validateSupportProposalForApproval } from '../src/proposals/support-decision.ts'
import { applyProposalTransition } from '../src/proposals/transitions.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

type Db = ReturnType<typeof createDb>['db']

describe('support-decision.ts', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let createdTicketIds: string[] = []
  let createdProposalIds: string[] = []

  afterEach(async () => {
    if (createdProposalIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.entityId, createdProposalIds))
      await db.delete(proposals).where(inArray(proposals.id, createdProposalIds))
      createdProposalIds = []
    }
    if (createdTicketIds.length > 0) {
      await db.delete(supportTickets).where(inArray(supportTickets.id, createdTicketIds))
      createdTicketIds = []
    }
  })

  async function seedTicket(overrides: Partial<{ agentSessionId: string }> = {}) {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `sd18-${crypto.randomUUID()}`,
        customerEmail: 'buyer@example.com',
        subject: 'Test',
        status: 'awaiting_approval',
        agentSessionId: overrides.agentSessionId ?? 'sess-live',
      })
      .returning()
    createdTicketIds.push(ticket!.id)
    return ticket!
  }

  async function seedProposal(overrides: {
    type: 'support_reply' | 'refund'
    ticketId: string
    orderId?: string
    status?: 'pending' | 'rejected' | 'expired' | 'approved'
  }) {
    const [row] = await db
      .insert(proposals)
      .values({
        type: overrides.type,
        status: overrides.status ?? 'pending',
        summary: `Test ${overrides.type}`,
        payload:
          overrides.type === 'support_reply'
            ? { type: 'support_reply', ticketId: overrides.ticketId, body: 'hi', threadSnapshotAt: new Date().toISOString() }
            : {
                type: 'refund',
                orderId: overrides.orderId ?? crypto.randomUUID(),
                shopifyOrderGid: 'gid://shopify/Order/999',
                amountCents: 1000,
                reason: 'damaged',
                openCjDispute: false,
                threadSnapshotAt: new Date().toISOString(),
              },
        sourceWorkflow: 'test',
        ticketId: overrides.ticketId,
        orderId: overrides.orderId,
      })
      .returning()
    createdProposalIds.push(row!.id)
    return row!
  }

  describe('onSupportProposalRejected', () => {
    it('rejecting a refund expires the pending sibling reply and silently escalates the ticket', async () => {
      const ticket = await seedTicket()
      const refund = await seedProposal({ type: 'refund', ticketId: ticket.id })
      const reply = await seedProposal({ type: 'support_reply', ticketId: ticket.id })

      await onSupportProposalRejected(db, { id: refund.id, ticketId: ticket.id, type: 'refund' })

      const [replyAfter] = await db.select().from(proposals).where(eq(proposals.id, reply.id))
      expect(replyAfter!.status).toBe('expired')

      const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
      expect(ticketAfter!.status).toBe('escalated')
      expect(ticketAfter!.escalationReason).toBe('owner_rejected_draft')
      expect(ticketAfter!.escalationNotifiedAt).not.toBeNull()
      expect(ticketAfter!.agentSessionId).toBeNull()

      const siblingAudit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, reply.id), eq(auditLog.action, 'proposal.sibling_rejected')))
      expect(siblingAudit).toHaveLength(1)
    })

    it('FR2a: rejecting the refund AFTER the reply shipped (ticket waiting_on_customer) escalates with a PAGE (notify stamp NULL), reason refund_promise_unbacked', async () => {
      const ticket = await seedTicket()
      // The reply already applied and flipped the ticket to waiting_on_customer.
      await db.update(supportTickets).set({ status: 'waiting_on_customer' }).where(eq(supportTickets.id, ticket.id))
      await seedProposal({ type: 'support_reply', ticketId: ticket.id, status: 'approved' }) // stands in for the shipped reply
      const refund = await seedProposal({ type: 'refund', ticketId: ticket.id })

      await onSupportProposalRejected(db, { id: refund.id, ticketId: ticket.id, type: 'refund' })

      const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
      expect(ticketAfter!.status).toBe('escalated')
      expect(ticketAfter!.escalationReason).toBe('refund_promise_unbacked')
      // NULL stamp = a real page: the shipped promise just lost its backing.
      expect(ticketAfter!.escalationNotifiedAt).toBeNull()
      expect(ticketAfter!.agentSessionId).toBeNull()
    })

    it('is callable with a plain Db handle (not only a transaction) — confirms the DbOrTx type widening did not break the ordinary call shape', async () => {
      const ticket = await seedTicket()
      const reply = await seedProposal({ type: 'support_reply', ticketId: ticket.id })

      await expect(onSupportProposalRejected(db as Db, { id: reply.id, ticketId: ticket.id, type: 'support_reply' })).resolves.toBeUndefined()

      const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
      expect(ticketAfter!.status).toBe('escalated')
    })

    // Fix round 1 (Task 18 review), M5: the reject transition + audit + sibling expiry + ticket
    // escalation must be ONE atomic unit — mirroring `apply-shared.ts`'s `failStaleAndHandBack`
    // precedent. This composes the exact same pieces `routes.ts`/`actions.ts` wrap in
    // `deps.db.transaction(...)`, with an injected throw AFTER every write, to prove a mid-
    // transaction failure rolls back EVERYTHING — not just leaves the proposal transitioned while
    // the ticket/sibling writes are lost, or vice versa.
    it('atomicity: a throw injected mid-transaction (after the proposal transition, the audit, and the sibling/ticket writes) rolls back ALL of it', async () => {
      const ticket = await seedTicket()
      const refund = await seedProposal({ type: 'refund', ticketId: ticket.id })
      const reply = await seedProposal({ type: 'support_reply', ticketId: ticket.id })

      await expect(
        db.transaction(async (tx) => {
          await applyProposalTransition(tx, refund.id, 'pending', 'rejected', {
            decidedBy: 'owner',
            decidedAt: new Date(),
            actionTokenHash: null,
          })
          await tx.insert(auditLog).values({
            actor: 'owner',
            action: 'proposal.reject',
            entityType: 'proposal',
            entityId: refund.id,
            detail: { via: 'test' },
          })
          await onSupportProposalRejected(tx, { id: refund.id, ticketId: ticket.id, type: 'refund' })
          throw new Error('injected mid-transaction failure')
        }),
      ).rejects.toThrow('injected mid-transaction failure')

      // Nothing committed: the refund is still pending (not rejected), the sibling reply is still
      // pending (not expired), the ticket is still awaiting_approval (not escalated), and no
      // reject/sibling_rejected audit rows exist.
      const [refundAfter] = await db.select().from(proposals).where(eq(proposals.id, refund.id))
      expect(refundAfter!.status).toBe('pending')

      const [replyAfter] = await db.select().from(proposals).where(eq(proposals.id, reply.id))
      expect(replyAfter!.status).toBe('pending')

      const [ticketAfter] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id))
      expect(ticketAfter!.status).toBe('awaiting_approval')
      expect(ticketAfter!.escalationReason).toBeNull()
      expect(ticketAfter!.agentSessionId).toBe('sess-live')

      const rejectAudit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, refund.id), eq(auditLog.action, 'proposal.reject')))
      expect(rejectAudit).toHaveLength(0)

      const siblingAudit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, reply.id), eq(auditLog.action, 'proposal.sibling_rejected')))
      expect(siblingAudit).toHaveLength(0)
    })
  })

  describe('validateSupportProposalForApproval', () => {
    // Fix round 1 (Task 18 review), IMPORTANT 2: a refund row with a null ticketId must fail with
    // a readable code, not coerce `''` into a uuid-typed column comparison (which threw inside
    // Postgres and, at the route layer, rendered a misleading "already handled" page).
    it('refund with a null ticketId fails refund_unverified_order explicitly, without throwing', async () => {
      const ticket = await seedTicket()
      const refund = await seedProposal({ type: 'refund', ticketId: ticket.id })
      // Force ticketId to NULL directly on the row, AFTER insert (proposals.ticket_id has no
      // not-null constraint) — proves the function's own explicit guard, not just a fixture that
      // never seeds NULL.
      await db.update(proposals).set({ ticketId: null }).where(eq(proposals.id, refund.id))
      const [row] = await db.select().from(proposals).where(eq(proposals.id, refund.id))

      const result = await validateSupportProposalForApproval(db, row!, row!.payload)

      expect(result).toEqual({ ok: false, code: 'refund_unverified_order', detail: expect.any(String) })
    })
  })
})
