import { SupportReplyPayloadSchema } from '@doge-buddy/core'
import { auditLog, supportMessages, supportTickets } from '@doge-buddy/db'
import { PROPOSAL_MARKER_HEADER, isMessageGone, type GmailClient } from '@doge-buddy/gmail'
import { and, asc, eq, lte } from 'drizzle-orm'
import { enqueueSupportAgentRun } from '../jobs/support-agent-run.ts'
import type { ApplyProposalDeps, ProposalRow } from './apply-shared.ts'
import { applyProposalTransition } from './transitions.ts'

/** Audit action for every terminal apply refusal below (pre-check or staleness). */
export const PROPOSAL_APPLY_FAILED_ACTION = 'proposal.apply_failed'
/** Audit action for a completed send — same string `applyNewListing` writes. */
export const PROPOSAL_APPLIED_ACTION = 'proposal.applied'
/** `applyError` written when the customer wrote again after the agent took its snapshot. */
export const STALE_APPLY_ERROR = 'stale: newer customer message'

/**
 * References cap (spec §4.3, "the last ~20"). A long thread's full id list would bloat every
 * header; twenty is plenty for any mail client's threading and keeps the header bounded.
 */
const REFERENCES_CAP = 20

/**
 * Ceiling on the recovery scan's `getMessage` calls. The scan walks newest-first and stops at the
 * first marker match, so our own send — always among the newest messages on the thread, since the
 * staleness guard above has already returned if anything newer arrived — is found within the first
 * couple of fetches in practice. The cap is what keeps a pathological thread from turning one
 * apply into an unbounded burst of Gmail calls.
 */
const RECOVERY_SCAN_CAP = 20

/**
 * `support_reply` proposal executor (Task 15, spec §4): turns an owner-approved reply draft into a
 * real, threaded email to the customer. Called with the row already in `applying` — the shell
 * (`executeApplyProposal`) commits `approved -> applying` BEFORE dispatching here, which is what
 * makes the crash window recoverable at all: a process that dies mid-send leaves a durable
 * `applying` marker to come back to.
 *
 * Two failure modes this file exists to prevent, in priority order:
 *
 *  1. **A double send.** Gmail has no idempotency keys, so the send itself cannot be made
 *     idempotent — instead every reply carries `X-DogeBuddy-Proposal: <proposalId>`, and a
 *     re-entered apply reads the thread back looking for its own marker before sending anything.
 *     Deliberately NOT `internalDate > decided_at`: Gmail is also the owner's manual channel, and
 *     their own hand-sent reply in the crash window must not be mistaken for ours (which would
 *     silently drop the approved draft while marking the proposal applied).
 *  2. **A stale send.** The approval is a snapshot of a conversation; if the customer wrote again
 *     between the agent's draft and the owner's tap, the draft may now be wrong (or worse —
 *     "your refund is on the way" answering a message that says "never mind, it arrived"). Any
 *     inbound newer than the payload's `threadSnapshotAt` aborts the send outright and hands the
 *     ticket back to the agent.
 *
 * Every refusal below is TERMINAL (`applying -> failed` + audit + owner notify + return), never a
 * throw: none of them get better on a retry, and the owner tapped Approve on their phone — a
 * silent, log-only failure of an approved send is not acceptable (house `alert()` never reaches
 * Telegram; `notify()` does).
 */
