import { formatCents, type NewListingPayload, type RefundPayload, type SupportReplyPayload } from '@doge-buddy/core'
import type { proposals } from '@doge-buddy/db'
import { validateDescriptionHtml } from '../../sourcing/guards.ts'
import { html, raw, type RawHtml } from './html.ts'

export type ProposalRow = typeof proposals.$inferSelect
export type ProposalListRow = Pick<ProposalRow, 'id' | 'type' | 'status' | 'summary' | 'createdAt' | 'expiresAt'>

/**
 * One <tr> per proposal for the /admin/proposals queue table: the id links to the detail page,
 * then type/status/summary/created/expires — every field auto-escaped via html``.
 */
export function renderProposalRow(p: ProposalListRow): RawHtml {
  return html`<tr>
    <td><a href="/admin/proposals/${p.id}">${p.id}</a></td>
    <td>${p.type}</td>
    <td>${p.status}</td>
    <td>${p.summary}</td>
    <td>${p.createdAt.toISOString()}</td>
    <td>${p.expiresAt.toISOString()}</td>
  </tr>`
}

/**
 * "Description (as it will appear)" section (Task 15). `descriptionHtml` is stored on the
 * proposal payload but, until now, was never rendered anywhere for an approver to see before
 * approval — this is the first surface that shows what will actually go live. SECURITY:
 * `validateDescriptionHtml` (Task 6's tag/attribute allowlist) is RE-RUN here, at render time,
 * rather than trusted from submit time — a manual/Phase-4-era proposal never passed it at submit
 * at all. Only when it validates (`=== null`) does this reach `raw()`; that re-validation is what
 * keeps `raw()` unreachable for anything the allowlist wouldn't pass. This is the ONLY new
 * `raw()` call in this file (or anywhere in this task) — an invalid descriptionHtml (including an
 * outright `<script>` injection) falls back to `esc()`-by-default inside a `<pre>` (the plain
 * string interpolation below), with a visible failure note.
 */
function renderDescriptionSection(descriptionHtml: string): RawHtml {
  const invalidReason = validateDescriptionHtml(descriptionHtml)
  if (invalidReason === null) {
    return html`<section id="description-preview">
      <h3>Description (as it will appear)</h3>
      <div class="description-html">${raw(descriptionHtml)}</div>
    </section>`
  }
  return html`<section id="description-preview">
    <h3>Description (as it will appear)</h3>
    <p style="color:red">failed HTML validation — showing source</p>
    <pre>${descriptionHtml}</pre>
  </section>`
}

/**
 * `new_listing`'s typed "listing preview with images": title, category, delivery window, one
 * <img> per imageUrl (src escaped like any other interpolation), a SKU/price/cost table
 * (formatCents for both money columns), and the description preview above. `payload` is cast, not
 * zod-parsed — a proposal that made it into the DB already passed PAYLOAD_SCHEMAS at submit time,
 * and this renderer's job is display, not re-validation (descriptionHtml is the one exception,
 * per renderDescriptionSection's own doc comment).
 */
