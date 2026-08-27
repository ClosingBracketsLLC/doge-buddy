# Phase 6B — Support Agent + Apply Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-ticket Agent SDK support agent that drafts replies (and refund proposals) for triaged tickets, with owner approval via Telegram/admin, plus the `support_reply` and `refund` apply executors that actually send the mail / move the money.

**Architecture:** The minute-cadence poll gains a 4th stage that selects `triaged` tickets and enqueues `support.agent-run` jobs (singleton queue + guarded CAS claim as the real mutex). The runner mirrors Phase 5's harness (extracted to `run-harness.ts`), returns structured output, and plain code validates + submits proposals. Sessions persist in a Postgres `SessionStore` (SDK `@alpha` mirror API) and resume per ticket. Apply executors fill `run-apply.ts`'s type-dispatch seam.

**Tech Stack:** TypeScript ESM, pnpm workspace, Fastify, pg-boss 10, drizzle/Postgres, `@anthropic-ai/claude-agent-sdk` 0.3.241, zod v4, vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-phase-6b-support-agent-design.md` — the plan argues from the spec; executors read both. The 6A spec (`2026-08-25-phase-6a-support-plumbing-design.md`) documents the substrate.

## Global Constraints

- **TDD every task:** failing test → implement → pass. `apps/ops` `test` script is vitest-ONLY; CI gates separately on `pnpm typecheck` — run BOTH before calling a task green.
- **Worktree discipline:** run all verification (pnpm install, tests, grep) FROM the worktree path. Kill any dev server by process group (`setsid` + `kill -- -PID`). A worktree's `pnpm db:up` creates its own compose project with an EMPTY volume — run `pnpm --filter @doge-buddy/db migrate` after `db:up`, always.
- **Guarded transitions:** every ticket/proposal status write is `UPDATE … WHERE status = $expected`; 0 rows = someone else won, skip silently (audit where the spec says so). Proposal writes go through `applyProposalTransition` (`proposals/transitions.ts`) — never assign `.status` directly.
- **CRITICAL-1 (6A):** every UPDATE transitioning a ticket INTO `escalated` must set `escalationNotifiedAt: null` — EXCEPT the owner-reject path, which pre-stamps `escalationNotifiedAt: now()` (silent; sanctioned exception #2, alongside the admin Escalate button). No 6B code ever calls the notifier for escalations — `notifyPendingEscalations` in the poll is the ONLY escalation-notify caller (its daily cap is check-then-act, safe only single-caller).
- **Two watermarks:** `last_agent_run_at` = claim/loop guard, stamped at claim. `last_agent_prompted_at` = prompt/staleness watermark, advanced to the run's `threadSnapshotAt` ONLY on an authoritative result. Never conflate them.
- **Agent constants (spec §6):** `SUPPORT_MODEL='claude-sonnet-5'`, `SUPPORT_MAX_TURNS=15`, `SUPPORT_MAX_BUDGET_USD=0.50`, `SUPPORT_WATCHDOG_MS=300_000`, `SUPPORT_AGENT_MAX_RUNS_PER_DAY=50`, `SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY=3`, `AGENT_SELECT_CAP_PER_CYCLE=10`.
- **Structured output is draft-07:** `z.toJSONSchema(schema, { target: 'draft-7' })` (see `agents/output-schema.ts`'s doc comment — 2020-12 fails live in the SDK subprocess's ajv).
- **SDK session facts (spec §2):** `projectKey` is NOT an Options field — it comes from `CLAUDE_CODE_PROJECT_DIR_NAME` env (only honored when `CLAUDE_CONFIG_DIR` is also set in env). `env` REPLACES the subprocess env — always spread `process.env`. `sessionStore` requires `persistSession: true`.
- **Type/lint conventions:** house `Alert = (severity: 'info'|'warning'|'critical', kind: string, detail: Record<string, unknown>) => Promise<void>`; `NotifyOwner = (n: {title, body, actions?}) => Promise<boolean>` (never rejects); drizzle numeric columns take strings; `.ts` extension imports.

---

### Task 1: §0 gmail package fixes (TimeoutError, RFC 2822 body/subject, extra headers, Authentication-Results)

**Files:**
- Modify: `packages/gmail/src/client.ts` (isAbortError ~line 73; `METADATA_HEADERS` line 14; `sendReply` ~line 310)
- Modify: `packages/gmail/src/rfc2822.ts`
- Modify: `packages/gmail/src/types.ts` (GmailClient.sendReply signature; normalized message shape)
- Modify: `packages/gmail/src/mock.ts` (mirror new surface)
- Test: `packages/gmail/src/rfc2822.test.ts`, `packages/gmail/src/client.test.ts` (extend existing files; follow their patterns)

**Interfaces:**
- Produces: `buildReplyRaw(input: BuildReplyRawInput & { extraHeaders?: Record<string, string> }): string`
- Produces: `GmailClient.sendReply(r: { threadId; to; subject; inReplyTo; references; bodyText; extraHeaders?: Record<string, string> })` — client stamps From, passes extraHeaders through to the builder. MockGmail stores the parsed headers of sent messages so tests can assert them (add a `sentMessages` inspection helper or decode the stored raw).
- Produces: normalized `getMessage` shape gains `authenticationResults: string | null` — the TOPMOST `Authentication-Results` header value (Gmail's own stamp is last-added/topmost; collect first occurrence). Add `'Authentication-Results'` to `METADATA_HEADERS`.

- [ ] **Step 1: Failing tests:**
  - `isAbortError`: a thrown `DOMException` with `name: 'TimeoutError'` takes the timeout path (single jittered retry, then the typed timeout error) — simulate with a fetch stub that rejects with `Object.assign(new Error('timed out'), { name: 'TimeoutError' })`; assert 2 fetch calls then the typed error. Any other name (e.g. `'AbortError'`) propagates unchanged with NO retry (the client accepts no caller signal — this branch is now "unknown error, don't touch").
  - rfc2822: output contains `MIME-Version: 1.0` and `Content-Transfer-Encoding: quoted-printable` headers; non-ASCII body (`'Hündchen 🐶 '.repeat(300)` — one long paragraph) encodes to quoted-printable with every encoded line ≤ 76 chars and decodes back byte-equal; ASCII body is still readable (QP leaves plain ASCII intact apart from soft breaks); long non-ASCII subject (`'Re: Hundeleine kaputt 🐶🐶🐶 sehr sehr lange Betreffzeile …'`) emits MULTIPLE `=?UTF-8?B?…?=` encoded-words each ≤ 75 chars, folded with `\r\n ` continuations, decoding back to the input; no multi-byte character split across encoded-words (decode each chunk individually — must not throw).
  - extraHeaders: `buildReplyRaw({ …, extraHeaders: { 'X-DogeBuddy-Proposal': 'abc-123' } })` output contains that header line; header NAME is validated `/^[A-Za-z0-9-]+$/` (an invalid name throws); header value is CR/LF-sanitized like every other field (`{ 'X-DogeBuddy-Proposal': 'x\r\nBcc: evil@x.com' }` must NOT produce a Bcc line).
  - client: `sendReply` with `extraHeaders` produces a POST body whose decoded `raw` contains the header (fixture-style test mirroring the existing sendReply fixture test); `getMessage` metadata normalization exposes `authenticationResults` from a raw payload carrying an `Authentication-Results` header, `null` when absent.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + `pnpm --filter @doge-buddy/gmail test && pnpm typecheck` → commit** `fix(gmail): TimeoutError retry path, RFC2047 folding, QP body, MIME-Version, extra headers, auth-results header`

---

### Task 2: §0.3 `GMAIL_CONTRACT=1` fixture re-recorder

**Files:**
- Create: `packages/gmail/scripts/record-fixtures.ts`
- Modify: `packages/gmail/package.json` (script `"record": "tsx scripts/record-fixtures.ts"`)
- Test: `packages/gmail/src/record-fixtures.test.ts` (scrub-assertion unit)

**Interfaces:**
- Consumes: the real client factory + env `GMAIL_SERVICE_ACCOUNT_EMAIL`/`GMAIL_SERVICE_ACCOUNT_KEY`/`GMAIL_IMPERSONATE`/`SUPPORT_ADDRESS` (read via `apps/ops`' loadDotEnv conventions is NOT available here — the script reads `process.env` directly and documents `env $(grep -v '^#' apps/ops/.env | xargs)`-style invocation in a header comment).
- Produces: rewritten fixture JSON files in the existing fixtures dir (same `{ request: { method, path, query }, response: { status, body } }` shape), for: getProfile, listHistory (1 page), listMessages, getMessage metadata + full (one nested-multipart, one single-part), listLabels, getThread. It does NOT record sendReply (no unsolicited sends) or token exchange (6A scrubbing contract: JWT path is unit-tested with a throwaway key, never recorded).

- [ ] **Step 1: Failing test:** `assertScrubbed(files)` helper — given a fixture object containing `"Authorization": "Bearer x"` anywhere or a string containing `Bearer ` or `PRIVATE KEY`, it throws listing the offending file; clean fixtures pass. The recorder imports and calls this on every file before writing; the test drives the helper directly.
- [ ] **Step 2: Implement the script:** wraps the real client's `request` seam (export a recording hook or wrap `fetch`) capturing request/response pairs; runs the recording sequence against the live mailbox ONLY when `process.env.GMAIL_CONTRACT === '1'` (otherwise prints usage and exits 0); scrubs Authorization headers structurally + runs `assertScrubbed` + writes files.
- [ ] **Step 3: Run (PASS) + typecheck → commit** `test(gmail): GMAIL_CONTRACT fixture re-recorder with scrub assertions` *(the actual live re-record happens in Task 20 if creds are present)*

---

### Task 3: Migration 0005 — session entries table + ticket/message columns

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0005_*.sql` (via `pnpm --filter @doge-buddy/db generate`)
- Test: `packages/db/src/schema.test.ts` pattern if present; otherwise migration smoke = `pnpm --filter @doge-buddy/db migrate` against local dev DB

