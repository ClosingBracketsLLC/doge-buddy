import { SupportReplyPayloadSchema, type SupportReplyPayload } from '@doge-buddy/core'
import { auditLog, supportMessages, supportTickets } from '@doge-buddy/db'
import { PROPOSAL_MARKER_HEADER, isMessageGone, type GmailClient } from '@doge-buddy/gmail'
import { and, asc, eq, lte } from 'drizzle-orm'
import {
  PROPOSAL_APPLIED_ACTION,
  PROPOSAL_APPLY_FAILED_ACTION,
  STALE_APPLY_ERROR,
  failStaleAndHandBack,
  notifyOwnerBestEffort,
  type ApplyProposalDeps,
  type ProposalRow,
} from './apply-shared.ts'
import { applyProposalTransition } from './transitions.ts'

/**
 * These three now live in `apply-shared.ts` — both support executors write the same audit actions
 * and the same stale `applyError` (Task 16). Re-exported here so every existing importer (this
 * file's test included) keeps working unchanged.
 */
export { PROPOSAL_APPLIED_ACTION, PROPOSAL_APPLY_FAILED_ACTION, STALE_APPLY_ERROR }

/**
 * References cap (spec §4.3, "the last ~20"). A long thread's full id list would bloat every
 * header; twenty is plenty for any mail client's threading and keeps the header bounded. When the
 * list is longer, RFC 5322 §3.6.4's own trimming guidance applies — see `buildReferences`.
 */
const REFERENCES_CAP = 20

/**
 * Safety valve on the recovery scan — deliberately NOT a silent cap (fix round 1, CRITICAL 1).
 *
 * An earlier version took `.slice(-20)` of the candidate list, which silently dropped our own
 * marked send whenever more than twenty unrecorded messages sat newer than it on the thread: the
 * scan then reported "nothing sent" and the customer got a second copy (reproduced). A scan that
 * cannot see every candidate cannot answer the only question it is asked.
 *
 * So: every candidate is scanned, and candidates are naturally a small slice of any thread (known
 * inbound ids are excluded, and those are the bulk). If a thread ever exceeds this many candidates,
 * that is not a case to guess at — it THROWS, and the job retries. Erring toward "retry" costs a
 * delay; erring toward "send" costs the customer a duplicate.
 */
const RECOVERY_SCAN_LIMIT = 50

/**
 * Outbound `Subject:` cap (FR6). The RFC 2822 builder passes a pure-ASCII subject through
 * unencoded and unfolded (`encodeSubjectIfNeeded` only folds non-ASCII into RFC 2047 encoded-words),
 * so a pathologically long ASCII subject — a ticket subject is customer-controlled — would emit a
 * single `Subject:` line past RFC 5322's 998-octet limit. The `Re:` threading is what matters, not a
 * 5,000-char subject; 900 chars keeps `Subject: Re: <subject>` comfortably under 998 octets on the
 * ASCII path while never touching a normal subject.
 */
const OUTBOUND_SUBJECT_MAX_CHARS = 900

/** Thrown (never returned) when the thread carries more unverifiable messages than the scan will
 * examine — the job retries rather than sending blind. */
export const THREAD_TOO_BUSY_ERROR = 'thread too busy to verify prior send — retrying'

