import { RefundPayloadSchema, centsToUsd, type RefundPayload } from '@doge-buddy/core'
import { auditLog, orders, proposals, supplierOrders, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import {
  PROPOSAL_APPLIED_ACTION,
  PROPOSAL_APPLY_FAILED_ACTION,
  failStaleAndHandBack,
  notifyOwnerBestEffort,
  proposalRefundNote,
  type ApplyProposalDeps,
  type ProposalRow,
} from './apply-shared.ts'
import { applyProposalTransition } from './transitions.ts'

/** Warning alert kind for a CJ dispute that could not be opened. The customer refund already
 * succeeded by the time any of these fire — supplier recovery is best-effort and must never
 * un-apply, retry, or fail the proposal. */
export const CJ_DISPUTE_SKIPPED_ALERT = 'cj_dispute_skipped'

/**
 * Audit action written the instant `refundCreate` returns — the local record that money actually
 * left the account, independent of whether this apply goes on to succeed. Deliberately separate
 * from `proposal.applied`: those two say different things, and after a crash the difference between
 * them ("refund issued, bookkeeping incomplete" vs "nothing happened") is the whole question.
 */
export const PROPOSAL_REFUND_ISSUED_ACTION = 'proposal.refund_issued'

/** Owner-facing title for a refund that did NOT go out for a terminal reason. */
const NOT_APPLIED_TITLE = 'Approved refund was NOT applied'
/** Alert kind when the owner notification itself fails. */
const NOTIFY_FAILED_ALERT = 'refund_notify_failed'

type TicketRow = typeof supportTickets.$inferSelect
type OrderRow = typeof orders.$inferSelect

/**
 * `refund` proposal executor (Task 16, spec §4): turns an owner-approved refund into real money
 * leaving the store's Shopify balance. Called with the row already in `applying` — the shell
 * (`executeApplyProposal`) commits `approved -> applying` BEFORE dispatching here, which is what
 * makes a crash mid-refund recoverable at all.
 *
 * This is the only file in the repo that moves customer money, so its two invariants come first:
 *
 *  1. **Exactly one refund per proposal, ever.** Two independent mechanisms, because each one alone
 *     has a hole. Shopify's `@idempotent(key)` collapses a *fast* duplicate (a redelivered job, a
 *     retry after a lost response) into one refund — but those keys live only ~24h, so a proposal
 *     re-entered after that window would key nothing. The durable half is the refund **note**:
 *     every refund this executor creates carries `db-proposal-<proposalId>` (`proposalRefundNote`,
 *     derived from the proposal id alone and frozen byte-for-byte — refunds already issued LIVE
 *     carry it), and a re-entered apply reads the order's refunds back and treats its own note as
 *     proof the money already moved.
 *  2. **Never more than the order is worth.** `amountCents <= total_cents - totalRefundedCents`,
 *     re-verified HERE and not just at draft time: sibling proposals, a second agent run, or a
 *     human in the Shopify admin may have refunded against this order since the validator ran.
 *
 * **Step order.** Deliberately NOT the spec's literal ordering: the `orderRefundState` fetch and
 * the note pre-check run BEFORE the staleness guard, mirroring the same amendment Task 15's review
 * forced on `apply-support-reply.ts` (recovery scan first). A completed refund is a fait accompli.
 * If a crash lands between `refundCreate` and the `applied` transition, and the customer writes
 * again in the retry window ("never mind, it turned up"), a staleness-first order would fail a
 * proposal whose money ALREADY moved — and that failure is not inert: the ticket goes back to the
 * agent, which re-drafts, and the validator's accumulation bound counts only LIVE refund proposals
 * (`LIVE_REFUND_PROPOSAL_STATUSES` = pending/approved/applying/applied — widened from applied-only
 * by Task 12's M11). The crashed attempt is `failed`, which that set excludes, so the re-drafted
 * refund is invisible to the bound and the owner is asked to approve a SECOND payout for the same
 * complaint. Only the checks that make recovery itself impossible (unconfigured ops, a missing
 * order row, a NULL total) run ahead of the pre-check.
 *
 * Full order: parse -> load ticket + order -> recovery-blocking checks -> `orderRefundState` ->
 * note pre-check (hit -> applied, done) -> ticket pre-check -> staleness -> accumulation bound ->
 * parent-transaction check -> `refundCreate` -> optional CJ dispute -> `applied`.
 *
 * **Refusals vs throws.** Every *refusal* is terminal (`applying -> failed` + audit + owner
 * `notify()` + return, never a throw): none of them get better on a retry, and the owner tapped
 * Approve on their phone — a silent, log-only failure of an approved refund is unacceptable (house
 * `alert()` never reaches Telegram; `notify()` does). Throws are reserved for a state this run
 * could not *establish* — a `refundCreate` userError, an unreachable Shopify — where the retry, and
 * ultimately `deadLetterApplyProposal`, is the right answer.
 */
export async function applyRefund(deps: ApplyProposalDeps, row: ProposalRow): Promise<void> {
  const { db } = deps
  const proposalId = row.id
  const payload = RefundPayloadSchema.parse(row.payload)
  const note = proposalRefundNote(proposalId)

  // Load both up front; the *refusal* on a missing ticket is deferred until after the pre-check
  // (see the step-order note above) — a ticket is not needed to recognise an already-issued refund.
  const ticket = row.ticketId ? await loadTicket(deps, row.ticketId) : undefined
  const [order] = await db.select().from(orders).where(eq(orders.id, payload.orderId))

  // --- Recovery-blocking checks: without any of these the pre-check itself cannot run ---

  const refundOps = deps.refundOps
  if (refundOps === null) {
    await failTerminal(deps, row, ticket?.id ?? null, 'refund ops not configured')
    return
  }
  if (!order) {
    // The ownership-verified `orders` row is the source of truth for both the Shopify gid we refund
    // against and the total we bound against — the payload's own copy is only a snapshot.
    await failTerminal(deps, row, ticket?.id ?? null, 'order not found')
    return
  }
  const totalCents = order.totalCents
  if (totalCents === null) {
    // No total means no accumulation bound, and an unbounded refund is exactly the failure mode
    // this executor exists to prevent.
    await failTerminal(deps, row, ticket?.id ?? null, 'order has no total')
    return
  }

  // --- Refund state: the pre-check and the bound both consume it (spec §4 refund step 2) ---

  const state = await refundOps.orderRefundState(order.shopifyOrderGid)

  // --- Idempotency pre-check (spec §4 refund step 3), FIRST — see the step-order note above ---

  if (state.refunds.some((r) => r.note === note)) {
    await completeApply(deps, row, { recovered: true, orderId: order.id, refundId: null })
    return
  }

  // --- Hard pre-check: no ticket, no staleness gate ---

  if (!ticket) {
    // Terminal for the same reason `apply-support-reply.ts`'s is: a ticket row that no longer
    // exists will never come back, so throwing would only burn the retry budget before
    // dead-lettering to this same `failed` state. Reached only when the pre-check proved no refund
    // was issued, so refusing here cannot contradict money that already moved.
    await failTerminal(deps, row, row.ticketId, 'ticket not found')
    return
  }

  // --- Ticket-status gate (spec §4 refund; FR4), AFTER the idempotency pre-check ---
  //
  // The Telegram approve token stays live for 7 days, so an owner can tap Approve on a refund whose
  // ticket has since been escalated (reply dead-lettered, admin Escalate/Resolve, a late tripwire) —
  // and unlike `applySupportReply`, this executor had NO ticket-status check, so that late tap paid
  // out anyway (money moves off-flow after the owner took the ticket over). Refuse on any status
  // OTHER than the two the refund legitimately runs under: `awaiting_approval` (the ordinary case),
  // and `waiting_on_customer` — the HAPPY path is the paired reply ships first (flipping the ticket
  // to `waiting_on_customer`) and the refund then applies to HONOR that shipped promise. Placed
  // AFTER the note pre-check on purpose: an already-issued refund must recover to `applied`
  // regardless of status (never strand real money), so this only ever refuses a refund that has NOT
  // moved money yet.
  if (ticket.status !== 'awaiting_approval' && ticket.status !== 'waiting_on_customer') {
    await failTerminal(deps, row, ticket.id, 'ticket no longer accepting refund')
    return
  }

  // --- Staleness guard (spec §4 refund step 1) ---

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.ticketId, ticket.id))
    .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt))
  const threadSnapshotAt = new Date(payload.threadSnapshotAt)
  const newerInbound = messages.find(
    (m) => m.direction === 'inbound' && m.sentAt !== null && m.sentAt > threadSnapshotAt,
  )
  if (newerInbound) {
    // A customer's "package arrived, cancel my refund request" gates money exactly as it gates
    // words. The notification is deliberately NOT error-flavoured: nothing is broken and nothing is
    // lost — the agent re-reads the thread and the owner decides again on a fresh draft.
    await failStaleAndHandBack(deps, row, {
      ticketId: ticket.id,
      threadSnapshotAt: payload.threadSnapshotAt,
      newerInboundAt: newerInbound.sentAt,
      notifyTitle: 'Refund held — the customer wrote again',
      notifyBody:
        `${row.summary}\n\nThe customer sent a newer message after this refund was drafted, so no money moved. ` +
        'The agent is re-reading the thread — re-approve after the agent re-drafts.',
      enqueueAlertKind: 'refund_stale_enqueue_failed',
      notifyAlertKind: NOTIFY_FAILED_ALERT,
    })
    return
  }

  // --- Accumulation bound + refundability (spec §4 refund step 2) ---

  const remainingCents = totalCents - state.totalRefundedCents
  if (payload.amountCents > remainingCents) {
    await failTerminal(deps, row, ticket.id, 'refund exceeds remaining refundable', {
      amountCents: payload.amountCents,
      totalCents,
      totalRefundedCents: state.totalRefundedCents,
      remainingCents,
    })
    return
  }
  const parentId = state.parentTransactionId
  if (parentId === null) {
    // Nothing on this order ever successfully took money (or the capture is gone), so there is no
    // transaction to refund against. Terminal: retrying cannot conjure one.
    await failTerminal(deps, row, ticket.id, 'no refundable parent transaction')
    return
  }
  const gateway = state.gateway
  if (gateway === null) {
    // `OrderTransaction.gateway` is nullable coming OUT of Shopify, but `OrderTransactionInput.gateway`
    // is `String!` going IN (live-introspected against the pinned 2026-07 schema, 2026-08-30) —
    // sending null is a GraphQL validation error, not a retryable condition. Terminal, and loud.
    await failTerminal(deps, row, ticket.id, 'parent transaction has no gateway', { parentId })
    return
  }

  // --- The refund (spec §4 refund step 4) ---

  // Everything above this line can be re-run for free; from here on the customer's money has moved
  // and only the note can prove it on a re-entry. `assertNoUserErrors` inside the op turns a
  // Shopify userError into a throw, which is what we want: pg-boss retries, the re-entry's
  // pre-check sees whether it actually landed, and retry exhaustion dead-letters to `failed` +
  // ticket escalation + an owner page (`deadLetterApplyProposal`).
  const { refundId } = await refundOps.refundCreate(
    {
      orderId: order.shopifyOrderGid,
      note,
      notify: true,
      transactions: [
        {
          // `orderId` is REQUIRED on every entry (`OrderTransactionInput.orderId: ID!` on the pinned
          // 2026-07 schema — live-introspected 2026-08-30), not just on the top-level RefundInput.
          // Without it the mutation fails validation before any money moves — silently fatal to
          // every refund, and invisible to the mocked tests until the schema was actually read.
          orderId: order.shopifyOrderGid,
          parentId,
          amount: centsToUsd(payload.amountCents),
          kind: 'REFUND',
          gateway,
        },
      ],
    },
    proposalId,
  )

  // The money-moved receipt, written IMMEDIATELY and on its own — before the CJ step, before the
  // `applied` transition. It is the only LOCAL trace that this refund happened if anything after
  // this line dead-letters: without it the owner gets a "FAILED to apply" page while the customer
  // has the cash, and the only way to tell the difference is opening the Shopify admin. With it,
  // `proposal.refund_issued` on the proposal's audit trail says plainly that the payout landed and
  // only the bookkeeping did not.
  await db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_REFUND_ISSUED_ACTION,
    entityType: 'proposal',
    entityId: proposalId,
    detail: { refundId, amountCents: payload.amountCents, orderGid: order.shopifyOrderGid },
  })

  // --- CJ dispute (spec §4 refund step 5), best-effort ---

  if (payload.openCjDispute) {
    await openCjDispute(deps, row, payload, order)
  }

  // --- Done (spec §4 refund step 6). Ticket status untouched: the paired reply owns the
  // customer communication, and a refund-only proposal cannot exist per spec §3. ---
  await completeApply(deps, row, { recovered: false, orderId: order.id, refundId })
}