export async function applySupportReply(deps: ApplyProposalDeps, row: ProposalRow): Promise<void> {
  const { db } = deps
  const proposalId = row.id
  const payload = SupportReplyPayloadSchema.parse(row.payload)
  const threadSnapshotAt = new Date(payload.threadSnapshotAt)

  const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.id, payload.ticketId))
  if (!ticket) {
    // Not one of the spec's listed pre-checks, but terminal for the same reason they are: a ticket
    // row that no longer exists will never come back, so throwing would only burn the retry budget
    // before dead-lettering to the same `failed` state this reaches directly.
    await failTerminal(deps, row, payload.ticketId, 'ticket not found')
    return
  }

  // Chronological, both directions — this same list is the staleness input, the threading input,
  // and the recovery scan's "which ids do we already know about" input.
  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.ticketId, ticket.id))
    .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt))

  // --- Step 1: hard pre-checks (spec §4.1), in the spec's order ---

  if (deps.gmail === null) {
    await failTerminal(deps, row, ticket.id, 'gmail not configured')
    return
  }
  const gmail: GmailClient = deps.gmail

  if (ticket.status !== 'awaiting_approval') {
    // A rejected-sibling or escalated ticket must not accept a late Approve tap — the action token
    // in the owner's Telegram message stays live until it expires, so this status check is the
    // thing that actually enforces §1's sibling-invalidation rule at send time.
    await failTerminal(deps, row, ticket.id, 'ticket no longer awaiting approval')
    return
  }

  const customerEmail = ticket.customerEmail
  if (customerEmail === null) {
    await failTerminal(deps, row, ticket.id, 'ticket has no customer email')
    return
  }

  const latestInbound = [...messages].reverse().find((m) => m.direction === 'inbound')
  if (!latestInbound) {
    await failTerminal(deps, row, ticket.id, 'no inbound message to reply to')
    return
  }
  const inReplyTo = latestInbound.rfcMessageId
  if (inReplyTo === null) {
    // Never send unthreaded: a reply with no In-Reply-To starts a new conversation in the
    // customer's client, detached from the thread they wrote in.
    await failTerminal(deps, row, ticket.id, 'latest inbound message has no rfc message id')
    return
  }

  // --- Step 2: staleness guard (spec §4.2) ---

  const newerInbound = messages.find(
    (m) => m.direction === 'inbound' && m.sentAt !== null && m.sentAt > threadSnapshotAt,
  )
  if (newerInbound) {
    await db.transaction(async (tx) => {
      await applyProposalTransition(tx, proposalId, 'applying', 'failed', { applyError: STALE_APPLY_ERROR })
      // `last_agent_run_at: null` is load-bearing, not hygiene: the stale message's Gmail
      // internalDate can predate the wall-clock claim stamp of the run that produced this draft,
      // in which case the re-run's claim CAS (`last_inbound_at > last_agent_run_at`) sees no new
      // inbound and no-ops until the 20-minute stuck branch finally fires. Clearing the stamp puts
      // the ticket back in "never run" territory so the re-run claims immediately.
      // Guarded on `awaiting_approval`; 0 rows is a normal outcome (another writer moved it).
      await tx
        .update(supportTickets)
        .set({ status: 'triaged', lastAgentRunAt: null })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, 'awaiting_approval')))
      await tx.insert(auditLog).values({
        actor: 'system',
        action: PROPOSAL_APPLY_FAILED_ACTION,
        entityType: 'proposal',
        entityId: proposalId,
        detail: {
          reason: STALE_APPLY_ERROR,
          ticketId: ticket.id,
          threadSnapshotAt: payload.threadSnapshotAt,
          newerInboundAt: newerInbound.sentAt?.toISOString() ?? null,
        },
      })
    })

    await notifyOwner(deps, row, STALE_APPLY_ERROR)
    // Best-effort: the ticket is already `triaged`, so the poll's own selection stage is the
    // backstop that re-runs the agent even if this enqueue never lands.
    await enqueueSupportAgentRun(deps.enqueue, ticket.id).catch((err) =>
      deps
        .alert('warning', 'support_reply_stale_enqueue_failed', {
          proposalId,
          ticketId: ticket.id,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {}),
    )
    return
  }

  // --- Step 3: send recovery (spec §4.4) ---

  let sentMessageId = await findAlreadySentMessageId(gmail, messages, ticket.gmailThreadId, proposalId)
  const recovered = sentMessageId !== null

  // --- Step 4: the send (spec §4.3) ---

  if (sentMessageId === null) {
    const sent = await gmail.sendReply({
      threadId: ticket.gmailThreadId,
      to: customerEmail,
      subject: ticket.subject ?? '(no subject)',
      inReplyTo,
      references: buildReferences(messages, inReplyTo).join(' '),
      bodyText: payload.body,
      // The send-recovery marker. Everything above this line can be re-run for free; from here on
      // the customer has the mail, and only this header can prove it on a re-entry.
      extraHeaders: { [PROPOSAL_MARKER_HEADER]: proposalId },
    })
    sentMessageId = sent.id
  }

  // --- Step 5: post-send bookkeeping (spec §4.5) ---

  // Ingest's poll will see this same SENT message and run its own insert; whichever writer gets
  // there first wins and exactly ONE outbound row survives (6A's invariant). `rfcMessageId` is
  // left null here — `sendReply` returns only the Gmail id, and this row exists to make the reply
  // visible to the agent's thread view, not to be threaded against.
  await db
    .insert(supportMessages)
    .values({
      ticketId: ticket.id,
      gmailMessageId: sentMessageId,
      direction: 'outbound',
      fromEmail: deps.supportAddress,
      bodyText: payload.body,
      sentAt: new Date(),
    })
    .onConflictDoNothing({ target: supportMessages.gmailMessageId })

  // The conditional flip: park on the customer ONLY if the thread still looks the way it did when
  // the owner approved. `last_inbound_at <= threadSnapshotAt` is the same watermark the staleness
  // guard used, re-evaluated now to catch a message that landed DURING this apply.
  const flipped = await db
    .update(supportTickets)
    .set({ status: 'waiting_on_customer' })
    .where(
      and(
        eq(supportTickets.id, ticket.id),
        eq(supportTickets.status, 'awaiting_approval'),
        lte(supportTickets.lastInboundAt, threadSnapshotAt),
      ),
    )
    .returning({ id: supportTickets.id })

  if (flipped.length === 0) {
    const [after] = await db
      .select({ status: supportTickets.status })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticket.id))
    if (after?.status === 'awaiting_approval') {
      // Still awaiting approval but the watermark moved: an inbound landed mid-apply. Hand the
      // ticket back to the agent instead of parking it — selection re-runs it.
      //
      // Spec §4.5 dovetail: an inbound ingested BEFORE the flip is caught right here; one ingested
      // AFTER the flip finds `waiting_on_customer` and takes 6A's normal reopen path (ingest flips
      // `resolved`/`waiting_on_customer` back to `new`). No arrival window strands a message.
      //
      // No `last_agent_run_at` clear needed here, unlike the staleness path: this message arrived
      // during the apply, i.e. strictly after the claim that produced the draft, so
      // `last_inbound_at > last_agent_run_at` already holds and the re-run's CAS authorizes itself.
      await db
        .update(supportTickets)
        .set({ status: 'triaged' })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, 'awaiting_approval')))
    }
  }

  await applyProposalTransition(db, proposalId, 'applying', 'applied', { appliedAt: new Date() })
  await db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLIED_ACTION,
    entityType: 'proposal',
    entityId: proposalId,
    detail: { ticketId: ticket.id, gmailMessageId: sentMessageId, recovered },
  })
}

