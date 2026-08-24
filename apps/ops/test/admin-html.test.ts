import { describe, expect, it } from 'vitest'
import { esc, html, layout, raw } from '../src/http/admin/html.ts'

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

  it('layout escapes the title and embeds the body verbatim, with the six nav links', () => {
    const doc = layout('P & Q', html`<p>body</p>`)
    expect(doc).toContain('<title>P &amp; Q</title>')
    expect(doc).toContain('<p>body</p>')
    for (const href of ['/admin', '/admin/proposals', '/admin/orders', '/admin/tickets', '/admin/runs', '/admin/settings']) {
      expect(doc).toContain(`href="${href}"`)
    }
  })
})
