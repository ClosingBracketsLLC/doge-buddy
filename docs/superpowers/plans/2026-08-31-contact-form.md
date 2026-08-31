# Contact Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Turnstile-gated `/contact` form on the Hydrogen storefront that becomes a normal support ticket in ops, triggers an acknowledgement email from support@ that *creates* the Gmail thread, and lets the existing 6B reply pipeline answer it threaded.

**Architecture:** Storefront route `/contact` (loader + action) proxies the submission to a new public ops endpoint `POST /public/contact`, which verifies Turnstile server-side, applies the honeypot/caps/fold, and writes the ticket + inbound message + tripwire in one transaction (sharing ingest's per-message bookkeeping via an extracted helper), then enqueues a `support.form-ack` job. The ack job sends a fixed-copy email with a deterministic `Message-ID` via a new `gmail.sendNew`, swaps the ticket's `form:<id>` placeholder thread id for the real one, and records the outbound row; the reply worker learns to hold while the placeholder exists and to thread its first reply onto the ack.

**Tech Stack:** TypeScript (Node 22, ESM, `.ts` imports), Fastify 5, drizzle-orm + Postgres (pg-boss for jobs), zod, vitest (real local DB at `postgres://doge:doge@localhost:5433/doge_buddy`), Hydrogen/React Router 7 on Oxygen, Cloudflare Turnstile.

**Spec:** `docs/superpowers/specs/2026-08-31-contact-form-design.md` — read it first; every task below cites its sections.

## Global Constraints

- Monorepo commands run from the repo root: `pnpm --filter @doge-buddy/<pkg> …`. `apps/ops` `test` is vitest-ONLY; CI gates on a separate `pnpm typecheck` — run BOTH before calling a task green.
- ops tests need the local DB up and migrated: `pnpm db:up` then `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate`. Every test file cleans only its own rows (prefix conventions below) — vitest runs files serially.
- Message-id / thread-id placeholders (spec §3): ticket `gmail_thread_id = 'form:<ticketId>'`; message `gmail_message_id = 'form:<uuid>'`. Never hand a `form:` id to a Gmail call.
- Ack `Message-ID` (spec §4): `<form-ack-<ticketId>@<support address domain>>`. Ack subject: `We got your message — Doge Buddy Support`. Ack body (verbatim, spec §4.3):
  `Hi <name>,\n\nThanks for reaching out — we've received your message and will reply in this email thread, usually within one business day. If you're writing about a damaged or wrong item, please reply here with a photo.\n\nDoge Buddy Support`
- Caps (spec §2): `CONTACT_MAX_PER_DAY = 100` accepted submissions per UTC day; per-sender fold reuses `MAX_TICKETS_PER_SENDER_PER_DAY = 5`.
- Validation (spec §1/§2): name 1–100 chars (trimmed); email trimmed + lower-cased, ≤254, matches `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; order number optional, trimmed, ≤20, matches `/^#?[0-9A-Za-z-]{1,19}$/`; message 10–4000 chars (trimmed); `turnstileToken` non-empty ≤2048; `honeypot` any string.
- Response contract of `POST /public/contact`: `200 {ok:true}`; `400 {ok:false,error:'validation',fields:{<field>:<msg>}}`; `400 {ok:false,error:'turnstile'}`; `429 {ok:false,error:'capped'}`. Route body limit 8 KB, JSON only.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (house rule). Never `git push` — Robert pushes.
- No `pkill -f` on this machine (kills other sessions); kill dev servers by PID.

---

## File map

| File | Responsibility |
|---|---|
| `packages/gmail/src/rfc2822.ts` | + `buildNewRaw` (new-thread message with explicit `Message-ID`), shared assembly with `buildReplyRaw` |
| `packages/gmail/src/types.ts` | + `GmailClient.sendNew` |
| `packages/gmail/src/client.ts` | + `sendNew` (POST `/messages/send`, no threadId, no retry) |
| `packages/gmail/src/mock.ts` | + `sendNew`, `rfc822msgid:`/`in:sent` search in `listMessages` |
| `packages/db/src/schema.ts` + `migrations/0009_*.sql` | `support_tickets.source` |
| `apps/ops/src/support/form-ids.ts` | `isGmailMessageId`, `formPlaceholderThreadId`, `isFormPlaceholder`, `formMessageId` |
| `apps/ops/src/support/ingest.ts` | export `findFloodFoldTarget`; extract `recordInboundOnTicket` |
| `apps/ops/src/support/triage.ts` | `labelSpam` skips `form:` ids |
| `apps/ops/src/support/turnstile.ts` | `verifyTurnstile` |
| `apps/ops/src/config.ts` | `TURNSTILE_SECRET_KEY` → `config.turnstile` |
| `apps/ops/src/http/contact.ts` | `POST /public/contact` plugin |
| `apps/ops/src/jobs/support-form-ack.ts` | ack copy, `support.form-ack` handler, `sweepUnackedFormTickets` |
| `apps/ops/src/jobs/support-poll-gmail.ts` | 5th stage: ack sweep |
| `apps/ops/src/proposals/apply-support-reply.ts` | placeholder guard, In-Reply-To fallback |
| `apps/ops/src/http/admin/render-tickets.ts` + `routes.ts` | "via contact form" badge |
| `apps/ops/src/server.ts` + `index.ts` | register contact routes, ack worker |
| `packages/core/src/policies.ts` | privacy line → `/contact` |
| `apps/storefront/app/lib/contact.ts` | `parseContactForm`, `forwardContact` (pure, tested) |
| `apps/storefront/app/routes/contact.tsx` | page + loader + action |
| `apps/storefront/app/entry.server.tsx`, `components/Footer.tsx`, `.env.example` | CSP, nav link, env docs |
| `docs/OWNER-CHECKLIST.md`, `README.md` | owner click-path, status |

---

### Task 1: `packages/gmail` — `buildNewRaw` + `sendNew` (client + mock)

**Files:**
- Modify: `packages/gmail/src/rfc2822.ts`
- Modify: `packages/gmail/src/types.ts:56-65`
- Modify: `packages/gmail/src/client.ts:350-367`
- Modify: `packages/gmail/src/mock.ts` (`storeMessage` ~148, `listMessages` ~241, `sendReply` ~306)
- Test: `packages/gmail/test/rfc2822.test.ts`, `packages/gmail/test/client.test.ts`, `packages/gmail/test/mock.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildNewRaw(input: { from: string; to: string; subject: string; messageId: string; bodyText: string; extraHeaders?: Record<string,string> }): string` (base64url raw; throws on a malformed `messageId`).
  - `GmailClient.sendNew(r: { to: string; subject: string; messageId: string; bodyText: string; extraHeaders?: Record<string,string> }): Promise<{ id: string; threadId: string }>`.
  - `MockGmail.listMessages({ q: 'in:sent rfc822msgid:<x@y>' })` returns the sent message whose `rfcMessageId === '<x@y>'`; `sendNew` stores the message with `rfcMessageId = r.messageId`, `labelIds ['SENT']`, a NEW thread id, and pushes to `sentMessages()`.

- [ ] **Step 1: Failing test for `buildNewRaw`** — append to `packages/gmail/test/rfc2822.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to see it fail** — `pnpm --filter @doge-buddy/gmail exec vitest run test/rfc2822.test.ts` → FAIL: `buildNewRaw` is not exported.

- [ ] **Step 3: Implement.** In `rfc2822.ts`, extract the tail of `buildReplyRaw` (from `const headers = headerLines.join('\r\n')` to the return) into a shared function and add the new builder:

```ts
export interface BuildNewRawInput {
  from: string
  to: string
  subject: string
  /** RFC 5322 `<local@domain>` — supplied by the caller so a retried send can be FOUND
   * (`rfc822msgid:` search) instead of duplicated. */
  messageId: string
  bodyText: string
  extraHeaders?: Record<string, string>
}

const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/

/** Shared tail of both builders: CRLF headers + blank line + quoted-printable body → base64url. */
function assembleRaw(headerLines: string[], bodyText: string): string {
  const headers = headerLines.join('\r\n')
  const fullMessage = `${headers}\r\n\r\n${encodeQuotedPrintable(bodyText)}`
  const base64 = Buffer.from(fullMessage, 'utf-8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * A NEW-thread message (no In-Reply-To/References, no `Re:`) with an explicit Message-ID — the
 * contact-form acknowledgement. Same sanitizing/encoding as `buildReplyRaw`.
 */
export function buildNewRaw(input: BuildNewRawInput): string {
  const { from, to, subject, messageId, bodyText, extraHeaders } = input
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new Error(`buildNewRaw: Message-ID must be <local@domain>, got "${messageId}"`)
  }
  const headerLines = [
    `From: ${sanitizeHeaderField(from)}`,
    `To: ${sanitizeHeaderField(to)}`,
    `Subject: ${encodeSubjectIfNeeded(sanitizeHeaderField(subject))}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
  ]
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      validateExtraHeaderName(name)
      headerLines.push(`${name}: ${sanitizeHeaderField(value)}`)
    }
  }
  return assembleRaw(headerLines, bodyText)
}
```

and make `buildReplyRaw` end with `return assembleRaw(headerLines, bodyText)` (delete its now-duplicated tail). Keep `validateExtraHeaderName`'s error text (`buildReplyRaw: invalid extra header name`) unchanged — the existing tests match it.

- [ ] **Step 4: Run rfc2822 tests** → PASS (all, including the pre-existing `buildReplyRaw` ones).

- [ ] **Step 5: Failing client test** — append to `packages/gmail/test/client.test.ts` inside `describe('createGmailClient')`:

```ts
  it('sendNew: POSTs { raw } WITHOUT threadId to /messages/send, returns { id, threadId }, and is attempted exactly once on a 503', async () => {
    let calls = 0
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls++
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
      const body = JSON.parse(String(init?.body))
      expect(body).not.toHaveProperty('threadId')
      const text = Buffer.from(body.raw, 'base64url').toString()
      expect(text).toContain('Message-ID: <form-ack-t1@dogebuddy.com>\r\n')
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
```

- [ ] **Step 6: Run it** → FAIL: `client.sendNew is not a function`.

- [ ] **Step 7: Implement.** `types.ts` — add to `GmailClient` after `sendReply`:

```ts
  /** A NEW-thread send (the contact-form ack). Like sendReply, never retried by the client. */
  sendNew(r: {
    to: string
    subject: string
    messageId: string
    bodyText: string
    extraHeaders?: Record<string, string>
  }): Promise<{ id: string; threadId: string }>
```

`client.ts` — import `buildNewRaw` beside `buildReplyRaw` and add after `sendReply`:

```ts
    async sendNew(r) {
      const raw = buildNewRaw({
        from: fromAddress,
        to: r.to,
        subject: r.subject,
        messageId: r.messageId,
        bodyText: r.bodyText,
        extraHeaders: r.extraHeaders,
      })
      const result = (await request('POST', '/messages/send', [], 'send', { raw })) as { id: string; threadId: string }
      return { id: result.id, threadId: result.threadId }
    },
```

(`'send'` is the endpoint tag the retry logic already excludes — same as `sendReply`.)

- [ ] **Step 8: Run client tests** → PASS.

- [ ] **Step 9: Failing mock test** — append to `packages/gmail/test/mock.test.ts`:

```ts
describe('MockGmail.sendNew + rfc822msgid search', () => {
  it('stores a SENT message on a NEW thread with the given Message-ID, findable via in:sent rfc822msgid:', async () => {
    const gmail = createMockGmail({ selfAddress: 'support@dogebuddy.com' })
    const sent = await gmail.sendNew({
      to: 'jane@example.com', subject: 'We got your message', messageId: '<form-ack-t1@dogebuddy.com>', bodyText: 'Hi Jane',
    })
    expect(sent.threadId).not.toBe('')
    const meta = await gmail.getMessage(sent.id, { format: 'metadata' })
    expect(meta.labelIds).toEqual(['SENT'])
    expect(meta.rfcMessageId).toBe('<form-ack-t1@dogebuddy.com>')
    expect(meta.inReplyTo).toBeNull()
    expect(meta.threadId).toBe(sent.threadId)

    const found = await gmail.listMessages({ q: 'in:sent rfc822msgid:<form-ack-t1@dogebuddy.com>' })
    expect(found.ids).toEqual([{ id: sent.id, threadId: sent.threadId }])
    const none = await gmail.listMessages({ q: 'in:sent rfc822msgid:<nope@dogebuddy.com>' })
    expect(none.ids).toEqual([])
    expect(gmail.sentMessages().map((m) => m.id)).toContain(sent.id)
  })
})
```

- [ ] **Step 10: Run it** → FAIL.

- [ ] **Step 11: Implement in `mock.ts`.** (a) `storeMessage`'s input gets `rfcMessageId?: string` and uses `rfcMessageId: input.rfcMessageId ?? `<${id}@mock.gmail>``. (b) add to the `MockGmail`-returned object, after `sendReply`:

```ts
    async sendNew(r) {
      maybeThrowPending('sendNew')
      const raw = buildNewRaw({
        from: selfAddress, to: r.to, subject: r.subject, messageId: r.messageId, bodyText: r.bodyText, extraHeaders: r.extraHeaders,
      })
      const msg = storeMessage({
        threadId: nextThreadId(),
        labelIds: ['SENT'],
        fromRaw: selfAddress,
        to: [r.to],
        subject: r.subject,
        bodyText: r.bodyText,
        rfcMessageId: r.messageId,
        dogeBuddyProposalId: r.extraHeaders?.[PROPOSAL_MARKER_HEADER] ?? null,
      })
      sentRawMessages.push({ id: msg.id, threadId: msg.threadId, raw })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id, threadId: msg.threadId }
    },
```

(c) in `listMessages`, before the loop, parse two more operators and apply them inside the loop:

```ts
      const rfcId = q.q?.match(/rfc822msgid:(<[^>\s]+>)/)?.[1] ?? null
      const sentOnly = /(?:^|\s)in:sent(?:\s|$)/.test(q.q ?? '')
      …
        if (rfcId && msg.rfcMessageId !== rfcId) continue
        if (sentOnly && !msg.labelIds.includes('SENT')) continue
```

Import `buildNewRaw` from `./rfc2822.ts`. Add `sendNew` to `failNext`'s method union automatically (it keys on `keyof GmailClient`).

- [ ] **Step 12: Run the whole package + typecheck** — `pnpm --filter @doge-buddy/gmail test && pnpm --filter @doge-buddy/gmail typecheck` → PASS. Then `pnpm --filter @doge-buddy/ops typecheck` → PASS (nothing in ops implements `GmailClient` by hand except via the mock; if a stub object in a test file fails the new required method, add `sendNew: async () => { throw new Error('unused') }` to that stub).

- [ ] **Step 13: Commit** — `git add packages/gmail && git commit -m "feat(gmail): sendNew + buildNewRaw — new-thread send with explicit Message-ID; mock rfc822msgid search"`.

---

### Task 2: Migration 0009 (`support_tickets.source`) + `form-ids.ts` + triage label guard

**Files:**
- Modify: `packages/db/src/schema.ts:154` (after `claimedOrderNumber`)
- Create: `packages/db/migrations/0009_*.sql` (generated) + `meta/` (generated)
- Create: `apps/ops/src/support/form-ids.ts`
- Modify: `apps/ops/src/support/triage.ts` (`labelSpam`, ~line 465)
- Test: `apps/ops/test/support-form-ids.test.ts`, `apps/ops/test/support-triage.test.ts`

**Interfaces:**
- Produces (from `form-ids.ts`):
  ```ts
  export const FORM_ID_PREFIX = 'form:'
  export function isGmailMessageId(id: string): boolean            // !id.startsWith('form:')
  export function formPlaceholderThreadId(ticketId: string): string // 'form:' + ticketId
  export function isFormPlaceholder(threadId: string): boolean      // startsWith('form:')
  export function formMessageId(): string                          // 'form:' + randomUUID()
  ```
- Produces: `supportTickets.source` column (`'email' | 'form'`, default `'email'`).

- [ ] **Step 1: Schema.** In `packages/db/src/schema.ts` after `claimedOrderNumber`:

```ts
  // Where the ticket's conversation began: 'email' (Gmail ingest) or 'form' (the storefront
  // contact form — `gmail_thread_id` starts life as the `form:<ticketId>` placeholder until the
  // ack job swaps in the real Gmail thread; see support/form-ids.ts).
  source: text('source').notNull().default('email'),
```

- [ ] **Step 2: Generate + apply** — `pnpm --filter @doge-buddy/db generate` (expect `migrations/0009_<name>.sql` containing `ALTER TABLE "support_tickets" ADD COLUMN "source" text DEFAULT 'email' NOT NULL;`) then `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate` → `migrations applied`.

- [ ] **Step 3: Failing unit test** — create `apps/ops/test/support-form-ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formMessageId, formPlaceholderThreadId, isFormPlaceholder, isGmailMessageId } from '../src/support/form-ids.ts'

describe('form ids', () => {
  it('placeholder thread id and message ids carry the form: prefix; real Gmail ids do not', () => {
    expect(formPlaceholderThreadId('abc')).toBe('form:abc')
    expect(isFormPlaceholder('form:abc')).toBe(true)
    expect(isFormPlaceholder('1a050c80ad6eb6d0')).toBe(false)
    expect(isGmailMessageId('1a050c80ad6eb6d0')).toBe(true)
    expect(isGmailMessageId(formMessageId())).toBe(false)
    expect(formMessageId()).toMatch(/^form:[0-9a-f-]{36}$/)
    expect(formMessageId()).not.toBe(formMessageId())
  })
})
```

- [ ] **Step 4: Run** → FAIL (module missing). **Implement** `apps/ops/src/support/form-ids.ts`:

```ts
import { randomUUID } from 'node:crypto'

/**
 * Contact-form tickets (spec §3) have no Gmail message behind their first inbound and no Gmail
 * thread until the ack job creates one. Both ids use this prefix so every Gmail-touching path can
 * tell them apart with one check — `gmail_message_id`/`gmail_thread_id` stay NOT NULL UNIQUE.
 */
export const FORM_ID_PREFIX = 'form:'

export function isGmailMessageId(id: string): boolean {
  return !id.startsWith(FORM_ID_PREFIX)
}

export function formPlaceholderThreadId(ticketId: string): string {
  return `${FORM_ID_PREFIX}${ticketId}`
}

export function isFormPlaceholder(threadId: string): boolean {
  return threadId.startsWith(FORM_ID_PREFIX)
}

export function formMessageId(): string {
  return `${FORM_ID_PREFIX}${randomUUID()}`
}
```

- [ ] **Step 5: Failing triage test** — in `apps/ops/test/support-triage.test.ts`, inside `describe('runTriage')`, add (uses the file's `seedTicket`/`seedMessage`/`verdict`/`makeDeps` helpers; `seedMessage` accepts `gmailMessageId`):

```ts
  it('a spam verdict on a form ticket labels only its REAL Gmail messages — a form: id never reaches applyLabel', async () => {
    const id = await seedTicket({ customerEmail: 'bulk@example.com', subject: 'Contact form: buy now' })
    await seedMessage(id, { bodyText: 'buy now', gmailMessageId: 'form:11111111-1111-1111-1111-111111111111' })
    const real = gmail.receiveInbound({ from: 'bulk@example.com', to: ['support@dogebuddy.com'], subject: 'Re: buy now', bodyText: 'again' })
    await seedMessage(id, { bodyText: 'again', gmailMessageId: real.id })
    const modify = vi.spyOn(gmail, 'modifyMessage')

    await runTriage(makeDeps(async () => verdict({ is_spam: true, category: 'other' })))

    expect((await ticketById(id))!.status).toBe('resolved')
    expect(modify.mock.calls.map(([mid]) => mid)).toEqual([real.id])
    expect(alert).not.toHaveBeenCalled()
  })
```

- [ ] **Step 6: Run** → FAIL (MockGmail throws/alerts on the unknown `form:` id). **Implement** in `triage.ts` `labelSpam`: import `isGmailMessageId` from `./form-ids.ts` and change the loop to

```ts
  for (const message of messages) {
    // A contact-form message has no Gmail message behind it (spec §3) — nothing to label.
    if (!isGmailMessageId(message.gmailMessageId)) continue
    await applyLabel(deps.gmail, labels, deps.alert, message.gmailMessageId, SPAM_LABEL)
  }
```

- [ ] **Step 7: Run** `pnpm --filter @doge-buddy/ops exec vitest run test/support-form-ids.test.ts test/support-triage.test.ts` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 8: Commit** — `git add packages/db apps/ops/src/support/form-ids.ts apps/ops/src/support/triage.ts apps/ops/test/support-form-ids.test.ts apps/ops/test/support-triage.test.ts && git commit -m "feat(support): migration 0009 support_tickets.source + form: id helpers; spam labeling skips form messages"`.

---

### Task 3: Ingest refactor — export `findFloodFoldTarget`, extract `recordInboundOnTicket`

**Files:**
- Modify: `apps/ops/src/support/ingest.ts` (the transaction block ~lines 355-405, `findFloodFoldTarget` ~493)
- Test: `apps/ops/test/support-ingest.test.ts` (existing suite must stay green untouched) + one new test

**Interfaces:**
- Produces:
  ```ts
  export async function findFloodFoldTarget(tx: Tx, now: Date, customerEmail: string | null): Promise<{ id: string } | null>
  export interface InboundBookkeepingInput { ticketId: string; subject: string | null; bodyText: string | null; sentAt: Date; gmailSpam: boolean }
  /** last_inbound_at GREATEST + gmail_spam CASE, guarded reopen, code tripwire. Returns the keyword that flipped the ticket, else null. */
  export async function recordInboundOnTicket(tx: Tx, input: InboundBookkeepingInput): Promise<string | null>
  export type Tx = …  // export the existing alias
  ```
- Consumed by Task 5.

- [ ] **Step 1: Failing test** (new behaviour the contact route needs: the References fallback must attach a reply to the ack, an OUTBOUND row). Add to `support-ingest.test.ts`:

```ts
  it('a customer reply whose In-Reply-To names an OUTBOUND message of ours (the form ack) attaches to that ticket even under a brand-new Gmail thread id', async () => {
    await seedSyncState()
    const [ticket] = await db.insert(supportTickets).values({
      gmailThreadId: 'ack-thread-1', customerEmail: 'jane@example.com', subject: 'Contact form: hello', status: 'triaged', source: 'form',
    }).returning({ id: supportTickets.id })
    await db.insert(supportMessages).values({
      ticketId: ticket!.id, gmailMessageId: 'ack-sent-1', direction: 'outbound', fromEmail: SUPPORT,
      bodyText: 'Thanks', rfcMessageId: '<form-ack-x@dogebuddy.com>', sentAt: new Date(),
    })
    gmail.receiveInbound({
      from: 'jane@example.com', to: [SUPPORT], subject: 'Re: We got your message', bodyText: 'here is more',
      inReplyTo: '<form-ack-x@dogebuddy.com>', references: '<form-ack-x@dogebuddy.com>',
    })

    await runIngest(deps)

    const msgs = await messagesOfTicket(ticket!.id)
    expect(msgs.map((m) => m.direction)).toEqual(['outbound', 'inbound'])
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, ticket!.id)))[0]!.status).toBe('new')
  })
```

(Add `'ack-thread-1'` cleanup: the file's afterEach deletes by a thread-id prefix — check its `like(...)` pattern and use a thread id that matches it, e.g. prefix the id with the file's prefix constant.)

- [ ] **Step 2: Run** → it should already PASS (`findTicketByReferences` has no direction filter; reopen from `triaged`? — NO: reopen only covers `resolved`/`waiting_on_customer`, so status stays `triaged`). Fix the assertion: expect `'triaged'`, and assert `lastInboundAt` moved forward instead. Re-run → PASS. This test is the regression guard for the refactor below.

- [ ] **Step 3: Refactor.** In `ingest.ts`: (a) `export` the `Tx` type alias and `findFloodFoldTarget`. (b) Add, above `ingestMessageId`:

```ts
export interface InboundBookkeepingInput {
  ticketId: string
  subject: string | null
  bodyText: string | null
  sentAt: Date
  /** Whether this message sat in Gmail's SPAM folder (always false for contact-form messages). */
  gmailSpam: boolean
}

/**
 * Everything a ticket must reflect once an INBOUND message row has been inserted for it, in the
 * caller's transaction: `last_inbound_at` (GREATEST — history can hand us an older message after a
 * newer one) with `gmail_spam` moved in step (CASE on the pre-update value), the guarded reopen
 * of a `resolved`/`waiting_on_customer` ticket (budgets + redraft cycle reset), and the code
 * tripwire. Shared by Gmail ingest and the contact-form endpoint (spec 2026-08-31 §2 step 5) so the
 * two inbound paths cannot drift. Returns the tripwire keyword that flipped the ticket, else null.
 */
export async function recordInboundOnTicket(tx: Tx, input: InboundBookkeepingInput): Promise<string | null> {
  const inboundAt = input.sentAt.toISOString()
  await tx
    .update(supportTickets)
    .set({
      lastInboundAt: sql`greatest(${supportTickets.lastInboundAt}, ${inboundAt}::timestamptz)`,
      gmailSpam: sql`case
        when ${inboundAt}::timestamptz >= coalesce(${supportTickets.lastInboundAt}, '-infinity'::timestamptz)
        then ${input.gmailSpam}
        else ${supportTickets.gmailSpam}
      end`,
    })
    .where(eq(supportTickets.id, input.ticketId))

  await tx
    .update(supportTickets)
    .set({ status: 'new', triageFailureCount: 0, agentFailureCount: 0, ...clearRedraftCycle() })
    .where(and(eq(supportTickets.id, input.ticketId), inArray(supportTickets.status, ['resolved', 'waiting_on_customer'])))

  const keyword = tripwireHit(input.subject, input.bodyText)
  if (!keyword) return null
  const escalated = await tx
    .update(supportTickets)
    .set({
      status: 'escalated',
      escalationReason: `tripwire: ${keyword}`,
      escalationNotifiedAt: null,
      ...clearRedraftCycle(),
    })
    .where(and(eq(supportTickets.id, input.ticketId), ne(supportTickets.status, 'escalated')))
    .returning({ id: supportTickets.id })
  return escalated.length > 0 ? keyword : null
}
```

(c) In `ingestMessageId`'s transaction, replace the three statements (the GREATEST/gmail_spam update, the reopen update, the tripwire block) with:

```ts
    const tripwireKeyword = await recordInboundOnTicket(tx, {
      ticketId: ticket.id,
      subject: full.subject,
      bodyText: full.bodyText,
      sentAt: full.internalDate,
      gmailSpam: full.labelIds.includes('SPAM'),
    })
    const outcome: MessageOutcome = { ticketId: ticket.id, inserted: true, direction, folded, tripwireKeyword }
    return outcome
```

Move the explanatory comments (IMPORTANT 3, CRITICAL 1, the `gmail_spam` note) onto the helper so nothing is lost.

- [ ] **Step 4: Run** `pnpm --filter @doge-buddy/ops exec vitest run test/support-ingest.test.ts test/support-poll-job.test.ts test/support-agent.e2e.test.ts` → PASS, all unchanged tests included. `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "refactor(support): extract recordInboundOnTicket + export findFloodFoldTarget for the contact-form path"` (add the test file explicitly).

---

### Task 4: Config `TURNSTILE_SECRET_KEY` + `verifyTurnstile`

**Files:**
- Modify: `apps/ops/src/config.ts` (schema line ~35, `Config` ~120, `loadConfig` tail)
- Create: `apps/ops/src/support/turnstile.ts`
- Test: `apps/ops/test/config.test.ts` (exists — append), `apps/ops/test/support-turnstile.test.ts`

**Interfaces:**
- Produces: `config.turnstile?: { secretKey: string }`;
  ```ts
  export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
  export interface VerifyTurnstileInput { secretKey: string; token: string; remoteIp: string | null; fetchFn?: typeof fetch; timeoutMs?: number }
  export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<{ ok: boolean; errorCodes: string[] }>
  ```
  Never throws: a network error / timeout / non-JSON body → `{ ok: false, errorCodes: ['network'] }`.

- [ ] **Step 1: Failing config test** — append to `apps/ops/test/config.test.ts` (mirror how that file builds a minimal env — it has a `baseEnv`/`DATABASE_URL` fixture; reuse it):

```ts
  it('TURNSTILE_SECRET_KEY → config.turnstile; absent → undefined', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).turnstile).toBeUndefined()
    expect(loadConfig({ DATABASE_URL: 'postgres://x', TURNSTILE_SECRET_KEY: '0xsecret' }).turnstile).toEqual({ secretKey: '0xsecret' })
  })
```

- [ ] **Step 2: Run** → FAIL. **Implement**: schema `TURNSTILE_SECRET_KEY: z.string().min(1).optional(),`; `Config` gets `turnstile?: { secretKey: string }`; `loadConfig`: `if (data.TURNSTILE_SECRET_KEY !== undefined) config.turnstile = { secretKey: data.TURNSTILE_SECRET_KEY }`.

- [ ] **Step 3: Failing verify test** — create `apps/ops/test/support-turnstile.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from '../src/support/turnstile.ts'

describe('verifyTurnstile', () => {
  it('POSTs form-encoded secret/response/remoteip and returns ok on success:true', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TURNSTILE_VERIFY_URL)
      expect(init?.method).toBe('POST')
      const params = new URLSearchParams(String(init?.body))
      expect(params.get('secret')).toBe('sec')
      expect(params.get('response')).toBe('tok')
      expect(params.get('remoteip')).toBe('203.0.113.9')
      return new Response(JSON.stringify({ success: true, hostname: 'dogebuddy.com' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 'sec', token: 'tok', remoteIp: '203.0.113.9', fetchFn })).resolves.toEqual({ ok: true, errorCodes: [] })
  })

  it('omits remoteip when unknown and surfaces error-codes on failure', async () => {
    const fetchFn = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).has('remoteip')).toBe(false)
      return new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 'sec', token: 'tok', remoteIp: null, fetchFn })).resolves.toEqual({ ok: false, errorCodes: ['timeout-or-duplicate'] })
  })

  it('never throws: a thrown fetch, a 5xx, or a non-JSON body all fail closed', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: boom })).resolves.toEqual({ ok: false, errorCodes: ['network'] })
    const five = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch
    await expect(verifyTurnstile({ secretKey: 's', token: 't', remoteIp: null, fetchFn: five })).resolves.toEqual({ ok: false, errorCodes: ['network'] })
  })
})
```

- [ ] **Step 4: Run** → FAIL. **Implement** `apps/ops/src/support/turnstile.ts`:

```ts
/** Cloudflare Turnstile server-side verification (spec 2026-08-31 §2 step 3). */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DEFAULT_TIMEOUT_MS = 5_000

export interface VerifyTurnstileInput {
  secretKey: string
  token: string
  remoteIp: string | null
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * Fails CLOSED: any transport problem is `ok:false` with `['network']` — the caller answers 400
 * and the visitor retries. Tokens are single-use on Cloudflare's side, so a replayed submission
 * fails here by construction.
 */
export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<{ ok: boolean; errorCodes: string[] }> {
  const fetchFn = input.fetchFn ?? fetch
  const body = new URLSearchParams({ secret: input.secretKey, response: input.token })
  if (input.remoteIp) body.set('remoteip', input.remoteIp)
  try {
    const res = await fetchFn(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, errorCodes: ['network'] }
    const json = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    return { ok: json.success === true, errorCodes: json.success === true ? [] : (json['error-codes'] ?? ['unknown']) }
  } catch {
    return { ok: false, errorCodes: ['network'] }
  }
}
```

- [ ] **Step 5: Run both test files + `pnpm typecheck`** → PASS. **Commit** — `git commit -m "feat(ops): TURNSTILE_SECRET_KEY config + verifyTurnstile (fail-closed siteverify)"`.

---

### Task 5: `POST /public/contact` (ops)

**Files:**
- Create: `apps/ops/src/http/contact.ts`
- Modify: `apps/ops/src/server.ts` (ServerDeps + register), `apps/ops/src/index.ts` (deps wiring, near `actionDeps`)
- Test: `apps/ops/test/http-contact.test.ts`

**Interfaces:**
- Consumes: Task 2 (`formPlaceholderThreadId`, `formMessageId`), Task 3 (`findFloodFoldTarget`, `recordInboundOnTicket`, `MAX_TICKETS_PER_SENDER_PER_DAY`), Task 4 (`verifyTurnstile`).
- Produces:
  ```ts
  export const CONTACT_MAX_PER_DAY = 100
  export const FORM_SUBMISSION_ACTION = 'support.form_submission'
  export const FORM_HONEYPOT_ACTION = 'support.form_honeypot'
  export const FORM_CAPPED_ACTION = 'support.form_capped'
  export const FORM_ACK_QUEUE = 'support.form-ack'          // canonical home: Task 6 re-exports from jobs/support-form-ack.ts — define it THERE and import it here
  export interface ContactRouteDeps { db: Db; enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>; alert: Alert; turnstileSecretKey: string; verify?: typeof verifyTurnstile; now?: () => Date }
  export function contactRoutes(deps: ContactRouteDeps): FastifyPluginAsync
  export function buildTicketSubject(message: string, orderNumber: string | null): string
  export function buildFormBody(name: string, orderNumber: string | null, message: string): string
  ```
  Ack job send options (used here, defined in Task 6 as `FORM_ACK_SEND_OPTS`): `{ singletonKey: ticketId, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 120 }`.

> Ordering note: Task 6 defines `FORM_ACK_QUEUE`/`FORM_ACK_SEND_OPTS` in `jobs/support-form-ack.ts`. To keep this task independently green, create that file NOW with only those two exports (Task 6 fills in the rest):
> ```ts
> import type { SendOpts } from '../fulfillment/types.ts'
> export const FORM_ACK_QUEUE = 'support.form-ack'
> export const FORM_ACK_SEND_OPTS = (ticketId: string): SendOpts => ({ singletonKey: ticketId, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 120 })
> ```

- [ ] **Step 1: Failing tests** — create `apps/ops/test/http-contact.test.ts` (route-level via `buildServer`, like `admin-*.test.ts` files do; if those use `app.inject`, do the same):

```ts
import { auditLog, createDb, supportMessages, supportTickets } from '@doge-buddy/db'
import { and, eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.ts'
import { CONTACT_MAX_PER_DAY, FORM_CAPPED_ACTION, FORM_HONEYPOT_ACTION, FORM_SUBMISSION_ACTION, type ContactRouteDeps } from '../src/http/contact.ts'
import { FORM_ACK_QUEUE } from '../src/jobs/support-form-ack.ts'
import { MAX_TICKETS_PER_SENDER_PER_DAY } from '../src/support/ingest.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
const EMAIL = 'contact-test@example.com'
const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z')

function valid(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Rob', email: EMAIL, orderNumber: '', message: 'Hi there, my snuff pad question is here.',
    turnstileToken: 'tok', honeypot: '', ip: '203.0.113.9', ...overrides,
  }
}

describe('POST /public/contact', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  let enqueue: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>
  let verify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    enqueue = vi.fn(async () => {})
    alert = vi.fn(async () => {})
    verify = vi.fn(async () => ({ ok: true, errorCodes: [] as string[] }))
  })

  afterEach(async () => {
    const rows = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ids))
      await db.delete(supportTickets).where(inArray(supportTickets.id, ids))
    }
    await db.delete(auditLog).where(inArray(auditLog.action, [FORM_SUBMISSION_ACTION, FORM_HONEYPOT_ACTION, FORM_CAPPED_ACTION]))
  })

  function app(overrides: Partial<ContactRouteDeps> = {}) {
    const deps: ContactRouteDeps = {
      db, enqueue: enqueue as never, alert: alert as never, turnstileSecretKey: 'sec',
      verify: verify as never, now: () => FIXED_NOW, ...overrides,
    }
    return buildServer({ pool, isQueueReady: () => true, contact: deps })
  }
  const post = (server: ReturnType<typeof buildServer>, payload: unknown) =>
    server.inject({ method: 'POST', url: '/public/contact', payload })

  it('happy path: verifies Turnstile with the ip, creates a form ticket + inbound message + audit row in one go, enqueues the ack', async () => {
    const res = await post(app(), valid({ orderNumber: '#1001' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ secretKey: 'sec', token: 'tok', remoteIp: '203.0.113.9' }))

    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket).toMatchObject({ source: 'form', status: 'new', subject: 'Contact form: order #1001', gmailSpam: false, lastInboundAt: FIXED_NOW })
    expect(ticket!.gmailThreadId).toBe(`form:${ticket!.id}`)
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, ticket!.id))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ direction: 'inbound', fromEmail: EMAIL, rfcMessageId: null, sentAt: FIXED_NOW })
    expect(msgs[0]!.gmailMessageId).toMatch(/^form:/)
    expect(msgs[0]!.bodyText).toBe('Name: Rob\nOrder number (claimed): #1001\n\nHi there, my snuff pad question is here.')
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, FORM_SUBMISSION_ACTION), eq(auditLog.entityId, ticket!.id)))
    expect(audits).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledWith(FORM_ACK_QUEUE, { ticketId: ticket!.id }, expect.objectContaining({ singletonKey: ticket!.id, retryLimit: 5 }))
  })

  it('subject falls back to the first 60 chars of the message (single line) when no order number is given', async () => {
    const long = 'Line one of a very long message that keeps going\nand going well past sixty characters in total length.'
    await post(app(), valid({ message: long }))
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket!.subject).toBe(`Contact form: ${long.replace(/\s+/g, ' ').slice(0, 60)}`)
  })

  it('honeypot filled → 200 ok, nothing stored, one honeypot audit row, Turnstile never called', async () => {
    const res = await post(app(), valid({ honeypot: 'http://spam' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(verify).not.toHaveBeenCalled()
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_HONEYPOT_ACTION))).toHaveLength(1)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('validation: bad email, short message, long name, bad order number → 400 with per-field messages; nothing stored', async () => {
    const res = await post(app(), valid({ email: 'nope', message: 'short', name: 'x'.repeat(101), orderNumber: 'not an order' }))
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('validation')
    expect(Object.keys(body.fields).sort()).toEqual(['email', 'message', 'name', 'orderNumber'])
    expect(verify).not.toHaveBeenCalled()
  })

  it('Turnstile failure → 400 turnstile, nothing stored', async () => {
    verify.mockResolvedValueOnce({ ok: false, errorCodes: ['invalid-input-response'] })
    const res = await post(app(), valid())
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ ok: false, error: 'turnstile' })
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toEqual([])
  })

  it('daily cap: the 101st accepted submission of the UTC day → 429 + ONE capped warning per day', async () => {
    await db.insert(auditLog).values(Array.from({ length: CONTACT_MAX_PER_DAY }, () => ({ actor: 'system', action: FORM_SUBMISSION_ACTION, detail: {}, createdAt: FIXED_NOW })))
    const server = app()
    const res = await post(server, valid())
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ ok: false, error: 'capped' })
    expect(alert).toHaveBeenCalledWith('warning', 'support_form_capped', expect.any(Object))
    const again = await post(server, valid())
    expect(again.statusCode).toBe(429)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_CAPPED_ACTION))).toHaveLength(1)
  })

  it('per-sender fold: the 6th ticket in a UTC day lands as a message on the sender\'s newest ticket (no new ticket, no ack job)', async () => {
    const server = app()
    for (let i = 0; i < MAX_TICKETS_PER_SENDER_PER_DAY; i++) expect((await post(server, valid({ message: `message number ${i} here` }))).statusCode).toBe(200)
    enqueue.mockClear()
    const res = await post(server, valid({ message: 'one more message from me' }))
    expect(res.statusCode).toBe(200)
    const tickets = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(tickets).toHaveLength(MAX_TICKETS_PER_SENDER_PER_DAY)
    const msgCounts = await Promise.all(tickets.map(async (t) => (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, t.id))).length))
    expect(msgCounts.reduce((a, b) => a + b, 0)).toBe(MAX_TICKETS_PER_SENDER_PER_DAY + 1)
    expect(enqueue).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warning', 'support_sender_flood', expect.objectContaining({ customerEmail: EMAIL }))
  })

  it('tripwire: a keyword in the message escalates the ticket with escalation_notified_at null', async () => {
    await post(app(), valid({ message: 'If this is not fixed I will file a chargeback with my bank today.' }))
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    expect(ticket!.status).toBe('escalated')
    expect(ticket!.escalationReason).toBe('tripwire: chargeback')
    expect(ticket!.escalationNotifiedAt).toBeNull()
  })

  it('atomic: a failing ack enqueue does NOT lose the ticket (enqueue runs after commit; failure is alerted, the poll sweep re-enqueues)', async () => {
    enqueue.mockRejectedValueOnce(new Error('boss down'))
    const res = await post(app(), valid())
    expect(res.statusCode).toBe(200)
    expect(await db.select().from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))).toHaveLength(1)
    expect(alert).toHaveBeenCalledWith('warning', 'support_form_ack_enqueue_failed', expect.any(Object))
  })

  it('rejects non-JSON and oversized bodies without touching the DB', async () => {
    const server = app()
    const res = await server.inject({ method: 'POST', url: '/public/contact', payload: 'name=x', headers: { 'content-type': 'text/plain' } })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const big = await post(server, valid({ message: 'a'.repeat(9000) }))
    expect(big.statusCode).toBe(413)
  })
})
```

> Spec §2 step 5 said "enqueue from inside the tx". pg-boss's `send` uses its own connection, so the plan implements the equivalent guarantee differently: enqueue **after commit** with an alert on failure, plus the poll's ack **sweep** (Task 6) that re-enqueues any form ticket still on its placeholder after 2 minutes. Net effect is the same "no ticket without an ack" property; note this in the spec when Task 10 updates it.

- [ ] **Step 2: Run** → FAIL (`contact.ts` missing; `buildServer` rejects `contact`).

- [ ] **Step 3: Implement `apps/ops/src/http/contact.ts`:**

```ts
import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { SendOpts } from '../fulfillment/types.ts'
import { FORM_ACK_QUEUE, FORM_ACK_SEND_OPTS } from '../jobs/support-form-ack.ts'
import { formMessageId, formPlaceholderThreadId } from '../support/form-ids.ts'
import { findFloodFoldTarget, MAX_TICKETS_PER_SENDER_PER_DAY, recordInboundOnTicket, type Alert } from '../support/ingest.ts'
import { verifyTurnstile } from '../support/turnstile.ts'

type Db = ReturnType<typeof createDb>['db']

/** Accepted submissions per UTC day — a flood costs at most this many ack emails (spec §2.4). */
export const CONTACT_MAX_PER_DAY = 100
export const FORM_SUBMISSION_ACTION = 'support.form_submission'
export const FORM_HONEYPOT_ACTION = 'support.form_honeypot'
export const FORM_CAPPED_ACTION = 'support.form_capped'
const BODY_LIMIT_BYTES = 8 * 1024

export interface ContactRouteDeps {
  db: Db
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
  turnstileSecretKey: string
  /** Injectable seam for tests; production uses the real siteverify call. */
  verify?: typeof verifyTurnstile
  now?: () => Date
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORDER_RE = /^#?[0-9A-Za-z-]{1,19}$/

const SubmissionSchema = z.object({
  name: z.string().trim().min(1, 'Please tell us your name').max(100, 'Name is too long'),
  email: z.string().trim().toLowerCase().max(254, 'Email is too long').regex(EMAIL_RE, 'Enter a valid email address'),
  orderNumber: z.string().trim().max(20, 'Order number is too long').regex(ORDER_RE, 'That does not look like an order number').or(z.literal('')),
  message: z.string().trim().min(10, 'Tell us a little more (at least 10 characters)').max(4000, 'Message is too long (4000 characters max)'),
  turnstileToken: z.string().min(1, 'Verification is required').max(2048),
  honeypot: z.string().max(2048).default(''),
  ip: z.string().max(64).nullable().default(null),
})

export function buildTicketSubject(message: string, orderNumber: string | null): string {
  if (orderNumber) return `Contact form: order ${orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`}`
  return `Contact form: ${message.replace(/\s+/g, ' ').slice(0, 60)}`
}

export function buildFormBody(name: string, orderNumber: string | null, message: string): string {
  return `Name: ${name}\nOrder number (claimed): ${orderNumber ?? '—'}\n\n${message}`
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * `POST /public/contact` (spec 2026-08-31 §2). Registered only when Gmail AND Turnstile are
 * configured (index.ts) — without either the route does not exist and the storefront shows its
 * "unavailable" copy. Check order is a hard sequence: honeypot → validation → Turnstile → daily cap
 * → one transaction (fold | create ticket; inbound row; shared inbound bookkeeping incl. tripwire;
 * submission audit) → enqueue the ack AFTER commit (failure alerted; the poll sweep re-enqueues).
 */
export function contactRoutes(deps: ContactRouteDeps): FastifyPluginAsync {
  const verify = deps.verify ?? verifyTurnstile
  const now = deps.now ?? (() => new Date())

  return async (app) => {
    app.post('/public/contact', { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const raw = request.body
      if (typeof raw !== 'object' || raw === null) {
        return reply.code(400).send({ ok: false, error: 'validation', fields: { body: 'Expected a JSON object' } })
      }
      const honeypot = (raw as { honeypot?: unknown }).honeypot
      if (typeof honeypot === 'string' && honeypot.trim() !== '') {
        await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_HONEYPOT_ACTION, detail: {} })
        return reply.code(200).send({ ok: true })
      }

      const parsed = SubmissionSchema.safeParse(raw)
      if (!parsed.success) {
        const fields: Record<string, string> = {}
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? 'body')
          if (!(key in fields)) fields[key] = issue.message
        }
        return reply.code(400).send({ ok: false, error: 'validation', fields })
      }
      const input = parsed.data
      const orderNumber = input.orderNumber === '' ? null : input.orderNumber

      const turnstile = await verify({ secretKey: deps.turnstileSecretKey, token: input.turnstileToken, remoteIp: input.ip })
      if (!turnstile.ok) return reply.code(400).send({ ok: false, error: 'turnstile' })

      const midnight = utcMidnight(now())
      const [accepted] = await deps.db
        .select({ value: count() })
        .from(auditLog)
        .where(and(eq(auditLog.action, FORM_SUBMISSION_ACTION), gte(auditLog.createdAt, midnight)))
      if ((accepted?.value ?? 0) >= CONTACT_MAX_PER_DAY) {
        await warnCapped(deps, midnight)
        return reply.code(429).send({ ok: false, error: 'capped' })
      }

      const at = now()
      const subject = buildTicketSubject(input.message, orderNumber)
      const bodyText = buildFormBody(input.name, orderNumber, input.message)

      const outcome = await deps.db.transaction(async (tx) => {
        const foldTarget = await findFloodFoldTarget(tx, at, input.email)
        let ticketId: string
        if (foldTarget) {
          ticketId = foldTarget.id
        } else {
          const [created] = await tx
            .insert(supportTickets)
            .values({ gmailThreadId: 'pending', customerEmail: input.email, subject, status: 'new', source: 'form' })
            .returning({ id: supportTickets.id })
          ticketId = created!.id
          await tx.update(supportTickets).set({ gmailThreadId: formPlaceholderThreadId(ticketId) }).where(eq(supportTickets.id, ticketId))
        }
        await tx.insert(supportMessages).values({
          ticketId, gmailMessageId: formMessageId(), direction: 'inbound', fromEmail: input.email,
          bodyText, rfcMessageId: null, authResults: null, sentAt: at,
        })
        const tripwireKeyword = await recordInboundOnTicket(tx, { ticketId, subject, bodyText, sentAt: at, gmailSpam: false })
        await tx.insert(auditLog).values({
          actor: 'system', action: FORM_SUBMISSION_ACTION, entityType: 'support_ticket', entityId: ticketId,
          detail: { folded: foldTarget !== null, tripwire: tripwireKeyword },
        })
        return { ticketId, folded: foldTarget !== null }
      })

      if (outcome.folded) {
        await deps.alert('warning', 'support_sender_flood', {
          customerEmail: input.email, foldedOntoTicketId: outcome.ticketId, maxPerDay: MAX_TICKETS_PER_SENDER_PER_DAY, via: 'form',
        }).catch(() => {})
      } else {
        try {
          await deps.enqueue(FORM_ACK_QUEUE, { ticketId: outcome.ticketId }, FORM_ACK_SEND_OPTS(outcome.ticketId))
        } catch (err) {
          await deps.alert('warning', 'support_form_ack_enqueue_failed', {
            ticketId: outcome.ticketId, error: err instanceof Error ? err.message : String(err),
          }).catch(() => {})
        }
      }
      return reply.code(200).send({ ok: true })
    })
  }
}

/** ONE cap warning per UTC day, guarded by that day's audit row (the triage-cap idiom). */
async function warnCapped(deps: ContactRouteDeps, midnight: Date): Promise<void> {
  const [existing] = await deps.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, FORM_CAPPED_ACTION), gte(auditLog.createdAt, midnight)))
    .limit(1)
  if (existing) return
  await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_CAPPED_ACTION, detail: { max: CONTACT_MAX_PER_DAY } })
  await deps.alert('warning', 'support_form_capped', { max: CONTACT_MAX_PER_DAY }).catch(() => {})
}
```

Notes for the implementer: (1) the insert-then-update for the placeholder is because the ticket id is DB-generated — two statements inside the same tx is fine; use a clearly-temporary literal that cannot collide (`'pending:' + randomUUID()` rather than `'pending'`, since `gmail_thread_id` is UNIQUE and two concurrent submissions would collide on `'pending'`). (2) The fold branch must NOT create a second ack (the sender's newest ticket already has, or is getting, one) — hence no enqueue. (3) `Alert` is exported from `support/ingest.ts`.

- [ ] **Step 4: Wire it.** `server.ts`: `ServerDeps` += `contact?: ContactRouteDeps`; after the actions block: `if (deps.contact) app.register(contactRoutes(deps.contact))`. `index.ts`, next to `actionDeps`:

```ts
// `POST /public/contact` (contact-form spec §2): only when Gmail (the ack) AND a Turnstile secret
// exist — otherwise the route must not exist at all, and the storefront shows its unavailable copy.
const contactDeps: ContactRouteDeps | undefined =
  config.gmail && config.turnstile ? { db, enqueue, alert, turnstileSecretKey: config.turnstile.secretKey } : undefined
