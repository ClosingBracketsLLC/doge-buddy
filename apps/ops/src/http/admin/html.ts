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
  return href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`)
}

function badgeFor(href: string, counts: NavCounts): RawHtml {
  if (href === '/admin/proposals' && counts.pendingProposals > 0) return html`<span class="badge">${counts.pendingProposals}</span>`
  if (href === '/admin/tickets' && counts.escalatedTickets > 0) return html`<span class="badge bad">${counts.escalatedTickets}</span>`
  return html``
}

function renderTabs(shell: Shell): RawHtml {
  const tab = (item: (typeof NAV_ITEMS)[number]) =>
    html`<a class="tab" href="${raw(item.href)}"${raw(isCurrent(item.href, shell.path) ? ' aria-current="page"' : '')}><span class="ico">${item.ico}</span>${item.label}${badgeFor(item.href, shell.counts)}</a>`
  const main = NAV_ITEMS.filter((i) => !('more' in i)).map(tab)
  const more = NAV_ITEMS.filter((i) => 'more' in i).map(tab)
  return html`<nav class="tabs" aria-label="Admin">${main}<details class="tab more"><summary><span class="ico">⋯</span>More</summary><div class="menu">${more}</div></details></nav>`
}

/**
 * The page frame. `shell` (current path + badge counts) is passed by `routes.ts`'s `page()` for
 * every authed page and omitted for the login pages, which get the same stylesheet but no tabs.
 * The stylesheet and the tiny script are inlined: no static route, no CDN, no CSP to negotiate.
 */
export function layout(title: string, body: RawHtml, shell?: Shell): string {
  return html`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#10171a" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fdf3e0" media="(prefers-color-scheme: light)"><title>${title}</title><style>${raw(ADMIN_CSS)}</style></head><body>
    <header class="topbar"><a class="brand" href="/admin">🐶 Doge Buddy</a><h1 class="page-title">${title}</h1>${LOGOUT_FORM}</header>
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
}

export function chipTone(state: string): ChipTone {
  return CHIP_TONES[state] ?? 'muted'
}

/** A colored status pill. The state text itself is still in the markup, so text assertions hold. */
export function chip(state: string): RawHtml {
  return html`<span class="chip chip-${raw(chipTone(state))}">${state}</span>`
}

/** 'never' | 'just now' | 'Nm ago' | 'Nh ago' | 'Nd ago' — never negative (clock skew reads as 'just now'). */
export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return 'never'
  const s = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}
