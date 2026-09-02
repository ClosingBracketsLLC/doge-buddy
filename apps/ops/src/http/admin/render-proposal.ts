import {
  formatCents,
  type DeprecateProductPayload,
  type NewListingPayload,
  type RefundPayload,
  type SupportReplyPayload,
} from '@doge-buddy/core'
import type { proposals } from '@doge-buddy/db'
import { validateDescriptionHtml } from '../../sourcing/guards.ts'
import { SUPPORT_REDRAFT_MAX } from '../../support/redraft.ts'
import { chip, html, kv, raw, relativeTime, type RawHtml } from './html.ts'

export type ProposalRow = typeof proposals.$inferSelect
export type ProposalListRow = Pick<ProposalRow, 'id' | 'type' | 'status' | 'summary' | 'createdAt' | 'expiresAt'>

/**
 * One <tr> per proposal for the /admin/proposals queue table: the id links to the detail page,
 * then type/status/summary/created/expires — every field auto-escaped via html``.
 */
export function renderProposalRow(p: ProposalListRow): RawHtml {
  return html`<tr>
    <td data-label="Id" class="mono"><a href="/admin/proposals/${p.id}">${p.id}</a></td>
    <td data-label="Type">${p.type}</td>
    <td data-label="Status">${chip(p.status)}</td>
    <td data-label="Summary" class="wrap">${p.summary}</td>
    <td data-label="Created"><span title="${p.createdAt.toISOString()}">${relativeTime(p.createdAt)}</span></td>
    <td data-label="Expires"><span title="${p.expiresAt.toISOString()}">${relativeTime(p.expiresAt)}</span></td>
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
 *
 * Task 4b: `highlights`/`specs`/`whatsInBox` (all optional on `NewListingPayload`, added for the
 * v2 product page) render after the description — the approver is the only human gate before
 * agent-authored page copy goes live, so it must see this text too, not just title/category/
 * images/prices/description. Every value goes through html``'s default escaping like everything
 * else in this file (never `raw()` — that's reserved for `renderDescriptionSection`'s
 * allowlist-revalidated path). Each section is conditional on the field being present and
 * non-empty so a legacy payload without them renders exactly as before — no empty `<h3>` or
 * dangling "What's in the box:" line.
 */
function renderNewListingPreview(payload: NewListingPayload): RawHtml {
  return html`<section>
    <h2>${payload.title}</h2>
    <p>Category: ${payload.categoryTag}</p>
    <p>Delivery: ${payload.deliveryMinDays}-${payload.deliveryMaxDays} days</p>
    <div class="listing-images">${payload.imageUrls.map((url) => html`<img src="${url}">`)}</div>
    <div class="table-wrap"><table class="rows">
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
            <td data-label="SKU">${v.sku}</td>
            <td data-label="Price">${formatCents(v.priceCents)}</td>
            <td data-label="Supplier cost">${formatCents(v.supplierCostCents)}</td>
          </tr>`,
        )}
      </tbody>
    </table></div>
    ${renderDescriptionSection(payload.descriptionHtml)}
    ${payload.highlights?.length ? html`<h3>Highlights</h3><ul>${payload.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : html``}
    ${payload.specs?.length
      ? html`<h3>Specs</h3><div class="table-wrap"><table class="rows"><tbody>${payload.specs.map(
          (s) => html`<tr><th>${s.label}</th><td>${s.value}</td></tr>`,
        )}</tbody></table></div>`
      : html``}
    ${payload.whatsInBox ? html`<p><strong>What's in the box:</strong> ${payload.whatsInBox}</p>` : html``}
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
  /** The `products.title` for a `deprecate_product` proposal's `productId`, when the product row
   * still exists — null/undefined falls back to showing the bare productId. */
  productTitle?: string | null
  /** The linked ticket's current `redraft_count` (Task 9) — used by `renderDecisionForms`'s reject
   * form to gate the "Re-draft" button (`redraftCount < SUPPORT_REDRAFT_MAX`), the same gate the
   * public `/a/` route's confirm page already applies. Loaded for `support_reply`/`refund` only;
   * absent (undefined) defaults to 0 — no ticket linked means no redraft cycle to be at the limit
   * of. */
  redraftCount?: number
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
 * `deprecate_product`'s human summary (Task 11 scoring): the product (title when known off
 * `extras.productTitle`, else the bare `productId` — no `/admin/products/:id` route exists yet
 * to link to) plus the raw evidence numbers the scoring job persisted (units/refunds/tickets
 * over the trailing 28 days, days live) and the judge/deterministic `reasoning` string.
 * Deliberately NOT a computed refund *rate*: the payload only carries a refund *count*, not the
 * order count a rate would need, so rendering one here would just be a fabricated number — the
 * raw counts are exactly what the payload can support. Like `renderRefundSummary`, deliberately
 * NO edit form: see `renderDecisionForms`'s `deprecate_product` branch.
 */
function renderDeprecateProductSummary(payload: unknown, extras: ProposalDetailExtras): RawHtml {
  const p = payload as Partial<DeprecateProductPayload>
  const evidence = p.evidence ?? ({} as Partial<DeprecateProductPayload['evidence']>)
  const productLabel = extras.productTitle ?? p.productId ?? 'unknown'
  return html`<section>
    <h3>Deprecation evidence</h3>
    <p>Product: ${productLabel} (${p.productId ?? ''})</p>
    <p>Units sold (28d): ${evidence.unitsSold28d ?? 0}</p>
    <p>Refunds (28d): ${evidence.refundCount28d ?? 0}</p>
    <p>Tickets (28d): ${evidence.ticketCount28d ?? 0}</p>
    <p>Days live: ${evidence.daysLive ?? 0}</p>
    <p>Reasoning: ${evidence.reasoning ?? ''}</p>
  </section>`
}

