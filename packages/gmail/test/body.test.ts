import { describe, expect, it } from 'vitest'
import { extractBodyText } from '../src/body.ts'
import nested from './fixtures/message-full-nested.json' with { type: 'json' }
import singlepart from './fixtures/message-full-singlepart.json' with { type: 'json' }

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

describe('extractBodyText', () => {
  it('shape 1: nested multipart — prefers the first text/plain leaf and ignores the attachment part', () => {
    const payload = nested.response.body.payload as Record<string, unknown>
    const parts = payload.parts as { parts: { body: { data: string } }[] }[]
    const expectedPlain = Buffer.from(
      parts[0]!.parts[0]!.body.data,
      'base64url',
    ).toString('utf8')

    expect(extractBodyText(payload)).toBe(expectedPlain)
    expect(extractBodyText(payload)).toContain("hasn't shipped yet")
  })

  it('shape 2: html-only payload — falls back to text/html, strips tags/style, collapses whitespace, decodes entities', () => {
    const html =
      '<html><body><style>p { color: red; }</style>' +
      '<p>Order &amp; Shipping</p><p>Status: &quot;pending&quot; &nbsp;still.</p>' +
      '<p>It&#39;s &lt;delayed&gt;.</p></body></html>'
    const payload = {
      mimeType: 'multipart/alternative',
      body: { size: 0 },
      parts: [
        {
          mimeType: 'text/html',
          body: { size: html.length, data: b64url(html) },
        },
        {
          // attachment-only part must never be considered a text leaf
          mimeType: 'application/octet-stream',
          filename: 'blob.bin',
          body: { attachmentId: 'att-1', size: 999 },
        },
      ],
    }

    const text = extractBodyText(payload)
    // style block content must be gone, tags stripped, whitespace collapsed, entities decoded
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('<p>')
    expect(text).toBe('Order & Shipping Status: "pending"  still. It\'s <delayed>.')
  })

  it('shape 3: single-part message — falls back to top-level payload.body.data', () => {
    const payload = singlepart.response.body.payload
    const expected = Buffer.from(payload.body.data!, 'base64url').toString('utf8')

    expect(extractBodyText(payload)).toBe(expected)
    expect(extractBodyText(payload)).toBe('Quick question about my refund status. - Bob')
  })

  it('skips a part that carries only an attachmentId (no body.data) even if it claims text/plain', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      body: { size: 0 },
      parts: [
        {
          mimeType: 'text/plain',
          filename: 'note.txt',
          body: { attachmentId: 'att-only-1', size: 40 }, // no data — must be skipped
        },
        {
          mimeType: 'text/plain',
          body: { size: 5, data: b64url('hello') },
        },
      ],
    }
    expect(extractBodyText(payload)).toBe('hello')
  })

  it('returns null when there is no usable leaf and no top-level body.data', () => {
    expect(extractBodyText({ mimeType: 'multipart/mixed', body: { size: 0 }, parts: [] })).toBeNull()
    expect(extractBodyText(null)).toBeNull()
    expect(extractBodyText(undefined)).toBeNull()
  })
})
