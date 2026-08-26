# Phase 6A — Support Email Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real email to `support@dogebuddy.com` becomes a categorized ticket on `/admin/tickets` with Gmail labels, and escalation-class mail pings the owner's Telegram — no LLM replies yet (that's 6B).

**Architecture:** New thin `packages/gmail` (hand-rolled fetch client + MockGmail twin, service-account JWT with domain-wide delegation impersonating the primary user), a minute-cadence singleton pg-boss job in ops that ingests via `users.history.list` into the existing `support_tickets`/`support_messages` tables, an ingest-time deterministic escalation tripwire, a capped Haiku triage pass, a commit-then-notify escalation queue, and real admin tickets pages.

**Tech Stack:** TypeScript ESM, node `crypto` (RS256 JWT), fetch, drizzle + Postgres, pg-boss 10, vitest, `@anthropic-ai/sdk` via an injectable seam (triage), Fastify + house `html.ts` (admin).

**Spec:** `docs/superpowers/specs/2026-08-25-phase-6a-support-plumbing-design.md` — the spec is normative; when this plan and the spec disagree, the spec wins and the discrepancy must be flagged.

## Global Constraints

- TDD is mandatory: failing test first for every behavior; watch it fail, then implement.
- `apps/ops` `test` script is vitest-only — run BOTH `pnpm --filter <pkg> test` AND `pnpm --filter <pkg> typecheck` before calling any task done.
- Local dev Postgres: `postgres://doge:doge@localhost:5433/doge_buddy` (start with `pnpm db:up`; migrate with `pnpm --filter @doge-buddy/db migrate`).
- All address comparisons use parsed, lowercased RFC 5322 addr-specs — never substring matches on raw headers (spec §1).
- The `SENT` Gmail label is the SOLE outbound-direction signal (spec §2.4).
- Every ingest side effect keys on the `support_messages` row actually inserting (`ON CONFLICT DO NOTHING RETURNING`) (spec §2.5).
- No fixture may contain `Bearer ` or `PRIVATE KEY`; the token path is never fixture-recorded (spec §1).
- Poll cadence is `* * * * *` (pg-boss cannot fire sub-minute); queue is `policy: 'singleton'` with `singletonKey: 'support.poll-gmail'`, `expireInSeconds: 120`, `retryLimit: 0` (spec §2).
- Escalation tripwire keywords (spec §2.6, fixed): `chargeback`, `dispute`, `lawsuit`, `attorney`, `legal action`, `injury`, `hurt`, `vet`, `recall`.
- Triage: model `claude-haiku-4-5`, `TRIAGE_MAX_CALLS_PER_DAY = 200`, per-cycle cap 20, per-call timeout 30s (spec §3).
- Commit after every green test cycle; conventional-commit messages.

---

### Task 1: `packages/gmail` scaffold + service-account auth

