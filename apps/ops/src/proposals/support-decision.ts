import { RefundPayloadSchema, SupportReplyPayloadSchema } from '@doge-buddy/core'
import { auditLog, proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { and, eq } from 'drizzle-orm'
import { hasLiveSiblingRefundProposal, validateReplyBody, validateRefundIntent, type ValidationFailure } from '../support/validator.ts'

type Db = ReturnType<typeof createDb>['db']
/** The type of the callback's `tx` parameter inside `db.transaction(async (tx) => {...})` — same
 * alias `proposals/transitions.ts` and `support/ingest.ts` declare, for the same reason:
 * `onSupportProposalRejected` (Task 18 review, M5) must be callable with a transaction handle so
 * its writes can join the reject decision's own transition+audit atomically. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx
type ProposalRow = typeof proposals.$inferSelect

/** The two support-decision proposal types this module knows about (support_reply / refund) — the
 * only ones a ticket can ever pair, per spec §3. */
type SupportProposalType = 'support_reply' | 'refund'

/** The OTHER support proposal type on the same ticket — a `support_reply` and a `refund` are the
 * only two types a ticket ever pairs (spec §3), so "sibling" always means "the other one". */
const SIBLING_TYPE: Record<SupportProposalType, SupportProposalType> = {
  support_reply: 'refund',
  refund: 'support_reply',
}

function isSupportProposalType(type: string): type is SupportProposalType {
  return type === 'support_reply' || type === 'refund'
}

/**
 * Owner ruling (Task 18 review, spec §1 exact): rejecting EITHER half of a support-ticket pair
 * (the draft reply or its paired refund) means the owner looked at this ticket and said no — the
 * ticket needs a human, not another automated pass. So a reject on either type:
 *
 *  1. Expires the ticket's still-`pending` SIBLING proposal (the other type) — approving it now
 *     would be deciding on a draft/refund the owner already rejected the other half of. Audited
 *     `proposal.sibling_rejected` per expired row.
 *  2. Escalates the ticket — `escalationReason: 'owner_rejected_draft'`, and, load-bearing,
 *     `escalationNotifiedAt: now()` stamped in the SAME write (not left NULL for the escalation
 *     poller to notify later): the owner caused this escalation with their own reject tap, so a
 *     notification about it would just page them about their own click a minute later. This is
 *     sanctioned exception #2 to "escalations always get notified" — PRE-STAMPING is what makes it
 *     silent instead of a spurious page.
 *  3. Clears `agentSessionId` — an escalated ticket is not the agent's to resume.
 *
 * Called from BOTH decision surfaces (the session-authed admin POST and the public one-click `/a/`
 * route) — the owner's "no" means the same thing regardless of which surface they used to say it.
 * Both callers pass their open transaction's `tx` (Task 18 review, M5) so the reject decision's own
 * proposal transition+audit and everything this function does land as ONE atomic write — mirroring
 * `apply-shared.ts`'s `failStaleAndHandBack` precedent, and for the same reason: a reject must never
 * partially land (proposal rejected but the ticket not escalated, or vice versa).
 *
 * The ticket UPDATE is guarded on `status = 'awaiting_approval'` (the status a ticket is in for as
 * long as a proposal on it is undecided — see `jobs/support-agent-run.ts`'s own flip to
 * `awaiting_approval` on submit): 0 rows is a normal, silent outcome — another writer (a second
 * reject on the sibling, a concurrent tab) already moved the ticket, same optimistic-concurrency
 * discipline as every other guarded UPDATE in this codebase.
 */
export async function onSupportProposalRejected(
  db: DbOrTx,
  row: { id: string; ticketId: string | null; type: string },
): Promise<void> {
  if (row.ticketId === null || !isSupportProposalType(row.type)) return

  const ticketId = row.ticketId
  const siblingType = SIBLING_TYPE[row.type]

  const expiredSiblings = await db
    .update(proposals)
    .set({ status: 'expired' })
    .where(and(eq(proposals.ticketId, ticketId), eq(proposals.type, siblingType), eq(proposals.status, 'pending')))
    .returning({ id: proposals.id })

  if (expiredSiblings.length > 0) {
    await db.insert(auditLog).values(
      expiredSiblings.map((sibling) => ({
        actor: 'system',
        action: 'proposal.sibling_rejected',
        entityType: 'proposal',
        entityId: sibling.id,
        detail: { ticketId, rejectedProposalId: row.id, rejectedType: row.type },
      })),
    )
  }

  await db
    .update(supportTickets)
    .set({
      status: 'escalated',
      escalationReason: 'owner_rejected_draft',
      escalationNotifiedAt: new Date(),
      agentSessionId: null,
    })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'awaiting_approval')))
}

