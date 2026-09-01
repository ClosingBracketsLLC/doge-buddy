import { formatCents } from '@doge-buddy/core'
import { ticketStatus } from '@doge-buddy/db'
import type { agentRuns, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { chip, html, raw, relativeTime, type RawHtml } from './html.ts'

/** One `.kv` row — same markup shape as render-dashboard.ts's own local `kv` helper (each
 * renderer keeps its own small copy rather than sharing one). */
function kv(label: string, value: RawHtml | string): RawHtml {
  return html`<div class="kv"><span>${label}</span><span class="v">${value}</span></div>`
}

export type TicketRow = typeof supportTickets.$inferSelect
export type MessageRow = typeof supportMessages.$inferSelect

/** One row of this ticket's own proposal history (Task 19) — the columns the thread view's
 * proposals section needs, loaded by the route's own query (`routes.ts`'s
 * `proposals WHERE ticket_id = $id ORDER BY created_at DESC`). */
export type TicketProposalRow = Pick<typeof proposals.$inferSelect, 'id' | 'type' | 'status' | 'summary' | 'createdAt'>

/** One row of this ticket's own support-agent run history (Task 19) — `routes.ts`'s own query
 * already filters to `workflow = 'support' AND trigger_ref = $ticketId`, newest first, capped at 5. */
export type TicketAgentRunRow = Pick<typeof agentRuns.$inferSelect, 'id' | 'status' | 'startedAt'>

/** Every legal `support_tickets.status` value, source-of-truth from the DB enum (mirrors
 * routes.ts's own `PROPOSAL_STATUSES = proposalStatus.enumValues` idiom). */
export const TICKET_STATUSES = ticketStatus.enumValues

/**
 * One /admin/tickets list row: the `support_tickets` columns the table needs plus the parent
 * order's `shopify_order_number` (left-joined — `null` when `orderId` is null OR the joined
 * order row has no number of its own). `id` links to the thread view.
 */
export interface TicketListRow {
  id: string
  status: string
  category: string | null
  sentiment: string | null
  customerEmail: string | null
  subject: string | null
  orderId: string | null
  linkedOrderNumber: string | null
  claimedOrderNumber: string | null
  lastInboundAt: Date | null
  createdAt: Date
  source: string
}

/** The linked order's summary shown on the thread view — a small projection of `orders`, not the
 * full row (this page shows a summary, not a second copy of /admin/orders). */
export interface LinkedOrderSummary {
  shopifyOrderGid: string
  shopifyOrderNumber: string | null
  customerName: string | null
  email: string | null
  financialStatus: string | null
  fulfillmentStatus: string | null
  totalCents: number | null
}

/** `?status=` filter chips: every real ticket status, plus a `spam` chip whose underlying filter
 * is `is_spam = true` (spam rows are always `resolved` per triage.ts, so no separate status value
 * is needed for it) — the chip list `routes.ts`'s GET handler validates against. */
export const TICKET_FILTER_CHIPS = ['all', ...TICKET_STATUSES, 'spam'] as const

function renderStatusChips(current: string | undefined): RawHtml {
  const active = current && (TICKET_FILTER_CHIPS as readonly string[]).includes(current) ? current : 'all'
  return html`<nav class="chips" id="ticket-filters">
    ${TICKET_FILTER_CHIPS.map((chipName) => {
      const href = chipName === 'all' ? '/admin/tickets' : `/admin/tickets?status=${chipName}`
      return html`<a href="${raw(href)}"${raw(chipName === active ? ' aria-current="page"' : '')}>${chipName}</a>`
    })}
  </nav>`
}

/** "linked order (verified)" beats "claimed order number (unverified)": a row only ever has one
 * of the two set (triage.ts's `resolveOrderLink` never sets both), but the verified case is
 * checked first regardless so a data anomaly can't silently show the weaker unverified claim. */
function renderOrderCell(row: Pick<TicketListRow, 'orderId' | 'linkedOrderNumber' | 'claimedOrderNumber'>): RawHtml {
  if (row.orderId) {
    return html`${row.linkedOrderNumber ?? row.orderId}`
  }
  if (row.claimedOrderNumber) {
    return html`claimed #${row.claimedOrderNumber} (unverified)`
  }
  return html`—`
}

function renderTicketRow(row: TicketListRow): RawHtml {
  const lastContact = row.lastInboundAt ?? row.createdAt
  return html`<tr>
    <td data-label="Status">${chip(row.status)}</td>
    <td data-label="Category">${row.category ?? '—'}</td>
    <td data-label="Sentiment">${row.sentiment ?? '—'}</td>
    <td data-label="Customer">${row.customerEmail ?? '—'}</td>
    <td data-label="Subject" class="wrap">${row.source === 'form' ? html`<span class="badge">via contact form</span> ` : html``}<a href="/admin/tickets/${row.id}">${row.subject ?? '(no subject)'}</a></td>
    <td data-label="Order">${renderOrderCell(row)}</td>
    <td data-label="Last contact"><span title="${lastContact.toISOString()}">${relativeTime(lastContact)}</span></td>
  </tr>`
}

/**
 * The /admin/tickets list body: filter chips followed by the table (or an empty state). Ordering
 * (escalated pinned first, then `last_inbound_at` desc) is done by the caller's SQL — this
 * function only renders whatever row order it's handed, same seam as render-orders.ts's pinned
 * section functions.
 */
export function renderTicketsList(rows: TicketListRow[], currentStatus: string | undefined): RawHtml {
  const chips = renderStatusChips(currentStatus)
  if (rows.length === 0) {
    return html`${chips}<p>No tickets.</p>`
  }
  return html`${chips}<div class="table-wrap"><table class="rows">
    <thead><tr><th>Status</th><th>Category</th><th>Sentiment</th><th>Customer</th><th>Subject</th><th>Order</th><th>Last contact</th></tr></thead>
    <tbody>
      ${rows.map(renderTicketRow)}
    </tbody>
  </table></div>`
}

/**
 * One message bubble: direction-styled via a CSS class (`message-inbound` / `message-outbound`,
 * both fixed enum values — safe to interpolate even though html`` would escape them anyway), and
 * the body rendered as PLAIN TEXT with `white-space: pre-wrap` — never as HTML. `bodyText` is a
 * customer-controlled string straight from Gmail; there is no rich-text path for it anywhere in
 * this admin surface.
 */
function renderMessage(m: MessageRow): RawHtml {
  const when = m.sentAt ?? m.createdAt
  return html`<div class="message message-${m.direction}">
    <p><strong>${m.direction}</strong> ${m.fromEmail ?? '—'} — ${when.toISOString()}</p>
    <div style="white-space: pre-wrap">${m.bodyText ?? ''}</div>
  </div>`
}

function renderVerdictBlock(t: TicketRow): RawHtml {
  return html`<section id="triage-verdict">
    <h3>Triage</h3>
    <p>Category: ${t.category ?? '—'}</p>
    <p>Sentiment: ${t.sentiment ?? '—'}</p>
    <p>Spam: ${t.isSpam === null ? '—' : t.isSpam ? 'yes' : 'no'}</p>
    <p>Escalation reason: ${t.escalationReason ?? '—'}</p>
    <p>Last triaged: ${t.lastTriagedAt ? t.lastTriagedAt.toISOString() : '—'}</p>
    <p>Triage failures: ${t.triageFailureCount}</p>
  </section>`
}

/**
 * Verified linked order (a small summary, not the full /admin/orders row) beats an unverified
 * claimed number, beats "no order mentioned at all" — same three-way precedence as
 * `renderOrderCell` above, spelled out again here since the thread view has room to show more
 * than just the order number.
 */
function renderLinkedOrderSection(order: LinkedOrderSummary | null, claimedOrderNumber: string | null): RawHtml {
  if (order) {
    return html`<section id="linked-order">
      <h3>Linked order</h3>
      <p>Order: ${order.shopifyOrderNumber ?? order.shopifyOrderGid}</p>
      <p>Customer: ${order.customerName ?? '—'} (${order.email ?? '—'})</p>
      <p>Status: ${order.financialStatus ?? '—'} / ${order.fulfillmentStatus ?? '—'}</p>
      <p>Total: ${order.totalCents === null ? '—' : formatCents(order.totalCents)}</p>
    </section>`
  }
  if (claimedOrderNumber) {
    return html`<section id="linked-order">
      <h3>Linked order</h3>
      <p>claimed #${claimedOrderNumber} (unverified)</p>
    </section>`
  }
  return html`<section id="linked-order">
    <h3>Linked order</h3>
    <p>None.</p>
  </section>`
}

/**
 * Escalate / Resolve — both POST to routes.ts's guarded-transition handlers, carrying the
 * status THIS PAGE RENDERED as a hidden `expectedStatus` field (the guard is
 * `WHERE id = ? AND status = expectedStatus`, so a stale tab's click 0-row-matches and no-ops
 * instead of clobbering whatever a different writer already changed the row to). Each form only
 * renders when it would actually change something — no "Escalate" button on an already-escalated
 * ticket, no "Resolve" on an already-resolved one — so a fresh page load never offers a
 * guaranteed-stale action.
 */
function renderActionForms(t: TicketRow): RawHtml {
  const escalate =
    t.status === 'escalated'
      ? html``
      : html`<form method="post" action="/admin/tickets/${t.id}/escalate" data-confirm="Escalate this ticket?">
          <input type="hidden" name="expectedStatus" value="${t.status}">
          <button type="submit" class="danger">Escalate</button>
        </form>`
  const resolve =
    t.status === 'resolved'
      ? html``
      : html`<form method="post" action="/admin/tickets/${t.id}/resolve" data-confirm="Resolve this ticket?">
          <input type="hidden" name="expectedStatus" value="${t.status}">
          <button type="submit" class="primary">Resolve</button>
        </form>`
  return html`<div class="actions sticky">${escalate}${resolve}</div>`
}

/**
 * Task 19: this ticket's own support-proposal history — id (linked to the proposal detail page),
 * type, status, and summary, newest first (caller-supplied order — same seam as every other
 * section here). `summary` is customer/agent-drafted text (a refund reason, a reply gist) and goes
 * through html``'s default escaping like every other interpolation in this file — never `raw()`.
 */
function renderTicketProposalsSection(rows: TicketProposalRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<section id="ticket-proposals">
      <h3>Proposals</h3>
      <p>No proposals.</p>
    </section>`
  }
  return html`<section id="ticket-proposals">
    <h3>Proposals</h3>
    <div class="table-wrap"><table class="rows">
      <thead><tr><th>Id</th><th>Type</th><th>Status</th><th>Summary</th><th>Created</th></tr></thead>
      <tbody>
        ${rows.map(
          (p) => html`<tr>
            <td data-label="Id" class="mono"><a href="/admin/proposals/${p.id}">${p.id}</a></td>
            <td data-label="Type">${p.type}</td>
            <td data-label="Status">${chip(p.status)}</td>
            <td data-label="Summary" class="wrap">${p.summary}</td>
            <td data-label="Created"><span title="${p.createdAt.toISOString()}">${relativeTime(p.createdAt)}</span></td>
          </tr>`,
        )}
      </tbody>
    </table></div>
  </section>`
}

/**
 * Task 19: this ticket's last handful of support-agent runs (`routes.ts`'s query already scopes
 * to `workflow = 'support' AND trigger_ref = ticketId`, newest first, `LIMIT 5`) — each id links to
 * the run detail page (`/admin/runs/:id`, the Phase 5 route), alongside its status and start time.
 */
function renderTicketAgentRunsSection(rows: TicketAgentRunRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<section id="ticket-agent-runs">
      <h3>Agent runs</h3>
      <p>No agent runs.</p>
    </section>`
  }
  return html`<section id="ticket-agent-runs">
    <h3>Agent runs</h3>
    <ul>
      ${rows.map(
        (r) => html`<li><a href="/admin/runs/${r.id}">${r.id}</a> — ${r.status} — ${r.startedAt.toISOString()}</li>`,
      )}
    </ul>
  </section>`
}

