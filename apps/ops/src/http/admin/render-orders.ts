import { html, type RawHtml } from './html.ts'

/**
 * One row of the /admin/orders view: a `supplier_orders` row joined to its parent `orders` row
 * (`supplierOrders.orderId = orders.id`). `id` is the `supplier_orders` row id — the value the
 * recovery form posts back as `:id` in `/admin/orders/:id/recover`, NOT the parent order's id.
 */
export interface OrderJoinRow {
  id: string
  shopifyOrderGid: string
  shopifyOrderNumber: string | null
  customerName: string | null
  supplier: string
  status: string
  lastError: string | null
  createdAt: Date
}

/**
 * The only three legal recovery targets from `needs_attention`, per the runbook this page
 * replaces — a strict subset of `applyTransition`'s full `needs_attention -> *` matrix (which
 * also allows `created`/`paid`). Exported so `routes.ts`'s POST handler validates against the
 * exact same list the `<select>` below offers, rather than a second copy drifting out of sync.
 */
export const RECOVERY_TARGETS = ['pending', 'confirmed', 'cancelled'] as const

function renderRecoveryForm(rowId: string): RawHtml {
  const action = `/admin/orders/${rowId}/recover`
  return html`<form method="post" action="${action}">
      <select name="target">
        ${RECOVERY_TARGETS.map((target) => html`<option value="${target}">${target}</option>`)}
      </select>
      <button type="submit">Recover</button>
    </form>`
}

/**
 * One <tr> per joined row. `lastError` is a raw supplier-adapter string (CJ error text, etc.) —
 * escaped like every other interpolation via html``, never trusted. The recovery form only
 * renders for the pinned (needs_attention) section; the lower section's rows pass `withForm:
 * false` since a non-needs_attention row has nothing to recover from.
 */
function renderOrderRow(r: OrderJoinRow, opts: { withForm: boolean }): RawHtml {
  return html`<tr>
    <td>${r.id}</td>
    <td>${r.shopifyOrderNumber ?? r.shopifyOrderGid}</td>
    <td>${r.customerName ?? ''}</td>
    <td>${r.supplier}</td>
    <td>${r.status}</td>
    <td>${r.lastError ?? ''}</td>
    <td>${r.createdAt.toISOString()}</td>
    <td>${opts.withForm ? renderRecoveryForm(r.id) : html``}</td>
  </tr>`
}

/**
 * Renders the `needs_attention` "pinned" section from an explicit row list rather than querying
 * the DB itself. This is a deliberate seam: Phase 7's canary-hold feature will fold additional
 * held rows (parked for reasons other than needs_attention) into the SAME list before calling
 * this function, so it stays the one render path for "rows an operator needs to look at" no
 * matter why a row landed there — do not have this function do its own DB read.
 */
export function renderNeedsAttentionSection(rows: OrderJoinRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<section>
      <h2>Needs attention</h2>
      <p>None.</p>
    </section>`
  }
  return html`<section>
    <h2>Needs attention</h2>
    <table>
      <tbody>
        ${rows.map((r) => renderOrderRow(r, { withForm: true }))}
      </tbody>
    </table>
  </section>`
}

/** Renders every other order row (any status but needs_attention), no recovery form. */
export function renderOtherOrdersSection(rows: OrderJoinRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<section>
      <h2>Other orders</h2>
      <p>None.</p>
    </section>`
  }
  return html`<section>
    <h2>Other orders</h2>
    <table>
      <tbody>
        ${rows.map((r) => renderOrderRow(r, { withForm: false }))}
      </tbody>
    </table>
  </section>`
}