**Files:**
- Create: `packages/gmail/package.json`, `packages/gmail/tsconfig.json`, `packages/gmail/src/index.ts`, `packages/gmail/src/auth.ts`
- Test: `packages/gmail/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces: `createGmailAuth(opts: { saEmail: string; saKey: string; impersonate: string; fetchFn?: typeof fetch; now?: () => Date }): GmailAuth` where `GmailAuth = { getAccessToken(): Promise<string> }`. Token cached; refreshed when < 10 min of its 1h validity remain. Errors from the token endpoint throw `GmailAuthError` (extends Error, has `status`, `body`).

- [ ] **Step 1: Scaffold the package** (copy `packages/shopify-admin/package.json` shape; name `@doge-buddy/gmail`; same devDependencies; dependency on `@doge-buddy/core: workspace:*`; tsconfig copied from `packages/shopify-admin/tsconfig.json`). Add the package to the root workspace if `pnpm-workspace.yaml` uses explicit globs (it uses `packages/*` — verify, then no change needed). Run `pnpm install`.

- [ ] **Step 2: Write the failing auth tests** — `packages/gmail/test/auth.test.ts`:

```ts
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGmailAuth } from '../src/auth.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function fakeTokenEndpoint(capture: { body?: URLSearchParams }, token = 'tok-1') {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    capture.body = new URLSearchParams(String(init?.body))
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('createGmailAuth', () => {
  it('sends a valid RS256 JWT with iss/sub/scope/aud claims', async () => {
    const capture: { body?: URLSearchParams } = {}
    const auth = createGmailAuth({
      saEmail: 'sa@x.iam.gserviceaccount.com', saKey: TEST_PEM, impersonate: 'admin@dogebuddy.com',
      fetchFn: fakeTokenEndpoint(capture), now: () => new Date(1_760_000_000_000),
    })
    expect(await auth.getAccessToken()).toBe('tok-1')
    const assertion = capture.body!.get('assertion')!
    const [h, c, sig] = assertion.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString())
    expect(claims).toMatchObject({
      iss: 'sa@x.iam.gserviceaccount.com', sub: 'admin@dogebuddy.com',
      scope: 'https://www.googleapis.com/auth/gmail.modify', aud: 'https://oauth2.googleapis.com/token',
      iat: 1_760_000_000, exp: 1_760_000_000 + 3600,
    })
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(ok).toBe(true)
    expect(capture.body!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  it('caches the token and refreshes when under 10 minutes remain', async () => {
    let t = 1_760_000_000_000
    const capture: { body?: URLSearchParams } = {}
    const fetchFn = fakeTokenEndpoint(capture)
    const auth = createGmailAuth({ saEmail: 'sa@x', saKey: TEST_PEM, impersonate: 'a@b', fetchFn, now: () => new Date(t) })
    await auth.getAccessToken(); await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(1)          // cached
    t += 51 * 60 * 1000                               // 51 min in => <10 min left
    await auth.getAccessToken()
    expect(fetchFn).toHaveBeenCalledTimes(2)          // refreshed
  })

  it('throws GmailAuthError with status+body on a non-200 token response', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    const auth = createGmailAuth({ saEmail: 'sa@x', saKey: TEST_PEM, impersonate: 'a@b', fetchFn })
    await expect(auth.getAccessToken()).rejects.toMatchObject({ name: 'GmailAuthError', status: 400 })
  })
})
```

- [ ] **Step 3: Run** `pnpm --filter @doge-buddy/gmail test` — expect FAIL (`createGmailAuth` not defined).

- [ ] **Step 4: Implement `src/auth.ts`** — build header/claims JSON, `Buffer.toString('base64url')`, sign with `createSign('RSA-SHA256').sign(saKey, 'base64url')`, POST form-encoded to `https://oauth2.googleapis.com/token`, cache `{ token, expiresAtMs }`, refresh when `now >= expiresAtMs - 10*60*1000`. `GmailAuthError` class in the same file, re-exported from `src/index.ts`. Never include the key or token in error messages (only status + response body).

- [ ] **Step 5: Run tests (PASS) + `pnpm --filter @doge-buddy/gmail typecheck`, then commit** `feat(gmail): package scaffold + service-account JWT auth`.

---

### Task 2: address parsing + client types + error taxonomy

**Files:**
- Create: `packages/gmail/src/address.ts`, `packages/gmail/src/types.ts`, `packages/gmail/src/errors.ts`
- Test: `packages/gmail/test/address.test.ts`

**Interfaces:**
- Produces (types.ts):

```ts
export interface HistoryRecord { id: string; messagesAdded: { id: string; threadId: string }[] }
export interface NormalizedMessage {
  id: string; threadId: string; labelIds: string[]; internalDate: Date
  /** Parsed lowercase addr-specs. fromRaw kept for display only. */
  fromAddr: string | null; fromRaw: string | null
  to: string[]; cc: string[]; deliveredTo: string[]
  subject: string | null; rfcMessageId: string | null; inReplyTo: string | null; references: string | null
  /** null when fetched with format:'metadata' */
  bodyText: string | null
}
export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  listHistory(q: { startHistoryId: string; pageToken?: string }): Promise<{ records: HistoryRecord[]; nextPageToken?: string }>
  listMessages(q: { q?: string; pageToken?: string; includeSpamTrash?: boolean }): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken?: string }>
  getMessage(id: string, opts: { format: 'metadata' | 'full' }): Promise<NormalizedMessage>
  listLabels(): Promise<{ id: string; name: string }[]>
  createLabel(name: string): Promise<{ id: string; name: string }>
  modifyMessage(id: string, mods: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void>
  sendReply(r: { threadId: string; to: string; subject: string; inReplyTo: string; references: string; bodyText: string }): Promise<{ id: string; threadId: string }>
}
```

- Produces (errors.ts): `GmailApiError` (fields `status: number`, `reason: string | null`, `message`), `HistoryExpiredError`, `MessageGoneError`, `GmailRateLimitError` — all extend Error with `name` set; type guards `isHistoryExpired(e)`, `isMessageGone(e)`.
- Produces (address.ts): `parseAddrSpecs(header: string | null | undefined): string[]` (all addresses in the header, lowercased addr-spec only) and `parseFirstAddrSpec(header): string | null`.

- [ ] **Step 1: Failing address tests** — `test/address.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseAddrSpecs, parseFirstAddrSpec } from '../src/address.ts'

