import type { agentRunEvents, agentRuns } from '@doge-buddy/db'
import { chip, html, kv, relativeTime, type RawHtml } from './html.ts'

export type AgentRunRow = typeof agentRuns.$inferSelect
export type AgentRunListRow = Pick<
  AgentRunRow,
  'id' | 'workflow' | 'status' | 'createdAt' | 'totalCostUsd' | 'modelUsage' | 'numTurns' | 'finishedAt'
>
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect

/**
 * `modelUsage` is untyped jsonb (no `.$type<>()` on that column) — narrows defensively before
 * touching it, same idiom as routes.ts's `snapshotContent`, rather than trusting the shape
 * blindly. `true` only when sourcing-run.ts's fallback path (no authoritative result message)
 * tagged this row's usage as a streaming-accumulator ESTIMATE rather than the real result cost.
 */
function isEstimated(modelUsage: unknown): boolean {
  if (modelUsage && typeof modelUsage === 'object' && 'estimated' in modelUsage) {
    return (modelUsage as { estimated: unknown }).estimated === true
  }
  return false
}

/**
 * `totalCostUsd` is a `numeric` column — drizzle's default mode returns it as a decimal STRING
 * (see sourcing-run.ts's `toNumericString`), null before any cost has been recorded yet (a
 * freshly-claimed 'running' row). Formats as `$X.XX`, suffixed ` (est)` per `isEstimated` above.
 */
function formatCostUsd(totalCostUsd: string | null, modelUsage: unknown): string {
  if (totalCostUsd === null) return '—'
  const formatted = `$${Number(totalCostUsd).toFixed(2)}`
  return isEstimated(modelUsage) ? `${formatted} (est)` : formatted
}

/** One <tr> per agent run for the /admin/runs list: id links to the detail page.
 *
 * `finishedAt` stays a raw ISO string (not `relativeTime`) — an existing test pins this list
 * cell's exact ISO text (admin-runs.test.ts test 2), so it's left alone per the task's "keep
 * pinned cell TEXT exactly" rule; `createdAt` isn't pinned anywhere and switches to `relativeTime`.
 */
export function renderRunRow(r: AgentRunListRow): RawHtml {
  return html`<tr>
    <td data-label="Id" class="mono"><a href="/admin/runs/${r.id}">${r.id}</a></td>
    <td data-label="Workflow">${r.workflow}</td>
    <td data-label="Status">${chip(r.status)}</td>
    <td data-label="Cost">${formatCostUsd(r.totalCostUsd, r.modelUsage)}</td>
    <td data-label="Turns">${r.numTurns ?? '—'}</td>
    <td data-label="Created"><span title="${r.createdAt.toISOString()}">${relativeTime(r.createdAt)}</span></td>
    <td data-label="Finished">${r.finishedAt ? r.finishedAt.toISOString() : '—'}</td>
  </tr>`
}

/**
 * `message` is jsonb (untyped) — an SDK `type:'assistant'` event's shape is
 * `{ type: 'assistant', message: { content: [contentBlock, ...], ... } }` (Anthropic Messages API
 * shape). Narrows defensively at every level; returns the first ~120 chars of the first `text`
 * content block, or null if the shape doesn't match (never throws on a malformed/foreign event).
 */
function assistantTextPreview(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const inner = (message as Record<string, unknown>).message
  if (!inner || typeof inner !== 'object') return null
  const content = (inner as Record<string, unknown>).content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        return b.text.slice(0, 120)
      }
    }
  }
  return null
}

/** `#seq type/subtype` (subtype omitted when absent), plus an assistant-message text preview. */
function eventSummary(e: AgentRunEventRow): string {
  const message = e.message
  const record = message && typeof message === 'object' ? (message as Record<string, unknown>) : {}
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  const subtype = typeof record.subtype === 'string' ? `/${record.subtype}` : ''
  const preview = type === 'assistant' ? assistantTextPreview(message) : null
  return `#${e.seq} ${type}${subtype}${preview ? ` — ${preview}` : ''}`
}

/**
 * One <details> block per event: summary is `eventSummary` above, body is the FULL event message
 * as pretty JSON. SECURITY: `agent_run_events.message` is untrusted third-party content the agent
 * fetched mid-run (CJ product pages, web-search results) — the JSON string is interpolated as a
 * plain value here, which `html\`\`` (html.ts) auto-escapes via `esc()` like every other
 * interpolation. NEVER wrap this in `raw()` — that would let fetched content execute as markup on
 * an authenticated admin page.
 */
function renderEvent(e: AgentRunEventRow): RawHtml {
  const body = JSON.stringify(e.message, null, 2)
  return html`<details>
    <summary>${eventSummary(e)}</summary>
    <pre>${body}</pre>
  </details>`
}

/**
 * The /admin/runs/:id detail page: a header card (workflow/status/model/started/finished/
 * cost/turns/sessionId) followed by the full event stream, oldest first. `events` is passed in
 * pre-loaded (ordered by seq) rather than queried here — same seam as render-orders.ts's
 * `renderNeedsAttentionSection`, keeping this a pure render function.
 */
export function renderRunDetail(run: AgentRunRow, events: AgentRunEventRow[]): RawHtml {
  const header = html`<div class="card" id="run-header">
    ${kv('Workflow', run.workflow)}
    ${kv('Status', chip(run.status))}
    ${kv('Model', run.model ?? '—')}
    ${kv('Started', html`<span title="${run.startedAt.toISOString()}">${relativeTime(run.startedAt)}</span>`)}
    ${kv('Finished', run.finishedAt ? html`<span title="${run.finishedAt.toISOString()}">${relativeTime(run.finishedAt)}</span>` : '—')}
    ${kv('Cost', formatCostUsd(run.totalCostUsd, run.modelUsage))}
    ${kv('Turns', String(run.numTurns ?? '—'))}
    ${kv('Session', run.sessionId ?? '—')}
  </div>`

  const stream =
    events.length === 0 ? html`<p>No events.</p>` : html`<section id="run-events">${events.map(renderEvent)}</section>`

  return html`<h1>Run ${run.id}</h1>
    ${header}
    ${stream}`
}