type TicketRow = typeof supportTickets.$inferSelect
type MessageRow = typeof supportMessages.$inferSelect

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
 *     re-entered apply reads the thread back looking for its own marker before doing anything else.
 *     Deliberately NOT `internalDate > decided_at`: Gmail is also the owner's manual channel, and
 *     their own hand-sent reply in the crash window must not be mistaken for ours (which would
 *     silently drop the approved draft while marking the proposal applied).
 *  2. **A stale send.** The approval is a snapshot of a conversation; if the customer wrote again
 *     between the agent's draft and the owner's tap, the draft may now be wrong (or worse —
 *     "your refund is on the way" answering a message that says "never mind, it arrived"). Any
 *     inbound newer than the payload's `threadSnapshotAt` aborts the send outright and hands the
 *     ticket back to the agent.
 *
 * **Step order (spec §4, amended fix round 1 — IMPORTANT 2):** the marker recovery scan runs
 * FIRST, before the ticket-status pre-check and before the staleness guard. A completed send is a
 * fait accompli: once the customer has the mail, the only correct continuation is the post-send
 * bookkeeping (all of it idempotent and guarded), never a refusal claiming it never sent. Refusing
 * there would leave the proposal `failed` and page the owner about a reply that is already sitting
 * in the customer's inbox. Only the two checks that make recovery itself impossible — a missing
 * ticket, an unconfigured Gmail client — run ahead of the scan.
 *
 * Full order: load + recovery-blocking checks -> RECOVERY SCAN (hit -> post-send, done) ->
 * ticket-status pre-check -> customer email / rfc id pre-checks -> staleness -> send -> post-send.
 *
 * **Refusals vs throws.** Every *refusal* is terminal (`applying -> failed` + audit + owner
 * `notify()` + return, never a throw): none of them get better on a retry, and the owner tapped
 * Approve on their phone — a silent, log-only failure of an approved send is unacceptable (house
 * `alert()` never reaches Telegram; `notify()` does). Throws are reserved for the opposite case —
 * a state this run could not *establish* (an unreadable thread, an over-busy thread, a failed
 * send). Those must retry, because the alternative is sending blind.
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
    // before dead-lettering to the same `failed` state this reaches directly. Ahead of the scan
    // because there is no thread id to scan without it.
    await failTerminal(deps, row, payload.ticketId, 'ticket not found')
    return
  }

  // Chronological, both directions — this same list is the recovery scan's "which ids are already
  // known inbound" input, the staleness input, and the threading input.
  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.ticketId, ticket.id))
    .orderBy(asc(supportMessages.sentAt), asc(supportMessages.createdAt))

  if (deps.gmail === null) {
    await failTerminal(deps, row, ticket.id, 'gmail not configured')
    return
  }
  const gmail: GmailClient = deps.gmail

  // --- Recovery scan (spec §4.4), FIRST — see the step-order note above ---

  const recoveredId = await findAlreadySentMessageId(gmail, messages, ticket.gmailThreadId, proposalId)
  if (recoveredId !== null) {
    await completeSend(deps, row, ticket, payload, threadSnapshotAt, recoveredId, true)
    return
  }

  // --- Hard pre-checks (spec §4.1) ---

  if (ticket.status !== 'awaiting_approval') {
    // A rejected-sibling or escalated ticket must not accept a late Approve tap — the action token
    // in the owner's Telegram message stays live until it expires, so this status check is the
    // thing that actually enforces §1's sibling-invalidation rule at send time. Reached only when
    // the scan proved nothing was sent, so refusing here cannot contradict a real send.
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

  // --- Staleness guard (spec §4.2) ---

  const newerInbound = messages.find(
    (m) => m.direction === 'inbound' && m.sentAt !== null && m.sentAt > threadSnapshotAt,
  )
  if (newerInbound) {
    // Shared with `applyRefund` — see `failStaleAndHandBack`'s own doc comment for why the ticket
    // hand-back clears the claim stamp in the same transaction.
    await failStaleAndHandBack(deps, row, {
      ticketId: ticket.id,
      threadSnapshotAt: payload.threadSnapshotAt,
      newerInboundAt: newerInbound.sentAt,
      notifyTitle: NOT_SENT_TITLE,
      // Task 18 review ruling: wording unified with `applyRefund`'s own stale hand-back notify —
      // both say the same thing about the same event (a customer message arriving mid-approval),
      // so an owner who sees one after the other reads it as one continuation, not two different
      // failures. Deliberately NOT error-flavoured: nothing is broken and nothing is lost — the
      // agent re-reads the thread and the owner decides again on a fresh draft.
      notifyBody:
        `${row.summary}\n\nThe customer sent a newer message after this reply was drafted, so nothing was sent. ` +
        'The agent is re-reading the thread — re-approve after the agent re-drafts.',
      enqueueAlertKind: 'support_reply_stale_enqueue_failed',
      notifyAlertKind: NOTIFY_FAILED_ALERT,
    })
    return
  }

  // --- The send (spec §4.3) ---

  const sent = await gmail.sendReply({
    threadId: ticket.gmailThreadId,
    to: customerEmail,
    subject: (ticket.subject ?? '(no subject)').slice(0, OUTBOUND_SUBJECT_MAX_CHARS),
    inReplyTo,
    references: buildReferences(messages, inReplyTo).join(' '),
    bodyText: payload.body,
    // The send-recovery marker. Everything above this line can be re-run for free; from here on
    // the customer has the mail, and only this header can prove it on a re-entry.
    extraHeaders: { [PROPOSAL_MARKER_HEADER]: proposalId },
  })

  await completeSend(deps, row, ticket, payload, threadSnapshotAt, sent.id, false)
}

/**
 * Post-send bookkeeping (spec §4.5) — the tail shared by a fresh send and a recovered one.
 *
 * Every write here is idempotent or guarded, which is what makes it safe as the recovery path's
 * landing point: a re-entry that finds its own marker runs exactly this and nothing else.
 */
