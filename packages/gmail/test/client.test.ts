import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createGmailClient } from '../src/client.ts'
import type { GmailAuth } from '../src/auth.ts'
import { GmailApiError, GmailRateLimitError, HistoryExpiredError, MessageGoneError } from '../src/errors.ts'

import profileFixture from './fixtures/profile.json' with { type: 'json' }
import historyPage1Fixture from './fixtures/history-page1.json' with { type: 'json' }
import historyEmptyFixture from './fixtures/history-empty.json' with { type: 'json' }
import historyPaged1Fixture from './fixtures/history-paged-1.json' with { type: 'json' }
import historyPaged2Fixture from './fixtures/history-paged-2.json' with { type: 'json' }
import history404Fixture from './fixtures/history-404.json' with { type: 'json' }
import messagesListFixture from './fixtures/messages-list.json' with { type: 'json' }
import threadGetFixture from './fixtures/thread-get.json' with { type: 'json' }
import thread404Fixture from './fixtures/thread-404.json' with { type: 'json' }
import messageFullNestedFixture from './fixtures/message-full-nested.json' with { type: 'json' }
import messageFullSinglepartFixture from './fixtures/message-full-singlepart.json' with { type: 'json' }
import messageFullAttachmentOnlyFixture from './fixtures/message-full-attachment-only.json' with { type: 'json' }
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

// Recorded against the live support mailbox with `GMAIL_CONTRACT=1` (scripts/record-fixtures.ts)
// on 2026-08-30 — every id, address, and header literal below is what real Gmail returned, so a
// re-record moves them (update this file in the same commit; see the recorder's header comment).
// The hand-authored fixtures (404/error cases, label-create, send-reply, history-paged-*, the
// proposal-marker metadata case) keep their synthetic `msg-…`/`thread-…` ids.
const NESTED_ID = '1a055078d2151dab' // inbound from Outlook, multipart/alternative
const SINGLEPART_ID = '1a0546e8974d4a47' // OUR sent reply — plain text/plain, carries a real marker
const ATTACHMENT_ONLY_ID = '1a05219fe1efd634' // Google's daily DMARC report: application/zip, no text leaf
const THREAD_ID = '1a050c80ad6eb6d0' // "Shipping time + tracking?" — two inbound + two SENT replies
const OUTLOOK_AUTH_RESULTS =
  'mx.google.com;       dkim=pass header.i=@outlook.com header.s=selector1 header.b=cTyH+z9f;       arc=pass (i=1);       spf=pass (google.com: domain of collinscontracting509@outlook.com designates 2a01:111:f403:d002:: as permitted sender) smtp.mailfrom=CollinsContracting509@outlook.com;       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com'