**Interfaces (Produces — exact drizzle additions):**
```ts
// supportTickets +=
lastAgentRunAt: timestamp('last_agent_run_at', { withTimezone: true }),
lastAgentPromptedAt: timestamp('last_agent_prompted_at', { withTimezone: true }),
agentFailureCount: integer('agent_failure_count').notNull().default(0),
// supportMessages +=
authResults: text('auth_results'),
// new table
export const agentSessionEntries = pgTable('agent_session_entries', {
  seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
  projectKey: text('project_key').notNull(),
  sessionId: text('session_id').notNull(),
  subpath: text('subpath').notNull().default(''),
  uuid: text('uuid'),
  entry: jsonb('entry').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('agent_session_entries_uuid_uq').on(t.sessionId, t.subpath, t.uuid).where(sql`${t.uuid} IS NOT NULL`),
  index('agent_session_entries_lookup_idx').on(t.projectKey, t.sessionId, t.subpath, t.seq),
])
```

- [ ] **Step 1:** Add schema, `pnpm --filter @doge-buddy/db generate`, inspect the generated SQL (additive only — no drops), `pnpm db:up && pnpm --filter @doge-buddy/db migrate` locally.
- [ ] **Step 2:** `pnpm typecheck` → commit `feat(db): 6B migration — agent_session_entries + ticket watermarks + auth_results`

---

### Task 4: Ingest changes — auth_results capture + reopen resets agent_failure_count

**Files:**
- Modify: `apps/ops/src/support/ingest.ts` (message insert ~line 325: add `authResults: full.authenticationResults`; reopen UPDATE ~line 355: add `agentFailureCount: 0`)
- Test: `apps/ops/src/support/ingest.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `authenticationResults` on the normalized full message; Task 3's columns.
- Produces: inbound `support_messages` rows carry `auth_results`; reopened tickets get fresh agent attempts.

- [ ] **Step 1: Failing tests:** an inbound message whose MockGmail seed carries an `Authentication-Results: mx.google.com; dmarc=pass …` header lands with that string in `support_messages.auth_results` (extend MockGmail seeding if it doesn't already pass arbitrary headers through — keep the change minimal); a ticket at `agent_failure_count = 2` in `waiting_on_customer` that receives a follow-up reopens to `new` with `agent_failure_count = 0` AND `triage_failure_count = 0` (both asserted).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): ingest stores Authentication-Results; reopen resets agent failure budget`

---

### Task 5: Policies single-source in `packages/core`

**Files:**
- Create: `packages/core/src/policies.ts`
- Modify: `packages/core/src/index.ts` (export), `apps/storefront/app/content/policies.tsx`
- Test: `packages/core/src/policies.test.ts`

**Interfaces (Produces):**
```ts
export interface PolicySection { heading?: string; paragraphs: string[] }
export interface PolicyCopy { handle: 'shipping' | 'returns' | 'privacy' | 'terms'; title: string; sections: PolicySection[] }
export const POLICY_COPY: PolicyCopy[]
/** All policies flattened to plain text for the agent's system prompt. */
export function policiesAsText(): string
```
The copy is moved VERBATIM from `apps/storefront/app/content/policies.tsx` (each `<p>` → one paragraph string, each `<h2>` → a section heading; `&apos;` etc. become real characters). The storefront keeps its `Policy`/`PolicyHandle` types and JSX shell but renders `POLICY_COPY` generically (map sections → optional `<h2 className="mt-6 font-display text-xl text-ink">` + `<p>`s). Byte-for-byte copy fidelity matters more than markup fidelity — the agent quotes this text.

- [ ] **Step 1: Failing tests:** `POLICY_COPY` has the 4 handles; returns policy text contains "30 days of delivery" and "5–10 business days"; `policiesAsText()` contains every paragraph of every policy exactly once.
- [ ] **Step 2: Run (FAIL) → implement (move copy, rewrite storefront render) → run (PASS) + `pnpm typecheck` (covers the storefront) → commit** `refactor(core): policy copy single-sourced for storefront + support agent`

---

### Task 6: Postgres SessionStore adapter

**Files:**
- Create: `apps/ops/src/agents/session-store.ts`
- Test: `apps/ops/src/agents/session-store.test.ts` (local DB, like other ops DB tests)

**Interfaces (Produces):**
```ts
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
export const SUPPORT_PROJECT_KEY = 'doge-buddy-support'
export function createPgSessionStore(db: Db): SessionStore
// implements: append(key, entries)  — NUL-scrub then per-entry insert; entries WITH uuid use
//             ON CONFLICT (session_id, subpath, uuid) DO NOTHING; entries without uuid plain insert
//           load(key) => entries ordered by seq, or null when zero rows
//           listSubkeys({projectKey, sessionId}) => distinct non-empty subpaths
// NUL scrub: JSON.stringify(entry).replaceAll(' ', '�') → JSON.parse → insert.
```
Key mapping: `key.projectKey → project_key`, `key.sessionId → session_id`, `key.subpath ?? '' → subpath`.