describe('parseAddrSpecs', () => {
  it('extracts lowercase addr-specs from display-name forms and lists', () => {
    expect(parseAddrSpecs('DogeBuddy Support <Admin@DogeBuddy.com>')).toEqual(['admin@dogebuddy.com'])
    expect(parseAddrSpecs('a@x.com, "B, comma" <b@y.com>')).toEqual(['a@x.com', 'b@y.com'])
    expect(parseAddrSpecs('bare@addr.com')).toEqual(['bare@addr.com'])
  })
  it('is NOT fooled by an address inside a display name (spoof case)', () => {
    expect(parseAddrSpecs('"support@dogebuddy.com" <x@evil.com>')).toEqual(['x@evil.com'])
  })
  it('handles null/empty/garbage', () => {
    expect(parseAddrSpecs(null)).toEqual([])
    expect(parseAddrSpecs('no address here')).toEqual([])
    expect(parseFirstAddrSpec('Bob <b@y.com>')).toBe('b@y.com')
    expect(parseFirstAddrSpec('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run (FAIL), then implement.** `parseAddrSpecs`: split on top-level commas outside quoted strings; per mailbox take the text inside the LAST `<...>` if present, else the bare token; validate with a conservative `/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/` regex; lowercase. Quoted display names must be stripped BEFORE looking for a bare address (that ordering is what makes the spoof test pass). `types.ts` and `errors.ts` are pure declarations + trivial classes — no tests beyond compilation.

- [ ] **Step 3: Tests PASS + typecheck, commit** `feat(gmail): address parsing, client types, error taxonomy`.

---

### Task 3: Gmail read client (profile/history/messages/labels) with fixture suite

**Files:**
- Create: `packages/gmail/src/client.ts`, `packages/gmail/src/body.ts`, `packages/gmail/test/fixtures/*.json`
- Test: `packages/gmail/test/client.test.ts`, `packages/gmail/test/body.test.ts`

**Interfaces:**
- Consumes: `GmailAuth` (Task 1), types/errors/address (Task 2).
- Produces: `createGmailClient(opts: { auth: GmailAuth; fetchFn?: typeof fetch }): GmailClient` implementing every read method of `GmailClient` (sendReply arrives Task 4). Base URL `https://gmail.googleapis.com/gmail/v1/users/me`. Also `extractBodyText(payload: unknown): string | null` from `body.ts`.

**Error taxonomy (implement exactly):** every response is checked; non-2xx parses the JSON error body's `error.errors[0].reason`/`error.status`. 401 → refresh token once (call `auth.getAccessToken()` again after invalidating cache — expose `auth` as-is; the client just retries once with a fresh call) → single retry. 429, or 403 with reason `userRateLimitExceeded`/`rateLimitExceeded`/`dailyLimitExceeded` → one retry after `200 + Math.random()*400` ms → then throw `GmailRateLimitError`. Other 403 → `GmailApiError` (permission — distinct). 404 from `listHistory` → `HistoryExpiredError`; 404 from `getMessage` → `MessageGoneError`. 5xx → one jittered retry → `GmailApiError`.

**Body extraction (`body.ts`):** depth-first walk of `payload`: prefer first `text/plain` leaf with `body.data`; else first `text/html` leaf, base64url-decode then strip tags (`.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ')`, collapse whitespace, decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`); else top-level `payload.body.data`; parts with only `attachmentId` are skipped.

- [ ] **Step 1: Author fixtures** (hand-written JSON — provisional until `GMAIL_CONTRACT=1` re-records; each fixture is `{ request: { method, path, query }, response: { status, body } }`, NO Authorization headers anywhere):
  - `profile.json`, `history-page1.json` + `history-page2.json` (with `nextPageToken`, records carrying string ids like `"3025"`, `"3031"` and `messagesAdded`), `history-404.json`, `messages-list.json`,
  - `message-full-nested.json` — multipart/mixed(multipart/alternative(text/plain,text/html), attachment w/ attachmentId), headers incl. repeating `Delivered-To`, `From: "Jane D" <Jane@Example.com>`,
  - `message-full-singlepart.json` — no `parts[]`, body in `payload.body.data`,
  - `message-metadata.json` (format=metadata: headers only),
  - `message-404.json`, `labels-list.json`, `label-create.json`, `error-403-quota.json` (reason `rateLimitExceeded`), `error-403-perm.json` (reason `forbidden`).

- [ ] **Step 2: Failing client tests** — a `fixtureFetch(map: Record<string, Fixture>)` helper that matches `path?query` and returns the fixture response; assert per method: URL/query built correctly (e.g. `format=metadata`, `metadataHeaders` repeated for From/To/Cc/Delivered-To/Subject/Message-ID/In-Reply-To/References), normalization (`fromAddr: 'jane@example.com'`, `to`/`cc`/`deliveredTo` parsed arrays, `internalDate` from ms-string), `bodyText` extracted from the nested fixture, `bodyText: null` for metadata, `HistoryExpiredError` on history-404, `MessageGoneError` on message-404, `GmailRateLimitError` after 403-quota retry, plain `GmailApiError` on 403-perm (NO retry), 401-then-200 single retry. Plus `body.test.ts` unit-testing `extractBodyText` on the three shapes directly. Plus the scrubbing assertion test:

```ts
it('no fixture contains auth material', async () => {
  const dir = new URL('./fixtures/', import.meta.url)
  for (const f of await readdir(dir)) {
    const text = await readFile(new URL(f, dir), 'utf8')
    expect(text.includes('Bearer '), `${f} contains a bearer token`).toBe(false)
    expect(text.includes('PRIVATE KEY'), `${f} contains key material`).toBe(false)
  }
})
```

- [ ] **Step 3: Run (FAIL) → implement `client.ts` + `body.ts` → run (PASS) + typecheck.**

- [ ] **Step 4: Commit** `feat(gmail): read client with fixtures — history, messages, labels, error taxonomy`.

---

### Task 4: `sendReply` — RFC 2822 builder with From-stamping

**Files:**
- Modify: `packages/gmail/src/client.ts` (add `sendReply`; `createGmailClient` gains required `fromAddress: string` option)
- Create: `packages/gmail/src/rfc2822.ts`
- Test: `packages/gmail/test/rfc2822.test.ts`

**Interfaces:**
- Produces: `buildReplyRaw(r: { from: string; to: string; subject: string; inReplyTo: string; references: string; bodyText: string }): string` (base64url of the full RFC 2822 message) and `GmailClient.sendReply` which POSTs `{ raw, threadId }` to `/messages/send`. NOTE for boot wiring (Task 12): `createGmailClient({ auth, fromAddress: config.gmail.supportAddress })`.

- [ ] **Step 1: Failing tests** — decode the produced raw and assert byte-exact header lines:

```ts
const raw = buildReplyRaw({ from: 'support@dogebuddy.com', to: 'jane@example.com',
  subject: 'Re: Broken leash', inReplyTo: '<abc@mail.example.com>', references: '<root@x> <abc@mail.example.com>',
  bodyText: 'Hi Jane,\n\nSorry about that.' })
const text = Buffer.from(raw, 'base64url').toString()
expect(text).toContain('From: support@dogebuddy.com\r\n')
expect(text).toContain('To: jane@example.com\r\n')
expect(text).toContain('Subject: Re: Broken leash\r\n')
expect(text).toContain('In-Reply-To: <abc@mail.example.com>\r\n')
expect(text).toContain('References: <root@x> <abc@mail.example.com>\r\n')
expect(text).toContain('Content-Type: text/plain; charset="UTF-8"\r\n')
expect(text.split('\r\n\r\n')[1]).toBe('Hi Jane,\n\nSorry about that.')
```

Plus: `sendReply` fixture test asserting the POST body is `{ raw, threadId }` and the subject gets a `Re: ` prefix added only when missing (pass `subject: 'Broken leash'` → header `Subject: Re: Broken leash`); a UTF-8 subject is RFC 2047 encoded (`Subject: =?UTF-8?B?...?=` — test with `'Re: Hundeleine kaputt 🐶'`).

- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(gmail): sendReply with From-stamped RFC 2822 builder`.

---

### Task 5: `MockGmail`

**Files:**
- Create: `packages/gmail/src/mock.ts` (exported from index — it's a test util for OTHER packages, so it ships in src like `MockSupplierAdapter` does in `@doge-buddy/supplier`)
- Test: `packages/gmail/test/mock.test.ts`

**Interfaces:**
- Produces: `createMockGmail(opts?: { selfAddress?: string }): MockGmail` where `MockGmail` implements `GmailClient` plus test helpers:

```ts
interface MockGmail extends GmailClient {
  receiveInbound(m: { from: string; to?: string[]; cc?: string[]; deliveredTo?: string[]; subject: string; bodyText: string; threadId?: string; labelIds?: string[] }): { id: string; threadId: string }
  /** Simulates Gmail draft autosave churn: each call REPLACES the prior revision (new message id, old id becomes 404-gone), DRAFT label. */
  saveDraft(m: { threadId: string; bodyText: string }): { id: string }
  /** Sends the current draft: draft message ids become gone; a new SENT message id appears on the thread. */
  sendDraft(threadId: string): { id: string }
  expireHistory(): void            // next listHistory throws HistoryExpiredError
  failNext(method: keyof GmailClient, err: Error): void
  labelsOf(id: string): string[]   // assertion helper
}
```

Every mutation appends history records with increasing numeric-string ids; `listHistory({startHistoryId})` returns records with id > start; `getMessage` on a gone id throws `MessageGoneError`; `listMessages` supports the resync `q` filter minimally (parses `to:X OR cc:X OR deliveredto:X` — matches messages whose to/cc/deliveredTo contain X) and `includeSpamTrash`.

- [ ] **Step 1: Failing tests** covering: receiveInbound → listHistory sees it; incremental history (second call from last id returns only new); draft churn (`saveDraft` twice → two history adds, first id now `MessageGoneError`, both DRAFT-labeled); `sendDraft` → SENT message present, draft ids gone; `expireHistory` → `HistoryExpiredError` once then normal; `modifyMessage`/`labelsOf` round-trip; `failNext` injection; `sendReply` appends a SENT message to the thread.

- [ ] **Step 2: Run (FAIL) → implement (in-memory maps: messages by id, thread index, history log, label registry seeded with system labels INBOX/SENT/DRAFT/SPAM/TRASH) → run (PASS) + typecheck → commit** `feat(gmail): MockGmail with faithful history + draft-churn semantics`.

---

### Task 6: DB migration + ops config + settings key

**Files:**
- Modify: `packages/db/src/schema.ts` (two tables), `apps/ops/src/config.ts`, `apps/ops/src/settings.ts`
- Create: generated migration under `packages/db/migrations/`
- Test: `apps/ops/test/config.test.ts` (extend), settings covered by existing settings tests pattern (add one case)

**Interfaces:**
- Produces (schema): `supportTickets` += `sentiment: text`, `isSpam: boolean('is_spam')`, `escalationReason: text('escalation_reason')`, `lastTriagedAt: timestamp('last_triaged_at', { withTimezone: true })`, `triageFailureCount: integer('triage_failure_count').notNull().default(0)`, `claimedOrderNumber: text('claimed_order_number')`, `escalationNotifiedAt: timestamp('escalation_notified_at', { withTimezone: true })`. `gmailSyncState` += `consecutiveFailures: integer('consecutive_failures').notNull().default(0)`, `lastSuccessAt: timestamp('last_success_at', { withTimezone: true })`.
- Produces (config): `config.gmail?: { saEmail: string; saKey: string; impersonate: string; supportAddress: string }` from `GMAIL_SERVICE_ACCOUNT_EMAIL` / `GMAIL_SERVICE_ACCOUNT_KEY` / `GMAIL_IMPERSONATE` / `SUPPORT_ADDRESS`; `saKey` has `\n` unescaped (`.replace(/\\n/g, '\n')`); all-or-none superRefine exactly like the existing `telegram` block (partial group = config error listing the missing names).
- Produces (settings): `SETTINGS_DEFAULTS['workflow.support.enabled'] = true`.

- [ ] **Step 1: Failing config tests** (mirror the telegram all-or-none cases): full quartet → `config.gmail` populated with unescaped key (`expect(config.gmail!.saKey).toContain('\n')` given an input containing `\\n`); absent quartet → `undefined`; partial (email only) → throws naming the three missing vars.
- [ ] **Step 2: Run (FAIL) → implement config + settings default → run (PASS).**
- [ ] **Step 3: Schema edit + `pnpm --filter @doge-buddy/db generate` (drizzle-kit) → inspect the generated SQL (additive ALTERs only) → `pnpm --filter @doge-buddy/db migrate` against local dev DB.**
- [ ] **Step 4: Full `apps/ops` suite (schema drift can break other tests) + typecheck both packages → commit** `feat(support): triage/escalation columns, gmail config quartet, support kill-lever setting`.

---

### Task 7: `registerCron` policy + singletonKey support

**Files:**
- Modify: `apps/ops/src/queue.ts` (`CronJobOptions`, `registerCron`)
- Test: `apps/ops/test/queue-register-cron.test.ts` (create; follow the existing queue test file's harness if one exists — check `apps/ops/test/` for a queue/pg-boss test to mirror; a stub-based test is acceptable: fake `boss` object capturing calls)

**Interfaces:**
- Produces: `CronJobOptions` += `policy?: 'standard' | 'singleton'`, `singletonKey?: string`. `registerCron` passes `policy` into `createQueueRetrying`'s options and the `updateQueue` follow-up (explicit `policy` now REPLACES the read-current-policy dance when provided; when absent, current behavior byte-for-byte). When `singletonKey` is set, `boss.schedule(name, cron, {}, { singletonKey })`.

- [ ] **Step 1: Failing tests** with a stub boss (`vi.fn()` methods, `getQueue` returning `{ policy: 'singleton' }` where relevant): (a) opts with `policy: 'singleton'` → `createQueue` called with policy AND `updateQueue` called with `policy: 'singleton'`; (b) opts WITHOUT policy on an existing singleton queue → `updateQueue` preserves `'singleton'` (the regression the existing doc comment warns about); (c) `singletonKey: 'k'` → `schedule` called with `(name, cron, {}, { singletonKey: 'k' })`; (d) no opts → `schedule(name, cron)` two-arg, no `updateQueue`.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck + full ops suite → commit** `feat(queue): registerCron accepts queue policy + schedule singletonKey`.

---

### Task 8: Ingest core — incremental sync, filter, first-insert side effects

**Files:**
- Create: `apps/ops/src/support/ingest.ts`
- Test: `apps/ops/test/support-ingest.test.ts` (local DB + `createMockGmail`, cleanup pattern copied from `sourcing-harvest.test.ts`: track created ticket/message ids, delete in `afterEach`)

**Interfaces:**
- Consumes: `GmailClient`/`MockGmail`, `NormalizedMessage`, error guards (`@doge-buddy/gmail`); `supportTickets`, `supportMessages`, `gmailSyncState` (schema); `Alert` type (same shape as harvest's).
- Produces:

```ts
export const TRIPWIRE_KEYWORDS = ['chargeback','dispute','lawsuit','attorney','legal action','injury','hurt','vet','recall'] as const
export const NEW_LABEL = 'DogeBuddy/New'
export const SPAM_LABEL = 'DogeBuddy/Spam'
export interface IngestDeps { db: Db; gmail: GmailClient; supportAddress: string; selfAddresses: string[]; alert: Alert; now?: () => Date }
export interface IngestResult { insertedMessages: number; newInboundTicketIds: string[]; tripwiredTicketIds: string[] }
export async function runIngest(deps: IngestDeps): Promise<IngestResult>
export function tripwireHit(subject: string | null, body: string | null): string | null  // returns matched keyword
```

Behavior per spec §2 (steps 1–8): seed-on-null; incremental listHistory walk collecting messagesAdded; per id `getMessage(id, {format:'metadata'})`; skip DRAFT/TRASH labels; `MessageGoneError` → skip; filter = any of to/cc/deliveredTo equals `supportAddress` OR thread has a ticket; on match `getMessage(id, {format:'full'})`; direction = labelIds includes `'SENT'` ? outbound : inbound; ticket upsert + message `INSERT ... ON CONFLICT DO NOTHING RETURNING id` via drizzle `.onConflictDoNothing().returning()`; first-insert side effects only (reopen resolved/waiting_on_customer→new via guarded UPDATE, `last_inbound_at = GREATEST`, `DogeBuddy/New` label add with cached label id + invalidate-once-on-error, tripwire: guarded `UPDATE ... SET status='escalated', escalation_reason='tripwire: <kw>' WHERE id=$ AND status NOT IN ('escalated')`); sync state advanced to max history-record id (BigInt compare) via `UPDATE gmail_sync_state SET last_history_id = $1 WHERE last_history_id < $1` after the batch. Resync path is Task 9 (here: `HistoryExpiredError` propagates).

- [ ] **Step 1: Failing tests** (each a scenario; use MockGmail seeded and a first `runIngest` to seed historyId where needed):
  1. inbound to support@ → ticket (customer_email = parsed from, subject, status new, last_inbound_at) + message row (direction inbound, body, rfc_message_id) + `DogeBuddy/New` label on the message + counted in `insertedMessages`.
  2. mail NOT addressed to support@ → nothing (no rows, no full fetch — assert via `failNext`-style spy or MockGmail call log that format:'full' was never requested for it).
  3. re-running `runIngest` with no new history → zero inserts, zero label calls (side effects keyed on insert).
  4. follow-up on a resolved ticket → reopened to `new`; on an `escalated` ticket → stays escalated.
  5. draft churn on a ticket thread (saveDraft ×2 + sendDraft) → zero draft rows, exactly one outbound row (the SENT copy).
  6. spoofed `From: support@dogebuddy.com` without SENT label → direction inbound.
  7. deleted message mid-batch (receive then make it gone) → poll completes, other messages ingested, historyId advanced.
  8. tripwire: body containing "I will file a chargeback" → ticket escalated with reason `tripwire: chargeback`, in `tripwiredTicketIds`.
  9. historyId stored is the max record id compared numerically (seed ids "99" and "100" via 100+ mutations or direct mock control) and a stale concurrent write loses (`WHERE last_history_id <`).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): gmail ingest — filtered, idempotent, tripwired`.

---

### Task 9: Resync path (history expired)

**Files:**
- Modify: `apps/ops/src/support/ingest.ts`
- Test: extend `apps/ops/test/support-ingest.test.ts`

**Interfaces:** unchanged (`runIngest` handles `HistoryExpiredError` internally now).

Behavior per spec §2.2: capture `getProfile().historyId` FIRST; `listMessages` with `q = "to:S OR cc:S OR deliveredto:S"`, `includeSpamTrash: true`, page-by-page — each page fully upserted (same code path as Task 8's per-message handling, which is what makes it side-effect-safe on re-seen messages) before the next page is fetched; then walk `listMessages`-by-thread for every known ticket thread (`q` can't see follow-ups that dropped the address — implement as: for each distinct `gmail_thread_id` in `support_tickets`, fetch that thread's message ids via `listMessages({ q: undefined })`? NO — use the thread endpoint: add `getThread(threadId): Promise<{ messages: { id: string }[] }>` to the client + mock (tiny addition, same normalization NOT needed — ids only) and walk those ids through the same per-message path); finally store the pre-captured historyId (guarded UPDATE, same comparator).

- [ ] **Step 1: Add `getThread` to `GmailClient` + fixture + MockGmail (failing test in packages/gmail, then implement, commit there first)** — `feat(gmail): getThread (resync support)`.
- [ ] **Step 2: Failing ops tests:** (a) `expireHistory()` + a mailbox containing an already-ingested resolved ticket, a new support mail, and a non-support mail → after `runIngest`: new mail ingested, resolved ticket NOT reopened (no re-seen side effects), non-support mail absent, sync state = the pre-captured profile historyId; (b) a follow-up (on a known thread) that dropped support@ from headers is still picked up via the thread walk; (c) failure injected on page 2 of `listMessages` → next `runIngest` completes without re-reopening anything (per-page commits make the retry idempotent).
- [ ] **Step 3: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): bounded resumable resync on history expiry`.

---

### Task 10: Escalation notifier — commit-then-notify, collapse, daily cap

**Files:**
- Create: `apps/ops/src/support/escalate.ts`
- Test: `apps/ops/test/support-escalate.test.ts`

**Interfaces:**
- Consumes: `NotifyOwner` (`apps/ops/src/notify/notify.ts` — `(n: { title: string; body: string; actions?: { label: string; url: string }[] }) => Promise<boolean>`), `auditLog`, `supportTickets`.
- Produces:

```ts
export const ESCALATION_NOTIFY_MAX_PER_DAY = 10
export interface EscalateDeps { db: Db; notify: NotifyOwner; alert: Alert; adminBaseUrl: string; now?: () => Date }
/** Notifies every escalated ticket with escalation_notified_at IS NULL: ONE collapsed Telegram
 * message per call, deep links per ticket; stamps escalation_notified_at only on notify()===true.
 * Daily cap counted via audit rows (action 'support.escalation_notified', one per BATCH);
 * over cap => single 'support.escalation_capped' warning alert per UTC day, tickets stay pending. */
export async function notifyPendingEscalations(deps: EscalateDeps): Promise<{ notified: number }>
```

- [ ] **Step 1: Failing tests:** (a) two pending escalations → ONE notify call whose body contains both subjects + `${adminBaseUrl}/admin/tickets/<id>` links; both stamped; audit row written; (b) notify returns false → nothing stamped, next call retries; (c) already-stamped tickets not re-notified; (d) 10 batches already audited today (seed audit rows) → no notify, one capped warning, and a second call the same day does NOT emit a second capped warning (guarded by that day's existing cap-warning audit row); (e) UTC day boundary respected (seed rows at yesterday 23:59 UTC → not counted).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): at-least-once collapsed escalation notifications with daily cap`.

---

### Task 11: Triage

**Files:**
- Create: `apps/ops/src/support/triage.ts`
- Test: `apps/ops/test/support-triage.test.ts`

**Interfaces:**
- Consumes: schema tables, `Alert`, tripwire constants (Task 8), `orders` table.
- Produces:

```ts
export const TRIAGE_MODEL = 'claude-haiku-4-5'
export const TRIAGE_MAX_CALLS_PER_DAY = 200
export const TRIAGE_MAX_PER_CYCLE = 20
export const TRIAGE_TIMEOUT_MS = 30_000
export interface TriageVerdict { category: 'toys'|'walks'|'beds'|'grooming'|'order_issue'|'shipping'|'refund_request'|'product_question'|'other'; order_number: string | null; sentiment: 'positive'|'neutral'|'negative'|'angry'; is_spam: boolean; escalation_flags: ('legal_threat'|'chargeback_threat'|'injury'|'recall_mention')[] }
/** Injectable seam: given the prompt, return the parsed verdict. Production impl calls
 * claude-haiku-4-5 structured output via @anthropic-ai/sdk with an AbortController timeout. */
export type TriageCall = (input: { subject: string | null; bodies: string[] }, signal: AbortSignal) => Promise<TriageVerdict>
export interface TriageDeps { db: Db; call: TriageCall; gmail: GmailClient; alert: Alert; now?: () => Date }
export async function runTriage(deps: TriageDeps): Promise<{ triaged: number; escalatedTicketIds: string[] }>
export function normalizeOrderNumber(v: string): string  // strips leading '#' + whitespace
export function createAnthropicTriageCall(opts: { apiKey: string }): TriageCall
```

Behavior per spec §3: selection `status='new' OR (status='triaged' AND last_inbound_at > last_triaged_at)`, order `last_inbound_at ASC`, limit `TRIAGE_MAX_PER_CYCLE`; per ticket: spend-guard audit row (action `support.triage`) BEFORE the call, cap by UTC-day count (at cap → stop, once-per-day warning); call with 30s AbortController; failure/timeout/unparse → `triage_failure_count + 1` (escalate at 2 with reason `triage_failed_twice`); success → precedence: (ticket already escalated → skip write), is_spam → guarded resolved + `DogeBuddy/Spam` label on the ticket's messages + is_spam true; else escalate if flags nonempty / sentiment angry / repeat complainant (≥3 non-spam tickets from customer_email in 30d incl. current); else `triaged`. Order link: normalize both sides, `AND orders.email = ticket.customer_email` (parsed lowercase); mismatch/no-match → `claimed_order_number`. Every status write guarded on the selected status. Per-sender flood (spec §3 last bullet) is enforced at INGEST-time ticket creation (Task 8's ticket-create step gains: if this sender already created 5 tickets today, attach the message to their newest ticket instead + one warning) — implement it HERE as a small change to `ingest.ts` with its own test, since it needs no triage machinery.

- [ ] **Step 1: Failing tests** with a stubbed `call` (table-driven verdicts): happy triage; re-triage on follow-up (`last_inbound_at > last_triaged_at`); no re-triage when older; spam precedence (angry+spam → resolved, NOT escalated, excluded from later repeat-complainant count); repeat complainant (3rd non-spam ticket escalates); tripwired-already ticket skipped; failure→count=1 stays new, second failure→escalated; cap stop + single daily warning; order link happy path (`#1001` claimed vs stored `1001`, matching email → linked); ownership mismatch → `claimed_order_number` set, `order_id` null; guarded write (owner resolved mid-flight → triage write skipped); per-sender flood fold (6th ticket same sender same day → message lands on ticket 5, no 6th ticket).
- [ ] **Step 2: Run (FAIL) → implement `runTriage` + the ingest flood change → run (PASS).**
- [ ] **Step 3: Implement `createAnthropicTriageCall`** using `@anthropic-ai/sdk` (already a transitive dep? check `apps/ops/package.json` — the Agent SDK is present but the plain SDK may not be: add `@anthropic-ai/sdk` to apps/ops dependencies, exact-pin per house convention, `pnpm install`). Structured output via a `tool` with `input_schema` matching `TriageVerdict` + `tool_choice: { type: 'tool', name: 'triage' }`; prompt states email content is untrusted data and instructs classification only. Unit test: stub fetch/client — assert the request carries the model id + tool_choice and the response tool input parses; a malformed tool input throws (counted as unparseable by `runTriage`).
- [ ] **Step 4: Full ops suite + typecheck → commit** `feat(support): capped haiku triage with code-floored escalation + order ownership linking`.

---

### Task 12: The poll job + boot wiring

**Files:**
- Create: `apps/ops/src/jobs/support-poll-gmail.ts`
- Modify: `apps/ops/src/index.ts` (construct gmail client from config; register cron), `apps/ops/src/queue.ts` only if boot needs the queue pre-created (follow the RECONCILE_QUEUE comment pattern — registerCron bundles create+work+schedule, so index.ts registration suffices)
- Test: `apps/ops/test/support-poll-job.test.ts`

**Interfaces:**
- Consumes: everything above; `createSettings` (`get('workflow.support.enabled')`, `get('killswitch.global')`), config.
- Produces: `supportPollGmailHandler(deps: { db; gmail: GmailClient | null; settings: Settings; alert: Alert; notify: NotifyOwner; adminBaseUrl: string; triageCall: TriageCall | null }): PgBoss.WorkHandler` and `SUPPORT_POLL_QUEUE = 'support.poll-gmail'`. index.ts registers: `registerCron(boss, SUPPORT_POLL_QUEUE, '* * * * *', handler, { policy: 'singleton', singletonKey: SUPPORT_POLL_QUEUE, expireInSeconds: 120, retryLimit: 0 })`, with `gmail: config.gmail ? createGmailClient({ auth: createGmailAuth({...config.gmail}), fromAddress: config.gmail.supportAddress }) : null` and `triageCall: config.anthropic ? createAnthropicTriageCall({ apiKey: ... }) : null`.

Handler behavior: (1) skip paths — `gmail === null` (once-per-boot info alert via a module-level flag), killswitch on, `workflow.support.enabled` false → return without touching sync state; (2) `runIngest`; (3) `runTriage` when `triageCall` present (its absence alerts once per boot too); (4) `notifyPendingEscalations`; (5) success → `consecutive_failures = 0`, `last_success_at = now` on `gmail_sync_state`; any stage throw → increment `consecutive_failures`, warning alert at exactly 5, critical + `notify` at exactly 20, then swallow (return, not throw — `retryLimit: 0` means pg-boss wouldn't retry anyway; the next minute is the retry). Stages 2–4 run in sequence but a triage failure must not skip stage 4 (try/catch per stage, remember the first error for the failure accounting).

- [ ] **Step 1: Failing tests** with stubbed deps (real DB for sync-state counters, MockGmail): skip on setting off (no gmail calls); failure increments counter and fires warning at 5 / critical+notify at 20 exactly once each; success resets counter + stamps last_success_at; triage throw still runs escalation notify; ingest throw skips triage but still does failure accounting.
- [ ] **Step 2: Run (FAIL) → implement handler → run (PASS).**
- [ ] **Step 3: Wire index.ts** (follow the existing wallet-monitor/reconcile registerCron call sites); boot the dev server once against local DB + no gmail config to prove the skip path logs its single info alert and nothing crashes (kill by process group: `setsid pnpm --filter @doge-buddy/ops dev` then `kill -- -PID`).
- [ ] **Step 4: Full ops suite + typecheck → commit** `feat(support): minute-cadence singleton poll job wired at boot`.

---

### Task 13: Admin tickets pages

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (replace the `/admin/tickets` stub; add `/admin/tickets/:id` + two POST actions; add poll-health line to `/admin`), `apps/ops/src/http/admin/html.ts` (only if a new shared helper is genuinely needed — prefer local functions in routes)
- Test: `apps/ops/test/admin-tickets.test.ts` (mirror the existing admin route test harness — see `apps/ops/test/admin-html.test.ts` and the routes tests for session/auth setup)

**Interfaces:**
- Consumes: `supportTickets`, `supportMessages`, `orders`, `esc`/`html`/`layout` from `html.ts`, existing `authed` route grouping + audit conventions.
- Produces: `GET /admin/tickets` (list: escalated pinned first then `last_inbound_at DESC`; `?status=` filter chips incl. `spam` → `is_spam = true`; columns: status, category, sentiment, customer, subject, order link or `claimed #N (unverified)`, age), `GET /admin/tickets/:id` (messages chronological with direction styling, triage verdict block, escalation reason, linked-order summary, Escalate/Resolve POST forms), `POST /admin/tickets/:id/escalate` and `POST /admin/tickets/:id/resolve` — guarded transitions (`WHERE id AND status = $expectedFromForm`), audit rows (`actor: 'owner'`, actions `support.ticket_escalated` / `support.ticket_resolved`), redirect back. `/admin` health gains `support poll: last ok <ts> (<n> consecutive failures)` from `gmail_sync_state`.

- [ ] **Step 1: Failing tests:** list renders seeded tickets in pinned order; status filter; **XSS: a ticket with subject `<script>alert(1)</script>` and body `<img onerror=x>` renders escaped (response text contains `&lt;script&gt;`, never `<script>`)**; thread view shows messages + claimed-unverified marker; escalate POST flips status + audits; resolve POST with stale expected status (row already resolved) → no-op + still redirects; unauthenticated request → login redirect (mirror existing tests).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(admin): tickets list + thread view with guarded actions and poll health`.

---

### Task 14: Whole-suite verification + docs

**Files:**
- Modify: `docs/OWNER-CHECKLIST.md` (6A live-verify items: Railway env vars `GMAIL_*`+`SUPPORT_ADDRESS`, then the two Tier-2 email tests), `README.md` phase line if it states the current phase.

- [ ] **Step 1:** `pnpm --filter @doge-buddy/gmail test && pnpm --filter @doge-buddy/ops test && pnpm typecheck` — all green, no warnings in output.
- [ ] **Step 2:** `GMAIL_CONTRACT=1` live re-record dry run IF creds present in `.env`: send one owner-seeded test email first, re-record, re-run contract suite, verify the scrubbing assertion still passes, commit fixtures — `test(gmail): fixtures re-recorded against live mailbox`.
- [ ] **Step 3:** Update docs; commit `docs: 6A build complete — live Tier-2 steps on owner checklist`.
- [ ] **Step 4 (process):** hand back for the final whole-branch multi-lens review Workflow (house rule — NOT optional) before merge.

---

## Self-review notes (spec coverage)

- Spec §1 → Tasks 1–5 (+ §1 scrubbing in Task 3 Step 2, getThread added in Task 9). §2 → Tasks 7, 8, 9, 12 (flood bound lands in Task 11 Step 1 as an ingest change — flagged there). §3 → Tasks 10, 11. §4 → Task 13. §5 → Task 6 (+ §5 skip paths in Task 12). §6 → distributed test steps + Task 14. §7 → owner-side, already done/tracked in OWNER-CHECKLIST.
- Type-consistency: `IngestDeps.selfAddresses` (plural) exists for direction display only — direction itself uses SENT (Global Constraints); implementers must not "improve" it into a From check.
- Deliberately absent (YAGNI, spec non-goals): reply UI, agent, apply workers, Pub/Sub, per-message triage.
