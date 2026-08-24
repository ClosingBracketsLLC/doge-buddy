import { formatCents, type NewListingPayload } from '@doge-buddy/core'
import type { proposals } from '@doge-buddy/db'
import { html, type RawHtml } from './html.ts'

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
 * `new_listing`'s typed "listing preview with images": title, category, delivery window, one
 * <img> per imageUrl (src escaped like any other interpolation), and a SKU/price/cost table
 * (formatCents for both money columns). `payload` is cast, not zod-parsed — a proposal that made
 * it into the DB already passed PAYLOAD_SCHEMAS at submit time, and this renderer's job is
 * display, not re-validation.
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
 * Approve / reject / edit-then-approve forms, rendered only for pending rows. All three post to
 * the Task 4 session-authed decision routes (`/admin/proposals/:id/approve|reject`); the
 * edit-then-approve textarea is prefilled with the current payload as pretty JSON — escaped by
 * html`` like any other interpolation, so a hostile payload value can't break out of the
 * <textarea> (e.g. via a literal `</textarea>` in a string field).
 */
function renderDecisionForms(p: ProposalRow): RawHtml {
  const approveAction = `/admin/proposals/${p.id}/approve`
  const rejectAction = `/admin/proposals/${p.id}/reject`
  const prefill = JSON.stringify(p.payload, null, 2)
  return html`<form method="post" action="${approveAction}">
      <button type="submit">Approve</button>
    </form>
    <form method="post" action="${rejectAction}">
      <button type="submit">Reject</button>
    </form>
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

export function renderProposalDetail(p: ProposalRow): RawHtml {
  const preview =
    p.type === 'new_listing' ? renderNewListingPreview(p.payload as NewListingPayload) : renderGenericPayload(p.payload)

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