- [ ] **Step 1: Failing tests:** append→load round-trips deep-equal through real JSONB (object-key reordering tolerated — assert with deep equality, not string compare); replaying the same uuid-carrying batch twice yields no duplicate rows; entries without uuid append twice = two rows; load of a never-written key returns `null` (not `[]`); subpath isolation (main vs `subagents/x` don't cross-contaminate; listSubkeys returns `['subagents/x']`); an entry whose text contains ` ` inserts successfully and loads with `�` in its place.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(agents): Postgres SessionStore adapter (SDK alpha mirror contract)`

---

### Task 7: Extract `run-harness.ts` from `sourcing-run.ts`

**Files:**
- Create: `apps/ops/src/agents/run-harness.ts`
- Modify: `apps/ops/src/agents/sourcing-run.ts` (becomes a thin consumer; ALL its exports/constants keep identical names + values)
- Test: existing `apps/ops/src/agents/sourcing-run.test.ts` must pass UNCHANGED (the regression net); new `apps/ops/src/agents/run-harness.test.ts` only for harness-only surface

**Interfaces (Produces):**
```ts
export interface HarnessConfig {
  model: string; maxTurns: number; maxBudgetUsd: number; watchdogMs: number
  systemPrompt: string
  outputJsonSchema: object
  tools: string[]                 // sourcing: ['WebSearch','WebFetch']; support: []
  allowedTools: string[]
  mcpServers: Record<string, unknown>
  envExtra?: Record<string, string>   // merged over { ...process.env, MCP_TOOL_TIMEOUT: '60000' }
  resume?: string
  sessionStore?: unknown              // SDK SessionStore; when set, persistSession: true is forced
  persistSession: boolean             // sourcing: false (today's behavior); support: true
  alertKinds: { invalidOutput: string; runFailed: string }   // e.g. 'sourcing_output_invalid'
}
export interface HarnessResult<T> {
  status: 'succeeded' | 'failed' | 'aborted'
  output: T | null
  costUsd: number | null
  costEstimated: boolean
  sessionId: string | null
  sawMirrorError: boolean            // a type:'system' message with subtype 'mirror_error' streamed
  failedBeforeFirstAssistant: boolean // true when the throw/abort happened before any assistant msg
}
export type QueryFn = NonNullable<SourcingRunDeps['queryFn']>   // re-exported; Tasks 10/11 use this name
export async function runAgentQuery<T>(
  deps: { db: Db; alert: Alert; queryFn?: QueryFn },
  runId: string, prompt: string, cfg: HarnessConfig,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; issues: unknown },
): Promise<HarnessResult<T>>
```
The harness body is `runSourcingAgent`'s current lines 161–310 moved verbatim wherever possible: event streaming to `agent_run_events`, `createUsageAccumulator`, every-5-events cost checkpoint, watchdog AbortController, authoritative-result vs estimate recording on `agent_runs`, never-throws contract. New behavior additions (all inert for sourcing): `resume`/`sessionStore`/`persistSession`/`envExtra` wired into options; `sessionId` in the result (sourcing already recorded it on the row); mirror_error + first-assistant tracking.

- [ ] **Step 1:** Write `run-harness.test.ts` failing tests for the NEW surface only: `sawMirrorError` true when the stubbed stream yields `{ type: 'system', subtype: 'mirror_error' }`; `failedBeforeFirstAssistant` true when the stub throws before any assistant message and false after one; options assembly (stub captures `options`) shows `resume`, `persistSession: true` forced with a sessionStore, `env.MCP_TOOL_TIMEOUT === '60000'`, `env.PATH` survives (process.env spread).
- [ ] **Step 2:** Implement the harness, rewrite `runSourcingAgent` as a wrapper (`persistSession: false`, its constants, `parse: SourcingOutputSchema.safeParse`, alertKinds `sourcing_output_invalid`/`sourcing_run_failed`).
- [ ] **Step 3:** `pnpm --filter @doge-buddy/ops test -- sourcing-run` — UNCHANGED tests PASS; run harness tests PASS; typecheck → commit `refactor(agents): extract shared run harness; sourcing-run becomes thin consumer`

---

### Task 8: Support output schema + plain-code validator

**Files:**
- Create: `apps/ops/src/agents/support-output-schema.ts`, `apps/ops/src/support/validator.ts`
- Test: `apps/ops/src/agents/support-output-schema.test.ts`, `apps/ops/src/support/validator.test.ts`

**Interfaces (Produces):**
```ts
// support-output-schema.ts
export const SupportOutputSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('propose'),
    reply: z.object({ body: z.string().min(1).max(4000) }),
    refund: z.object({ amountCents: z.number().int().positive(), reason: z.string().min(1).max(500),
      openCjDispute: z.boolean(), cjDisputeReasonId: z.string().min(1).optional() }).optional(),
    rationale: z.string().min(1).max(2000) }),
  z.object({ outcome: z.literal('escalate'), escalationReason: z.string().min(1).max(500), rationale: z.string().min(1).max(2000) }),
  z.object({ outcome: z.literal('no_action'), rationale: z.string().min(1).max(2000) }),
])
export type SupportOutput = z.infer<typeof SupportOutputSchema>
export const SUPPORT_OUTPUT_JSON_SCHEMA = z.toJSONSchema(SupportOutputSchema, { target: 'draft-7' })

// validator.ts — three exports; the route (Task 18) reuses the two pieces.
export type ValidationFailure = { ok: false; code: string; detail: string }
export type ValidationResult = { ok: true } | ValidationFailure
/** Body-only checks + sibling-aware promised-action screen. ticketId used for the sibling lookup. */
export async function validateReplyBody(db: Db, ticketId: string, body: string,
  opts: { hasRefundInOutput: boolean; trackingUrl: string | null }): Promise<ValidationResult>
/** Refund cross-checks: verified order, non-NULL total, accumulation bound, dmarc=pass, reason id. */
export async function validateRefundIntent(db: Db, ticket: { id: string; orderId: string | null },
  refund: { amountCents: number; openCjDispute: boolean; cjDisputeReasonId?: string }): Promise<ValidationResult>
/** Composes the two for an agent output; also rejects propose when ticket.customerEmail is null. */
export async function validateSupportOutput(db: Db,
  ticket: { id: string; orderId: string | null; customerEmail: string | null },
  output: SupportOutput): Promise<ValidationResult>
```
Validator rules — implement EXACTLY spec §3's mechanisms:
- Plain text: reject `/<[a-z!\/]/i` matches (HTML tags), length > 4000.
- Promised-action screen: whitespace-normalize; find any ACTION token (`/refund(ed)?|reimburs\w*|credit(ed)?|store credit|money back|compensat\w*|replacement|reship\w*|resend|cancel\w* (your|the) order|payment (returned|reversed)/i`) within 200 chars of any PROMISE token (`/issued|processed|sent|approved|applied|on its way|within \d+ (business )?days|has been|will be/i`). If hit AND `!hasRefundInOutput` AND no live sibling refund proposal (`SELECT 1 FROM proposals WHERE ticket_id=$1 AND type='refund' AND status IN ('pending','approved','applying','applied')`) → fail `promised_action`.
- URL/domain screen: extract schemed URLs (`/https?:\/\/\S+/gi` → `new URL()`, require protocol `https:` and hostname `dogebuddy.com`/`www.dogebuddy.com`) OR byte-equal to `opts.trackingUrl`; then extract bare domain tokens (`/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi`, filtered to a plausible-TLD list: com|net|org|io|co|shop|store|info|biz|us|uk|de|xyz|me|app|dev|link|site) not already inside an allowed URL — their registrable base must equal `dogebuddy.com` (exact label boundary) → else fail `url_not_allowed`.
- Contact screen: any email addr-spec (`/[\w.+-]+@[\w-]+(\.[\w-]+)+/g`) not ending `@dogebuddy.com` → fail; any phone-like token (`/[+(]?\d[\d\s().-]{6,}\d/` with ≥7 digits total) → fail `contact_channel`.
- Refund: `orderId` null → fail `refund_unverified_order`; order row's `totalCents` null → fail; `amountCents > totalCents − Σ(prior applied refund proposals' payload amountCents for this order)` → fail `refund_exceeds_total`; latest inbound message's `auth_results` NULL or not matching `/\bdmarc=pass\b/i` → fail `refund_sender_unauthenticated`; `openCjDispute && !cjDisputeReasonId` → fail.

- [ ] **Step 1: Failing tests (table-driven — this is the security surface, be exhaustive):** schema round-trips each outcome + rejects refund-without-reply shape (refund only exists inside propose which requires reply — assert a propose with refund but no reply fails zod); `SUPPORT_OUTPUT_JSON_SCHEMA` has no `$ref` and no 2020-12 `$schema`. Validator: promised-action hits across newlines within 200 chars ("your refund has been\nprocessed"); "store credit has been applied" hits; "a free replacement is on its way" hits; policy quote WITHOUT refund → fail, same body WITH live sibling refund proposal → pass, same body with `hasRefundInOutput` → pass; URL cases: `https://dogebuddy.com/track` pass, `https://www.dogebuddy.com` pass, `http://dogebuddy.com` fail (not https), `https://evil.com` fail, `https://dogebuddy.com.evil.com/x` fail, `https://dogebuddy.com@evil.com/` fail (userinfo — URL hostname is evil.com), bare `dogebuddy-help.com` fail, bare `dogebuddy.com` pass, `admin.dogebuddy.com` fail (subdomain excluded), tracking URL byte-equal pass / off-by-one fail; contact: `help@gmail.com` fail, `support@dogebuddy.com` pass, `+1 (888) 555-0142` fail, `order #12345` pass (digits < 7 with separators — tune the regex until this table passes); refund: each failure code, incl. accumulation ($10 applied prior + $15 new on $20 order → fail) and `auth_results: null` → fail.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): agent output schema + plain-code validator (URL/contact/promise/refund screens)`

