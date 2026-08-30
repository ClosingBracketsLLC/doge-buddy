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

const NAV = ['', 'proposals', 'orders', 'tickets', 'runs', 'settings', 'guidance'] as const

// Unconditional in every layout() call, including the pre-login pages: a logged-out viewer
// clicking it just re-hits the authed onRequest gate (POST /admin/logout, not session-checked
// here) and lands back on /admin/login, same as any other unauthed POST to an authed path — no
// per-caller "am I authed" flag needed to keep this minimal.
const LOGOUT_FORM = html`<form method="post" action="/admin/logout" style="display:inline"><button type="submit">Log out</button></form>`

export function layout(title: string, body: RawHtml): string {
  const links = NAV.map((p) => {
    const href = p === '' ? '/admin' : `/admin/${p}`
    return html`<a href="${raw(href)}">${p === '' ? 'dashboard' : p}</a>`
  })
  return html`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <nav>${links} ${LOGOUT_FORM}</nav>
    <main>${body}</main>
  </body></html>`.value
}