```

and spread `...(contactDeps ? { contact: contactDeps } : {})` into `buildServer({...})`. Log once after build: `app.log.info(contactDeps ? 'contact form endpoint ARMED' : 'contact form endpoint DISABLED (needs GMAIL_* + TURNSTILE_SECRET_KEY)')`.

- [ ] **Step 5: Run** `pnpm --filter @doge-buddy/ops exec vitest run test/http-contact.test.ts` → PASS; `pnpm typecheck` → PASS. If the 413 assertion fails because Fastify answers 413 only for `content-length` over the limit, keep the assertion (inject sets content-length).

- [ ] **Step 6: Commit** — `git add apps/ops/src/http/contact.ts apps/ops/src/jobs/support-form-ack.ts apps/ops/src/server.ts apps/ops/src/index.ts apps/ops/test/http-contact.test.ts && git commit -m "feat(ops): POST /public/contact — honeypot, Turnstile, daily cap, sender fold, ticket+message+tripwire in one tx, ack enqueue"`.

---

### Task 6: Ack job `support.form-ack` + poll sweep

**Files:**
- Modify (fill in): `apps/ops/src/jobs/support-form-ack.ts`
- Modify: `apps/ops/src/jobs/support-poll-gmail.ts` (deps + 5th stage), `apps/ops/src/index.ts` (queue + worker + poll deps)
- Test: `apps/ops/test/support-form-ack.test.ts`, `apps/ops/test/support-validator.test.ts` (ack copy), `apps/ops/test/support-poll-job.test.ts` (stage wiring)

**Interfaces:**
- Consumes: Task 1 (`gmail.sendNew`, `listMessages` rfc822msgid), Task 2 (`isFormPlaceholder`).
- Produces:
  ```ts
  export const FORM_ACK_QUEUE = 'support.form-ack'
  export const FORM_ACK_SEND_OPTS: (ticketId: string) => SendOpts
  export const FORM_ACK_SUBJECT = 'We got your message — Doge Buddy Support'
  export const FORM_ACK_SENT_ACTION = 'support.form_ack_sent'
  export const FORM_ACK_SKIPPED_ACTION = 'support.form_ack_skipped'
  export const FORM_ACK_SWEEP_AFTER_MS = 2 * 60_000
  export function formAckMessageId(ticketId: string, supportAddress: string): string  // `<form-ack-${ticketId}@${domain}>`
  export function formAckBody(name: string): string
  export function nameFromFormBody(bodyText: string | null): string   // parses "Name: …" first line, falls back to 'there'
  export interface FormAckDeps { db: Db; gmail: GmailClient | null; supportAddress: string; alert: Alert; now?: () => Date }
  export async function executeFormAck(deps: FormAckDeps, ticketId: string): Promise<'sent' | 'recovered' | 'skipped'>
  export function formAckHandler(deps: FormAckDeps): PgBoss.WorkHandler<{ ticketId: string }>   // includeMetadata: alerts `support_form_ack_failed` on the final retry
  export async function sweepUnackedFormTickets(deps: { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }): Promise<{ enqueued: number }>
  ```

- [ ] **Step 1: Failing tests** — create `apps/ops/test/support-form-ack.test.ts`:

```ts
import { auditLog, createDb, supportMessages, supportTickets } from '@doge-buddy/db'
import { createMockGmail, type GmailClient, type MockGmail } from '@doge-buddy/gmail'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORM_ACK_QUEUE, FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION, FORM_ACK_SUBJECT, FORM_ACK_SWEEP_AFTER_MS,
  executeFormAck, formAckBody, formAckHandler, formAckMessageId, nameFromFormBody, sweepUnackedFormTickets,
} from '../src/jobs/support-form-ack.ts'
import { formPlaceholderThreadId } from '../src/support/form-ids.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'
const SUPPORT = 'support@dogebuddy.com'
const EMAIL = 'formack-test@example.com'
const NOW = new Date('2024-06-15T12:00:00.000Z')