---

### Task 9: Support MCP tools

**Files:**
- Create: `apps/ops/src/agents/support-mcp-tools.ts`
- Test: `apps/ops/src/agents/support-mcp-tools.test.ts`

**Interfaces (Produces — mirror `mcp-tools.ts`'s handler-object pattern exactly):**
```ts
export interface SupportMcpDeps {
  db: Db
  adapter: Pick<SupplierAdapter, 'getDisputeOptions'>
  ticketId: string   // the server is created PER RUN, pinned to one ticket
}
export function createSupportToolHandlers(deps: SupportMcpDeps): {
  get_ticket_thread(args: {}, _extra?: unknown): Promise<CallToolResult>   // messages: direction, fromEmail, sentAt ISO, bodyText
  get_order(args: {}, _extra?: unknown): Promise<CallToolResult>
  get_dispute_options(args: {}, _extra?: unknown): Promise<CallToolResult>
}
export function createSupportMcpServer(deps: SupportMcpDeps): ReturnType<typeof createSdkMcpServer>  // name: 'support'
```
`get_order` projection (spec §3 — customer-safe, NOTHING else): `{ orderNumber, financialStatus, fulfillmentStatus, totalCents, createdAt, trackingNumber, trackingUrl: null /* v1: no stored URL — pass tracking number only */, supplierStatus }` from `orders` + the ticket's linked order's `supplier_orders` row. It reads the ticket row itself to get `order_id` — a ticket with `order_id IS NULL` returns `{ verifiedOrder: false }` (NOT an error). NEVER include: supplier cost/amount fields, CJ ids, `raw_payload`, email of anyone. `get_dispute_options`: linked supplier_order's `supplier_order_id` → `adapter.getDisputeOptions`; no linked order → `{ verifiedOrder: false }`.
**Note for Task 8 consistency:** `validateReplyBody`'s `trackingUrl` opt is the supplier order's `tracking_number`-derived URL — since v1 stores no URL, pass `null` (the allowlist is then dogebuddy.com-only). Keep the parameter so a stored tracking URL can flow later.

- [ ] **Step 1: Failing tests:** thread tool returns this ticket's messages only (seed 2 tickets); order tool on a linked ticket returns the projection fields and — assert explicitly — the JSON text does NOT contain `supplier_cost`, `productAmountCents` values, or the CJ order id string; unlinked ticket → `{ verifiedOrder: false }`; dispute tool calls the adapter with the supplier_order_id; adapter throw → `isError: true` with `scrubMessage`'d text.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(agents): support MCP server — thread/order/dispute read-only tools`

---

### Task 10: Support runner (`support-run.ts`) — prompts + harness consumption

**Files:**
- Create: `apps/ops/src/agents/support-run.ts`
- Test: `apps/ops/src/agents/support-run.test.ts`

**Interfaces (Produces):**
```ts
export const SUPPORT_MODEL = 'claude-sonnet-5'
export const SUPPORT_MAX_TURNS = 15
export const SUPPORT_MAX_BUDGET_USD = 0.5
export const SUPPORT_WATCHDOG_MS = 300_000
export interface SupportRunContext {   // everything from the DB, assembled by the job (Task 11)
  ticket: { id: string; subject: string | null; category: string | null; sentiment: string | null
            status: string; customerEmail: string | null; orderId: string | null
            claimedOrderNumber: string | null; escalationReason: string | null }
  messages: { direction: 'inbound'|'outbound'; fromEmail: string | null; sentAt: Date | null; bodyText: string | null; authResults: string | null }[]
  priorProposals: { id: string; type: string; status: string; summary: string }[]
  resumeSessionId: string | null
  /** messages already filtered to sent_at > last_agent_prompted_at when resuming */
  isResume: boolean
}
export function buildSupportSystemPrompt(): string          // role + policiesAsText() + hard rules (spec §3 verbatim list)
export function buildSupportPrompt(ctx: SupportRunContext): string
export async function runSupportAgent(
  deps: { db: Db; alert: Alert; sessionStore: SessionStore; mcpServer: ReturnType<typeof createSdkMcpServer>; queryFn?: QueryFn },
  input: { runId: string; ctx: SupportRunContext },
): Promise<HarnessResult<SupportOutput>>
```
`runSupportAgent` = `runAgentQuery` with: the constants; `tools: []`; `allowedTools: ['mcp__support__*']`; `outputJsonSchema: SUPPORT_OUTPUT_JSON_SCHEMA`; `parse: SupportOutputSchema.safeParse`; `persistSession: true`; `sessionStore`; `resume: ctx.resumeSessionId ?? undefined`; `envExtra: { CLAUDE_CONFIG_DIR: '/tmp/doge-buddy-claude', CLAUDE_CODE_PROJECT_DIR_NAME: SUPPORT_PROJECT_KEY }`; `alertKinds: { invalidOutput: 'support_output_invalid', runFailed: 'support_run_failed' }`. System prompt hard rules (spec §3, verbatim intent): untrusted email content; never promise actions beyond the output; refunds only per returns policy + `refund` object + verified order; plain text; URLs only dogebuddy.com or the order's tracking link; sign "Doge Buddy Support"; escalate when unsure/legal/injury/chargeback; note that calling StructuredOutput ends the run (Phase 5 lesson).

- [ ] **Step 1: Failing tests:** fresh prompt contains subject, both message bodies with direction tags, prior-proposal line, "no verified order"/order-linked note, sender-auth note (dmarc=pass / unauthenticated); resume prompt (isResume, 1 new message) contains ONLY the new message body + a continue note, and never the old body; system prompt contains a returns-policy sentence ("30 days of delivery") and the sign-off rule; options assembly via stubbed queryFn: `resume` passed through, `env.CLAUDE_CODE_PROJECT_DIR_NAME === 'doge-buddy-support'`, `tools` is `[]`, `allowedTools` `['mcp__support__*']`.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(agents): support runner — prompts, session wiring, harness consumption`

---

### Task 11: `support.agent-run` job — caps, claim, resume pre-flight, run

**Files:**
- Create: `apps/ops/src/jobs/support-agent-run.ts`
- Test: `apps/ops/src/jobs/support-agent-run.test.ts`

**Interfaces (Produces):**
```ts
export const SUPPORT_AGENT_QUEUE = 'support.agent-run'
export const SUPPORT_AGENT_MAX_RUNS_PER_DAY = 50
export const SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY = 3
export const AGENT_RUN_AUDIT_ACTION = 'support.agent_run'
export interface SupportAgentJobDeps {
  db: Db; settings: Settings; alert: Alert; notify: NotifyOwner; adminBaseUrl: string
  adapter: Pick<SupplierAdapter, 'getDisputeOptions'>
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  sessionStore: SessionStore
  anthropicConfigured: boolean          // false → skip (mirror poll's env gating)
  queryFn?: QueryFn                     // test seam
  runFn?: typeof runSupportAgent        // test seam for outcome tests (Task 12 uses heavily)
  now?: () => Date
}
export async function executeSupportAgentRun(deps: SupportAgentJobDeps, ticketId: string): Promise<void>
export function supportAgentRunHandler(deps: SupportAgentJobDeps): PgBoss.WorkHandler<{ ticketId: string }>
export function enqueueSupportAgentRun(enqueue: SupportAgentJobDeps['enqueue'], ticketId: string): Promise<void>
// = enqueue(SUPPORT_AGENT_QUEUE, { ticketId }, { singletonKey: ticketId, retryLimit: 1, retryDelay: 30, expireInSeconds: 600 })
```
`executeSupportAgentRun` order (spec §1 "Job order", pinned — implement EXACTLY):
1. `killswitch.global` || `!workflow.support.enabled` || `!anthropicConfigured` → return (no stamp, no audit).
2. Load ticket. Per-ticket cap: `COUNT(audit_log WHERE action='support.agent_run' AND entity_id=$ticketId AND created_at >= utcMidnight)` ≥ 3 → guarded `triaged → escalated` (`escalationReason: 'agent_run_cap'`, `escalationNotifiedAt: null`), audit, return.
3. Global cap inside `db.transaction` + `pg_advisory_xact_lock(hashtext('support-agent-daily'))`: count today's `support.agent_run` audit rows; ≥ 50 → (outside the txn) once-per-day warning alert guarded by a `support.agent_run_capped` audit row (copy `escalate.ts`'s cap-warning pattern), return WITHOUT stamping; else INSERT the `support.agent_run` audit row (`entityType: 'ticket'`, `entityId: ticketId`) in the same txn.
4. CAS claim, as ONE `db.transaction`: (a) `SELECT ... FOR UPDATE` the ticket row; (b) in JS, evaluate the claim predicate against the locked row — `status === 'triaged' && agentFailureCount < 2 && (lastAgentRunAt === null || lastInboundAt > lastAgentRunAt || stuck)` where `stuck = lastAgentRunAt < now−20min && (lastAgentPromptedAt === null || lastAgentPromptedAt < lastAgentRunAt)`; predicate false → audit `support.agent_run_skipped` + return (the row lock makes this a true CAS — concurrent claimers serialize on it); (c) `UPDATE ... SET last_agent_run_at = now()` (+ `agent_failure_count = agent_failure_count + 1` when `stuck`); (d) capture `threadSnapshotAt = lastInboundAt` from the locked read. After commit: if `stuck` made the count ≥ 2 → guarded `triaged → escalated` (`agent_failed`, `escalationNotifiedAt: null`) + clear `agentSessionId` + return (no run).
5. Resume pre-flight: `ticket.agentSessionId` set → `sessionStore.load({ projectKey: SUPPORT_PROJECT_KEY, sessionId })`; `null` → clear `agentSessionId` (plain UPDATE), resume off, NO failure. Assemble `SupportRunContext` (messages filtered by `last_agent_prompted_at` when resuming; full otherwise).
6. Insert `agent_runs` row directly (`workflow: 'support'`, `triggerRef: ticketId`, `model: SUPPORT_MODEL`, `status: 'running'`) — NOT `claimDailyRun` (that's one-per-day; support runs many).
7. `runSupportAgent(...)`. Result handling is Task 12's scope — for THIS task, stub `runFn` in tests and assert everything through step 6.

- [ ] **Step 1: Failing tests (stub `runFn` to return a benign no_action success):** killswitch → no audit row, no stamp; per-ticket cap (seed 3 audit rows) → escalated with reason `agent_run_cap` + `escalation_notified_at IS NULL`; global cap (seed 50) → ticket untouched (`last_agent_run_at` NULL) + exactly one `support.agent_run_capped` audit row across two invocations; successful path writes the `support.agent_run` audit row with `entityId = ticketId` BEFORE `runFn` is invoked (assert ordering via a runFn spy that reads the DB); CAS: a `waiting_on_customer` ticket → skipped audit; a claimed-5-minutes-ago ticket with no new inbound → skipped; stuck 25-minutes-ago claim with `last_agent_prompted_at` older → re-claimed with `agent_failure_count` incremented; stuck re-claim at count 1 → escalated `agent_failed`, `runFn` NEVER called, session id cleared; pre-flight: `agentSessionId` set but store empty → `agentSessionId` cleared, ctx.resumeSessionId null, `agent_failure_count` unchanged.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): agent-run job — caps, CAS claim, stuck recovery, resume pre-flight`

---

### Task 12: Job outcome handling — transitions, submit step, failure semantics

**Files:**
- Modify: `apps/ops/src/jobs/support-agent-run.ts` (+ its test file)

**Interfaces:**
- Consumes: Task 8 `validateSupportOutput`, Task 11's steps 1–6, `submitProposal` (`proposals/submit.ts` — signature unchanged), `enqueueSupportAgentRun`.
- Produces: the complete spec-§1 outcome behavior. Also: `/tmp/doge-buddy-claude/<local session dir>` best-effort `rm -rf` after every run (wrap in try/catch; `fs.rm(path.join('/tmp/doge-buddy-claude'), { recursive: true, force: true })` of the RUN's session subdir if identifiable, else the whole dir — it is disposable by design).

Outcome mapping (result = `HarnessResult<SupportOutput>`):
- `result.sawMirrorError` → warning alert `support_session_mirror_error` + clear `agentSessionId` (still process the outcome normally).
- Resumed run AND `result.status !== 'succeeded'` AND `result.failedBeforeFirstAssistant` → warning alert `support_resume_failed`, clear `agentSessionId`, ONE in-process retry via `runSupportAgent` with fresh ctx (`resumeSessionId: null`, full messages). Only the retry's failure proceeds to the failure path.
- `succeeded` + `validateSupportOutput` ok:
  - `no_action` → audit `support.agent_no_action` (detail: rationale) — ticket stays `triaged`.
  - `escalate` → guarded `triaged → escalated` (`escalationReason: output.escalationReason.slice(0,500)`, `escalationNotifiedAt: null`); 0 rows → audit skip.
  - `propose` → (a) guarded `triaged → awaiting_approval`; 0 rows → audit `support.agent_propose_lost_race` + return (do NOT submit); (b) expire this ticket's still-pending support proposals: `UPDATE proposals SET status='expired' WHERE ticket_id=$1 AND type IN ('support_reply','refund') AND status='pending'` + audit `proposal.superseded` per row; (c) `submitProposal(deps′, { type: 'support_reply', summary: 'Reply: ' + (ticket.subject ?? '(no subject)'), payload: { type: 'support_reply', ticketId, body: output.reply.body }, sourceWorkflow: 'support', agentRunId: runId, ticketId })`; (d) if `output.refund`: `submitProposal(..., { type: 'refund', summary: 'Refund $X.XX order #N', payload: { type: 'refund', orderId: ticket.orderId!, shopifyOrderGid, amountCents, reason, openCjDispute, cjDisputeReasonId }, sourceWorkflow: 'support', agentRunId: runId, ticketId, orderId: ticket.orderId! })`. **`threadSnapshotAt` (claim-time `last_inbound_at`, ISO string) is stored INSIDE both payloads as `threadSnapshotAt`** — wait: payload schemas are strict zod objects. Instead store it on the proposal ROW via `submitProposal` input? Not supported. → Extend `SupportReplyPayloadSchema` and `RefundPayloadSchema` in `packages/core/src/proposals.ts` with `threadSnapshotAt: z.iso.datetime()` (REQUIRED on both; part of this task; update Task 8 tests if they constructed payloads). The apply executors read it from the payload.
  - After any authoritative result (all three outcomes): `UPDATE support_tickets SET last_agent_prompted_at = $threadSnapshotAt WHERE id = $1` (unguarded — watermark only) and store `result.sessionId` into `agentSessionId` when non-null.
- Failure path (thrown runFn, `status: 'failed'|'aborted'`, zod-invalid output, validator reject): in one txn — `agent_failure_count += 1`; if now ≥ 2 → guarded `triaged → escalated` (`agent_failed`, notifiedAt null) + clear `agentSessionId`; ELSE `last_agent_run_at = NULL` (immediate re-claimability — spec §1 failure row). Audit `support.agent_run_failed` (detail: code/reason). Then **`throw`** (pg-boss retry = second attempt). Validator rejection detail goes in the audit row, NOT in any customer-visible surface.

- [ ] **Step 1: Failing tests (stub `runFn` per case):** propose happy path → ticket `awaiting_approval` BEFORE `submitProposal` runs (spy ordering), two proposals with `ticketId` set on the row, prior pending refund proposal expired with `proposal.superseded` audit, `last_agent_prompted_at = threadSnapshotAt`, session id stored; propose losing the transition race (concurrently flip ticket to escalated in the spy) → no proposals submitted; escalate outcome → escalated + reason + NULL stamp; no_action → still `triaged`, audit row, and a SECOND immediate `executeSupportAgentRun` skips at CAS (no new inbound); validator-reject → `agent_failure_count = 1`, `last_agent_run_at` NULL, handler THREW; second validator-reject → escalated `agent_failed` + `agentSessionId` NULL; budget-abort (`status:'aborted'`) same path; resume-early-failure → runFn called twice (second with `resumeSessionId: null`), no failure count on first, session cleared; mirror_error on success → warning alert + session cleared but proposals still submitted; refund outcome present → refund payload carries `threadSnapshotAt` + `shopifyOrderGid` from the linked order row.
- [ ] **Step 2:** Extend `packages/core/src/proposals.ts` schemas (`threadSnapshotAt: z.iso.datetime()` on SupportReply + Refund payloads) — run core + ops suites (Task 8's validator tests updated if they build payloads).
- [ ] **Step 3: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): agent outcome handling — transitions, supersede+submit, failure semantics`