/** The /admin/tickets/:id thread view: header, triage verdict, linked-order summary, the two
 * guarded action forms, this ticket's proposal + agent-run history (Task 19), then the message
 * thread in chronological order (caller-supplied order — this function only renders it, same seam
 * as render-run.ts's `renderRunDetail`). */
export function renderTicketDetail(
  t: TicketRow,
  messages: MessageRow[],
  linkedOrder: LinkedOrderSummary | null,
  ticketProposals: TicketProposalRow[],
  agentRunRows: TicketAgentRunRow[],
): RawHtml {
  return html`<h1>Ticket ${t.id}</h1>
    <div class="card">
      ${kv('Status', chip(t.status))}
      ${kv('Subject', t.subject ?? '(no subject)')}
      ${kv('Customer', t.customerEmail ?? '—')}
      <p>Source: ${t.source === 'form' ? 'contact form' : 'email'}</p>
    </div>
    ${renderVerdictBlock(t)}
    ${renderLinkedOrderSection(linkedOrder, t.claimedOrderNumber)}
    ${renderActionForms(t)}
    ${renderTicketProposalsSection(ticketProposals)}
    ${renderTicketAgentRunsSection(agentRunRows)}
    <section id="thread">
      <h3>Messages</h3>
      ${messages.length === 0 ? html`<p>No messages.</p>` : messages.map(renderMessage)}
    </section>`
}
