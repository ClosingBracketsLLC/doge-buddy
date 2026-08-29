import { formatCents } from '@doge-buddy/core'
import {
  NewListingPayloadSchema, SupportReplyPayloadSchema, RefundPayloadSchema,
  DeprecateProductPayloadSchema, type ProposalType, type SupportReplyPayload, type RefundPayload,
} from '@doge-buddy/core'
import { proposals, auditLog, orders, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import { and, eq, sql } from 'drizzle-orm'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { Settings, SettingKey } from '../settings.ts'
import { senderAuthNote } from '../support/validator.ts'
import { generateActionToken } from './tokens.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export const PAYLOAD_SCHEMAS = {
  new_listing: NewListingPayloadSchema,
  support_reply: SupportReplyPayloadSchema,
  refund: RefundPayloadSchema,
  deprecate_product: DeprecateProductPayloadSchema,
} as const

const MODE_KEYS: Record<ProposalType, SettingKey & `workflow.${string}.mode`> = {
  new_listing: 'workflow.sourcing.mode',
  support_reply: 'workflow.support_reply.mode',
  refund: 'workflow.refund.mode',
  deprecate_product: 'workflow.deprecation.mode',
}

/**
 * `expireInSeconds: 600` (Task 15 review, M5): without an explicit expiry, a `proposal.apply` job
 * whose worker is hard-killed mid-run sits on pg-boss's default expiry before it can be retried,
 * widening the window in which a second handler could pick the same proposal up while the first
 * one's effects are still in flight. Ten minutes sits well above any real apply's runtime (the
 * `support_reply` executor's slowest path is a handful of Gmail calls) while bounding that window
 * — the same reasoning `support.agent-run`'s own 600s expiry documents.
 */
export const PROPOSAL_RETRY_OPTS = { retryLimit: 5, retryBackoff: true, retryDelay: 30, expireInSeconds: 600 }

export function enqueueProposalApply(
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>,
  proposalId: string,
): Promise<void> {
  return enqueue('proposal.apply', { proposalId }, { ...PROPOSAL_RETRY_OPTS, singletonKey: proposalId })
}

export interface SubmitProposalDeps {
  db: Db
  settings: Settings
  notify: NotifyOwner
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
  adminBaseUrl?: string
}

/**
 * Cheap sender-authentication line for a ticket's LATEST inbound message (spec §5's "auth-note").
 * Same NULLS-LAST/created_at/id tiebreak ordering as `support/validator.ts`'s
 * `validateRefundIntent` — "latest inbound message" must never depend on unstable row order when
 * two messages land the same second. A ticket with no inbound message at all (shouldn't happen for
 * a real ticket, but this is notify-body text, not a security gate) reads as unverified.
 *
 * The pass/fail JUDGMENT itself is `support/validator.ts`'s `senderAuthNote` (Task 18 review, M7;
 * FR1) — this function only does the DB fetch. `senderAuthNote` and the refund money-gate both run
 * the SAME `dmarcPasses` parser, so this display note can never disagree with what actually gates a
 * refund — including on an attacker-forged header (`smtp.mailfrom=dmarc=pass@evil`) that a naive
 * substring test would misread as verified.
 */
async function senderAuthNoteForTicket(db: Db, ticketId: string): Promise<string> {
  const [latestInbound] = await db
    .select({ authResults: supportMessages.authResults })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.direction, 'inbound')))
    .orderBy(sql`${supportMessages.sentAt} DESC NULLS LAST, ${supportMessages.createdAt} DESC, ${supportMessages.id} DESC`)
    .limit(1)
  return senderAuthNote(latestInbound?.authResults ?? null)
}

/**
 * Field-level bounds (Task 18 review, N1) applied BEFORE assembly to the untrusted/unbounded
 * fields that feed a notify body — a ticket subject (attacker-controlled: it's a customer email
 * subject line) or a refund reason. Bounding these up front, rather than only capping the final
 * assembled string, is what keeps a long subject from being able to push mandatory content (the
 * ⚠ paired-refund warning, the admin deep link) past the final cap — see `capNotifyBody`'s own doc
 * comment for the rest of that story.
 */