---

### Task 13: Poll selection stage + orphan backstop + queue/index wiring

**Files:**
- Create: `apps/ops/src/support/agent-select.ts`
- Modify: `apps/ops/src/jobs/support-poll-gmail.ts` (4th stage), `apps/ops/src/queue.ts` (export `createQueueRetrying`), `apps/ops/src/index.ts` (create+work the new queue; thread deps)
- Test: `apps/ops/src/support/agent-select.test.ts`, extend `apps/ops/src/jobs/support-poll-gmail.test.ts`

**Interfaces (Produces):**
```ts
// agent-select.ts
export const AGENT_SELECT_CAP_PER_CYCLE = 10
export interface AgentSelectDeps { db: Db; enqueue: SendFn; alert: Alert; now?: () => Date }
/** Selection (spec §1 predicate, ORDER BY last_inbound_at ASC, LIMIT 10 → enqueueSupportAgentRun each)
 *  + orphan backstop (awaiting_approval, no live support proposal, updated_at < now()-15min →
 *  guarded escalated, reason 'orphaned_awaiting_approval', escalationNotifiedAt: null). */
export async function selectAndEnqueueAgentRuns(deps: AgentSelectDeps): Promise<{ enqueued: number; orphansEscalated: number }>
```
Poll integration: `SupportPollDeps` gains `agentSelect?: (deps: AgentSelectDeps) => Promise<...>` + `enqueue` — the stage runs ONLY when `!ingestFailed` (spec: "runs only when triage ran"), after the escalate stage, in its own try/catch feeding `firstError` like the others. Orphan-backstop escalations are picked up by the SAME cycle's escalate stage next minute (notify stays in the poll).
Index wiring: `createQueueRetrying(queue.boss, SUPPORT_AGENT_QUEUE, { name: SUPPORT_AGENT_QUEUE, policy: 'singleton' })` then `queue.boss.work(SUPPORT_AGENT_QUEUE, supportAgentRunHandler(supportAgentDeps))` — deps assembled from existing index.ts singletons (db, settings, alert, notify, adminBaseUrl, adapter, enqueue, `createPgSessionStore(db)`, `anthropicConfigured: Boolean(config.anthropicApiKey)`). Note in a comment: the queue MUST be `policy: 'singleton'` (three panel lenses; `queue.ts:149` reasoning applies verbatim).