/** `validateSupportProposalForApproval`'s success shape — DELIBERATELY not `ValidationResult`
 * (support/validator.ts's own return type, `{ ok: true; normalizedBody?: string }`): this wraps
 * the whole payload the caller should store, not just a body string, because `refund` has no body
 * to normalize at all and `support_reply`'s normalized body has to be spliced back into its
 * payload before it can be stored. */
export type SupportApprovalValidation = { ok: true; payload: unknown } | ValidationFailure

/**
 * Owner ruling (Task 18 review): the §3 validator is a security gate, and it must re-run on EVERY
 * approval of a `support_reply` or `refund` proposal — edited or not, admin surface or one-click —
 * never just at submit/draft time. A proposal that passed the screen when the agent drafted it can
 * stop being safe by the time the owner taps Approve (its sibling refund got rejected out from
 * under it, say), and the raw-JSON edit path on the admin surface must never be a way to bypass the
 * screen entirely.
 *
 * `support_reply` re-runs `validateReplyBody` with `trackingUrl: null` (Task 18 scope — a real
 * tracking URL isn't threaded through the approval routes) and `hasRefundInOutput` set to whether a
 * LIVE sibling refund proposal currently exists on the ticket — precomputed here (rather than
 * always passing `false` and letting `validateReplyBody`'s own internal fallback compute the same
 * thing) so the promised-action screen's sibling-refund answer is visibly the same value this
 * function reasoned about, not a second, later DB read that could in principle disagree.
 *
 * `refund` re-runs `validateRefundIntent` against the row's own `ticketId`/`orderId` — a refund
 * payload carries no ticket id of its own, so the proposals row's columns are the only source for
 * it. Passes `row.id` as `excludeProposalId` (Task 18 review, CRITICAL 1): the row being approved
 * is itself `pending` — one of the LIVE statuses the accumulation bound sums — so without excluding
 * it, it counts against its own total and the bound degenerates to `amount > total - amount`,
 * permanently refusing any refund over half the order (reproduced: a 100%-of-total refund always
 * failed `refund_exceeds_total`). A null `row.ticketId` (Task 18 review, IMPORTANT 2) is refused
 * EXPLICITLY here rather than coerced to `''` and handed to a uuid-typed column comparison — that
 * coercion made Postgres throw, which this route's generic error handling turned into a misleading
 * "already handled" page instead of a readable validation failure.
 *
 * On success, returns `{ ok: true, payload }` — for `support_reply` this is `payload` with `body`
 * REPLACED by `validateReplyBody`'s `normalizedBody` (Task 18 ruling: "what was screened is what
 * sends" — storing anything else would let a body normalize differently between the screen and the
 * eventual send). `refund` has no body to normalize, so its payload passes through unchanged.
 * Any other proposal type is not this module's concern and passes through unvalidated.
 */
export async function validateSupportProposalForApproval(
  db: Db,
  row: ProposalRow,
  payload: unknown,
): Promise<SupportApprovalValidation> {
  if (row.type === 'support_reply') {
    const parsed = SupportReplyPayloadSchema.parse(payload)
    const liveSiblingRefundExists = await hasLiveSiblingRefundProposal(db, parsed.ticketId)
    const result = await validateReplyBody(db, parsed.ticketId, parsed.body, {
      hasRefundInOutput: liveSiblingRefundExists,
      trackingUrl: null,
    })
    if (!result.ok) return result
    return { ok: true, payload: { ...parsed, body: result.normalizedBody ?? parsed.body } }
  }

  if (row.type === 'refund') {
    if (row.ticketId === null) {
      return { ok: false, code: 'refund_unverified_order', detail: 'proposal has no linked ticket' }
    }
    const parsed = RefundPayloadSchema.parse(payload)
    const result = await validateRefundIntent(
      db,
      { id: row.ticketId, orderId: row.orderId },
      { amountCents: parsed.amountCents, openCjDispute: parsed.openCjDispute, cjDisputeReasonId: parsed.cjDisputeReasonId },
      row.id,
    )
    if (!result.ok) return result
    return { ok: true, payload: parsed }
  }

  return { ok: true, payload }
}
