import { chip, html, relativeTime, type RawHtml } from './html.ts'

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
  return html`<form class="actions" method="post" action="${action}" data-confirm="Recover this order to the selected state?">
      <select name="target">
        ${RECOVERY_TARGETS.map((target) => html`<option value="${target}">${target}</option>`)}
      </select>
      <button type="submit" class="primary">Recover</button>
    </form>`
}

/** Shared `<thead>` for both sections below — same column set, pinned/other differ only in
 * whether each row carries a recovery form. */
const ORDERS_TABLE_HEAD = html`<thead><tr><th>Id</th><th>Order</th><th>Customer</th><th>Supplier</th><th>Status</th><th>Last error</th><th>Created</th><th>Action</th></tr></thead>`

/**
 * One <tr> per joined row. `lastError` is a raw supplier-adapter string (CJ error text, etc.) —
 * escaped like every other interpolation via html``, never trusted. The recovery form only
 * renders for the pinned (needs_attention) section; the lower section's rows pass `withForm:
 * false` since a non-needs_attention row has nothing to recover from.
 */
function renderOrderRow(r: OrderJoinRow, opts: { withForm: boolean }): RawHtml {
  return html`<tr>
    <td data-label="Id" class="mono">${r.id}</td>
    <td data-label="Order">${r.shopifyOrderNumber ?? r.shopifyOrderGid}</td>
    <td data-label="Customer">${r.customerName ?? ''}</td>
    <td data-label="Supplier">${r.supplier}</td>
    <td data-label="Status">${chip(r.status)}</td>
    <td data-label="Last error" class="wrap">${r.lastError ?? ''}</td>
    <td data-label="Created"><span title="${r.createdAt.toISOString()}">${relativeTime(r.createdAt)}</span></td>
    <td data-label="Action">${opts.withForm ? renderRecoveryForm(r.id) : html``}</td>
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
    <div class="table-wrap"><table class="rows">
      ${ORDERS_TABLE_HEAD}
      <tbody>
        ${rows.map((r) => renderOrderRow(r, { withForm: true }))}
      </tbody>
    </table></div>
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
    <div class="table-wrap"><table class="rows">
      ${ORDERS_TABLE_HEAD}
      <tbody>
        ${rows.map((r) => renderOrderRow(r, { withForm: false }))}
      </tbody>
    </table></div>
  </section>`
}