- [ ] **Step 1: Failing tests:** selection enqueues a `triaged` never-run ticket and a new-inbound ticket, skips claimed-no-new-inbound, skips `agent_failure_count = 2`, caps at 10 (seed 12), passes `{ singletonKey: ticketId, retryLimit: 1, ... }` opts (spy on enqueue); orphan: `awaiting_approval` + only an `expired` proposal + `updated_at` 20 min old → escalated with `orphaned_awaiting_approval` + NULL stamp; same but `updated_at` 5 min → untouched; same but a `pending` proposal exists → untouched; poll: ingest failure → agentSelect NOT called; agentSelect throw → poll records failure but escalate stage already ran.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(support): poll selection stage + orphan backstop; agent-run queue wired (singleton)`

---

### Task 14: `run-apply.ts` dispatch extraction

**Files:**
- Create: `apps/ops/src/proposals/apply-new-listing.ts`
- Modify: `apps/ops/src/proposals/run-apply.ts`
- Test: existing `run-apply` tests pass UNCHANGED

**Interfaces (Produces):**
```ts
// run-apply.ts keeps: executeApplyProposal (claim/transition shell, lines 67–109 semantics intact),
// deadLetterApplyProposal, proposalHandle, ProposalShopifyOps, ApplyProposalDeps.
// The `row.type !== 'new_listing'` throw at line 111 becomes:
const executors: Record<string, (deps, row) => Promise<void>> = {
  new_listing: applyNewListing,        // the moved lines 115–239, byte-identical logic
  support_reply: applySupportReply,    // Task 15
  refund: applyRefund,                 // Task 16
}
const exec = executors[row.type]
if (!exec) throw new Error(`unimplemented proposal type: ${row.type}`)
await exec(deps, row)
// ApplyProposalDeps GROWS (Tasks 15/16 consume; queue.ts fallback stubs added here):
export interface ApplyProposalDeps {
  db: Db; alert: Alert; shopify: ProposalShopifyOps
  adapter: Pick<SupplierAdapter, 'subscribeProductWebhook' | 'getDisputeOptions' | 'openDispute'>
  gmail: GmailClient | null            // null → support_reply apply fails loudly (alert), never TypeErrors
  refundOps: RefundOps | null          // Task 16's interface; null → refund apply fails loudly
  supportAddress: string               // config SUPPORT_ADDRESS; Task 15 stamps it as the outbound row's fromEmail ('' when unset)
  notify: NotifyOwner
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  adminBaseUrl: string
}
export type ProposalRow = typeof proposals.$inferSelect   // the executors' row parameter type
```
`queue.ts`: thread `gmail`/`refundOps`/`notify`/`enqueue`/`adminBaseUrl` through `FulfillmentQueueDeps` (optional, with loud-failure/noop fallbacks mirroring the existing `shopifyNotConfigured` pattern; `notify` fallback = `createNoopNotifier(alert)`); `index.ts` passes the real ones. `deadLetterApplyProposal` GAINS (spec §4 preamble): after the `failed` transition, for `row.type in ('support_reply','refund')` → guarded ticket `awaiting_approval → escalated` (`apply_failed`, NULL stamp; 0 rows fine) + `notify({ title: 'Approved <type> FAILED to apply', body: summary, actions: [{ label: 'View', url: adminBaseUrl + '/admin/proposals/' + id }] })`.

- [ ] **Step 1:** Extract + grow deps + dead-letter additions; failing tests for the NEW dead-letter behavior only (support_reply dead-letter → ticket escalated + notify spy called; new_listing dead-letter → neither).
- [ ] **Step 2:** Full existing `run-apply`/`proposal-apply`/queue test files PASS unchanged (update only their deps-construction to the grown interface — mechanical) + typecheck → commit `refactor(proposals): type-dispatch apply executors; deps grown for 6B; support dead-letter escalates+notifies`

---

### Task 15: `support_reply` apply executor

**Files:**
- Create: `apps/ops/src/proposals/apply-support-reply.ts`
- Test: `apps/ops/src/proposals/apply-support-reply.test.ts`

**Interfaces:**
- Consumes: `SupportReplyPayloadSchema` (now with `threadSnapshotAt`), `applyProposalTransition`, `GmailClient.sendReply` + `getThread` + `getMessage`, `enqueueSupportAgentRun` (Task 11), grown `ApplyProposalDeps`.
- Produces: `applySupportReply(deps: ApplyProposalDeps, row: ProposalRow): Promise<void>` — called with the row already in `applying` (shell guarantees).

Implementation order (spec §4 support_reply, EXACTLY):
1. Parse payload; load ticket + messages (chronological). Hard pre-checks — each: `applyProposalTransition(db, id, 'applying', 'failed', { applyError })` + audit + `notify()` + return (NOT throw — these are terminal, not retryable): `deps.gmail === null` (`'gmail not configured'`); ticket.status !== 'awaiting_approval' (`'ticket no longer awaiting approval'`); `customerEmail` null; latest inbound has no `rfcMessageId`.
2. Staleness: any inbound `sentAt > new Date(payload.threadSnapshotAt)` → in ONE transaction: proposal `applying → failed` (`'stale: newer customer message'`) + guarded ticket `awaiting_approval → triaged` **with `lastAgentRunAt: null`** + audit; then `notify()` (approval didn't send) + `enqueueSupportAgentRun(deps.enqueue, ticketId)` (best-effort catch → alert) + return.
3. Recovery check (re-entry): `getThread(ticket.gmailThreadId)` → ids not in `support_messages` → `getMessage(id, { format: 'metadata' })` each (bounded: only unknown ids) → any with header `X-DogeBuddy-Proposal` equal to this proposal id → treat as sent, `sentMessageId = that id`, skip step 4.
4. Send: `references` = all thread `rfcMessageId`s in order (last 20, final = latest inbound's), `sendReply({ threadId, to: customerEmail, subject: ticket.subject ?? '(no subject)', inReplyTo: latestInbound.rfcMessageId, references: refs.join(' '), bodyText: payload.body, extraHeaders: { 'X-DogeBuddy-Proposal': row.id } })`.
5. Post-send, in order: upsert outbound `support_messages` (`gmailMessageId: sentMessageId`, `direction: 'outbound'`, `fromEmail: deps.supportAddress` (Task 14's growth), `bodyText: payload.body`, `sentAt: now`) ON CONFLICT DO NOTHING; conditional flip `UPDATE support_tickets SET status='waiting_on_customer' WHERE id=$1 AND status='awaiting_approval' AND last_inbound_at <= $threadSnapshotAt`; if 0 rows AND a re-read shows still `awaiting_approval` → guarded flip to `triaged` instead (mid-apply arrival; 6A reopen covers post-flip arrivals — see spec §4.5 dovetail); `applyProposalTransition(db, id, 'applying', 'applied', { appliedAt })` + audit `proposal.applied`.

- [ ] **Step 1: Failing tests (MockGmail):** happy path → MockGmail sent message has byte-exact `In-Reply-To`/`References`/`Subject: Re: …`/`From: support@…`/`X-DogeBuddy-Proposal` headers (decode the raw), exactly ONE outbound `support_messages` row after simulating ingest ALSO seeing the sent id (call the upsert twice), ticket `waiting_on_customer`, proposal `applied`; stale inbound → proposal `failed` + ticket `triaged` + `last_agent_run_at` NULL + enqueue spy called + notify called + NOTHING sent; escalated ticket → failed `'ticket no longer awaiting approval'` + nothing sent; null customer_email → failed; missing rfc_message_id → failed; recovery: pre-seed a thread message with the marker header, re-enter in `applying` → NO second send, proposal `applied`; recovery with only an OWNER-sent unmarked message → sends normally (the marker is the discriminator); inbound-during-apply (insert between send and flip) → ticket lands `triaged` not `waiting_on_customer`.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(proposals): support_reply apply — staleness, marker-header recovery, conditional flip`

