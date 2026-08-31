import { describe, expect, it } from 'vitest'
import { buildReplyRaw } from '../src/rfc2822.ts'

/**
 * Minimal RFC 2045 quoted-printable decoder, used only to verify our own encoder round-trips.
 * Strips soft line breaks (=\r\n) before resolving =XX hex escapes, exactly as a real QP decoder
 * would — a hex escape or a real character can legally straddle where a soft break used to be.
 */
function decodeQuotedPrintable(text: string): Buffer {
  const noSoftBreaks = text.replace(/=\r\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const c = noSoftBreaks[i]!
    if (c === '=' && i + 2 < noSoftBreaks.length) {
      bytes.push(Number.parseInt(noSoftBreaks.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(c.charCodeAt(0))
    }
  }
  return Buffer.from(bytes)
}

describe('buildReplyRaw', () => {
  it('builds RFC 2822 with CRLF headers and proper body separation', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Re: Broken leash',
      inReplyTo: '<abc@mail.example.com>',
      references: '<root@x> <abc@mail.example.com>',
      bodyText: 'Hi Jane,\n\nSorry about that.',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    expect(text).toContain('From: support@dogebuddy.com\r\n')
    expect(text).toContain('To: jane@example.com\r\n')
    expect(text).toContain('Subject: Re: Broken leash\r\n')
    expect(text).toContain('In-Reply-To: <abc@mail.example.com>\r\n')
    expect(text).toContain('References: <root@x> <abc@mail.example.com>\r\n')
    expect(text).toContain('Content-Type: text/plain; charset="UTF-8"\r\n')
    // After blank line separator (CRLF\r\n), body keeps original line endings
    expect(text.split('\r\n\r\n')[1]).toBe('Hi Jane,\n\nSorry about that.')
  })

  it('adds Re: prefix only when subject does not already start with it', () => {
    const raw1 = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Broken leash',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text1 = Buffer.from(raw1, 'base64url').toString()
    expect(text1).toContain('Subject: Re: Broken leash\r\n')

    // Already has Re: prefix (case-insensitive check)
    const raw2 = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Re: Broken leash',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text2 = Buffer.from(raw2, 'base64url').toString()
    expect(text2).toContain('Subject: Re: Broken leash\r\n')
    // Should not double-prefix
    expect(text2).not.toContain('Subject: Re: Re:')

    // Case-insensitive check
    const raw3 = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 're: already has prefix',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text3 = Buffer.from(raw3, 'base64url').toString()
    expect(text3).toContain('Subject: re: already has prefix\r\n')
    // Should not add another prefix
    expect(text3).not.toContain('Subject: Re: re:')
  })

  it('RFC 2047 encodes non-ASCII subjects as UTF-8 base64', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Re: Hundeleine kaputt 🐶',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    // Subject should be RFC 2047 encoded as =?UTF-8?B?...?=
    expect(text).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?\=\r\n/)
    // Verify the encoded part decodes correctly
    const match = text.match(/Subject: (=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?\=)\r\n/)
    if (match && match[1]) {
      const encoded = match[1]
      const base64Match = encoded.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?\=/)
      if (base64Match && base64Match[1]) {
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8')
        expect(decoded).toBe('Re: Hundeleine kaputt 🐶')
      }
    }
  })

  it('preserves caller line endings in body after blank-line separator', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'Line 1\nLine 2\r\nLine 3',
    })
    const text = Buffer.from(raw, 'base64url').toString()
    const body = text.split('\r\n\r\n')[1]
    expect(body).toBe('Line 1\nLine 2\r\nLine 3')
  })

  it('returns base64url encoded output', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })

    // Should be base64url (no padding, - and _ instead of + and /)
    expect(typeof raw).toBe('string')
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    // Decoding should not throw
    expect(() => Buffer.from(raw, 'base64url').toString()).not.toThrow()
  })

  it('sanitizes header injection: strips CRLF from subject, inReplyTo, references, to, from', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Foo\r\nBcc: evil@x.com',
      inReplyTo: '<abc@mail.example.com>\r\nBcc: evil2@x.com',
      references: '<root@x> <abc@mail.example.com>\r\nBcc: evil3@x.com',
      bodyText: 'test',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    // Should NOT contain any separate Bcc: header line (header injection prevented)
    const parts = text.split('\r\n\r\n')
    const headerLines = parts[0] ?? ''
    const bccHeaderLines = headerLines.split('\r\n').filter((line) => line.startsWith('Bcc:'))
    expect(bccHeaderLines).toHaveLength(0)

    // Verify exactly one of each header (no duplication from injection)
    const subjectLines = text.split('\r\n').filter((line) => line.startsWith('Subject:'))
    expect(subjectLines).toHaveLength(1)
    const inReplyToLines = text.split('\r\n').filter((line) => line.startsWith('In-Reply-To:'))
    expect(inReplyToLines).toHaveLength(1)
    const refLines = text.split('\r\n').filter((line) => line.startsWith('References:'))
    expect(refLines).toHaveLength(1)
  })

  it('sanitizes LF-only line breaks in header fields', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test\nInjection',
      inReplyTo: '<abc@mail.example.com>\nBcc: evil@x.com',
      references: '<root@x>\nBcc: evil@x.com',
      bodyText: 'test',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    // Should NOT contain separate Bcc: header line (injection prevented)
    const parts = text.split('\r\n\r\n')
    const headerLines = parts[0] ?? ''
    const bccHeaderLines = headerLines.split('\r\n').filter((line) => line.startsWith('Bcc:'))
    expect(bccHeaderLines).toHaveLength(0)

    const subjectLines = text.split('\r\n').filter((line) => line.startsWith('Subject:'))
    expect(subjectLines).toHaveLength(1)
  })

  it('sanitizes to and from fields for header injection', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com\r\nBcc: evil@x.com',
      to: 'jane@example.com\r\nBcc: evil@x.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    // Should NOT contain separate Bcc: header line
    const parts = text.split('\r\n\r\n')
    const headerLines = parts[0] ?? ''
    const bccHeaderLines = headerLines.split('\r\n').filter((line) => line.startsWith('Bcc:'))
    expect(bccHeaderLines).toHaveLength(0)

    const fromLines = text.split('\r\n').filter((line) => line.startsWith('From:'))
    expect(fromLines).toHaveLength(1)
    const toLines = text.split('\r\n').filter((line) => line.startsWith('To:'))
    expect(toLines).toHaveLength(1)
  })

  it('includes MIME-Version and quoted-printable Content-Transfer-Encoding headers', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'Hello there',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    expect(text).toContain('MIME-Version: 1.0\r\n')
    expect(text).toContain('Content-Transfer-Encoding: quoted-printable\r\n')
  })

  it('quoted-printable encodes a long non-ASCII body: every encoded line <= 76 chars, decodes back byte-equal', () => {
    const bodyText = 'Hündchen 🐶 '.repeat(300)
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText,
    })
    const text = Buffer.from(raw, 'base64url').toString()
    const encodedBody = text.split('\r\n\r\n')[1]!

    for (const line of encodedBody.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76)
    }

    const decoded = decodeQuotedPrintable(encodedBody)
    expect(decoded.equals(Buffer.from(bodyText, 'utf-8'))).toBe(true)
  })

  it('quoted-printable leaves a plain ASCII body readable, apart from soft breaks', () => {
    const bodyText = 'Hi Jane,\n\nSorry about that. We shipped a replacement leash today.\n\nRegards,\nSupport'
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText,
    })
    const text = Buffer.from(raw, 'base64url').toString()
    const encodedBody = text.split('\r\n\r\n')[1]!

    // No soft breaks needed — every line here is well under 76 chars — so the ASCII body
    // should pass through completely unchanged.
    expect(encodedBody).toBe(bodyText)
  })

  it('folds a long non-ASCII subject into multiple RFC 2047 encoded-words, each <= 75 chars, with no split multi-byte characters', () => {
    const longSubject =
      'Re: Hundeleine kaputt 🐶🐶🐶 sehr sehr lange Betreffzeile die definitiv über ein einzelnes encoded-word hinausgeht und noch mehr Text braucht damit garantiert gefaltet wird'
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: longSubject,
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })
    const text = Buffer.from(raw, 'base64url').toString()

    const match = text.match(/Subject: ([\s\S]*?)\r\nIn-Reply-To:/)
    expect(match).not.toBeNull()
    const subjectValue = match![1]!

    const words = subjectValue.split('\r\n ')
    expect(words.length).toBeGreaterThan(1)

    let decoded = ''
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75)
      const wordMatch = word.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/)
      expect(wordMatch).not.toBeNull()
      decoded += Buffer.from(wordMatch![1]!, 'base64').toString('utf-8')
    }

    // Reconstructing byte-for-byte (rather than just "doesn't throw") is what actually proves no
    // multi-byte character was split across a chunk boundary — a split would corrupt the UTF-8
    // sequence and this equality would fail.
    expect(decoded).toBe(longSubject)
  })

  it('extraHeaders: adds a custom header line to the output', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
      extraHeaders: { 'X-DogeBuddy-Proposal': 'abc-123' },
    })
    const text = Buffer.from(raw, 'base64url').toString()

    expect(text).toContain('X-DogeBuddy-Proposal: abc-123\r\n')
  })

  it('extraHeaders: an invalid header name throws', () => {
    expect(() =>
      buildReplyRaw({
        from: 'support@dogebuddy.com',
        to: 'jane@example.com',
        subject: 'Test',
        inReplyTo: '<abc@mail.example.com>',
        references: '<abc@mail.example.com>',
        bodyText: 'test',
        extraHeaders: { 'Bad Header!': 'value' },
      }),
    ).toThrow()
  })

  it('extraHeaders: value is CR/LF-sanitized like every other field (no header injection)', () => {
    const raw = buildReplyRaw({
      from: 'support@dogebuddy.com',
      to: 'jane@example.com',
      subject: 'Test',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
      extraHeaders: { 'X-DogeBuddy-Proposal': 'x\r\nBcc: evil@x.com' },
    })
    const text = Buffer.from(raw, 'base64url').toString()

    const bccLines = text.split('\r\n').filter((line) => line.startsWith('Bcc:'))
    expect(bccLines).toHaveLength(0)
  })
})