describe('support.form-ack', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())
  let gmail: MockGmail
  let alert: ReturnType<typeof vi.fn>
  beforeEach(() => { gmail = createMockGmail({ selfAddress: SUPPORT }); alert = vi.fn(async () => {}) })
  afterEach(async () => {
    const rows = await db.select({ id: supportTickets.id }).from(supportTickets).where(eq(supportTickets.customerEmail, EMAIL))
    const ids = rows.map((r) => r.id)
    if (ids.length) { await db.delete(supportMessages).where(inArray(supportMessages.ticketId, ids)); await db.delete(supportTickets).where(inArray(supportTickets.id, ids)) }
    await db.delete(auditLog).where(inArray(auditLog.action, [FORM_ACK_SENT_ACTION, FORM_ACK_SKIPPED_ACTION]))
  })

  async function seedFormTicket(opts: { createdAt?: Date; acked?: boolean } = {}): Promise<string> {
    const [t] = await db.insert(supportTickets).values({
      gmailThreadId: `formack-tmp-${Math.random()}`, customerEmail: EMAIL, subject: 'Contact form: hi', status: 'new', source: 'form',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning({ id: supportTickets.id })
    await db.update(supportTickets).set({ gmailThreadId: opts.acked ? 'real-thread-1' : formPlaceholderThreadId(t!.id) }).where(eq(supportTickets.id, t!.id))
    await db.insert(supportMessages).values({
      ticketId: t!.id, gmailMessageId: `form:${t!.id}`, direction: 'inbound', fromEmail: EMAIL,
      bodyText: 'Name: Rob\nOrder number (claimed): —\n\nhi there friend', sentAt: NOW,
    })
    return t!.id
  }
  const deps = () => ({ db, gmail: gmail as GmailClient, supportAddress: SUPPORT, alert: alert as never, now: () => NOW })

  it('formAckMessageId / formAckBody / nameFromFormBody', () => {
    expect(formAckMessageId('abc', SUPPORT)).toBe('<form-ack-abc@dogebuddy.com>')
    expect(nameFromFormBody('Name: Rob\nOrder number (claimed): —\n\nhi')).toBe('Rob')
    expect(nameFromFormBody(null)).toBe('there')
    expect(formAckBody('Rob')).toBe(
      "Hi Rob,\n\nThanks for reaching out — we've received your message and will reply in this email thread, usually within one business day. If you're writing about a damaged or wrong item, please reply here with a photo.\n\nDoge Buddy Support",
    )
  })

  it('sends the ack on a NEW thread with our Message-ID, swaps the placeholder for the real thread id, records the outbound row', async () => {
    const id = await seedFormTicket()
    await expect(executeFormAck(deps(), id)).resolves.toBe('sent')
    const sent = gmail.sentMessages()
    expect(sent).toHaveLength(1)
    const raw = Buffer.from(sent[0]!.raw, 'base64url').toString()
    expect(raw).toContain(`Message-ID: <form-ack-${id}@dogebuddy.com>\r\n`)
    expect(raw).toContain(`To: ${EMAIL}\r\n`)
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/) // em dash → RFC 2047
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(sent[0]!.threadId)
    const msgs = await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))
    const out = msgs.find((m) => m.direction === 'outbound')
    expect(out).toMatchObject({ gmailMessageId: sent[0]!.id, fromEmail: SUPPORT, rfcMessageId: `<form-ack-${id}@dogebuddy.com>`, sentAt: NOW })
    expect(out!.bodyText).toBe(formAckBody('Rob'))
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SENT_ACTION))).toHaveLength(1)
  })

  it('already acked (no placeholder) → skipped, no send', async () => {
    const id = await seedFormTicket({ acked: true })
    await expect(executeFormAck(deps(), id)).resolves.toBe('skipped')
    expect(gmail.sentMessages()).toHaveLength(0)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, FORM_ACK_SKIPPED_ACTION))).toHaveLength(1)
  })

  it('crash recovery: a sent copy already carries our Message-ID → NO second send, thread recovered from it', async () => {
    const id = await seedFormTicket()
    const prior = await gmail.sendNew({ to: EMAIL, subject: FORM_ACK_SUBJECT, messageId: formAckMessageId(id, SUPPORT), bodyText: 'x' })
    await expect(executeFormAck(deps(), id)).resolves.toBe('recovered')
    expect(gmail.sentMessages()).toHaveLength(1)
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(prior.threadId)
    const out = (await db.select().from(supportMessages).where(eq(supportMessages.ticketId, id))).find((m) => m.direction === 'outbound')
    expect(out!.gmailMessageId).toBe(prior.id)
  })

  it('a failed send throws (pg-boss retries); nothing recorded', async () => {
    const id = await seedFormTicket()
    gmail.failNext('sendNew', new Error('503'))
    await expect(executeFormAck(deps(), id)).rejects.toThrow('503')
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, id))
    expect(t!.gmailThreadId).toBe(formPlaceholderThreadId(id))
  })

  it('handler: on the FINAL retry a failure is alerted as support_form_ack_failed and rethrown', async () => {
    const id = await seedFormTicket()
    gmail.failNext('sendNew', new Error('503'))
    const handler = formAckHandler(deps())
    await expect(handler([{ id: 'j1', name: FORM_ACK_QUEUE, data: { ticketId: id }, retryCount: 5, retryLimit: 5 } as never])).rejects.toThrow('503')
    expect(alert).toHaveBeenCalledWith('critical', 'support_form_ack_failed', expect.objectContaining({ ticketId: id }))
  })

  it('gmail null → throws (misconfiguration must be loud, not a silent skip)', async () => {
    const id = await seedFormTicket()
    await expect(executeFormAck({ ...deps(), gmail: null }, id)).rejects.toThrow(/gmail/i)
  })

  it('sweep: re-enqueues form tickets still on their placeholder after 2 minutes, not fresh ones, not acked ones', async () => {
    const stale = await seedFormTicket({ createdAt: new Date(NOW.getTime() - FORM_ACK_SWEEP_AFTER_MS - 1000) })
    await seedFormTicket({ createdAt: NOW })
    await seedFormTicket({ createdAt: new Date(NOW.getTime() - 10 * 60_000), acked: true })
    const enqueue = vi.fn(async () => {})
    await expect(sweepUnackedFormTickets({ db, enqueue, alert: alert as never, now: () => NOW })).resolves.toEqual({ enqueued: 1 })
    expect(enqueue).toHaveBeenCalledWith(FORM_ACK_QUEUE, { ticketId: stale }, expect.objectContaining({ singletonKey: stale }))
  })
})
```

Also append to `support-validator.test.ts` (next to the POLICY_COPY loop): `it('the contact-form ack copy passes the reply screens verbatim', async () => { const r = await validateReplyBody(db, await seedTicket(), formAckBody('Rob'), noRefund); expect(r.ok).toBe(true) })` — import `formAckBody`.

- [ ] **Step 2: Run** → FAIL. **Implement** `apps/ops/src/jobs/support-form-ack.ts` (replace the stub):

```ts
import { auditLog, supportMessages, supportTickets, type createDb } from '@doge-buddy/db'
import type { GmailClient } from '@doge-buddy/gmail'
import { and, eq, like, lt } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type { SendOpts } from '../fulfillment/types.ts'
import { formPlaceholderThreadId, isFormPlaceholder } from '../support/form-ids.ts'
import type { Alert } from '../support/ingest.ts'