/** Exported (FR6) so the proposal-summary builder in `jobs/support-agent-run.ts` bounds a ticket
 * subject at the SOURCE — `proposals.summary` = `Reply: <subject>` flows into four best-effort apply
 * notify bodies that bypass `capNotifyBody`, and an unbounded subject there could push a Telegram
 * message past 4096 chars → notify returns false → the "your approved reply/refund did NOT send"
 * page is dropped on the money/mail path. */
export const SUBJECT_MAX_CHARS = 200
const REASON_MAX_CHARS = 300

function truncateField(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
}

/**
 * `support_reply`'s Telegram body (spec §5): subject + customer + auth-note, then the draft body
 * itself — head 600 + tail 200 with an ellipsis between when it's over 800 chars, the WHOLE body
 * otherwise. The `body.slice(0, 600) + (... ? tail : body.slice(600))` shape is deliberate, not
 * just "trim if long": for a body ≤ 800 chars, `slice(0, 600) + slice(600)` reconstructs the
 * string EXACTLY regardless of its length (including < 600), so there is no separate "short body"
 * branch to keep in sync with the long one. The subject is bounded to `SUBJECT_MAX_CHARS` before
 * it goes into that assembly (Task 18 review, N1) — see `capNotifyBody`'s doc comment for why.
 *
 * When a live sibling refund proposal is still `pending` on the same ticket, appends spec §5's
 * warning line — the owner is about to approve a reply that may promise a refund without having
 * decided the refund itself yet. This line is passed to `capNotifyBody` as MANDATORY TAIL (Task 18
 * review, N1): a long subject/body must never be able to push it off the end of a capped body,
 * because a silently-missing warning is exactly the failure this line exists to prevent.
 */
async function buildSupportReplyNotifyBody(db: Db, payload: SupportReplyPayload): Promise<string> {
  const [ticket] = await db
    .select({ subject: supportTickets.subject, customerEmail: supportTickets.customerEmail })
    .from(supportTickets)
    .where(eq(supportTickets.id, payload.ticketId))
    .limit(1)

  const authNote = await senderAuthNoteForTicket(db, payload.ticketId)

  const body = payload.body
  const bodyExcerpt = body.slice(0, 600) + (body.length > 800 ? `\n…\n${body.slice(-200)}` : body.slice(600))

  const [siblingRefund] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.ticketId, payload.ticketId), eq(proposals.type, 'refund'), eq(proposals.status, 'pending')))
    .limit(1)

  const subject = truncateField(ticket?.subject ?? '(no subject)', SUBJECT_MAX_CHARS)
  const head = [
    `Subject: ${subject}`,
    `Customer: ${ticket?.customerEmail ?? '(unknown)'}`,
    authNote,
    '',
    bodyExcerpt,
  ].join('\n')
  const tail = siblingRefund
    ? `\n\n⚠ promises a refund — decide/approve the paired refund proposal ${siblingRefund.id}; if the refund is rejected or expires after this reply sends, the ticket re-escalates`
    : ''
  return capNotifyBody(head, tail)
}

/**
 * `refund`'s Telegram body (spec §5): `$X.XX on order #N — <reason>`, then the dispute flag and
 * the same cheap auth-note `support_reply`'s body uses. `ticketId` is the top-level
 * `SubmitProposalInput.ticketId` (a refund payload carries no ticket id of its own) — absent it,
 * the auth-note is simply omitted rather than guessed at. `reason` is bounded to
 * `REASON_MAX_CHARS` before assembly (Task 18 review, N1) — nothing here is mandatory tail (no
 * ⚠ line, no deep link), so a plain final-cap via `capNotifyBody`'s default empty tail is enough.
 */
async function buildRefundNotifyBody(db: Db, payload: RefundPayload, ticketId: string | undefined): Promise<string> {
  const [order] = await db
    .select({ number: orders.shopifyOrderNumber })
    .from(orders)
    .where(eq(orders.id, payload.orderId))
    .limit(1)

  const reason = truncateField(payload.reason, REASON_MAX_CHARS)
  const lines = [
    `${formatCents(payload.amountCents)} on order #${order?.number ?? 'unknown'} — ${reason}`,
    payload.openCjDispute ? 'CJ dispute: requested' : 'CJ dispute: no',
  ]
  if (ticketId) {
    lines.push(await senderAuthNoteForTicket(db, ticketId))
  }
  return capNotifyBody(lines.join('\n'))
}

