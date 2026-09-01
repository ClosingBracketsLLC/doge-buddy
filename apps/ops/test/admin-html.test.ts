import { describe, expect, it } from 'vitest'
import { ADMIN_CSS, ADMIN_JS } from '../src/http/admin/styles.ts'
import { chip, chipTone, esc, html, layout, raw, relativeTime } from '../src/http/admin/html.ts'

describe('admin html helpers', () => {
  it('esc escapes & < > " \' and stringifies non-strings', () => {
    expect(esc(`<a href="x">&'b`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;b')
    expect(esc(42)).toBe('42')
    expect(esc(null)).toBe('null')
  })

  it('html escapes every interpolation by default', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`
    expect(out.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('raw() passes through verbatim; nested html`` results are raw', () => {
    const inner = html`<b>${'x & y'}</b>`
    const out = html`<div>${inner}${raw('<hr>')}</div>`
    expect(out.value).toBe('<div><b>x &amp; y</b><hr></div>')
  })

  it('arrays are joined with each member escaped-or-raw by the same rule', () => {
    const out = html`<ul>${['<li>a', raw('<li>b')]}</ul>`
    expect(out.value).toBe('<ul>&lt;li&gt;a<li>b</ul>')
  })

  it('layout without a shell: viewport + stylesheet + JS, NO tabs (login pages)', () => {
    const doc = layout('P & Q', html`<p>body</p>`)
    expect(doc).toContain('<title>P &amp; Q</title>')
    expect(doc).toContain('<p>body</p>')
    expect(doc).toContain('name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"')
    expect(doc).toContain('<style>')
    expect(doc).toContain(ADMIN_CSS)
    expect(doc).toContain(ADMIN_JS)
    expect(doc).not.toContain('class="tabs"')
    expect(doc).not.toContain('action="/admin/logout"')
  })

  it('layout with a shell renders the seven nav links, badges only when > 0, aria-current on the active tab', () => {
    const doc = layout('Tickets', html`<p>x</p>`, { path: '/admin/tickets', counts: { pendingProposals: 3, escalatedTickets: 0 } })
    expect(doc).toContain('class="tabs"')
    for (const href of ['/admin', '/admin/proposals', '/admin/tickets', '/admin/orders', '/admin/runs', '/admin/settings', '/admin/guidance']) {
      expect(doc).toContain(`href="${href}"`)
    }
    expect(doc).toContain('<span class="badge">3</span>')
    expect(doc).not.toContain('class="badge bad"')
    expect(doc).toMatch(/<a class="tab" href="\/admin\/tickets" aria-current="page">/)
    expect(doc).not.toMatch(/href="\/admin" aria-current/)
    expect(doc).toContain('<h1 class="page-title">Tickets</h1>')
    expect(doc).toContain('action="/admin/logout"')
    // Rail bug fix: the >=640px rail can't open the collapsed <details class="tab more"> menu via
    // CSS alone, so each 'more' item (Runs/Settings/Guidance) also renders as a plain rail tab
    // (class="tab more-item") right after Orders — hidden at <640px, shown at >=640px — alongside
    // its unchanged copy inside the <details> menu (shown at <640px, hidden at >=640px).
    expect(doc).toContain('<a class="tab more-item" href="/admin/settings"')
    expect((doc.match(/href="\/admin\/settings"/g) ?? []).length).toBe(2)
    // Autosubmit forms must confirm-then-.submit() — never fall back to .requestSubmit(), which
    // fires no `submit` event and would silently skip data-confirm on autosubmit+confirm forms.
    expect(ADMIN_JS).not.toContain('requestSubmit')
    expect(ADMIN_JS).toContain("'autosubmit' in f.dataset")
    expect(ADMIN_JS).toContain('defaultSelected')
  })

  it('escalated badge uses the bad tone; /admin is current only on an exact match; detail paths match their list tab', () => {
    const doc = layout('Home', html``, { path: '/admin', counts: { pendingProposals: 0, escalatedTickets: 2 } })
    expect(doc).toContain('<span class="badge bad">2</span>')
    expect(doc).toMatch(/<a class="tab" href="\/admin" aria-current="page">/)
    const detail = layout('Proposal', html``, { path: '/admin/proposals/abc', counts: { pendingProposals: 0, escalatedTickets: 0 } })
    expect(detail).toMatch(/<a class="tab" href="\/admin\/proposals" aria-current="page">/)
    expect(detail).not.toContain('class="badge')
  })

  it('chip maps states to tones and escapes the text', () => {
    expect(chipTone('pending')).toBe('warn')
    expect(chipTone('applied')).toBe('ok')
    expect(chipTone('escalated')).toBe('bad')
    expect(chipTone('needs_attention')).toBe('bad')
    expect(chipTone('running')).toBe('info')
    expect(chipTone('succeeded')).toBe('ok')
    expect(chipTone('whatever')).toBe('muted')
    expect(chip('<x>').value).toBe('<span class="chip chip-muted">&lt;x&gt;</span>')
  })

  it('relativeTime buckets', () => {
    const now = new Date('2026-08-31T12:00:00Z')
    expect(relativeTime(null, now)).toBe('never')
    expect(relativeTime(new Date('2026-08-31T11:59:40Z'), now)).toBe('just now')
    expect(relativeTime(new Date('2026-08-31T11:57:00Z'), now)).toBe('3m ago')
    expect(relativeTime(new Date('2026-08-31T10:00:00Z'), now)).toBe('2h ago')
    expect(relativeTime(new Date('2026-08-27T12:00:00Z'), now)).toBe('4d ago')
    expect(relativeTime(new Date('2026-08-31T12:00:30Z'), now)).toBe('just now') // clock skew: never negative
    // Fix round: future dates (a proposal's expiresAt) get their own 'in N…' buckets instead of
    // being clamped to 'just now'.
    expect(relativeTime(new Date('2026-08-31T15:00:00Z'), now)).toBe('in 3h')
    expect(relativeTime(new Date('2026-08-31T12:45:00Z'), now)).toBe('in 45m')
    expect(relativeTime(new Date('2026-09-03T12:00:00Z'), now)).toBe('in 3d')
  })
})
