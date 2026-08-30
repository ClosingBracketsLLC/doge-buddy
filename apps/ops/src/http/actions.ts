import { timingSafeEqual } from 'node:crypto'
import { auditLog, proposals, supportTickets, type createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { SendOpts } from '../fulfillment/types.ts'
import { enqueueProposalApply } from '../proposals/submit.ts'
import { onSupportProposalRejected, onSupportProposalRejectedForRedraft, validateSupportProposalForApproval } from '../proposals/support-decision.ts'
import { hashActionToken } from '../proposals/tokens.ts'
import { applyProposalTransition, StaleProposalStatusError } from '../proposals/transitions.ts'
import { resolveRejectAction, SUPPORT_REDRAFT_MAX } from '../support/redraft.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type ProposalRow = typeof proposals.$inferSelect
type Decision = 'approve' | 'reject'

export interface ActionRouteDeps {
  db: Db
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
}

// Constant copy on purpose: this page must render identically for an unknown id, a wrong/garbage
// token, an already-decided row, and an expired row — no field of it may leak which case applied,
// so it can never act as a state oracle for someone probing links.
const FRIENDLY_COPY = 'This link was already handled or has expired.'

/** Escapes the five HTML-significant characters. Used on every piece of user-supplied text
 * (the proposal summary) before it's interpolated into a hand-rolled template literal. */
function esc(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

function friendlyPage(): string {
  return page(`<p>${FRIENDLY_COPY}</p>`)
}

/**
 * `isSupportReject`/`redraftCount` (Task 8): the reason-capture form only ever renders for a
 * REJECT of a `support_reply`/`refund` proposal that's tied to a ticket — approve, and reject of a
 * non-support (e.g. sourcing/product) proposal, stay today's plain single-button confirm. Sourcing
 * proposals have no ticket to re-draft against, so giving them a reason box would be a dead end
 * that misleads the clicker into thinking a redraft is possible.
 */
function confirmPage(
  proposalId: string,
  decision: Decision,
  summary: string,
  token: string,
  isSupportReject: boolean,
  redraftCount: number,
): string {
  const label = decision === 'approve' ? 'Approve' : 'Reject'
  const action = `/a/${proposalId}/${decision}?t=${encodeURIComponent(token)}`
  if (decision === 'approve' || !isSupportReject) {
    return page(`
      <p>${esc(summary)}</p>
      <form method="post" action="${action}">
        <button type="submit">${label}</button>
      </form>
    `)
  }
  const canRedraft = redraftCount < SUPPORT_REDRAFT_MAX
  return page(`
    <p>${esc(summary)}</p>
    <form method="post" action="${action}">
      <p><label>Reason for the agent (optional — leave blank to escalate to you):<br>
        <textarea name="reason" rows="6" cols="70" maxlength="2000"></textarea></label></p>
      ${canRedraft
        ? `<button type="submit" name="action" value="redraft">Re-draft with this reason</button> `
        : `<p>Re-drafted ${SUPPORT_REDRAFT_MAX}× already — rejecting again escalates to you.</p>`}
      <button type="submit" name="action" value="escalate">Just escalate to me</button>
    </form>
  `)
}

function resultPage(decision: Decision): string {
  return decision === 'approve'
    ? page('<p>Approved ✓ — the listing will go live shortly.</p>')
    : page('<p>Rejected ✓</p>')
}

/**
 * Rendered instead of the normal `resultPage('approve')` when the transition committed
 * (the proposal IS 'approved' in the DB) but `enqueueProposalApply` itself threw — distinct copy
 * so the clicker knows the apply still needs a nudge, rather than seeing the same "will go live
 * shortly" text a healthy approve gets. Same recovery shape as Task 7's order-recovery
 * enqueue-failure page: never un-approve, just surface the gap and point at the fix (the admin
 * dashboard's resend-apply button, Item 1c).
 */
function enqueueFailedPage(): string {
  return page('<p>Approved ✓ — but queueing failed; the admin dashboard can re-send.</p>')
}

/**
 * Rendered when Task 18's §3 validator re-run refuses a `support_reply`/`refund` approve (its
 * sibling refund got rejected out from under it, an off-domain URL crept into the body, etc.) —
 * distinct from `friendlyPage()` on purpose: by this point `isValidDecision` already proved the
 * clicker holds the real token for a still-pending row, so there is no token-guessing oracle risk
 * left to protect against, and naming the code+detail (same shape the admin surface's 400 page
 * uses) is what tells a real owner what actually went wrong instead of a generic "expired" copy
 * that would misdirect them into re-requesting a link that was never the problem.
 */
function validationFailedPage(code: string, detail: string): string {
  return page(`<p>Could not approve: ${esc(code)} — ${esc(detail)}</p>`)
}

/**
 * Rendered when a reject reason exceeds the 2000-char bound (Task 8). Deliberately NOT
 * `friendlyPage()` — that copy ("already handled or has expired") would mislead the clicker into
 * thinking the link is dead and their reason was silently swallowed, when actually nothing at all
 * happened: the check runs before the reject transition, so the token is still valid and the
 * proposal is still pending. A readable refusal lets them go back and shorten it.
 */
function reasonTooLongPage(): string {
  return page('<p>Reason too long (max 2000 characters) — nothing was changed. Go back and shorten it.</p>')
}

/**
 * Timing-safe check that `token` (raw, from the query string) matches `row`'s stored hash, on a
 * row that is still pending and not yet expired. Both sides of the comparison are 64-char hex
 * sha256 digests, but length is still guarded before `timingSafeEqual` (which throws on unequal
 * lengths) — the same pattern as `verifyShopifyWebhookHmac` / CJ's `verifyWebhook`.
 */
function isValidDecision(row: ProposalRow | undefined, token: string | undefined): row is ProposalRow {
  if (!row || !token) return false
  if (row.status !== 'pending') return false
  if (row.actionTokenHash === null) return false
  if (!(row.expiresAt.getTime() > Date.now())) return false

  const expected = Buffer.from(row.actionTokenHash, 'utf8')
  const provided = Buffer.from(hashActionToken(token), 'utf8')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

export function actionRoutes(deps: ActionRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    // Fastify ships parsers for application/json and text/plain ONLY — a real browser submitting
    // the confirm page's <form method="post"> sends application/x-www-form-urlencoded, which
    // 415'd (FST_ERR_CTP_INVALID_MEDIA_TYPE) before the route ever ran (found live on the first
    // Telegram-button tap) until this parser was added. Task 8: it now actually PARSES the body
    // into an object (`request.body`) instead of discarding it, because the reject route's reason
    // form needs `reason`/`action` off the wire. Approve still reads nothing from the body, so
    // this stays fully backward-compatible with it — an empty/absent body just parses to `{}`, the
    // same effective no-op the old discard-everything parser produced. Scoped to this plugin's
    // encapsulation context, like the webhook plugin's raw-body parser.
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req: unknown, body: unknown, done: (err: Error | null, body?: unknown) => void) => {
        try {
          const params = new URLSearchParams(body as string)
          done(null, Object.fromEntries(params.entries()))
        } catch (err) {
          done(err instanceof Error ? err : new Error('bad form body'), undefined)
        }
      },
    )
    async function lookup(proposalId: string): Promise<ProposalRow | undefined> {
      const [row] = await deps.db.select().from(proposals).where(eq(proposals.id, proposalId))
      return row
    }

    async function handleGet(decision: Decision, proposalId: string, token: string | undefined): Promise<string> {
      const row = await lookup(proposalId)
      if (isValidDecision(row, token)) {
        // Gate the reason form strictly on REJECT of a support-ticket-linked support_reply/refund
        // — the GET must not consume the single-use token (only the POST does), so this is a
        // read-only render off the already-validated row plus one extra read-only lookup.
        const isSupportReject =
          decision === 'reject' && (row.type === 'support_reply' || row.type === 'refund') && row.ticketId !== null
        let redraftCount = 0
        if (isSupportReject) {
          const [ticket] = await deps.db
            .select({ redraftCount: supportTickets.redraftCount })
            .from(supportTickets)
            .where(eq(supportTickets.id, row.ticketId!))
          redraftCount = ticket?.redraftCount ?? 0
        }
        // Use the DB-verified row's own id, not the raw request path param, so the form action
        // attribute can never be built from unvalidated user input.
        return confirmPage(row.id, decision, row.summary, token!, isSupportReject, redraftCount)
      }
      return friendlyPage()
    }

    async function handlePost(
      decision: Decision,
      proposalId: string,
      token: string | undefined,
      formBody: unknown,
    ): Promise<string> {
      const row = await lookup(proposalId)

      // Lazy expiry: a pending row past its expiresAt flips to 'expired' the moment someone
      // actually acts on it (POST), regardless of whether the token they carried was valid —
      // GET never does this (see actions.test.ts case 8). A concurrent racer who beat us to the
      // same transition just means someone else already handled it.
      if (row && row.status === 'pending' && !(row.expiresAt.getTime() > Date.now())) {
        try {
          await applyProposalTransition(deps.db, proposalId, 'pending', 'expired')
          await deps.db.insert(auditLog).values({
            actor: 'system',
            action: 'proposal.expired',
            entityType: 'proposal',
            entityId: proposalId,
            detail: { via: 'lazy-expiry' },
          })
        } catch (err) {
          if (!(err instanceof StaleProposalStatusError)) throw err
        }
        return friendlyPage()
      }

      if (!isValidDecision(row, token)) {
        return friendlyPage()
      }

      // §3 validator re-run (Task 18 review ruling — security gate, same as the admin surface):
      // there is no edit path on this one-click route, but the row can still have stopped being
      // safe to approve since it was drafted (its sibling refund got rejected out from under it,
      // say) — this must never transition on a failure. On success, `payloadToStore` becomes the
      // validator's own returned payload (for `support_reply`, the NFKC-normalized body — "what
      // was screened is what sends").
      let payloadToStore: unknown
      if (decision === 'approve' && (row.type === 'support_reply' || row.type === 'refund')) {
        const validation = await validateSupportProposalForApproval(deps.db, row, row.payload)
        if (!validation.ok) {
          return validationFailedPage(validation.code, validation.detail)
        }
        payloadToStore = validation.payload
      }

      const status = decision === 'approve' ? 'approved' : 'rejected'
      // `row.ticketId !== null` makes the `row.ticketId!` deref below sound and matches handleGet's
      // gate: a support proposal with a null ticketId falls through to the plain terminal reject
      // (onSupportProposalRejected early-returns on null ticketId) — same net behavior, just honest.
      const isSupportRejectDecision =
        decision === 'reject' && (row.type === 'support_reply' || row.type === 'refund') && row.ticketId !== null

      // Task 8: resolve the reject dispatch OUTSIDE the transaction, before any state changes. The
      // over-2000-char refusal must return here — before `applyProposalTransition` ever runs — so
      // it can never consume the single-use token or change any state (§ "SECURITY/EDGE" in the
      // brief: the token rides the query string and is only cleared by the transition below).
      let resolution: ReturnType<typeof resolveRejectAction> | undefined
      let reason = ''
      if (isSupportRejectDecision) {
        const body = (formBody ?? {}) as { reason?: string; action?: string }
        const rawReason = body.reason ?? ''
        if (rawReason.length > 2000) return reasonTooLongPage()
        reason = rawReason
        const [ticket] = await deps.db
          .select({ status: supportTickets.status, redraftCount: supportTickets.redraftCount })
          .from(supportTickets)
          .where(eq(supportTickets.id, row.ticketId!))
        resolution = resolveRejectAction({
          reason,
          action: body.action ?? 'escalate',
          redraftCount: ticket?.redraftCount ?? 0,
          ticketStatus: ticket?.status ?? '',
        })
      }

      try {
        if (isSupportRejectDecision) {
          // Atomic (Task 18 review, M5): same shape as the admin surface's decision route — the
          // reject transition, its own audit row, and everything the dispatch below does (sibling
          // expiry+audit, ticket re-arm or escalation) land in ONE transaction, mirroring
          // `apply-shared.ts`'s `failStaleAndHandBack` precedent. A throw anywhere inside rolls
          // EVERYTHING back, including the transition itself.
          await deps.db.transaction(async (tx) => {
            await applyProposalTransition(tx, proposalId, 'pending', status, {
              decidedBy: 'owner',
              decidedAt: new Date(),
              actionTokenHash: null,
            })
            await tx.insert(auditLog).values({
              actor: 'owner',
              action: 'proposal.reject',
              entityType: 'proposal',
              entityId: proposalId,
              detail: { via: 'link', resolution: resolution!.kind },
            })
            const r = { id: row.id, ticketId: row.ticketId, type: row.type }
            if (resolution!.kind === 'redraft') {
              // ATOMIC FALLBACK (Task 8 brief): a 0-row re-arm means the ticket left
              // `awaiting_approval` between our pre-tx read and this guarded UPDATE (a concurrent
              // tab, a second reject) — fall back to the terminal escalate in the SAME tx. Never
              // leave the proposal rejected + sibling expired with no ticket-side signal at all.
              const rearmed = await onSupportProposalRejectedForRedraft(tx, r, reason, () => new Date())
              if (!rearmed) await onSupportProposalRejected(tx, r)
            } else if (resolution!.kind === 'escalate_limit') {
              await onSupportProposalRejected(tx, r, {
                awaitingApprovalReason: 'redraft_limit_reached',
                awaitingApprovalNotify: true,
              })
            } else {
              await onSupportProposalRejected(tx, r)
            }
          })
        } else {
          await applyProposalTransition(deps.db, proposalId, 'pending', status, {
            decidedBy: 'owner',
            decidedAt: new Date(),
            actionTokenHash: null,
            ...(payloadToStore !== undefined ? { payload: payloadToStore } : {}),
          })
          await deps.db.insert(auditLog).values({
            actor: 'owner',
            action: decision === 'approve' ? 'proposal.approve' : 'proposal.reject',
            entityType: 'proposal',
            entityId: proposalId,
            detail: { via: 'link' },
          })
        }
      } catch (err) {
        // Someone else's request (or another tab, or a race) already decided this row between
        // our lookup and our guarded UPDATE — the single-use mechanism worked, just not for us.
        if (err instanceof StaleProposalStatusError) return friendlyPage()
        throw err
      }

      if (decision === 'approve') {
        try {
          await enqueueProposalApply(deps.enqueue, proposalId)
        } catch {
          // The transition above already committed — never un-approve on an enqueue failure,
          // just alert and tell the clicker where the fix lives (best-effort alert, same as
          // every other alert call site here: its own failure must never break the response).
          await deps.alert('critical', 'apply_enqueue_failed', { proposalId }).catch(() => {})
          return enqueueFailedPage()
        }
      }

      return resultPage(decision)
    }

    /**
     * Public, unauthenticated route: no input (a malformed `proposalId`, a future query-shape
     * change, whatever) may ever surface as anything but the same friendly page at 200. Without
     * this, e.g. a non-UUID `proposalId` reaches `lookup`'s `WHERE id = $1` and Postgres throws
     * "invalid input syntax for type uuid", which Fastify's default error handler turns into a
     * 500 whose body includes the raw query — a real leak on a link anyone can click. Every
     * unexpected error is reported via `alert` (best-effort — its own failure must never break
     * the response) and degrades to the exact same uniform page, so this can never become a
     * state oracle even under a code path nobody anticipated.
     */
    async function safeRender(
      proposalId: string,
      work: () => Promise<string>,
    ): Promise<string> {
      try {
        return await work()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await deps.alert('warning', 'action_route_error', { proposalId, error: message }).catch(() => {})
        return friendlyPage()
      }
    }

    for (const decision of ['approve', 'reject'] as const) {
      fastify.get(`/a/:proposalId/${decision}`, async (request, reply) => {
        const { proposalId } = request.params as { proposalId: string }
        const { t } = request.query as { t?: string }
        const body = await safeRender(proposalId, () => handleGet(decision, proposalId, t))
        return reply.code(200).type('text/html; charset=utf-8').send(body)
      })

      fastify.post(`/a/:proposalId/${decision}`, async (request, reply) => {
        const { proposalId } = request.params as { proposalId: string }
        const { t } = request.query as { t?: string }
        // Approve never reads the body — pass `undefined` so it can never accidentally observe a
        // form field, even if one were somehow present. Only reject's dispatch reads `reason`/`action`.
        const formBody = decision === 'reject' ? request.body : undefined
        const body = await safeRender(proposalId, () => handlePost(decision, proposalId, t, formBody))
        return reply.code(200).type('text/html; charset=utf-8').send(body)
      })
    }
  }
}