interface NotifyBodyCtx {
  db: Db
  id: string
  summary: string
  adminBaseUrl: string
  ticketId?: string
}

/**
 * Hard backstop under Telegram's ~4096-char message limit (Task 18 review, M8/N1 — mirrors
 * `support/escalate.ts`'s own `BODY_MAX_CHARS` + comment). Every field folded into a notify body
 * is untrusted, effectively-unbounded text — a ticket subject or a refund reason a customer (or a
 * hostile one) controls the length of.
 *
 * `head` and `tail` are capped DIFFERENTLY on purpose (N1 fix — M8's original version head-sliced
 * the WHOLE assembled string, which silently truncated the ⚠ paired-refund warning off the end of
 * the body whenever a long subject pushed it past 3500 chars: reproduced with a 3400-char subject,
 * the owner could approve a promise-of-refund reply with no warning of its paired refund at all).
 * `tail` carries content that MUST survive — the ⚠ warning line, the generic body's admin deep
 * link — and is NEVER truncated (short of some future tail alone exceeding the whole budget, which
 * none of this file's fixed-shape tails can). Only `head` — the variable, unbounded-length content
 * — is cut down to fit whatever budget `tail` leaves. Per-field bounds (`SUBJECT_MAX_CHARS`,
 * `REASON_MAX_CHARS`) applied before assembly are the FIRST line of defense so `head` rarely needs
 * trimming at all in practice; this is the backstop for when it still does.
 */
const NOTIFY_BODY_MAX_CHARS = 3500

export function capNotifyBody(head: string, tail: string = ''): string {
  const budget = NOTIFY_BODY_MAX_CHARS - tail.length
  const cappedHead = budget <= 0 ? '' : head.length > budget ? head.slice(0, budget) : head
  return cappedHead + tail
}

/**
 * Per-type Telegram notify body (Task 18, spec §5). `support_reply` and `refund` get dedicated,
 * human-readable bodies built from the DB (see the two builders above, which cap themselves);
 * every other type (`new_listing`, `deprecate_product`) keeps the ORIGINAL generic body verbatim —
 * summary, IP-check checkbox, the TikTok Creative Center ritual line — with the admin deep link
 * passed to `capNotifyBody` as mandatory tail (Task 18 review, N1): an operator must always be
 * able to reach the proposal from the notification even when `summary` is unusually long. `payload`
 * here is the already-`PAYLOAD_SCHEMAS`-validated value `submitProposal` is about to insert, not
 * re-validated — same "display, not re-validation" contract `render-proposal.ts`'s renderers use.
 */
export async function buildProposalNotifyBody(type: ProposalType, payload: unknown, ctx: NotifyBodyCtx): Promise<string> {
  if (type === 'support_reply') {
    return buildSupportReplyNotifyBody(ctx.db, payload as SupportReplyPayload)
  }
  if (type === 'refund') {
    return buildRefundNotifyBody(ctx.db, payload as RefundPayload, ctx.ticketId)
  }

  const head = [
    ctx.summary,
    '',
    '[ ] IP check done',
    'Ritual: check TikTok Creative Center (Pet Supplies, US, 7d) — paste anything interesting into the dashboard',
  ].join('\n')
  const tail = `\n${ctx.adminBaseUrl}/admin/proposals/${ctx.id}`
  return capNotifyBody(head, tail)
}

export interface SubmitProposalInput {
  type: 'new_listing' | 'support_reply' | 'refund' | 'deprecate_product'
  summary: string
  payload: unknown
  sourceWorkflow: string
  agentRunId?: string
  ticketId?: string
  productId?: string
  orderId?: string
}

/**
 * Single entry point every workflow's output routes through. Validates the payload against
 * its per-type zod schema, decides manual vs. auto per `workflow.<x>.mode` (with a refund
 * amount cap override that forces manual even when the setting says auto), persists the
 * proposals row, writes the audit trail, and — manual only — notifies the owner with a
 * one-click approve/reject pair sharing a single action token.
 *
 * `opts.suppressNotify` (Task 4): manual-path-only escape hatch for callers that want the
 * pending proposal + audit row persisted WITHOUT an owner push — e.g. a caller that's about to
 * fold several proposals into a single digest notification of its own, where per-proposal
 * Telegram pushes would be redundant noise. When true, the `generateActionToken()` mint and
 * `deps.notify(...)` call are both skipped (no orphaned token hash sitting unused in the row),
 * and since there's nothing to notify, the `adminBaseUrl`-absent `notify_unconfigured` alert is
 * skipped too — that alert exists to flag a MISSING push, not to fire when no push was ever
 * intended. Auto mode has no notify step regardless (it enqueues apply), so `suppressNotify` is
 * a no-op there. Optional + defaulted so the ~5 existing 2-arg callers and the `submit: typeof
 * submitProposal` injection seam used elsewhere are unaffected.
 */
