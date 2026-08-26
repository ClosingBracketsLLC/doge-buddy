import { describe, expect, it } from 'vitest'
import { buildReplyRaw } from '../src/rfc2822.ts'

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
})