/**
 * The reject form's own contents (Task 9, mirroring `actions.ts`'s `confirmPage` — same copy, same
 * gating, so the admin surface and the public `/a/` one-click surface never diverge in behavior).
 * For `support_reply`/`refund` this is a reason `<textarea>` (posted as `reason`, capped at 2000
 * chars client-side via `maxlength` — the route itself is the real 2000-char gate) plus TWO submit
 * buttons sharing `name="action"`: `value="redraft"` (gated on `redraftCount < SUPPORT_REDRAFT_MAX`
 * — once the ticket has already been redrafted the max number of times, the button is replaced by
 * plain copy saying so, same as the public confirm page) and `value="escalate"`. Every other type
 * (including `deprecate_product`, which has no ticket to redraft against) keeps today's plain
 * single-button reject form — and so does a `support_reply`/`refund` proposal whose `ticketId` is
 * null (Task 9 fix round 1): `actions.ts`'s `handleGet` gates its own reason form on
 * `row.ticketId !== null` (there's no ticket to re-draft against without one), and the POST-side
 * dispatch here already mirrors that by treating a null `ticketId` as a plain reject (see
 * `onSupportProposalRejected`'s own early-return) — this GET-side gate must match it exactly, or
 * the two surfaces would show different forms for the exact same row.
 */
function renderRejectForm(p: ProposalRow, rejectAction: string, redraftCount: number): RawHtml {
  const isSupportReject = (p.type === 'support_reply' || p.type === 'refund') && p.ticketId !== null
  if (!isSupportReject) {
    return html`<form method="post" action="${rejectAction}">
      <button type="submit">Reject</button>
    </form>`
  }

  const canRedraft = redraftCount < SUPPORT_REDRAFT_MAX
  return html`<form method="post" action="${rejectAction}">
    <p><label>Reason for the agent (optional — leave blank to escalate to you):<br>
      <textarea name="reason" rows="6" cols="70" maxlength="2000"></textarea></label></p>
    ${canRedraft
      ? html`<button type="submit" name="action" value="redraft" class="danger">Re-draft with this reason</button> `
      : html`<p>Re-drafted ${SUPPORT_REDRAFT_MAX}× already — rejecting again escalates to you.</p>`}
    <button type="submit" name="action" value="escalate" class="danger">Just escalate to me</button>
  </form>`
}

/**
 * Approve / reject / edit-then-approve forms, rendered only for pending rows. All three post to
 * the Task 4 session-authed decision routes (`/admin/proposals/:id/approve|reject`).
 *
 * `redraftCount` (Task 9) — the linked ticket's current redraft count, loaded by the route's
 * `loadProposalDetailExtras` and defaulted to 0 here when absent (no ticket linked, or a proposal
 * type `loadProposalDetailExtras` doesn't bother loading it for) — threaded through only to
 * `renderRejectForm`'s redraft-button gate; every other form in this function ignores it.
 *
 * Task 18 splits the edit-then-approve form by type instead of one shape for every type:
 *  - `refund`: NO edit form at all — approve/reject buttons only (a refund amount/order is not
 *    something to hand-edit from a textarea; see `renderRefundSummary`'s own doc comment).
 *  - `deprecate_product` (Task 11 scoring): same as `refund` — NO edit form. The payload is
 *    scoring-computed evidence (unit/refund/ticket counts, days live, reasoning), not something
 *    an owner should hand-edit from a raw-JSON textarea; see `renderDeprecateProductSummary`.
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
function renderDecisionForms(p: ProposalRow, redraftCount = 0): RawHtml {
  const approveAction = `/admin/proposals/${p.id}/approve`
  const rejectAction = `/admin/proposals/${p.id}/reject`
  const approveReject = html`<div class="actions sticky">
    <form method="post" action="${approveAction}" data-confirm="Approve this proposal?">
      <button type="submit" class="primary">Approve</button>
    </form>
    ${renderRejectForm(p, rejectAction, redraftCount)}
  </div>`

  if (p.type === 'refund') {
    return approveReject
  }

  if (p.type === 'deprecate_product') {
    return approveReject
  }

  if (p.type === 'support_reply') {
    const currentBody = (p.payload as Partial<SupportReplyPayload>).body ?? ''
    return html`${approveReject}
    <form method="post" action="${approveAction}" data-confirm="Approve the EDITED payload?">
      <p>Edit body then approve:</p>
      <textarea name="body" rows="16" cols="80">${currentBody}</textarea>
      <button type="submit">Approve edited</button>
    </form>`
  }

  const prefill = JSON.stringify(p.payload, null, 2)
  return html`${approveReject}
    <form method="post" action="${approveAction}" data-confirm="Approve the EDITED payload?">
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
  return html`<form method="post" action="${action}" data-confirm="Re-send the apply job?">
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
          : p.type === 'deprecate_product'
            ? renderDeprecateProductSummary(p.payload, extras)
            : renderGenericPayload(p.payload)

  const actions =
    p.status === 'pending'
      ? renderDecisionForms(p, extras.redraftCount ?? 0)
      : p.status === 'approved'
        ? renderResendForm(p)
        : html``

  const header = html`<div class="card">
    ${kv('Type', p.type)}
    ${kv('Status', chip(p.status))}
    ${kv('Summary', p.summary)}
    ${kv('Created', html`<span title="${p.createdAt.toISOString()}">${relativeTime(p.createdAt)}</span>`)}
    ${kv('Expires', html`<span title="${p.expiresAt.toISOString()}">${relativeTime(p.expiresAt)}</span>`)}
  </div>`

  return html`<h1>Proposal ${p.id}</h1>
    ${header}
    ${preview} ${actions}`
}