type Db = ReturnType<typeof createDb>['db']
type SendFn = (name: string, data: object, opts?: SendOpts) => Promise<void>

export const FORM_ACK_QUEUE = 'support.form-ack'
export const FORM_ACK_SEND_OPTS = (ticketId: string): SendOpts => ({
  singletonKey: ticketId, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 120,
})
export const FORM_ACK_SUBJECT = 'We got your message — Doge Buddy Support'
export const FORM_ACK_SENT_ACTION = 'support.form_ack_sent'
export const FORM_ACK_SKIPPED_ACTION = 'support.form_ack_skipped'
/** A form ticket still on its placeholder this long after creation is re-enqueued by the poll. */
export const FORM_ACK_SWEEP_AFTER_MS = 2 * 60_000
const SWEEP_LIMIT = 20

export function formAckMessageId(ticketId: string, supportAddress: string): string {
  const domain = supportAddress.split('@')[1] ?? 'dogebuddy.com'
  return `<form-ack-${ticketId}@${domain}>`
}

/** Fixed copy (spec §4.3) — NOT agent-written; guarded by a validator test so it never carries a promise token beside an action token. */
export function formAckBody(name: string): string {
  return (
    `Hi ${name},\n\n` +
    "Thanks for reaching out — we've received your message and will reply in this email thread, usually within one business day. " +
    "If you're writing about a damaged or wrong item, please reply here with a photo.\n\n" +
    'Doge Buddy Support'
  )
}

