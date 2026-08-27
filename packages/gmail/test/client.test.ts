import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createGmailClient } from '../src/client.ts'
import type { GmailAuth } from '../src/auth.ts'
import { GmailApiError, GmailRateLimitError, HistoryExpiredError, MessageGoneError } from '../src/errors.ts'

import profileFixture from './fixtures/profile.json' with { type: 'json' }
import historyPage1Fixture from './fixtures/history-page1.json' with { type: 'json' }
import historyPage2Fixture from './fixtures/history-page2.json' with { type: 'json' }
import history404Fixture from './fixtures/history-404.json' with { type: 'json' }
import messagesListFixture from './fixtures/messages-list.json' with { type: 'json' }
import threadGetFixture from './fixtures/thread-get.json' with { type: 'json' }
import thread404Fixture from './fixtures/thread-404.json' with { type: 'json' }
import messageFullNestedFixture from './fixtures/message-full-nested.json' with { type: 'json' }
import messageFullSinglepartFixture from './fixtures/message-full-singlepart.json' with { type: 'json' }
import messageMetadataFixture from './fixtures/message-metadata.json' with { type: 'json' }
import messageMetadataAuthResultsFixture from './fixtures/message-metadata-auth-results.json' with { type: 'json' }
import messageMetadataProposalMarkerFixture from './fixtures/message-metadata-proposal-marker.json' with { type: 'json' }
import message404Fixture from './fixtures/message-404.json' with { type: 'json' }
import labelsListFixture from './fixtures/labels-list.json' with { type: 'json' }
import labelCreateFixture from './fixtures/label-create.json' with { type: 'json' }
import error403QuotaFixture from './fixtures/error-403-quota.json' with { type: 'json' }
import error403PermFixture from './fixtures/error-403-perm.json' with { type: 'json' }
import sendReplyFixture from './fixtures/send-reply.json' with { type: 'json' }

const FROM_ADDRESS = 'support@dogebuddy.com'

interface Fixture {
  request: { method: string; path: string; query?: Record<string, string | string[]> }
  response: { status: number; body: unknown }
}

function buildKey(method: string, path: string, query?: Record<string, string | string[]>): string {
  const params = new URLSearchParams()
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item)
      else params.append(k, v)
    }
  }
  const qs = params.toString()
  return `${method.toUpperCase()} ${path}${qs ? `?${qs}` : ''}`
}