import { buildNewRaw } from '../src/rfc2822.ts'

describe('buildNewRaw', () => {
  const base = {
    from: 'support@dogebuddy.com',
    to: 'jane@example.com',
    subject: 'We got your message — Doge Buddy Support',
    messageId: '<form-ack-abc@dogebuddy.com>',
    bodyText: 'Hi Jane,\n\nThanks.',
  }
  const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

  it('emits From/To/Subject/Message-ID and NO In-Reply-To/References, no Re: prefix', () => {
    const text = decode(buildNewRaw(base))
    const headers = text.split('\r\n\r\n')[0]!
    expect(headers).toContain('From: support@dogebuddy.com\r\n')
    expect(headers).toContain('To: jane@example.com\r\n')
    expect(headers).toContain('Message-ID: <form-ack-abc@dogebuddy.com>\r\n')
    expect(headers).not.toContain('In-Reply-To')
    expect(headers).not.toContain('References')
    expect(headers).not.toContain('Subject: Re:')
    // Non-ASCII subject (the em dash) is RFC 2047 encoded like buildReplyRaw does.
    expect(headers).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/)
    expect(headers).toContain('Content-Transfer-Encoding: quoted-printable')
    expect(text.endsWith('Thanks.')).toBe(true)
  })

  it('rejects a Message-ID that is not <local@domain>', () => {
    expect(() => buildNewRaw({ ...base, messageId: 'form-ack-abc@dogebuddy.com' })).toThrow(/Message-ID/)
    expect(() => buildNewRaw({ ...base, messageId: '<a b@c>' })).toThrow(/Message-ID/)
  })

  it('passes extraHeaders through with the same name validation as buildReplyRaw', () => {
    const text = decode(buildNewRaw({ ...base, extraHeaders: { 'X-DogeBuddy-Form': 'ticket-1' } }))
    expect(text).toContain('X-DogeBuddy-Form: ticket-1\r\n')
    expect(() => buildNewRaw({ ...base, extraHeaders: { 'Bad Name': 'x' } })).toThrow(/invalid extra header name/)
  })
})