/** The form body starts with `Name: <name>` (http/contact.ts's buildFormBody). */
export function nameFromFormBody(bodyText: string | null): string {
  const m = bodyText?.match(/^Name: (.+)$/m)
  const name = m?.[1]?.trim()
  return name && name.length > 0 ? name : 'there'
}

export interface FormAckDeps {
  db: Db
  gmail: GmailClient | null
  supportAddress: string
  alert: Alert
  now?: () => Date
}

/**
 * Sends the contact-form acknowledgement that CREATES the ticket's Gmail thread (spec §4).
 * Idempotent across a crash between send and DB write: the Message-ID is deterministic, and a
 * prior sent copy found via `rfc822msgid:` is recovered instead of re-sent. The thread swap is a
 * guarded UPDATE (`WHERE gmail_thread_id = placeholder`), so a duplicate worker matching 0 rows
 * writes nothing.
 */
export async function executeFormAck(deps: FormAckDeps, ticketId: string): Promise<'sent' | 'recovered' | 'skipped'> {
  if (!deps.gmail) throw new Error('support.form-ack: gmail not configured')
  const gmail = deps.gmail
  const now = deps.now ?? (() => new Date())

  const [ticket] = await deps.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId))
  if (!ticket) throw new Error(`support.form-ack: ticket ${ticketId} not found`)
  if (!isFormPlaceholder(ticket.gmailThreadId)) {
    await deps.db.insert(auditLog).values({ actor: 'system', action: FORM_ACK_SKIPPED_ACTION, entityType: 'support_ticket', entityId: ticketId, detail: { reason: 'already_acked' } })
    return 'skipped'
  }
  if (!ticket.customerEmail) throw new Error(`support.form-ack: ticket ${ticketId} has no customer email`)

  const [inbound] = await deps.db
    .select({ bodyText: supportMessages.bodyText })
    .from(supportMessages)
    .where(and(eq(supportMessages.ticketId, ticketId), eq(supportMessages.direction, 'inbound')))
    .limit(1)
  const messageId = formAckMessageId(ticketId, deps.supportAddress)
  const bodyText = formAckBody(nameFromFormBody(inbound?.bodyText ?? null))

  let sent: { id: string; threadId: string }
  let recovered = false
  const prior = await gmail.listMessages({ q: `in:sent rfc822msgid:${messageId}` })
  if (prior.ids[0]) {
    sent = prior.ids[0]
    recovered = true
  } else {
    sent = await gmail.sendNew({ to: ticket.customerEmail, subject: FORM_ACK_SUBJECT, messageId, bodyText })
  }

  await deps.db.transaction(async (tx) => {
    await tx
      .update(supportTickets)
      .set({ gmailThreadId: sent.threadId })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.gmailThreadId, formPlaceholderThreadId(ticketId))))
    await tx
      .insert(supportMessages)
      .values({
        ticketId, gmailMessageId: sent.id, direction: 'outbound', fromEmail: deps.supportAddress,
        bodyText, rfcMessageId: messageId, authResults: null, sentAt: now(),
      })
      .onConflictDoNothing({ target: supportMessages.gmailMessageId })
    await tx.insert(auditLog).values({
      actor: 'system', action: FORM_ACK_SENT_ACTION, entityType: 'support_ticket', entityId: ticketId,
      detail: { gmailMessageId: sent.id, threadId: sent.threadId, recovered },
    })
  })
  return recovered ? 'recovered' : 'sent'
}