/** Matches an incoming request's method+path?query against fixtures' own `request` field. */
function fixtureFetch(map: Record<string, Fixture>): typeof fetch {
  const byKey = new Map<string, Fixture>()
  for (const fixture of Object.values(map)) {
    byKey.set(buildKey(fixture.request.method, fixture.request.path, fixture.request.query), fixture)
  }
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${u.pathname}${u.search}`
    const fixture = byKey.get(key)
    if (!fixture) {
      throw new Error(`fixtureFetch: no fixture registered for "${key}". Known: ${[...byKey.keys()].join(' | ')}`)
    }
    return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status })
  }) as unknown as typeof fetch
}

function stubAuth(): GmailAuth {
  return {
    getAccessToken: vi.fn(async () => 'tok-1'),
    invalidate: vi.fn(),
  }
}

describe('createGmailClient', () => {
  it('getProfile: builds GET /profile and normalizes the response', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ profile: profileFixture }),
    })
    await expect(client.getProfile()).resolves.toEqual({
      emailAddress: 'admin@dogebuddy.com',
      historyId: '3025',
    })
  })

  it('listHistory: pages via startHistoryId + pageToken and maps messagesAdded', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ page1: historyPage1Fixture, page2: historyPage2Fixture }),
    })

    const page1 = await client.listHistory({ startHistoryId: '3000' })
    expect(page1.nextPageToken).toBe('page-2-token')
    expect(page1.records).toEqual([
      { id: '3025', messagesAdded: [{ id: 'msg-201', threadId: 'thread-100' }] },
      { id: '3031', messagesAdded: [{ id: 'msg-202', threadId: 'thread-101' }] },
    ])

    const page2 = await client.listHistory({ startHistoryId: '3000', pageToken: 'page-2-token' })
    expect(page2.nextPageToken).toBeUndefined()
    expect(page2.records).toEqual([{ id: '3040', messagesAdded: [{ id: 'msg-203', threadId: 'thread-102' }] }])
  })

  it('listHistory: 404 becomes HistoryExpiredError', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ err: history404Fixture }),
    })
    await expect(client.listHistory({ startHistoryId: '500' })).rejects.toBeInstanceOf(HistoryExpiredError)
  })

  it('listMessages: builds the q param and returns id/threadId pairs', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ list: messagesListFixture }),
    })
    await expect(client.listMessages({ q: 'in:inbox' })).resolves.toEqual({
      ids: [
        { id: 'msg-301', threadId: 'thread-200' },
        { id: 'msg-302', threadId: 'thread-201' },
      ],
      nextPageToken: undefined,
    })
  })

  it('getThread: builds GET /threads/{id}?format=minimal and returns live message ids', async () => {
    const fetchFn = vi.fn(fixtureFetch({ thread: threadGetFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getThread('thread-100')).resolves.toEqual({
      messages: [{ id: 'msg-201' }, { id: 'msg-205' }],
    })

    const calledUrl = new URL(String(fetchFn.mock.calls[0]![0]))
    expect(calledUrl.pathname).toBe('/gmail/v1/users/me/threads/thread-100')
    expect(calledUrl.searchParams.get('format')).toBe('minimal')
  })

  it('getThread: 404 becomes a plain GmailApiError, NOT a typed thread-gone error', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ err: thread404Fixture }),
    })
    await expect(client.getThread('thread-gone-1')).rejects.toMatchObject({
      name: 'GmailApiError',
      status: 404,
    })
  })

  it('getMessage(full, nested): builds format=full and fully normalizes headers + recursive body extraction', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullNestedFixture }),
    })
    const msg = await client.getMessage('msg-nested-1', { format: 'full' })

    expect(msg.id).toBe('msg-nested-1')
    expect(msg.threadId).toBe('thread-100')
    expect(msg.labelIds).toEqual(['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'])
    expect(msg.internalDate).toEqual(new Date(1_756_148_400_000))
    expect(msg.fromRaw).toBe('"Jane D" <Jane@Example.com>')
    expect(msg.fromAddr).toBe('jane@example.com')
    expect(msg.to).toEqual(['support@dogebuddy.com'])
    expect(msg.cc).toEqual(['manager@example.com', 'ops@example.com'])
    expect(msg.deliveredTo).toEqual(['jane@example.com', 'support@dogebuddy.com'])
    expect(msg.subject).toBe("Re: Order #4521 hasn't shipped")
    expect(msg.rfcMessageId).toBe('<CAJ+abc123@mail.gmail.com>')
    expect(msg.inReplyTo).toBe('<original-msg-999@mail.gmail.com>')
    expect(msg.references).toBe('<original-msg-999@mail.gmail.com>')
    // depth-first walk must prefer the text/plain leaf over its text/html sibling
    // and must never attempt to decode the attachment-only pdf part.
    expect(msg.bodyText).toBe(
      "Hi DogeBuddy team,\n\nMy order #4521 hasn't shipped yet and it's been 9 days. Can you check on it?\n\nThanks,\nJane",
    )
  })

  it('getMessage(full, nested): authenticationResults exposes the TOPMOST Authentication-Results header value (controller ruling: full format, not just metadata)', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullNestedFixture }),
    })
    const msg = await client.getMessage('msg-nested-1', { format: 'full' })

    // The fixture carries two Authentication-Results headers (Gmail's own stamp topmost, an
    // upstream relay's stamp further down) — only the first occurrence must win.
    expect(msg.authenticationResults).toBe(
      'mx.google.com; spf=pass (google.com: domain of jane@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jane@example.com; dkim=pass header.i=@example.com; dmarc=pass',
    )
  })

  it('getMessage(full, singlepart): falls back to top-level body.data and nulls absent headers', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullSinglepartFixture }),
    })
    const msg = await client.getMessage('msg-single-1', { format: 'full' })

    expect(msg.bodyText).toBe('Quick question about my refund status. - Bob')
    expect(msg.fromAddr).toBe('bob@customer.com')
    expect(msg.cc).toEqual([])
    expect(msg.deliveredTo).toEqual([])
    expect(msg.inReplyTo).toBeNull()
    expect(msg.references).toBeNull()
  })

  it('getMessage(metadata): requests format=metadata with repeated metadataHeaders in the required order, bodyText is null', async () => {
    const fetchFn = vi.fn(fixtureFetch({ msg: messageMetadataFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })
    const msg = await client.getMessage('msg-nested-1', { format: 'metadata' })

    const calledUrl = new URL(String(fetchFn.mock.calls[0]![0]))
    expect(calledUrl.pathname).toBe('/gmail/v1/users/me/messages/msg-nested-1')
    expect(calledUrl.searchParams.get('format')).toBe('metadata')
    expect(calledUrl.searchParams.getAll('metadataHeaders')).toEqual([
      'From',
      'To',
      'Cc',
      'Delivered-To',
      'Subject',
      'Message-ID',
      'In-Reply-To',
      'References',
      'Authentication-Results',
      'X-DogeBuddy-Proposal',
    ])

    expect(msg.bodyText).toBeNull()
    expect(msg.fromAddr).toBe('jane@example.com')
    expect(msg.deliveredTo).toEqual(['jane@example.com', 'support@dogebuddy.com'])
    // This fixture's response carries no Authentication-Results header at all.
    expect(msg.authenticationResults).toBeNull()
    // Nor an X-DogeBuddy-Proposal one — an ordinary customer message never carries the marker.
    expect(msg.dogeBuddyProposalId).toBeNull()
  })

  it('getMessage(metadata): dogeBuddyProposalId exposes the X-DogeBuddy-Proposal marker when present', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageMetadataProposalMarkerFixture }),
    })
    const msg = await client.getMessage('msg-marker-1', { format: 'metadata' })

    // The whole point of the METADATA_HEADERS entry: a metadata fetch returns only the named
    // headers, and this is the one `apply-support-reply.ts`'s re-entry scan reads to decide
    // "already sent" vs "send now".
    expect(msg.dogeBuddyProposalId).toBe('9f1c2b34-5d6e-47a8-9012-3456789abcde')
    expect(msg.authenticationResults).toBeNull()
  })

  it('getMessage(metadata): authenticationResults exposes the TOPMOST Authentication-Results header value when present', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageMetadataAuthResultsFixture }),
    })
    const msg = await client.getMessage('msg-auth-1', { format: 'metadata' })

    // The fixture carries two Authentication-Results headers — only the first (topmost, Gmail's
    // own stamp) occurrence must be returned.
    expect(msg.authenticationResults).toBe(
      'mx.google.com; spf=pass (google.com: domain of jane@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jane@example.com; dkim=pass header.i=@example.com; dmarc=pass',
    )
  })

  it('getMessage: 404 becomes MessageGoneError', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ err: message404Fixture }),
    })
    await expect(client.getMessage('msg-deleted-1', { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
  })

  it('listLabels: returns id/name pairs', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ labels: labelsListFixture }),
    })
    await expect(client.listLabels()).resolves.toEqual([
      { id: 'INBOX', name: 'INBOX' },
      { id: 'SENT', name: 'SENT' },
      { id: 'UNREAD', name: 'UNREAD' },
      { id: 'Label_1', name: 'DogeBuddy/New' },
    ])
  })

  it('createLabel: POSTs {name} to /labels and returns the created label', async () => {
    const fetchFn = vi.fn(fixtureFetch({ create: labelCreateFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.createLabel('DogeBuddy/Spam')).resolves.toEqual({ id: 'Label_2', name: 'DogeBuddy/Spam' })

    const [, init] = fetchFn.mock.calls[0]!
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'DogeBuddy/Spam' })
  })

  it('modifyMessage: POSTs addLabelIds/removeLabelIds to /messages/{id}/modify', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1/modify')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ addLabelIds: ['DogeBuddy/New'], removeLabelIds: ['UNREAD'] })
      return new Response(JSON.stringify({ id: 'msg-1', threadId: 'thread-1', labelIds: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })
    await expect(
      client.modifyMessage('msg-1', { addLabelIds: ['DogeBuddy/New'], removeLabelIds: ['UNREAD'] }),
    ).resolves.toBeUndefined()
  })

  it('403 rateLimitExceeded: retries once after a jittered delay, then throws GmailRateLimitError', async () => {
    const fetchFn = vi.fn(fixtureFetch({ err: error403QuotaFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getMessage('msg-quota-1', { format: 'full' })).rejects.toBeInstanceOf(GmailRateLimitError)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('403 forbidden (non-quota reason): throws plain GmailApiError with NO retry', async () => {
    const fetchFn = vi.fn(fixtureFetch({ err: error403PermFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getMessage('msg-perm-1', { format: 'full' })).rejects.toMatchObject({
      name: 'GmailApiError',
      status: 403,
      reason: 'forbidden',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('429: retries once after a jittered delay, then throws GmailRateLimitError', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } }),
        { status: 429 },
      )
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getProfile()).rejects.toBeInstanceOf(GmailRateLimitError)
    expect(calls).toBe(2)
  })

  it('5xx: retries once after a jittered delay, then throws GmailApiError', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }),
        { status: 503 },
      )
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getProfile()).rejects.toMatchObject({ name: 'GmailApiError', status: 503 })
    expect(calls).toBe(2)
  })

  it('IMPORTANT 4a: every request carries a 20s AbortSignal so a poll can never hang forever', async () => {
    const fetchFn = vi.fn(fixtureFetch({ profile: profileFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await client.getProfile()

    const init = fetchFn.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('IMPORTANT 4a: a fetch that times out (TimeoutError) retries once after a jittered delay, then throws the typed timeout error', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getProfile()).rejects.toMatchObject({ name: 'GmailApiError', status: 0, reason: 'timeout' })
    expect(calls).toBe(2)
  })

  it('a fetch rejecting with any other error name (e.g. AbortError) propagates unchanged, with NO retry — the client accepts no caller signal, so this is an unknown error', async () => {
    let calls = 0
    const original = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchFn = vi.fn(async () => {
      calls++
      throw original
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(client.getProfile()).rejects.toBe(original)
    expect(calls).toBe(1)
  })

  it('401: invalidates the cached token, refetches it, and retries the request exactly once', async () => {
    let tokenCalls = 0
    const getAccessToken = vi.fn(async () => (tokenCalls++ === 0 ? 'stale-token' : 'fresh-token'))
    const invalidate = vi.fn()
    const auth: GmailAuth = { getAccessToken, invalidate }

    let fetchCalls = 0
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      fetchCalls++
      const headers = init?.headers as Record<string, string> | undefined
      if (fetchCalls === 1) {
        expect(headers?.Authorization).toBe('Bearer stale-token')
        return new Response(
          JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }),
          { status: 401 },
        )
      }
      expect(headers?.Authorization).toBe('Bearer fresh-token')
      return new Response(JSON.stringify(profileFixture.response.body), { status: 200 })
    }) as unknown as typeof fetch

    const client = createGmailClient({ auth, fromAddress: FROM_ADDRESS, fetchFn })
    await expect(client.getProfile()).resolves.toEqual({ emailAddress: 'admin@dogebuddy.com', historyId: '3025' })

    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(fetchCalls).toBe(2)
  })

  it('a second consecutive 401 (post-retry) is NOT retried again — surfaces as GmailApiError', async () => {
    const auth: GmailAuth = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() }
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }),
        { status: 401 },
      )
    }) as unknown as typeof fetch

    const client = createGmailClient({ auth, fromAddress: FROM_ADDRESS, fetchFn })
    await expect(client.getProfile()).rejects.toMatchObject({ name: 'GmailApiError', status: 401 })
    expect(calls).toBe(2)
    expect(auth.invalidate).toHaveBeenCalledTimes(1)
  })

  it('sendReply: POSTs { raw, threadId } to /messages/send and returns { id, threadId }', async () => {
    const fetchFn = vi.fn(fixtureFetch({ send: sendReplyFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    const response = await client.sendReply({
      threadId: 'thread-100',
      to: 'jane@example.com',
      subject: 'Broken leash',
      inReplyTo: '<abc@mail.example.com>',
      references: '<root@x> <abc@mail.example.com>',
      bodyText: 'Hi Jane,\n\nSorry about that.',
    })

    expect(response).toEqual({ id: 'msg-reply-1', threadId: 'thread-100' })

    // Verify POST body contains raw and threadId
    const [, init] = fetchFn.mock.calls[0]!
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body).toHaveProperty('raw')
    expect(body).toHaveProperty('threadId')
    expect(body.threadId).toBe('thread-100')

    // Verify raw is base64url encoded
    expect(typeof body.raw).toBe('string')
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/)

    // Decode and verify the message contains expected headers
    const text = Buffer.from(body.raw, 'base64url').toString()
    expect(text).toContain('From: support@dogebuddy.com\r\n')
    expect(text).toContain('To: jane@example.com\r\n')
    expect(text).toContain('Subject: Re: Broken leash\r\n')
  })

  it('sendReply: RFC 2047 encodes non-ASCII subjects', async () => {
    const fetchFn = vi.fn(fixtureFetch({ send: sendReplyFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await client.sendReply({
      threadId: 'thread-100',
      to: 'jane@example.com',
      subject: 'Re: Hundeleine kaputt 🐶',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'test',
    })

    const [, init] = fetchFn.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    const text = Buffer.from(body.raw, 'base64url').toString()

    // Should contain RFC 2047 encoded subject
    expect(text).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?\=\r\n/)
  })

  it('sendReply: extraHeaders pass through into the raw message', async () => {
    const fetchFn = vi.fn(fixtureFetch({ send: sendReplyFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await client.sendReply({
      threadId: 'thread-100',
      to: 'jane@example.com',
      subject: 'Broken leash',
      inReplyTo: '<abc@mail.example.com>',
      references: '<root@x> <abc@mail.example.com>',
      bodyText: 'Hi Jane,\n\nSorry about that.',
      extraHeaders: { 'X-DogeBuddy-Proposal': 'abc-123' },
    })

    const [, init] = fetchFn.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    const text = Buffer.from(body.raw, 'base64url').toString()
    expect(text).toContain('X-DogeBuddy-Proposal: abc-123\r\n')
  })

  it('no fixture contains auth material', async () => {
    const dir = new URL('./fixtures/', import.meta.url)
    for (const f of await readdir(dir)) {
      const text = await readFile(new URL(f, dir), 'utf8')
      expect(text.includes('Bearer '), `${f} contains a bearer token`).toBe(false)
      expect(text.includes('PRIVATE KEY'), `${f} contains key material`).toBe(false)
    }
  })
})