---

### Task 16: `orderRefundState` op + `refund` apply executor

**Files:**
- Modify: `packages/shopify-admin/src/operations.ts` (+ its fixture test file)
- Create: `apps/ops/src/proposals/apply-refund.ts`
- Test: `apps/ops/src/proposals/apply-refund.test.ts`

**Interfaces (Produces):**
```ts
// shopify-admin (FIXTURE-ASSUMPTION until first live run — house convention):
export interface OrderRefundState {
  totalRefundedCents: number
  refunds: { id: string; note: string | null }[]
  parentTransactionId: string | null   // the successful SALE/CAPTURE transaction
  gateway: string | null
}
export async function orderRefundState(client: ShopifyAdminClient, orderGid: string): Promise<OrderRefundState>
// query: order(id) { refunds { id note totalRefundedSet { shopMoney { amount } } }
//                    transactions(first: 20) { id kind status gateway } }
// totalRefundedCents = sum over refunds of round(amount * 100); parent = first transaction with
// kind in (SALE, CAPTURE) and status SUCCESS.

// ops-side curried surface (the `refundOps` slot on ApplyProposalDeps, wired in index.ts):
export interface RefundOps {
  orderRefundState(orderGid: string): Promise<OrderRefundState>
  refundCreate(input: Record<string, unknown>, idempotencyKey: string): Promise<{ refundId: string }>
}
export async function applyRefund(deps: ApplyProposalDeps, row: ProposalRow): Promise<void>
```
`applyRefund` order (spec §4 refund): parse payload; load ticket + order. Terminal-fail (transition to `failed` + audit + notify + return) on: `refundOps === null`; `orderId` row missing; `totalCents` null. Staleness guard identical to Task 15 step 2 (same watermark, guarded `awaiting_approval → triaged` + stamp clear, 0 rows fine, notify + enqueue re-run). Then: `state = refundOps.orderRefundState(order.shopifyOrderGid)`; pre-check: any `state.refunds[].note === 'db-proposal-' + row.id` → already applied, transition + audit, return; bound: `payload.amountCents > order.totalCents − state.totalRefundedCents` → terminal-fail `'refund exceeds remaining refundable'`; `state.parentTransactionId` null → terminal-fail. `refundCreate({ orderId: order.shopifyOrderGid, note: 'db-proposal-' + row.id, notify: true, transactions: [{ parentId: state.parentTransactionId, amount: centsToUsd(payload.amountCents), kind: 'REFUND', gateway: state.gateway }] }, row.id)` — userErrors throw (→ pg-boss retry → Task 14 dead-letter). CJ dispute when `payload.openCjDispute`: linked `supplier_orders` row → `adapter.getDisputeOptions(supplierOrderId)`; reason id absent from `reasons[]` or `amountCents > maxRefundCents` → skip + warning alert `cj_dispute_skipped` (refund already succeeded); else `adapter.openDispute({ supplierOrderId, idempotencyKey: row.id, reasonId, kind: 'refund', amountCents: payload.amountCents, message: payload.reason })` → jsonb-merge `{ cjDispute: { id } }` into `proposals.payload`. Finally `applying → applied` + audit.

- [ ] **Step 1: Failing tests:** shopify-admin fixture test for `orderRefundState` (mixed refunds, cents rounding, parent-transaction pick); refund happy path calls `refundCreate` ONCE with idempotencyKey = proposal id + note + correct amount string; double delivery (re-run after applied) → shell skips (existing behavior — assert `refundCreate` once total); re-entry in `applying` with the note already in `state.refunds` → NO `refundCreate`, proposal `applied`; amount exceeding total-minus-refunded → `failed` + notify, no call; stale inbound → same behavior as Task 15's stale test; dispute: valid reason → `openDispute` called with `idempotencyKey: row.id` + payload gains `cjDispute.id`; invalid reason → refund still `applied` + `cj_dispute_skipped` alert + no `openDispute`.
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(proposals): refund apply — Shopify refundCreate w/ pre-check + optional CJ dispute`

---

### Task 17: `cj.dispute-poll` cron

**Files:**
- Create: `apps/ops/src/jobs/cj-dispute-poll.ts`
- Modify: `apps/ops/src/index.ts` (registerCron `'0 */6 * * *'`)
- Test: `apps/ops/src/jobs/cj-dispute-poll.test.ts`

**Interfaces:**
```ts
export interface DisputePollDeps { db: Db; adapter: Pick<SupplierAdapter, 'getDispute'>; alert: Alert; now?: () => Date }
export async function executeDisputePoll(deps: DisputePollDeps): Promise<{ polled: number; terminal: number }>
export function cjDisputePollHandler(deps: DisputePollDeps): PgBoss.WorkHandler<object>
```
Selection (spec §4.5): `proposals WHERE type='refund' AND status='applied' AND payload->'cjDispute'->>'id' IS NOT NULL AND payload->'cjDispute'->>'status' IS NULL`, LIMIT 20/cycle (CJ 1-rps bucket courtesy). Per row: `getDispute(id)`; terminal (`value in ('refunded','reissued','rejected')`) → jsonb-merge `{ cjDispute: { id, status: value, closedAt: now().toISOString() } }` + audit `cj.dispute_terminal` + info alert; `pending`/`unknown` → leave for next cycle; adapter throw → warning alert, continue with the rest.

- [ ] **Step 1: Failing tests:** terminal dispute gets the marker + is NOT selected on a second `executeDisputePoll` call (the termination test the spec demands); pending stays unmarked; adapter throw on row 1 doesn't stop row 2; selection ignores proposals without `cjDispute.id`.
- [ ] **Step 2: Run (FAIL) → implement + index wiring → run (PASS) + typecheck → commit** `feat(cj): dispute-poll cron with terminal markers`

---

### Task 18: Per-type Telegram bodies + admin proposal rendering + validator on approve

**Files:**
- Modify: `apps/ops/src/proposals/submit.ts` (notify body builder), `apps/ops/src/http/admin/render-proposal.ts`, `apps/ops/src/http/admin/routes.ts` (decision POSTs), `apps/ops/src/http/actions.ts` (one-click approve/reject for support types)
- Create: `apps/ops/src/proposals/support-decision.ts` (shared reject/approve-validation helpers)
- Test: extend `submit`/`admin-routes`/`actions` test files

**Interfaces (Produces):**
```ts
// support-decision.ts
/** Owner rejected a support proposal (either surface): expire pending sibling (audit
 * 'proposal.sibling_rejected'), guarded ticket → 'escalated' with escalationNotifiedAt: now()
 * (PRE-STAMPED — silent; sanctioned exception #2), escalationReason 'owner_rejected_draft',
 * clear agentSessionId. */