/** Worker (`boss.work(FORM_ACK_QUEUE, { includeMetadata: true }, …)`): the last retry's failure pages the owner. */
export function formAckHandler(deps: FormAckDeps): PgBoss.WorkHandler<{ ticketId: string }> {
  return async (jobs) => {
    let firstError: unknown = null
    for (const job of jobs) {
      try {
        await executeFormAck(deps, job.data.ticketId)
      } catch (err) {
        firstError = firstError ?? err
        const meta = job as unknown as { retryCount?: number; retryLimit?: number }
        if ((meta.retryCount ?? 0) >= (meta.retryLimit ?? 0)) {
          await deps.alert('critical', 'support_form_ack_failed', {
            ticketId: job.data.ticketId, error: err instanceof Error ? err.message : String(err),
          }).catch(() => {})
        }
      }
    }
    if (firstError !== null) throw firstError
  }
}

/** Poll stage: any form ticket still on its placeholder after FORM_ACK_SWEEP_AFTER_MS gets its ack job (re-)enqueued — `stately` + singletonKey make this idempotent. */
export async function sweepUnackedFormTickets(deps: { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }): Promise<{ enqueued: number }> {
  const now = deps.now ?? (() => new Date())
  const cutoff = new Date(now().getTime() - FORM_ACK_SWEEP_AFTER_MS)
  const rows = await deps.db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(eq(supportTickets.source, 'form'), like(supportTickets.gmailThreadId, 'form:%'), lt(supportTickets.createdAt, cutoff)))
    .limit(SWEEP_LIMIT)
  for (const { id } of rows) await deps.enqueue(FORM_ACK_QUEUE, { ticketId: id }, FORM_ACK_SEND_OPTS(id))
  return { enqueued: rows.length }
}
```

- [ ] **Step 3: Poll stage.** In `support-poll-gmail.ts`: `SupportPollDeps` += `formAckSweep?: (deps: { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }) => Promise<{ enqueued: number }>`; in `executeSupportPoll`, after the agent-select stage, add an independent stage (NOT gated on ingest — the sweep needs no Gmail):

```ts
  // 5th stage (contact-form spec §4): re-enqueue acks for form tickets stuck on their placeholder.
  const sweepFn = deps.formAckSweep ?? sweepUnackedFormTickets
  try {
    await sweepFn({ db: deps.db, enqueue: deps.enqueue, alert: deps.alert, now })
  } catch (err) {
    firstError = firstError ?? err   // whatever the existing stages call their first-error binding
  }