/**
 * Re-entry check: did a prior attempt of THIS proposal already put the reply on the thread?
 *
 * Returns that message's Gmail id, or null when nothing on the thread carries our marker.
 *
 * DEVIATION from the brief's literal wording ("ids not already in `support_messages`"), made
 * deliberately: that filter has a double-send hole. The apply's own post-send upsert — and ingest's
 * poll, which sees the SENT message within a minute — both put our sent id INTO `support_messages`,
 * so a crash after either one would leave a re-entry skipping the very message it is looking for
 * and sending the customer a second copy. Only INBOUND ids are excluded here instead: a customer's
 * own message can never carry our marker, and inbound is the bulk of any thread, so the scan stays
 * just as bounded as intended while actually closing the window. `RECOVERY_SCAN_CAP` + newest-first
 * iteration keeps the fetch count fixed regardless of thread length.
 */
async function findAlreadySentMessageId(
  gmail: GmailClient,
  messages: (typeof supportMessages.$inferSelect)[],
  gmailThreadId: string,
  proposalId: string,
): Promise<string | null> {
  const thread = await gmail.getThread(gmailThreadId)
  const knownInboundIds = new Set(
    messages.filter((m) => m.direction === 'inbound').map((m) => m.gmailMessageId),
  )
  const candidates = thread.messages
    .map((m) => m.id)
    .filter((id) => !knownInboundIds.has(id))
    .slice(-RECOVERY_SCAN_CAP)
    .reverse()

  for (const id of candidates) {
    let meta
    try {
      meta = await gmail.getMessage(id, { format: 'metadata' })
    } catch (err) {
      // A message deleted out from under us can't be ours — skip it. Anything else (a 5xx, a rate
      // limit) means we could NOT establish whether we already sent, so it must throw: the job
      // retries and re-checks rather than sending blind into an unverified thread.
      if (isMessageGone(err)) continue
      throw err
    }
    if (meta.dogeBuddyProposalId === proposalId) return id
  }
  return null
}

/**
 * `References` per spec §4.3: the thread's rfc ids oldest -> newest, capped to the last
 * `REFERENCES_CAP`, with the In-Reply-To target guaranteed last. The explicit re-anchoring matters
 * because the newest message on the thread is not necessarily the latest INBOUND one (the owner
 * may have hand-replied after it), and RFC 5322 threading expects the parent to be the final id.
 */
function buildReferences(messages: (typeof supportMessages.$inferSelect)[], inReplyTo: string): string[] {
  const ordered: string[] = []
  const seen = new Set<string>([inReplyTo])
  for (const m of messages) {
    if (m.rfcMessageId === null || seen.has(m.rfcMessageId)) continue
    seen.add(m.rfcMessageId)
    ordered.push(m.rfcMessageId)
  }
  ordered.push(inReplyTo)
  return ordered.slice(-REFERENCES_CAP)
}

/**
 * The terminal-refusal path shared by every hard pre-check: `applying -> failed` with the reason,
 * an audit row, and an owner notification — then the caller returns. Never throws.
 */
async function failTerminal(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  ticketId: string,
  applyError: string,
): Promise<void> {
  await applyProposalTransition(deps.db, row.id, 'applying', 'failed', { applyError })
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLY_FAILED_ACTION,
    entityType: 'proposal',
    entityId: row.id,
    detail: { reason: applyError, ticketId },
  })
  await notifyOwner(deps, row, applyError)
}

/**
 * Tells the owner their approved reply did NOT go out. `NotifyOwner` never rejects by its own
 * contract, but this guards anyway — a notify failure must never turn a clean terminal refusal
 * into a thrown, retried, dead-lettered one.
 */
async function notifyOwner(deps: ApplyProposalDeps, row: ProposalRow, reason: string): Promise<void> {
  await deps
    .notify({
      title: 'Approved support_reply was NOT sent',
      body: `${row.summary}\n\nReason: ${reason}`,
      actions: [{ label: 'View', url: `${deps.adminBaseUrl}/admin/proposals/${row.id}` }],
    })
    .catch((err) =>
      deps
        .alert('warning', 'support_reply_notify_failed', {
          proposalId: row.id,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {}),
    )
}