function renderNewListingPreview(payload: NewListingPayload): RawHtml {
  return html`<section>
    <h2>${payload.title}</h2>
    <p>Category: ${payload.categoryTag}</p>
    <p>Delivery: ${payload.deliveryMinDays}-${payload.deliveryMaxDays} days</p>
    <div class="listing-images">${payload.imageUrls.map((url) => html`<img src="${url}">`)}</div>
    <table>
      <thead>
        <tr>
          <th>SKU</th>
          <th>Price</th>
          <th>Supplier cost</th>
        </tr>
      </thead>
      <tbody>
        ${payload.variants.map(
          (v) => html`<tr>
            <td>${v.sku}</td>
            <td>${formatCents(v.priceCents)}</td>
            <td>${formatCents(v.supplierCostCents)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${renderDescriptionSection(payload.descriptionHtml)}
  </section>`
}

/**
 * Every other proposal type: a <dl> of the payload's own top-level keys, each value run through
 * JSON.stringify (so nested objects/arrays render as readable text) and escaped like everything
 * else html`` touches.
 */
function renderGenericPayload(payload: unknown): RawHtml {
  const entries = Object.entries((payload ?? {}) as Record<string, unknown>)
  return html`<dl>
    ${entries.map(([key, value]) => html`<dt>${key}</dt>
      <dd>${JSON.stringify(value)}</dd>`)}
  </dl>`
}

/**
 * `support_reply`'s preview (Task 18): the draft body exactly as it will send, escaped (html``'s
 * default) inside a `pre-wrap` block so long lines wrap instead of forcing horizontal scroll, but
 * whitespace/newlines are preserved — a customer-controlled `<script>` in the body renders as
 * inert `&lt;script&gt;` text, never live markup.
 */
function renderSupportReplyPreview(payload: unknown): RawHtml {
  const body = (payload as Partial<SupportReplyPayload>).body ?? ''
  return html`<section>
    <h3>Reply body (as it will send)</h3>
    <pre style="white-space:pre-wrap">${body}</pre>
  </section>`
}

/** Extra, DB-derived context `renderRefundSummary` needs that isn't on the bare payload/row —
 * loaded once by the route (`routes.ts`'s `loadProposalDetailExtras`) and threaded through rather
 * than queried here, keeping this file's renderers themselves DB-free like every other one in it. */
export interface ProposalDetailExtras {
  /** The linked order's `shopify_order_number`, or null if unknown/order missing. */
  orderNumber?: string | null
  /** The proposal's own `ticket_id` — used to link the order summary to the ticket thread. */
  ticketId?: string | null
  /** Cheap sender-authentication note for the ticket's latest inbound message, or null when not
   * cheaply available (no ticket linked). */
  authNote?: string | null
  /** The `refundId` off a `proposal.refund_issued` audit row, when one exists (Task 16 note) —
   * present exactly when money actually moved, regardless of the proposal's current status. */
  refundIssuedId?: string | null
}

/**
 * `refund`'s human summary (Task 18): amount, an order-number link to the ticket thread, reason,
 * dispute flag, and — when cheaply available — the sender-auth note. Deliberately NO edit form (a
 * refund amount/order is not something to hand-edit from a textarea): approve/reject only.
 */
function renderRefundSummary(payload: unknown, extras: ProposalDetailExtras): RawHtml {
  const p = payload as Partial<RefundPayload>
  const orderLabel = `#${extras.orderNumber ?? 'unknown'}`
  return html`<section>
    <h3>Refund summary</h3>
    <p>Amount: ${formatCents(p.amountCents ?? 0)}</p>
    <p>Order: ${extras.ticketId ? html`<a href="/admin/tickets/${extras.ticketId}">${orderLabel}</a>` : orderLabel}</p>
    <p>Reason: ${p.reason ?? ''}</p>
    <p>CJ dispute: ${p.openCjDispute ? 'yes' : 'no'}</p>
    ${extras.authNote ? html`<p>${extras.authNote}</p>` : html``}
    ${extras.refundIssuedId ? html`<p>refund WAS issued: ${extras.refundIssuedId}</p>` : html``}
  </section>`
}

/**
 * Approve / reject / edit-then-approve forms, rendered only for pending rows. All three post to
 * the Task 4 session-authed decision routes (`/admin/proposals/:id/approve|reject`).
 *
 * Task 18 splits the edit-then-approve form by type instead of one shape for every type:
 *  - `refund`: NO edit form at all — approve/reject buttons only (a refund amount/order is not
 *    something to hand-edit from a textarea; see `renderRefundSummary`'s own doc comment).
 *  - `support_reply`: the raw-JSON `payload` textarea is SUPPRESSED — a body-only `body` textarea
 *    replaces it (form field name `body`), so an owner editing a reply can only ever touch the
 *    text that will send, never smuggle a different `ticketId`/`threadSnapshotAt` through the edit
 *    path. This is also what keeps `validateSupportProposalForApproval` (Task 18's §3 gate)
 *    reachable on every edit: the route always reconstructs `{ ...storedPayload, body }` from a
 *    known-good base rather than trusting arbitrary edited JSON.
 *  - every other type: unchanged raw-JSON `payload` textarea, prefilled with the current payload
 *    as pretty JSON — escaped by html`` like any other interpolation, so a hostile payload value
 *    can't break out of the <textarea> (e.g. via a literal `</textarea>` in a string field).
 */
function renderDecisionForms(p: ProposalRow): RawHtml {
  const approveAction = `/admin/proposals/${p.id}/approve`
  const rejectAction = `/admin/proposals/${p.id}/reject`
  const approveReject = html`<form method="post" action="${approveAction}">
      <button type="submit">Approve</button>
    </form>
    <form method="post" action="${rejectAction}">
      <button type="submit">Reject</button>
    </form>`

  if (p.type === 'refund') {
    return approveReject
  }

  if (p.type === 'support_reply') {
    const currentBody = (p.payload as Partial<SupportReplyPayload>).body ?? ''
    return html`${approveReject}
    <form method="post" action="${approveAction}">
      <p>Edit body then approve:</p>
      <textarea name="body" rows="16" cols="80">${currentBody}</textarea>
      <button type="submit">Approve edited</button>
    </form>`
  }

  const prefill = JSON.stringify(p.payload, null, 2)
  return html`${approveReject}
    <form method="post" action="${approveAction}">
      <p>Edit then approve:</p>
      <textarea name="payload" rows="16" cols="80">${prefill}</textarea>
      <button type="submit">Approve edited</button>
    </form>`
}

/**
 * The Item 1c recovery form: shown ONLY for `status === 'approved'` (never
 * pending/applying/applied/failed/rejected/expired) — posts to the idempotent
 * `/admin/proposals/:id/resend-apply` route, which re-enqueues `proposal.apply` for a row that
 * committed to 'approved' but whose original enqueue failed (or as a manual nudge if an operator
 * just wants to be sure). Safe to click more than once: `enqueueProposalApply`'s `singletonKey`
 * dedupes an already-queued job, and `executeApplyProposal`'s status dispatch makes re-entering
 * an already-`applying`/`applied` row a no-op rather than a double-apply.
 */
function renderResendForm(p: ProposalRow): RawHtml {
  const action = `/admin/proposals/${p.id}/resend-apply`
  return html`<form method="post" action="${action}">
    <button type="submit">Re-send apply</button>
  </form>`
}

export function renderProposalDetail(p: ProposalRow, extras: ProposalDetailExtras = {}): RawHtml {
  const preview =
    p.type === 'new_listing'
      ? renderNewListingPreview(p.payload as NewListingPayload)
      : p.type === 'support_reply'
        ? renderSupportReplyPreview(p.payload)
        : p.type === 'refund'
          ? renderRefundSummary(p.payload, extras)
          : renderGenericPayload(p.payload)

  const actions =
    p.status === 'pending' ? renderDecisionForms(p) : p.status === 'approved' ? renderResendForm(p) : html``

  return html`<h1>Proposal ${p.id}</h1>
    <p>Type: ${p.type}</p>
    <p>Status: ${p.status}</p>
    <p>Summary: ${p.summary}</p>
    <p>Created: ${p.createdAt.toISOString()}</p>
    <p>Expires: ${p.expiresAt.toISOString()}</p>
    ${preview} ${actions}`
}