async function loadTicket(deps: ApplyProposalDeps, ticketId: string): Promise<TicketRow | undefined> {
  const [ticket] = await deps.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
  return ticket
}

/**
 * `applying -> applied` plus the audit row, for both the fresh path and the recovered one.
 * `recovered: true` means the note pre-check found this proposal's own refund already on the order.
 */
async function completeApply(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  detail: { recovered: boolean; orderId: string; refundId: string | null },
): Promise<void> {
  await applyProposalTransition(deps.db, row.id, 'applying', 'applied', { appliedAt: new Date() })
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLIED_ACTION,
    entityType: 'proposal',
    entityId: row.id,
    detail,
  })
}

/**
 * The terminal-refusal path shared by every hard pre-check: `applying -> failed` with the reason,
 * an audit row, and an owner notification — then the caller returns. Never throws.
 */
async function failTerminal(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  ticketId: string | null,
  applyError: string,
  extraDetail: Record<string, unknown> = {},
): Promise<void> {
  await applyProposalTransition(deps.db, row.id, 'applying', 'failed', { applyError })
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLY_FAILED_ACTION,
    entityType: 'proposal',
    entityId: row.id,
    detail: { reason: applyError, ticketId, ...extraDetail },
  })
  await notifyOwnerBestEffort(deps, row, {
    title: NOT_APPLIED_TITLE,
    body: `${row.summary}\n\nReason: ${applyError}`,
    alertKind: NOTIFY_FAILED_ALERT,
  })
}