export async function submitProposal(
  deps: SubmitProposalDeps,
  input: SubmitProposalInput,
  opts?: { suppressNotify?: boolean },
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const schema = PAYLOAD_SCHEMAS[input.type]
  const parsed = schema.parse(input.payload) as { amountCents?: number }

  const modeKey = MODE_KEYS[input.type]
  let mode = await deps.settings.get(modeKey)

  if (mode === 'auto' && input.type === 'refund') {
    const cap = await deps.settings.get('refund.auto_max_cents')
    if ((parsed.amountCents ?? 0) > cap) {
      mode = 'manual'
    }
  }

  if (mode === 'manual') {
    const suppressNotify = opts?.suppressNotify ?? false
    const { token, hash } = suppressNotify ? { token: null, hash: null } : generateActionToken()

    const [row] = await deps.db
      .insert(proposals)
      .values({
        type: input.type,
        status: 'pending',
        summary: input.summary,
        payload: parsed,
        sourceWorkflow: input.sourceWorkflow,
        agentRunId: input.agentRunId,
        ticketId: input.ticketId,
        productId: input.productId,
        orderId: input.orderId,
        autoApproved: false,
        actionTokenHash: hash,
      })
      .returning()
    const id = row!.id

    await deps.db.insert(auditLog).values({
      actor: 'system',
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: id,
      detail: { type: input.type, sourceWorkflow: input.sourceWorkflow, mode: 'manual' },
    })

    if (!suppressNotify) {
      if (deps.adminBaseUrl) {
        const approveUrl = `${deps.adminBaseUrl}/a/${id}/approve?t=${token}`
        const rejectUrl = `${deps.adminBaseUrl}/a/${id}/reject?t=${token}`
        const body = await buildProposalNotifyBody(input.type, parsed, {
          db: deps.db,
          id,
          summary: input.summary,
          adminBaseUrl: deps.adminBaseUrl,
          ticketId: input.ticketId,
        })

        await deps.notify({
          title: `New ${input.type} proposal`,
          body,
          actions: [
            { label: 'Approve', url: approveUrl },
            { label: 'Reject', url: rejectUrl },
          ],
        })
      } else {
        await deps.alert('warning', 'notify_unconfigured', { proposalId: id })
      }
    }

    return { id, status: 'pending' }
  }

  // auto
  const decidedAt = new Date()
  const [row] = await deps.db
    .insert(proposals)
    .values({
      type: input.type,
      status: 'approved',
      summary: input.summary,
      payload: parsed,
      sourceWorkflow: input.sourceWorkflow,
      agentRunId: input.agentRunId,
      ticketId: input.ticketId,
      productId: input.productId,
      orderId: input.orderId,
      autoApproved: true,
      decidedBy: 'system:auto',
      decidedAt,
      actionTokenHash: null,
    })
    .returning()
  const id = row!.id

  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.created',
    entityType: 'proposal',
    entityId: id,
    detail: { type: input.type, sourceWorkflow: input.sourceWorkflow, mode: 'auto' },
  })
  await deps.db.insert(auditLog).values({
    actor: 'system',
    action: 'proposal.approve',
    entityType: 'proposal',
    entityId: id,
    detail: { via: 'auto' },
  })

  try {
    await enqueueProposalApply(deps.enqueue, id)
  } catch {
    // The transition above already committed — never un-approve on an enqueue failure, just
    // alert and let `/admin` resend-apply recover it. Same precedent as the action-route's
    // `enqueueFailedPage` path (`http/actions.ts`) — best-effort alert, its own failure must
    // never break this response.
    await deps.alert('critical', 'apply_enqueue_failed', { proposalId: id }).catch(() => {})
  }

  return { id, status: 'approved' }
}
