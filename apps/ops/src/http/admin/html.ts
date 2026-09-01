/** Marker for strings that are already safe HTML. The ONLY way html`` inserts verbatim. */
export class RawHtml {
  constructor(readonly value: string) {}
}

export function raw(value: string): RawHtml {
  return new RawHtml(value)
}

export function esc(input: unknown): string {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function render(value: unknown): string {
  if (value instanceof RawHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  return esc(value)
}

/**
 * Auto-escaping tagged template — the admin surface's ONLY way to build markup. Everything
 * interpolated is escaped unless explicitly RawHtml (which only our own html`` produces), so
 * attacker-influenced bytes (audit detail, proposal payloads, lastError strings) are inert by
 * default. Returns RawHtml so fragments compose without double-escaping.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1]!
  }
  return new RawHtml(out)
}

import { ADMIN_CSS, ADMIN_JS } from './styles.ts'

export interface NavCounts { pendingProposals: number; escalatedTickets: number }
export interface Shell { path: string; counts: NavCounts }

/** Tab bar / rail items in display order. `more` items live under the "More" cell on phones. */
export const NAV_ITEMS = [
  { href: '/admin', label: 'Home', ico: '⌂' },
  { href: '/admin/proposals', label: 'Proposals', ico: '✓' },
  { href: '/admin/tickets', label: 'Tickets', ico: '✉' },
  { href: '/admin/orders', label: 'Orders', ico: '▤' },
  { href: '/admin/runs', label: 'Runs', ico: '⟳', more: true },
  { href: '/admin/settings', label: 'Settings', ico: '⚙', more: true },
  { href: '/admin/guidance', label: 'Guidance', ico: '☰', more: true },
] as const

const LOGOUT_FORM = html`<form method="post" action="/admin/logout"><button type="submit">Log out</button></form>`

function isCurrent(href: string, path: string): boolean {
  return href === '/admin'
    ? path === '/admin' || path.startsWith('/admin?')
    : path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`)
}

function badgeFor(href: string, counts: NavCounts): RawHtml {
  if (href === '/admin/proposals' && counts.pendingProposals > 0) return html`<span class="badge">${counts.pendingProposals}</span>`
  if (href === '/admin/tickets' && counts.escalatedTickets > 0) return html`<span class="badge bad">${counts.escalatedTickets}</span>`
  return html``
}

/**
 * `>= 640px` (styles.ts) lays the rail out as a plain vertical list of `.tab`s — CSS alone can't
 * "open" the `<details class="tab more">` disclosure to reveal Runs/Settings/Guidance there, so at
 * that width the collapsed `<details>` (still rendered, for the < 640px cover-screen tab bar)
 * would silently strand those three links unreachable. Fix: render every `more` item TWICE —
 * once as a plain rail tab (`class="tab more-item"`, placed right after Orders) that styles.ts
 * shows only at `>= 640px` and hides at `< 640px`, and once more, unchanged, inside the `<details>`
 * menu that styles.ts shows only below 640px. Same `ico`/label/badge/aria-current markup either
 * way — the two copies just differ in which one the current viewport keeps visible.
 */
function renderTabs(shell: Shell): RawHtml {
  const tab = (item: (typeof NAV_ITEMS)[number], extraClass = '') =>
    html`<a class="tab${raw(extraClass)}" href="${raw(item.href)}"${raw(isCurrent(item.href, shell.path) ? ' aria-current="page"' : '')}><span class="ico">${item.ico}</span>${item.label}${badgeFor(item.href, shell.counts)}</a>`
  const main = NAV_ITEMS.filter((i) => !('more' in i)).map((i) => tab(i))
  const moreItems = NAV_ITEMS.filter((i) => 'more' in i)
  const moreRailTabs = moreItems.map((i) => tab(i, ' more-item'))
  const moreMenuTabs = moreItems.map((i) => tab(i))
  return html`<nav class="tabs" aria-label="Admin">${main}${moreRailTabs}<details class="tab more"><summary><span class="ico">⋯</span>More</summary><div class="menu">${moreMenuTabs}</div></details></nav>`
}

/**
 * The page frame. `shell` (current path + badge counts) is passed by `routes.ts`'s `page()` for
 * every authed page and omitted for the login pages, which get the same stylesheet but no tabs.
 * The stylesheet and the tiny script are inlined: no static route, no CDN, no CSP to negotiate.
 */
export function layout(title: string, body: RawHtml, shell?: Shell): string {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#10171a" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fdf3e0" media="(prefers-color-scheme: light)"><title>${title}</title><style>${raw(ADMIN_CSS)}</style></head><body>
    <header class="topbar"><a class="brand" href="/admin">🐶 Doge Buddy</a><h1 class="page-title">${title}</h1>${shell ? LOGOUT_FORM : html``}</header>
    ${shell ? renderTabs(shell) : html``}
    <main>${body}</main>
    <script>${raw(ADMIN_JS)}</script>
  </body></html>`.value
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const CHIP_TONES: Record<string, ChipTone> = {
  // proposals
  pending: 'warn', approved: 'info', applying: 'info', applied: 'ok', rejected: 'bad', expired: 'muted', failed: 'bad',
  // tickets
  new: 'warn', triaged: 'warn', awaiting_approval: 'warn', waiting_on_customer: 'info', resolved: 'ok', escalated: 'bad', spam: 'muted',
  // supplier orders
  created: 'info', confirmed: 'info', paid: 'ok', shipped: 'ok', delivered: 'ok', cancelled: 'muted', needs_attention: 'bad', awaiting_funds: 'warn',
  // agent runs
  running: 'info', succeeded: 'ok', aborted: 'bad',
  // switches
  ON: 'bad', OFF: 'muted', auto: 'info', manual: 'muted',
  // control-center home
  DEGRADED: 'bad', ok: 'ok', never: 'muted',
}

export function chipTone(state: string): ChipTone {
  return CHIP_TONES[state] ?? 'muted'
}

/** A colored status pill. The state text itself is still in the markup, so text assertions hold. */
export function chip(state: string): RawHtml {
  return html`<span class="chip chip-${raw(chipTone(state))}">${state}</span>`
}

/**
 * 'never' | 'just now' | 'Nm ago'/'Nh ago'/'Nd ago' (past) | 'in Nm'/'in Nh'/'in Nd' (future) —
 * magnitude-based buckets in both directions, so a sub-minute difference either way (including
 * ordinary clock skew) reads as 'just now' rather than a spurious negative or future value. Used
 * for both "last happened" fields (support poll, agent runs, tickets) and "will happen" fields
 * (a proposal's `expiresAt`), so it has to handle `date` landing on either side of `now`.
 */
export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return 'never'
  const diffMs = date.getTime() - now.getTime()
  if (diffMs >= 60_000) {
    const s = Math.floor(diffMs / 1000)
    if (s < 3600) return `in ${Math.floor(s / 60)}m`
    if (s < 86_400) return `in ${Math.floor(s / 3600)}h`
    return `in ${Math.floor(s / 86_400)}d`
  }
  const s = Math.max(0, Math.floor(-diffMs / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** One `.kv` row: `<div class="kv"><span>label</span><span class="v"[ title="…"]>value</span></div>`.
 * `iso`, when given, adds a `title` attribute carrying the exact timestamp — used by callers that
 * display a relative time in `value` but still want the precise instant available on hover/inspect.
 * The one shared implementation for every renderer's kv-row card (dashboard, proposal, run, ticket
 * detail pages) — they used to each carry their own near-identical copy. */
export function kv(label: string, value: RawHtml | string, iso?: Date | null): RawHtml {
  const title = iso ? html` title="${iso.toISOString()}"` : html``
  return html`<div class="kv"><span>${label}</span><span class="v"${title}>${value}</span></div>`
}