```

Add to `support-poll-job.test.ts`: `it('5th stage: the form-ack sweep runs every cycle, even when ingest failed', …)` — pass `ingestFn` that throws and a `formAckSweep` spy; assert the spy was called once.

- [ ] **Step 4: Register the worker** in `index.ts` right after the `support.agent-run` block:

```ts
// `support.form-ack` (contact-form spec §4): sends the acknowledgement that creates a form
// ticket's Gmail thread. `stately` + singletonKey (set by every producer via FORM_ACK_SEND_OPTS)
// bounds duplicates to one outstanding job per ticket; the handler itself is idempotent on top.
await createQueueRetrying(queue.boss, FORM_ACK_QUEUE, { name: FORM_ACK_QUEUE, policy: 'stately' })
await queue.boss.updateQueue(FORM_ACK_QUEUE, { name: FORM_ACK_QUEUE, policy: 'stately' })
await queue.boss.work(FORM_ACK_QUEUE, { includeMetadata: true }, formAckHandler({
  db, gmail: gmailClient, supportAddress: config.gmail?.supportAddress ?? '', alert,
}))
app.log.info(`${FORM_ACK_QUEUE} worker ARMED`)
```

(`gmailClient` is `GmailClient | null` there already.)

- [ ] **Step 5: Run** `pnpm --filter @doge-buddy/ops exec vitest run test/support-form-ack.test.ts test/support-validator.test.ts test/support-poll-job.test.ts` → PASS; `pnpm typecheck` → PASS. If `PgBoss.WorkHandler`'s job type lacks `retryCount`, the `as unknown as` cast in the handler covers it — do not widen the public type.

- [ ] **Step 6: Commit** — `git add apps/ops && git commit -m "feat(support): support.form-ack job — deterministic Message-ID ack creates the form ticket's Gmail thread; poll sweep re-enqueues stragglers"`.

---

### Task 7: Reply worker — placeholder guard + In-Reply-To fallback

**Files:**
- Modify: `apps/ops/src/proposals/apply-support-reply.ts:133-168`
- Test: `apps/ops/test/apply-support-reply.test.ts`

**Interfaces:**
- Consumes: Task 2 (`isFormPlaceholder`).
- Produces: `export const FORM_ACK_PENDING_ERROR = 'form acknowledgement not sent yet — retrying'`.

- [ ] **Step 1: Failing tests** — inside `describe('applySupportReply')` in the existing test file (reuse its `seedTicket`/`seedProposal`-style helpers; read the file's helpers first — they seed a ticket by `gmailThreadId` and an inbound message with an `rfcMessageId`; extend the ticket seeder with an optional `gmailThreadId` override and the message seeder with `direction` + nullable `rfcMessageId` if it lacks them):

```ts
  it('form ticket still on its placeholder thread id → throws FORM_ACK_PENDING_ERROR (retry), sends nothing, proposal stays applying', async () => {
    const ticketId = await seedTicket({ gmailThreadId: `${THREAD_PREFIX}form-placeholder`, status: 'awaiting_approval' })
    await db.update(supportTickets).set({ gmailThreadId: `form:${ticketId}`, source: 'form' }).where(eq(supportTickets.id, ticketId))
    await seedInbound(ticketId, { gmailMessageId: `form:${uid()}`, rfcMessageId: null })
    const row = await seedApplyingProposal(ticketId)
    await expect(applySupportReply(makeDeps(), row)).rejects.toThrow(FORM_ACK_PENDING_ERROR)
    expect(gmail.sentMessages()).toHaveLength(0)
    expect((await db.select().from(proposals).where(eq(proposals.id, row.id)))[0]!.status).toBe('applying')
  })

  it('form ticket after the ack: In-Reply-To falls back to the ack\'s (outbound) Message-ID and References starts with it', async () => {
    const ticketId = await seedTicket({ gmailThreadId: `${THREAD_PREFIX}acked`, status: 'awaiting_approval' })
    await seedInbound(ticketId, { gmailMessageId: `form:${uid()}`, rfcMessageId: null })
    const ack = await gmail.sendNew({ to: CUSTOMER, subject: 'We got your message', messageId: '<form-ack-t@dogebuddy.test>', bodyText: 'ack' })
    await db.update(supportTickets).set({ gmailThreadId: ack.threadId, source: 'form' }).where(eq(supportTickets.id, ticketId))
    await db.insert(supportMessages).values({ ticketId, gmailMessageId: ack.id, direction: 'outbound', fromEmail: SUPPORT_ADDRESS, bodyText: 'ack', rfcMessageId: '<form-ack-t@dogebuddy.test>', sentAt: new Date() })
    const row = await seedApplyingProposal(ticketId)

    await applySupportReply(makeDeps(), row)

    const sent = gmail.sentMessages().filter((m) => m.id !== ack.id)
    expect(sent).toHaveLength(1)
    const headers = headerLines(sent[0]!.raw)
    expect(headers).toContain('In-Reply-To: <form-ack-t@dogebuddy.test>')
    expect(headers.find((h) => h.startsWith('References: '))).toBe('References: <form-ack-t@dogebuddy.test>')
    expect(sent[0]!.threadId).toBe(ack.threadId)
  })
```

- [ ] **Step 2: Run** → FAIL (no such export; today the placeholder path calls `getThread('form:…')`, and the fallback path fails terminally with `latest inbound message has no rfc message id`).

- [ ] **Step 3: Implement.** Import `isFormPlaceholder` from `../support/form-ids.ts`. Export `FORM_ACK_PENDING_ERROR`. Right after the `if (deps.gmail === null)` block and BEFORE the recovery scan:

```ts
  // A contact-form ticket whose ack hasn't created its Gmail thread yet (contact-form spec §5):
  // nothing to scan or thread onto. Throw — the job retries on its normal schedule and the ack
  // job's own dead-letter alert pages the owner if the thread never materializes.
  if (isFormPlaceholder(ticket.gmailThreadId)) throw new Error(FORM_ACK_PENDING_ERROR)
```

Replace the In-Reply-To derivation:

```ts
  // The first reply on a form ticket threads onto OUR ack (its inbound has no rfc id); once the
  // customer has replied to the ack, the newest inbound carries a real id and wins as before.
  const latestOutboundWithId = [...messages].reverse().find((m) => m.direction === 'outbound' && m.rfcMessageId !== null)
  const inReplyTo = latestInbound.rfcMessageId ?? latestOutboundWithId?.rfcMessageId ?? null
  if (inReplyTo === null) {
    await failTerminal(deps, row, ticket.id, 'no rfc message id to thread the reply onto')
    return
  }
```

(Keep the existing "never send unthreaded" comment.) Check the existing test that asserts the old terminal message `'latest inbound message has no rfc message id'` — update its expected string to the new one, since a ticket with NO ids at all still fails terminally.

- [ ] **Step 4: Run** `pnpm --filter @doge-buddy/ops exec vitest run test/apply-support-reply.test.ts` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add apps/ops/src/proposals/apply-support-reply.ts apps/ops/test/apply-support-reply.test.ts && git commit -m "feat(support): reply worker holds on a form placeholder thread and threads the first reply onto the ack"`.

---

### Task 8: Admin badge

**Files:**
- Modify: `apps/ops/src/http/admin/render-tickets.ts` (`TicketListRow`, `renderTicketRow`, `renderTicketDetail`), `apps/ops/src/http/admin/routes.ts:434-447` (select `source`)
- Test: the existing admin tickets test file (`ls apps/ops/test | grep -i admin-tickets`) — append.

**Interfaces:** `TicketListRow.source: string`.

- [ ] **Step 1: Failing test** — in the admin tickets test (it renders `/admin/tickets` through an authed `inject`; copy its login/seed helpers): seed a ticket with `source: 'form'` and another default; assert the list HTML contains `via contact form` exactly once and the form ticket's detail page contains `<p>Source: contact form</p>` while the email ticket's contains `<p>Source: email</p>`.

- [ ] **Step 2: Run** → FAIL. **Implement**: add `source: string` to `TicketListRow`; in `routes.ts`'s list select add `source: supportTickets.source,`; in `renderTicketRow` change the subject cell to

```ts
    <td>${row.source === 'form' ? html`<span class="badge">via contact form</span> ` : html``}<a href="/admin/tickets/${row.id}">${row.subject ?? '(no subject)'}</a></td>
```

and in `renderTicketDetail` after the Customer line: `` <p>Source: ${t.source === 'form' ? 'contact form' : 'email'}</p> ``.

- [ ] **Step 3: Run the admin test file + `pnpm typecheck`** → PASS. **Commit** — `git commit -am "feat(admin): 'via contact form' badge on ticket list + detail"`.

---

### Task 9: Storefront — `/contact` route, action, CSP, footer, policy copy, env docs

**Files:**
- Create: `apps/storefront/app/lib/contact.ts`, `apps/storefront/app/lib/__tests__/contact.test.ts`, `apps/storefront/app/routes/contact.tsx`
- Modify: `apps/storefront/app/entry.server.tsx:17-22`, `apps/storefront/app/components/Footer.tsx:13-18`, `apps/storefront/.env.example`, `packages/core/src/policies.ts:72`
- Test: `packages/core` policies test (`packages/core/src/policies.test.ts` — the privacy paragraph assertion) + `apps/ops/test/support-validator.test.ts` POLICY_COPY loop (runs automatically)

**Interfaces (`app/lib/contact.ts`):**
```ts
export interface ContactFields { name: string; email: string; orderNumber: string; message: string }
export type ContactResult =
  | { kind: 'sent' }
  | { kind: 'validation'; fields: Record<string, string> }
  | { kind: 'turnstile' } | { kind: 'capped' } | { kind: 'unavailable' }
export function parseContactForm(form: FormData): { fields: ContactFields; turnstileToken: string; honeypot: string }
export async function forwardContact(input: { opsBaseUrl: string; fields: ContactFields; turnstileToken: string; honeypot: string; ip: string | null; fetchFn?: typeof fetch; timeoutMs?: number }): Promise<ContactResult>
export function clientIp(headers: Headers): string | null   // cf-connecting-ip, else first x-forwarded-for entry
```

- [ ] **Step 1: Failing tests** — `apps/storefront/app/lib/__tests__/contact.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';
import {clientIp, forwardContact, parseContactForm} from '../contact';

const fields = {name: 'Rob', email: 'rob@example.com', orderNumber: '', message: 'Hello there, question here.'};
const base = {opsBaseUrl: 'https://ops.example', fields, turnstileToken: 'tok', honeypot: '', ip: '203.0.113.9'};

describe('parseContactForm', () => {
  it('reads the named fields incl. Turnstile\'s cf-turnstile-response and the honeypot', () => {
    const fd = new FormData();
    fd.set('name', 'Rob'); fd.set('email', 'rob@example.com'); fd.set('orderNumber', '#1001');
    fd.set('message', 'Hello there'); fd.set('cf-turnstile-response', 'tok'); fd.set('website', '');
    expect(parseContactForm(fd)).toEqual({fields: {name: 'Rob', email: 'rob@example.com', orderNumber: '#1001', message: 'Hello there'}, turnstileToken: 'tok', honeypot: ''});
  });
});

describe('forwardContact', () => {
  it('POSTs JSON to /public/contact and maps 200 → sent', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://ops.example/public/contact');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({...fields, turnstileToken: 'tok', honeypot: '', ip: '203.0.113.9'});
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual({kind: 'sent'});
  });
  it('honeypot filled → sent WITHOUT calling ops', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(forwardContact({...base, honeypot: 'x', fetchFn})).resolves.toEqual({kind: 'sent'});
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    [400, {ok: false, error: 'validation', fields: {email: 'bad'}}, {kind: 'validation', fields: {email: 'bad'}}],
    [400, {ok: false, error: 'turnstile'}, {kind: 'turnstile'}],
    [429, {ok: false, error: 'capped'}, {kind: 'capped'}],
    [503, {}, {kind: 'unavailable'}],
    [404, {}, {kind: 'unavailable'}],
  ])('maps %s %j → %j', async (status, body, expected) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), {status})) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual(expected);
  });
  it('network error → unavailable', async () => {
    const fetchFn = vi.fn(async () => {throw new Error('down');}) as unknown as typeof fetch;
    await expect(forwardContact({...base, fetchFn})).resolves.toEqual({kind: 'unavailable'});
  });
});

describe('clientIp', () => {
  it('prefers cf-connecting-ip, else the first x-forwarded-for hop, else null', () => {
    expect(clientIp(new Headers({'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2, 3.3.3.3'}))).toBe('1.1.1.1');
    expect(clientIp(new Headers({'x-forwarded-for': '2.2.2.2, 3.3.3.3'}))).toBe('2.2.2.2');
    expect(clientIp(new Headers())).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter storefront test` (check the package name in `apps/storefront/package.json` and use it) → FAIL. **Implement** `app/lib/contact.ts`:

```ts
export interface ContactFields { name: string; email: string; orderNumber: string; message: string }
export type ContactResult =
  | {kind: 'sent'}
  | {kind: 'validation'; fields: Record<string, string>}
  | {kind: 'turnstile'}
  | {kind: 'capped'}
  | {kind: 'unavailable'};

const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
};

export function parseContactForm(form: FormData) {
  return {
    fields: {name: str(form, 'name'), email: str(form, 'email'), orderNumber: str(form, 'orderNumber'), message: str(form, 'message')},
    turnstileToken: str(form, 'cf-turnstile-response'),
    honeypot: str(form, 'website'),
  };
}

export function clientIp(headers: Headers): string | null {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim() || null;
  return null;
}

/** Proxies the submission to ops (contact-form spec §1). The honeypot is checked here too: a bot
 * that filled it gets the success page without ops ever hearing about it. */
export async function forwardContact(input: {
  opsBaseUrl: string; fields: ContactFields; turnstileToken: string; honeypot: string; ip: string | null;
  fetchFn?: typeof fetch; timeoutMs?: number;
}): Promise<ContactResult> {
  if (input.honeypot.trim() !== '') return {kind: 'sent'};
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${input.opsBaseUrl}/public/contact`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...input.fields, turnstileToken: input.turnstileToken, honeypot: input.honeypot, ip: input.ip}),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (res.status === 200) return {kind: 'sent'};
    if (res.status === 429) return {kind: 'capped'};
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as {error?: string; fields?: Record<string, string>};
      if (body.error === 'validation') return {kind: 'validation', fields: body.fields ?? {}};
      if (body.error === 'turnstile') return {kind: 'turnstile'};
    }
    return {kind: 'unavailable'};
  } catch {
    return {kind: 'unavailable'};
  }
}
```

- [ ] **Step 3: Run** → PASS. **Route** `app/routes/contact.tsx`:

```tsx
import {Form, useActionData, useLoaderData, useNavigation} from 'react-router';
import {useNonce} from '@shopify/hydrogen';
import type {Route} from './+types/contact';
import {clientIp, forwardContact, parseContactForm, type ContactResult} from '~/lib/contact';