export async function onSupportProposalRejected(db: Db, row: { id: string; ticketId: string | null; type: string }): Promise<void>
/** Re-runs the §3 validator for a support proposal about to be approved (either surface, edited
 * or not). support_reply → validateReplyBody(db, ticketId, payload.body, { hasRefundInOutput:
 * liveSiblingRefundExists, trackingUrl: null }); refund → validateRefundIntent. Returns the
 * ValidationResult; callers render/refuse on failure. */
export async function validateSupportProposalForApproval(db: Db, row: ProposalRow, payload: unknown): Promise<ValidationResult>
```
- `submit.ts`: for `support_reply`, notify body = subject + customer + auth-note + `body.slice(0, 600) + (body.length > 800 ? '\n…\n' + body.slice(-200) : body.slice(600))` (head+tail per spec §5) + (sibling refund pending → `⚠ promises a refund — paired refund proposal <id>; decide the refund first or together`); for `refund`, body = `$X.XX on order #N — <reason>` + dispute flag + auth-note. Other types unchanged (incl. TikTok ritual line).
- `render-proposal.ts`: `support_reply` pending → escaped `pre-wrap` body + a form POSTing field `body` (textarea) to approve — the raw-JSON `payload` textarea is NOT rendered for this type; `refund` pending → human summary, NO edit form (approve/reject buttons only); other types unchanged.
- `routes.ts` decision POST: for support types — reject → after the existing transition+audit, call `onSupportProposalRejected`; approve → if `body` field present (support_reply only) build `{ ...storedPayload, body }` and zod-parse; then ALWAYS `validateSupportProposalForApproval` before the transition; failure → 400 page with the validation detail, NO transition. `actions.ts` one-click POST: same two hooks (no edit path there).

- [ ] **Step 1: Failing tests:** Telegram body for a 2,000-char draft contains the first 600 chars AND the last 200 with `…` between; refund-paired reply body contains the ⚠ line; XSS: a draft body `<script>alert(1)</script>` renders escaped in admin (`&lt;script&gt;`) and the raw-JSON textarea is ABSENT for support_reply; body-edit approve with an off-domain URL in the new body → 400 naming `url_not_allowed`, proposal still `pending`; unedited approve of a support_reply whose sibling refund was meanwhile rejected → 400 `promised_action` (sibling gone) — covers the §5 bypass; one-click reject of the refund → sibling reply proposal `expired` + ticket `escalated` + `escalation_notified_at` NOT NULL (silent) + `agent_session_id` NULL; a later one-click approve of that now-expired reply → "Already handled" page (existing mechanics).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(admin): per-type proposal bodies + edit, validator on approve, silent reject-escalation`

---

### Task 19: Admin tickets view + health row

**Files:**
- Modify: `apps/ops/src/http/admin/render-tickets.ts`, `apps/ops/src/http/admin/routes.ts` (thread view query + `/admin` health), `apps/ops/src/http/admin/health.ts` if that's where health rows live (follow the existing `last_success_at` poll row's pattern)
- Test: extend admin tests

- [ ] **Step 1: Failing tests:** thread view lists the ticket's support proposals (id-linked to `/admin/proposals/:id`) with statuses; shows an agent-run link when `agent_runs` rows with `triggerRef = ticketId` exist (`/admin/runs/:id`, newest); `/admin` health shows `support agent: N runs today / 50` (count of today's `support.agent_run` audit rows).
- [ ] **Step 2: Run (FAIL) → implement → run (PASS) + typecheck → commit** `feat(admin): ticket thread shows proposals + agent runs; health shows agent budget`

---

### Task 20: E2E suite + whole-suite verification + docs

**Files:**
- Create: `apps/ops/src/support/support-agent.e2e.test.ts` (local DB + MockGmail + stubbed queryFn/runFn + mock supplier — follow 6A's E2E harness setup)
- Modify: `docs/OWNER-CHECKLIST.md`, `README.md` (phase line), `docs/superpowers/specs/2026-08-26-phase-6b-support-agent-design.md` (§Panel line only if needed)

- [ ] **Step 1: E2E cases (spec §7 list — each is one test):** full flow: inbound email → ingest → triage stub → selection enqueues → job (stubbed model output: propose+refund) → proposals + Telegram capture → admin approve → apply → MockGmail threading headers byte-exact + marker → ONE outbound row → `waiting_on_customer`; follow-up email → reopen → re-triage → selection → job passes `resume` with the stored session id (queryFn options spy); stale approve; reject flow (silent escalation — assert `notifyPendingEscalations` sends NOTHING for it next cycle); orphan backstop (expire a pending proposal via the admin-page bulk flip path specifically — proving writer-independence); apply dead-letter → escalated + notify; hard-kill sim (claim stamped, no result, 25 min clock skip via `now` injection) → stuck re-claim increments; per-ticket + global caps; kill levers; double apply delivery → single send/refund.
- [ ] **Step 2:** `pnpm --filter @doge-buddy/gmail test && pnpm --filter @doge-buddy/core test && pnpm --filter @doge-buddy/db test && pnpm --filter @doge-buddy/shopify-admin test && pnpm --filter @doge-buddy/ops test && pnpm typecheck` — ALL green, no warnings.
- [ ] **Step 3:** IF Gmail creds present in `apps/ops/.env`: run the Task 2 recorder (`GMAIL_CONTRACT=1`) after sending one owner-seeded test email; re-run gmail contract suite; commit fixtures `test(gmail): fixtures re-recorded against live mailbox`.
- [ ] **Step 4:** Docs: OWNER-CHECKLIST gains the 6B live-verify items (spec §8: Send-mail-as check, outlook.com address, Tier-2 walk incl. Bogus-order refund + redeploy-resume check, DMARC if still open); README phase line; checklist footer pointer → "6B built; live tier next". Commit `docs: 6B build complete — live Tier-2 steps on owner checklist`.
- [ ] **Step 5 (process):** Hand back for the **final whole-branch multi-lens review Workflow** (house rule — NOT optional) before merge.

---

## Self-review notes (spec coverage)

- Spec §0 → Tasks 1–2 (+ live re-record in Task 20.3). §1 → Tasks 3, 11, 12, 13 (transitions split: job-side in 11/12, reject/expiry-side in 18 + orphan in 13, apply-side in 14–16). §2 → Tasks 3, 6, 10 (wiring), 11 (pre-flight), 12 (mirror_error + /tmp cleanup). §3 → Tasks 5 (policies), 8, 9, 10, 12 (submit step). §4 → Tasks 14, 15, 16, 17. §5 → Tasks 18, 19. §6 → constants distributed (10, 11, 13); no new env. §7 → per-task tests + Task 20. §8 → Task 20.4.
- Type consistency deliberately pinned: `threadSnapshotAt` lives IN the payload schemas (extended in Task 12 Step 2 — core change rides that task); `ApplyProposalDeps` grows once, in Task 14, and Tasks 15/16 consume the grown shape; `supportAddress` joins the growth in Task 14 (used by Task 15 step 5).
- Execution order note: Tasks 1–7 are independent-ish (1 before 2 and 4; 3 before 4/6; 7 before 10); Tasks 8–13 sequential-ish (8,9 before 10; 10,11 before 12; 11 before 13); 14 before 15/16; 16 before 17; 18/19 after 12/14. Task 20 last.
- Deliberately absent (spec non-goals): auto-mode flip, owner reply UI, Pub/Sub, session retention sweeps, deprecation worker.