async function completeSend(
  deps: ApplyProposalDeps,
  row: ProposalRow,
  ticket: TicketRow,
  payload: SupportReplyPayload,
  threadSnapshotAt: Date,
  sentMessageId: string,
  recovered: boolean,
): Promise<void> {
  const { db } = deps

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
  // guard used, re-evaluated now to catch a message that landed DURING this apply. Guarded on
  // `awaiting_approval`, so a recovery landing here after the flip already happened (or after the
  // owner escalated the ticket) matches 0 rows and leaves their status alone.
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
      // `last_agent_run_at: null` here for the same reason the staleness path clears it (fix round
      // 1, IMPORTANT 3) — and the reason is ingestion time, not arrival time. A message can reach
      // Gmail BEFORE the claim and still be ingested during this apply, which leaves
      // `last_inbound_at < last_agent_run_at`: selection's `last_inbound_at > last_agent_run_at`
      // branch never fires, and the stuck branch never fires either because that run FINISHED
      // (`last_agent_finished_at` is past its claim). The ticket would sit in `triaged`,
      // unselectable and unpaged, until a future inbound happened to arrive. Clearing the stamp
      // restores "never run" and makes it selectable on the next cycle.
      await db
        .update(supportTickets)
        .set({ status: 'triaged', lastAgentRunAt: null })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, 'awaiting_approval')))
    }
  }

  await applyProposalTransition(db, row.id, 'applying', 'applied', { appliedAt: new Date() })
  await db.insert(auditLog).values({
    actor: 'system',
    action: PROPOSAL_APPLIED_ACTION,
    entityType: 'proposal',
    entityId: row.id,
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
 * own message can never carry our marker, and inbound is the bulk of any thread, so the candidate
 * set stays as small as the original filter intended while actually closing the window.
 *
 * The candidate list is scanned in FULL (fix round 1, CRITICAL 1 — a truncated scan silently
 * reported "not sent" and duplicated the reply); `RECOVERY_SCAN_LIMIT` is a throwing safety valve,
 * not a slice. Iteration is newest-first purely so the common case exits after one fetch.
 */
async function findAlreadySentMessageId(
  gmail: GmailClient,
  messages: MessageRow[],
  gmailThreadId: string,
  proposalId: string,
): Promise<string | null> {
  const thread = await gmail.getThread(gmailThreadId)
  const knownInboundIds = new Set(
    messages.filter((m) => m.direction === 'inbound').map((m) => m.gmailMessageId),
  )
  const candidates = thread.messages.map((m) => m.id).filter((id) => !knownInboundIds.has(id))

  if (candidates.length > RECOVERY_SCAN_LIMIT) {
    // Refusing to guess: with this many unverifiable messages the scan cannot cheaply prove
    // whether we already sent, and the wrong guess duplicates a customer-visible email.
    throw new Error(THREAD_TOO_BUSY_ERROR)
  }

  for (const id of [...candidates].reverse()) {
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
 * `References` per spec §4.3: the thread's rfc ids oldest -> newest with the In-Reply-To target
 * guaranteed last. The explicit re-anchoring matters because the newest message on the thread is
 * not necessarily the latest INBOUND one (the owner may have hand-replied after it), and RFC 5322
 * threading expects the parent to be the final id.
 *
 * Trimming follows RFC 5322 §3.6.4 rather than a plain tail slice (fix round 1, M6): when the list
 * is longer than `REFERENCES_CAP`, keep the FIRST id — the thread root, which is what mail clients
 * group the conversation by — plus the newest `REFERENCES_CAP - 1`. A tail-only trim drops the root
 * and can split a long thread into a second conversation in the customer's client.
 */
function buildReferences(messages: MessageRow[], inReplyTo: string): string[] {
  const ordered: string[] = []
  const seen = new Set<string>([inReplyTo])
  for (const m of messages) {
    if (m.rfcMessageId === null || seen.has(m.rfcMessageId)) continue
    seen.add(m.rfcMessageId)
    ordered.push(m.rfcMessageId)
  }
  ordered.push(inReplyTo)

  if (ordered.length <= REFERENCES_CAP) return ordered
  return [ordered[0]!, ...ordered.slice(-(REFERENCES_CAP - 1))]
}

/** Owner-facing title for every refusal below: their approved reply did NOT go out. */
const NOT_SENT_TITLE = 'Approved support_reply was NOT sent'
/** Alert kind when the owner notification itself fails. */
const NOTIFY_FAILED_ALERT = 'support_reply_notify_failed'

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
  await notifyOwnerBestEffort(deps, row, {
    title: NOT_SENT_TITLE,
    body: `${row.summary}\n\nReason: ${applyError}`,
    alertKind: NOTIFY_FAILED_ALERT,
  })
}