export const meta: Route.MetaFunction = () => [{title: 'Contact | Doge Buddy'}];

export async function loader({context}: Route.LoaderArgs) {
  const siteKey = context.env.PUBLIC_TURNSTILE_SITE_KEY ?? '';
  const enabled = Boolean(siteKey && context.env.OPS_BASE_URL);
  return {siteKey, enabled};
}

export async function action({request, context}: Route.ActionArgs) {
  const opsBaseUrl = context.env.OPS_BASE_URL;
  if (!opsBaseUrl) return {result: {kind: 'unavailable'} as ContactResult, values: null};
  const parsed = parseContactForm(await request.formData());
  const result = await forwardContact({opsBaseUrl, ...parsed, ip: clientIp(request.headers)});
  return {result, values: result.kind === 'sent' ? null : parsed.fields};
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

export default function Contact() {
  const {siteKey, enabled} = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nonce = useNonce();
  const submitting = useNavigation().state !== 'idle';
  const result = data?.result;
  const values = data?.values ?? {name: '', email: '', orderNumber: '', message: ''};
  const fieldError = (f: string) => (result?.kind === 'validation' ? result.fields[f] : undefined);

  if (!enabled || result?.kind === 'unavailable') {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="font-display text-3xl">Contact us</h1>
        <p className="mt-4">The contact form is temporarily unavailable — please try again later.</p>
      </main>
    );
  }
  if (result?.kind === 'sent') {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="font-display text-3xl">Sent!</h1>
        <p className="mt-4">A confirmation from support@dogebuddy.com is on its way — reply to it to add anything (photos included).</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <script src={TURNSTILE_SCRIPT} async defer nonce={nonce} />
      <h1 className="font-display text-3xl">Contact us</h1>
      {result?.kind === 'turnstile' && <p role="alert" className="mt-4 text-red-700">Verification failed — please try again.</p>}
      {result?.kind === 'capped' && <p role="alert" className="mt-4 text-red-700">Too many messages right now — please try again later.</p>}
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1">Name
          <input name="name" required maxLength={100} defaultValue={values.name} className="rounded border px-3 py-2" />
          {fieldError('name') && <span className="text-sm text-red-700">{fieldError('name')}</span>}
        </label>
        <label className="flex flex-col gap-1">Email
          <input name="email" type="email" required maxLength={254} defaultValue={values.email} className="rounded border px-3 py-2" />
          {fieldError('email') && <span className="text-sm text-red-700">{fieldError('email')}</span>}
        </label>
        <label className="flex flex-col gap-1">Order number (optional)
          <input name="orderNumber" maxLength={20} defaultValue={values.orderNumber} placeholder="#1001" className="rounded border px-3 py-2" />
          {fieldError('orderNumber') && <span className="text-sm text-red-700">{fieldError('orderNumber')}</span>}
        </label>
        <label className="flex flex-col gap-1">Message
          <textarea name="message" required minLength={10} maxLength={4000} rows={6} defaultValue={values.message} className="rounded border px-3 py-2" />
          {fieldError('message') && <span className="text-sm text-red-700">{fieldError('message')}</span>}
        </label>
        {/* Honeypot: off-screen, not display:none (some bots skip hidden fields); humans never see it. */}
        <div aria-hidden="true" style={{position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden'}}>
          <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        </div>
        <div className="cf-turnstile" data-sitekey={siteKey} />
        <button type="submit" disabled={submitting} className="rounded bg-ink px-4 py-2 text-surface">
          {submitting ? 'Sending…' : 'Send message'}
        </button>
      </Form>
    </main>
  );
}
```

Add `PUBLIC_TURNSTILE_SITE_KEY?: string; OPS_BASE_URL?: string;` to the storefront's `Env` type (find where `PUBLIC_CHECKOUT_DOMAIN` is declared — `env.d.ts` or `app/lib/context.ts`'s `Env` interface — and add both there). Use the brand classes that already exist in `Footer.tsx`/`tailwind.css` (`bg-ink`, `text-surface`, `font-display`); if any class above doesn't exist, use the nearest existing one — no new CSS.

- [ ] **Step 4: CSP** in `entry.server.tsx`:

```ts
  const {nonce, header, NonceProvider} = createContentSecurityPolicy({
    shop: {checkoutDomain: context.env.PUBLIC_CHECKOUT_DOMAIN, storeDomain: context.env.PUBLIC_STORE_DOMAIN},
    // Cloudflare Turnstile (the /contact form): a script, an iframe challenge, and XHR to itself.
    scriptSrc: ['https://challenges.cloudflare.com'],
    frameSrc: ['https://challenges.cloudflare.com'],
    connectSrc: ['https://challenges.cloudflare.com'],
  });
```

Hydrogen merges these with its defaults (`'self'`, the nonce, the checkout domain) — verify by running `pnpm --filter <storefront> dev`, opening `/contact`, and checking the response's `Content-Security-Policy` header contains `challenges.cloudflare.com` under all three directives.

- [ ] **Step 5: Footer + policy + env.** `Footer.tsx` `POLICY_LINKS` += `{to: '/contact', title: 'Contact'}` (last). `packages/core/src/policies.ts:72` → `'Use the contact form at /contact to access or delete your data.'` and update the matching assertion in `packages/core/src/policies.test.ts` (grep `coming soon`). `.env.example` += 

```
# Contact form (app/routes/contact.tsx): both required for the form to render; without them the
# page shows "temporarily unavailable". Site key from Cloudflare → Turnstile → the widget; OPS_BASE_URL
# is the Railway ops host, no trailing slash.
# PUBLIC_TURNSTILE_SITE_KEY=
# OPS_BASE_URL=https://doge-buddyops-production.up.railway.app
```

- [ ] **Step 6: Verify** — `pnpm --filter <storefront> test && pnpm --filter <storefront> typecheck` (or the package's lint/typecheck script), `pnpm --filter @doge-buddy/core test`, `pnpm --filter @doge-buddy/ops exec vitest run test/support-validator.test.ts` (the POLICY_COPY loop must still pass on the new sentence), `pnpm typecheck`. Then run the storefront locally with Turnstile's test keys (`PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA`, `OPS_BASE_URL=http://localhost:3001`) against a local ops started with `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` + the Gmail vars from `apps/ops/.env` + `ADMIN_BASE_URL=http://localhost:3001` — submit once from the browser; expect the success page, a form ticket in the local DB, and (with real Gmail creds) an ack sent from support@ to the address you typed — use your own address. Kill both dev servers by PID afterwards.

- [ ] **Step 7: Commit** — `git add apps/storefront packages/core && git commit -m "feat(storefront): /contact — Turnstile-gated form proxied to ops; CSP, footer link, privacy copy → /contact"`.

---

### Task 10: Docs + owner checklist

**Files:**
- Modify: `docs/OWNER-CHECKLIST.md` ("Now / this week": new 🔴 item; "Publish the storefront": the *Decide before publishing* bullet → done), `README.md` (phase paragraph), `docs/superpowers/specs/2026-08-31-contact-form-design.md` (status line; §2 step 5 note about enqueue-after-commit + sweep)

- [ ] **Step 1:** Checklist 🔴 item (place directly under the existing "Migration 0008 on Railway FIRST" item, since both ride the same push):

```markdown
- [ ] 🔴 **Contact form go-live (3 keys, 1 migration, 1 push, then a 5-minute live walk).**
  1. **Cloudflare → Turnstile → Add widget**: name `dogebuddy contact`, hostnames `dogebuddy.com` AND the Oxygen preview hostname (from the Hydrogen channel), widget mode **Managed**. Copy the **Site key** and the **Secret key**.
  2. **Railway → ops → Variables**: `TURNSTILE_SECRET_KEY=<secret key>` (Apply banner!).
  3. **Shopify admin → Hydrogen channel → storefront → Environments → every environment**: `PUBLIC_TURNSTILE_SITE_KEY=<site key>`, `OPS_BASE_URL=https://doge-buddyops-production.up.railway.app`.
  4. From this checkout: `DATABASE_URL='<Railway PUBLIC postgres url>' pnpm --filter @doge-buddy/db migrate` → expect 10/10 (0008 + 0009 together if 0008 hasn't run yet).
  5. `git push origin main` → Railway redeploys ops (log line `contact form endpoint ARMED`), Oxygen redeploys the storefront.
  6. **Live walk** (Claude watches the DB/mailbox): open `/contact` on the preview URL signed in, submit from the Outlook test address with a real question → (a) ticket with the "via contact form" badge on `/admin/tickets`; (b) ack in the Outlook INBOX from support@; (c) approve the agent's draft from your phone → reply lands in the SAME Outlook conversation; (d) reply to it from Outlook → same ticket, no duplicate. Claude then checks `rfc822msgid:` on the sent ack (spec exit criterion 6).
```

Mark the *Decide before publishing* bullet: `- [x] ~~*Decide before publishing:* …~~ **Decided + BUILT (2026-08-31): option (a).** …` with a one-line pointer to the item above; update the "Already true: no contact form" bullet to say the form now exists but is Turnstile-gated + honeypotted + capped (100/day) + folded (5/sender/day).

- [ ] **Step 2:** README phase paragraph: add one sentence after the no-refund sentence: "A Turnstile-gated `/contact` form feeds the same pipeline — a fixed-copy acknowledgement from support@ creates the Gmail thread the agent's reply then threads onto."

- [ ] **Step 3:** Spec: status line → "BUILT 2026-08-31 (local main); live walk pending owner keys"; add under §2 step 5: "*Implementation note:* the ack job is enqueued **after** commit (pg-boss sends on its own connection); the poll's 5th stage re-enqueues any form ticket still on its placeholder after 2 minutes, which gives the same no-ticket-without-ack guarantee."

- [ ] **Step 4: Full verification before the final commit** — `pnpm --filter @doge-buddy/ops test` (all), `pnpm --filter @doge-buddy/gmail test`, `pnpm --filter @doge-buddy/core test`, storefront tests, `pnpm typecheck` — all green. Commit — `git add docs README.md && git commit -m "docs: contact form built — owner go-live checklist (Turnstile keys, migration 0009, push, live walk)"`.

---

## Self-review

- **Spec coverage:** §1 → Task 9; §2 (all six steps) → Task 5 (+ Task 3 helper, Task 4 Turnstile); §3 → Task 2; §4 → Task 6 (+ Task 1 `sendNew`, `rfc822msgid`); §5 → Task 7; §6 → Task 8; §7 → Tasks 4, 9, 10; §8 → each task's tests; §9 → Task 10. Exit criteria 1–6 → the owner live walk in Task 10. One deliberate deviation (enqueue-after-commit + sweep instead of in-tx enqueue) is called out in Task 5 and written back into the spec in Task 10.
- **Placeholders:** none — every code step is concrete; the two "read the file's helpers first" notes (Tasks 5, 7, 8) point at real existing helpers by role.
- **Type consistency:** `FORM_ACK_QUEUE`/`FORM_ACK_SEND_OPTS` defined once in `jobs/support-form-ack.ts` (stubbed in Task 5, completed in Task 6) and imported by `http/contact.ts`; `recordInboundOnTicket(tx, InboundBookkeepingInput)` (Task 3) is what Task 5 calls; `isFormPlaceholder`/`formPlaceholderThreadId`/`formMessageId`/`isGmailMessageId` (Task 2) are used by Tasks 5, 6, 7; `GmailClient.sendNew` (Task 1) signature matches its uses in Task 6 and the Task 7 test; `ContactResult` kinds match the ops response contract in Global Constraints.