/**
 * Claw the refunded money back from the supplier (spec §4 refund step 5) — best-effort, ALWAYS.
 *
 * By the time this runs the customer has their money; the dispute is only about whether CJ
 * reimburses us. So every failure mode here is a `warning` alert and a return, never a throw:
 * throwing would retry an apply whose refund already succeeded, and failing the proposal would page
 * the owner about a refund that worked. The skip reasons are distinguished in the alert detail so
 * the owner can tell "CJ no longer offers that reason" from "CJ was down".
 *
 * KNOWN GAP, accepted deliberately: a crash between `refundCreate` and here (or between
 * `openDispute` and the payload merge below) loses the dispute for this proposal — the re-entry's
 * note pre-check sees the refund landed and completes straight to `applied`, so this step never
 * runs again. It is NOT retried on the recovery path because `SupplierAdapter.openDispute` promises
 * idempotency on `idempotencyKey` nowhere in its contract (only `placeOrder` does), and re-issuing
 * a possibly-non-idempotent supplier write to salvage a best-effort reimbursement is a worse trade
 * than losing the reimbursement. The alert above is the owner's signal to open it by hand.
 */
async function openCjDispute(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  payload: RefundPayload,
  order: OrderRow,
): Promise<void> {
  const skip = (reason: string, extra: Record<string, unknown> = {}): Promise<void> =>
    deps
      .alert('warning', CJ_DISPUTE_SKIPPED_ALERT, {
        proposalId: row.id,
        orderId: order.id,
        reason,
        ...extra,
      })
      .catch(() => {})

  const reasonId = payload.cjDisputeReasonId
  if (!reasonId) {
    // `RefundPayloadSchema` refuses this combination, so it can only come from a hand-written row.
    await skip('no_reason_id')
    return
  }

  const [supplierOrder] = await deps.db
    .select({ supplierOrderId: supplierOrders.supplierOrderId })
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, order.id), eq(supplierOrders.supplier, 'cj')))
    .limit(1)
  const supplierOrderId = supplierOrder?.supplierOrderId
  if (!supplierOrderId) {
    await skip('no_supplier_order')
    return
  }

  // Concurrent-duplicate guard, read FRESH from the row rather than from `row.payload` (a snapshot
  // taken before the refund even ran). `openDispute` promises idempotency on `idempotencyKey`
  // nowhere in `SupplierAdapter`'s contract, so a second apply racing this one — or any path that
  // re-enters after the merge below committed — must not open a second dispute. The merged id is
  // the only durable evidence one already exists.
  const [fresh] = await deps.db
    .select({ existingDisputeId: sql<string | null>`${proposals.payload} -> 'cjDispute' ->> 'id'` })
    .from(proposals)
    .where(eq(proposals.id, row.id))
  if (fresh?.existingDisputeId) {
    await skip('already_open', { disputeId: fresh.existingDisputeId })
    return
  }

  let disputeId: string
  try {
    const options = await deps.adapter.getDisputeOptions(supplierOrderId)
    if (!options.disputable) {
      // CJ's dispute window for this order has closed (or it was never disputable).
      await skip('not_disputable')
      return
    }
    if (!options.reasons.some((r) => r.id === reasonId)) {
      // CJ's reason list is per-order and time-sensitive — the id the agent picked at draft time
      // may simply no longer be offered.
      await skip('reason_not_available', { reasonId })
      return
    }
    if (options.maxRefundCents !== undefined && payload.amountCents > options.maxRefundCents) {
      await skip('amount_above_max', { amountCents: payload.amountCents, maxRefundCents: options.maxRefundCents })
      return
    }
    if (!options.allowedKinds.includes('refund')) {
      // CJ will only offer a reissue on this order. We already refunded the customer in cash, so a
      // reissue is not a substitute — skip rather than silently open the wrong kind of dispute.
      await skip('kind_not_allowed', { allowedKinds: options.allowedKinds })
      return
    }

    // `idempotencyKey: row.id` is the same key `refundCreate` used — CJ maps it to
    // `businessDisputeId`, so a retried apply reuses the existing dispute instead of opening a
    // second one.
    ;({ disputeId } = await deps.adapter.openDispute({
      supplierOrderId,
      idempotencyKey: row.id,
      reasonId,
      kind: 'refund',
      amountCents: payload.amountCents,
      message: payload.reason,
    }))
  } catch (err) {
    await skip('cj_error', { error: err instanceof Error ? err.message : String(err) })
    return
  }

  // Merged into the payload DB-side (`||`) rather than read-modify-written from `row.payload`:
  // that snapshot is already stale by this point, and the merge is what `cj.dispute-poll` later
  // selects on and writes its terminal marker into.
  //
  // WARNING for Task 17: jsonb `||` is a SHALLOW merge — it replaces the whole `cjDispute` value,
  // it does not deep-merge into it. When the poll adds `status`/`closedAt` it must write the
  // COMPLETE object (`{ id, status, closedAt }`), never a partial like `{ status }`, or the `id`
  // this line just stored is destroyed and the dispute becomes unpollable. Every other top-level
  // payload key (`threadSnapshotAt`, `amountCents`, …) survives untouched because they sit beside
  // `cjDispute`, not inside it — the happy-path test asserts exactly that.
  await deps.db
    .update(proposals)
    .set({ payload: sql`${proposals.payload} || ${JSON.stringify({ cjDispute: { id: disputeId } })}::jsonb` })
    .where(eq(proposals.id, row.id))
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.cj_dispute_opened',
    entityType: 'proposal',
    entityId: row.id,
    detail: { disputeId, supplierOrderId, reasonId, amountCents: payload.amountCents },
  })
}