function decodeLeaf(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

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
      emailAddress: 'support@dogebuddy.com',
      historyId: '5563',
    })
  })

  it('listHistory (recorded): maps a real page — messagesAdded on the arrival record only, label-change records map to an empty list', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ page1: historyPage1Fixture }),
    })

    const page = await client.listHistory({ startHistoryId: '5290' })
    expect(page.nextPageToken).toBeUndefined()
    // Six real records for one inbound message: its arrival (5352), then the poll's own label
    // traffic (labelsAdded Label_2, labelsRemoved UNREAD) and bare `messages`-only records —
    // only the arrival carries messagesAdded; everything else must map to [] and never throw.
    expect(page.records).toEqual([
      { id: '5352', messagesAdded: [{ id: NESTED_ID, threadId: NESTED_ID }] },
      { id: '5478', messagesAdded: [] },
      { id: '5493', messagesAdded: [] },
      { id: '5500', messagesAdded: [] },
      { id: '5501', messagesAdded: [] },
      { id: '5502', messagesAdded: [] },
    ])
  })

  it('listHistory (recorded): from the current historyId real Gmail omits the `history` key entirely — maps to no records', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ empty: historyEmptyFixture }),
    })

    // The shape every quiet poll cycle sees: `{ historyId }` and nothing else.
    expect(historyEmptyFixture.response.body).not.toHaveProperty('history')
    await expect(client.listHistory({ startHistoryId: '5563' })).resolves.toEqual({
      records: [],
      nextPageToken: undefined,
    })
  })

  it('listHistory: pages via startHistoryId + pageToken and maps messagesAdded (hand-authored pair — a real mailbox cannot be made to paginate on demand)', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ page1: historyPaged1Fixture, page2: historyPaged2Fixture }),
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
    const result = await client.listMessages({ q: 'in:inbox' })

    // 17 inbox messages at recording time, newest first; the wire carries only id/threadId pairs.
    expect(result.nextPageToken).toBeUndefined()
    expect(result.ids).toHaveLength(17)
    expect(result.ids[0]).toEqual({ id: NESTED_ID, threadId: NESTED_ID })
    expect(result.ids[1]).toEqual({ id: '1a0546cd45070d07', threadId: THREAD_ID })
    for (const entry of result.ids) {
      expect(entry.id).toMatch(/^[0-9a-f]{16}$/)
      expect(entry.threadId).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('getThread: builds GET /threads/{id}?format=minimal and returns live message ids', async () => {
    const fetchFn = vi.fn(fixtureFetch({ thread: threadGetFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    // A real four-message thread in wire order: customer (spam-foldered), our SENT reply, the
    // customer's follow-up, our SENT follow-up. Snippets/labels/sizes on the wire are dropped.
    await expect(client.getThread(THREAD_ID)).resolves.toEqual({
      messages: [{ id: THREAD_ID }, { id: '1a050cb8f3d313ef' }, { id: '1a0546cd45070d07' }, { id: SINGLEPART_ID }],
    })

    const calledUrl = new URL(String(fetchFn.mock.calls[0]![0]))
    expect(calledUrl.pathname).toBe(`/gmail/v1/users/me/threads/${THREAD_ID}`)
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
    const msg = await client.getMessage(NESTED_ID, { format: 'full' })

    expect(msg.id).toBe(NESTED_ID)
    expect(msg.threadId).toBe(NESTED_ID)
    expect(msg.labelIds).toEqual(['Label_2', 'IMPORTANT', 'CATEGORY_PERSONAL', 'INBOX'])
    expect(msg.internalDate).toEqual(new Date(1_788_132_951_000))
    expect(msg.fromRaw).toBe('Robert Collins <CollinsContracting509@outlook.com>')
    expect(msg.fromAddr).toBe('collinscontracting509@outlook.com') // lowercased
    // Outlook writes `"support@dogebuddy.com" <support@dogebuddy.com>` — display name dropped.
    expect(msg.to).toEqual(['support@dogebuddy.com'])
    expect(msg.cc).toEqual([]) // no Cc header at all on the wire
    expect(msg.deliveredTo).toEqual(['support@dogebuddy.com'])
    expect(msg.subject).toBe("Re: Return request — my dog isn't interested")
    expect(msg.rfcMessageId).toBe('<SA1PR05MB99846352AA70BDB8D69B7A819BEAAA2@SA1PR05MB998463.namprd05.prod.outlook.com>')
    expect(msg.inReplyTo).toBe('<SA1PR05MB998463F33A0C15E728033E86D1EAAA2@SA1PR05MB998463.namprd05.prod.outlook.com>')
    expect(msg.references).toBe('<SA1PR05MB998463F33A0C15E728033E86D1EAAA2@SA1PR05MB998463.namprd05.prod.outlook.com>')

    // multipart/alternative(text/plain, text/html): the depth-first walk must return the
    // text/plain leaf verbatim (Outlook's CRLF line endings included) and never the HTML sibling.
    const parts = messageFullNestedFixture.response.body.payload.parts
    expect(parts.map((p) => p.mimeType)).toEqual(['text/plain', 'text/html'])
    expect(msg.bodyText).toBe(decodeLeaf(parts[0]!.body.data))
    expect(msg.bodyText).toMatch(/^Update — this is about order #1001\. The snuff pad arrived with the seams split open/)
    expect(msg.bodyText).toContain('\r\n')
    expect(msg.bodyText).not.toContain('</')
  })

  it('getMessage(full, nested): authenticationResults is the Authentication-Results header — NOT either of the two ARC-Authentication-Results headers Gmail also stamps', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullNestedFixture }),
    })
    const msg = await client.getMessage(NESTED_ID, { format: 'full' })

    // Real Gmail stamps one Authentication-Results and two ARC-Authentication-Results headers on
    // this message; the lookup must match the header NAME exactly (case-insensitively), not by
    // suffix — the ARC variants would otherwise be mistaken for the money gate's input.
    const names = messageFullNestedFixture.response.body.payload.headers.map((h) => h.name)
    expect(names.filter((n) => n === 'Authentication-Results')).toHaveLength(1)
    expect(names.filter((n) => n === 'ARC-Authentication-Results')).toHaveLength(2)
    expect(msg.authenticationResults).toBe(OUTLOOK_AUTH_RESULTS)
  })

  it('getMessage(full): with two Authentication-Results headers the TOPMOST wins (controller ruling: full format, not just metadata)', async () => {
    // Real inbound mail carries a single Gmail stamp; an upstream relay can append its own further
    // down. Synthesize that on top of the recorded message: Gmail's stays first and must win.
    const body = structuredClone(messageFullNestedFixture.response.body) as {
      payload: { headers: { name: string; value: string }[] }
    }
    body.payload.headers.push({
      name: 'Authentication-Results',
      value: 'relay.example.net; spf=fail smtp.mailfrom=someone@example.net; dmarc=fail',
    })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    const msg = await client.getMessage(NESTED_ID, { format: 'full' })
    expect(msg.authenticationResults).toBe(OUTLOOK_AUTH_RESULTS)
  })

  it('getMessage(full, singlepart): falls back to top-level body.data; a sent copy has no Delivered-To/Cc/Authentication-Results and carries the real proposal marker', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullSinglepartFixture }),
    })
    const msg = await client.getMessage(SINGLEPART_ID, { format: 'full' })

    // No mainstream client sends single-part text/plain any more — OUR replies (buildReplyRaw) are
    // the realistic source of this shape, so the recorded message is the SENT copy of an agent reply.
    expect(msg.labelIds).toEqual(['SENT'])
    expect(msg.bodyText).toBe(decodeLeaf(messageFullSinglepartFixture.response.body.payload.body.data))
    expect(msg.bodyText).toMatch(/^Hi Rob,\n\nHappy to help/)
    expect(msg.fromAddr).toBe('support@dogebuddy.com')
    expect(msg.to).toEqual(['collinscontracting509@outlook.com'])
    expect(msg.cc).toEqual([])
    expect(msg.deliveredTo).toEqual([]) // Gmail stamps Delivered-To on inbound only
    expect(msg.authenticationResults).toBeNull() // …and Authentication-Results likewise
    expect(msg.inReplyTo).toBe('<SA1PR05MB998463BBE5394402B91CBDDA4AEAAA2@SA1PR05MB998463.namprd05.prod.outlook.com>')
    expect(msg.references).toBe(
      '<SA1PR05MB9984632C57E7B7D97E03E3B496EAAA2@SA1PR05MB998463.namprd05.prod.outlook.com> <SA1PR05MB998463BBE5394402B91CBDDA4AEAAA2@SA1PR05MB998463.namprd05.prod.outlook.com>',
    )
    expect(msg.dogeBuddyProposalId).toBe('72b9da79-364c-44c8-b160-d3e8e44a8cc1')

    // Gmail hands OUR `Message-ID` header back as `Message-Id` on the sent copy — the header
    // lookup has to be case-insensitive or every recovery scan would see a null message id.
    const wireHeader = messageFullSinglepartFixture.response.body.payload.headers.find(
      (h) => h.name.toLowerCase() === 'message-id',
    )
    expect(wireHeader?.name).toBe('Message-Id')
    expect(msg.rfcMessageId).toBe(wireHeader?.value)
    expect(msg.rfcMessageId).toMatch(/^<.+@.+>$/)
  })

  it('getMessage(full, attachment-only): a message with no text leaf at all (the daily DMARC zip report) yields bodyText null with headers still normalized', async () => {
    const client = createGmailClient({
      auth: stubAuth(),
      fromAddress: FROM_ADDRESS,
      fetchFn: fixtureFetch({ msg: messageFullAttachmentOnlyFixture }),
    })
    const msg = await client.getMessage(ATTACHMENT_ONLY_ID, { format: 'full' })

    // Real traffic the poll ingests every day: Google's aggregate DMARC report is a single
    // application/zip part with an attachmentId and no inline data — never decoded, never thrown on.
    expect(messageFullAttachmentOnlyFixture.response.body.payload.mimeType).toBe('application/zip')
    expect(msg.bodyText).toBeNull()
    expect(msg.fromAddr).toBe('noreply-dmarc-support@google.com')
    expect(msg.to).toEqual(['support@dogebuddy.com'])
    expect(msg.subject).toBe('Report domain: dogebuddy.com Submitter: google.com Report-ID: 11316150216743750765')
    expect(msg.labelIds).toEqual(['Label_1', 'Label_2', 'IMPORTANT', 'CATEGORY_UPDATES', 'INBOX'])
    expect(msg.authenticationResults).toContain('dmarc=pass')
    expect(msg.dogeBuddyProposalId).toBeNull()
  })

  it('getMessage(metadata): requests format=metadata with repeated metadataHeaders in the required order, bodyText is null', async () => {
    const fetchFn = vi.fn(fixtureFetch({ msg: messageMetadataFixture }))
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })
    const msg = await client.getMessage(SINGLEPART_ID, { format: 'metadata' })

    const calledUrl = new URL(String(fetchFn.mock.calls[0]![0]))
    expect(calledUrl.pathname).toBe(`/gmail/v1/users/me/messages/${SINGLEPART_ID}`)
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

    // A metadata fetch returns ONLY the requested headers and no payload body: Gmail answered with
    // From/To/Subject/In-Reply-To/References/X-DogeBuddy-Proposal/Message-Id for this sent copy.
    expect(msg.bodyText).toBeNull()
    expect(msg.fromAddr).toBe('support@dogebuddy.com')
    expect(msg.to).toEqual(['collinscontracting509@outlook.com'])
    expect(msg.deliveredTo).toEqual([])
    // A sent copy carries no Authentication-Results header at all (Gmail stamps inbound only).
    expect(msg.authenticationResults).toBeNull()
    // …but it does carry our recovery marker — the real wire round-trip of the header
    // `apply-support-reply.ts`'s re-entry scan reads to decide "already sent" vs "send now".
    expect(msg.dogeBuddyProposalId).toBe('72b9da79-364c-44c8-b160-d3e8e44a8cc1')
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
    const msg = await client.getMessage(NESTED_ID, { format: 'metadata' })

    // Gmail's real stamp on the Outlook message, verbatim (multi-space separators included) — the
    // refund sender-auth gate parses exactly this string. An inbound metadata fetch carries no marker.
    expect(msg.authenticationResults).toBe(OUTLOOK_AUTH_RESULTS)
    expect(msg.authenticationResults).toContain('dmarc=pass')
    expect(msg.deliveredTo).toEqual(['support@dogebuddy.com'])
    expect(msg.dogeBuddyProposalId).toBeNull()
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
    const labels = await client.listLabels()

    // 14 system labels + the two the poll created; type/visibility fields on the wire are dropped.
    expect(labels).toHaveLength(16)
    expect(labels).toEqual(
      expect.arrayContaining([
        { id: 'INBOX', name: 'INBOX' },
        { id: 'SENT', name: 'SENT' },
        { id: 'UNREAD', name: 'UNREAD' },
        { id: 'SPAM', name: 'SPAM' },
        { id: 'Label_1', name: 'DogeBuddy/Spam' },
        { id: 'Label_2', name: 'DogeBuddy/New' },
      ]),
    )
    for (const label of labels) expect(Object.keys(label).sort()).toEqual(['id', 'name'])
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

  it('sendReply is EXCLUDED from the timeout retry: a timed-out send is attempted exactly once', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(
      client.sendReply({
        threadId: 'thread-100',
        to: 'jane@example.com',
        subject: 'Broken leash',
        inReplyTo: '<abc@mail.example.com>',
        references: '<abc@mail.example.com>',
        bodyText: 'test',
      }),
    ).rejects.toMatchObject({ name: 'GmailApiError', status: 0, reason: 'timeout' })
    // A timed-out send may already be queued at Gmail; retrying here would put two copies in the
    // customer's inbox from inside one call, and both would carry the same recovery marker.
    expect(calls).toBe(1)
  })

  it('sendReply is EXCLUDED from the 5xx retry: a 503 on send is attempted exactly once', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }),
        { status: 503 },
      )
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(
      client.sendReply({
        threadId: 'thread-100',
        to: 'jane@example.com',
        subject: 'Broken leash',
        inReplyTo: '<abc@mail.example.com>',
        references: '<abc@mail.example.com>',
        bodyText: 'test',
      }),
    ).rejects.toMatchObject({ name: 'GmailApiError', status: 503 })
    expect(calls).toBe(1)
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
    await expect(client.getProfile()).resolves.toEqual({ emailAddress: 'support@dogebuddy.com', historyId: '5563' })

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

  it('sendNew: POSTs { raw } WITHOUT threadId to /messages/send, returns { id, threadId }, and is attempted exactly once on a 503', async () => {
    let calls = 0
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls++
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
      const body = JSON.parse(String(init?.body))
      expect(body).not.toHaveProperty('threadId')
      const text = Buffer.from(body.raw, 'base64url').toString()
      expect(text).toContain(`Message-ID: <form-ack-t${calls}@dogebuddy.com>\r\n`)
      expect(text).not.toContain('In-Reply-To')
      return calls === 1
        ? new Response(JSON.stringify({ id: 'sent-1', threadId: 'thread-new-1' }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 503, message: 'x', errors: [{ reason: 'backendError' }] } }), { status: 503 })
    }) as unknown as typeof fetch
    const client = createGmailClient({ auth: stubAuth(), fromAddress: FROM_ADDRESS, fetchFn })

    await expect(
      client.sendNew({ to: 'jane@example.com', subject: 'We got your message', messageId: '<form-ack-t1@dogebuddy.com>', bodyText: 'Hi' }),
    ).resolves.toEqual({ id: 'sent-1', threadId: 'thread-new-1' })

    await expect(
      client.sendNew({ to: 'jane@example.com', subject: 'x', messageId: '<form-ack-t2@dogebuddy.com>', bodyText: 'Hi' }),
    ).rejects.toMatchObject({ name: 'GmailApiError', status: 503 })
    expect(calls).toBe(2) // one per call — no retry on the send endpoint
  })
})
