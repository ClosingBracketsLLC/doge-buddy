# Phase 6A — Support email plumbing (design)

**Date:** 2026-08-25 · **Status:** approved by Robert (chat) · **Parent:** `2026-08-09-doge-buddy-design.md` §(c) Support
**Slicing decision:** Phase 6 ships in two slices. **6A (this doc): email plumbing, live** — Gmail
client, polling ingest, Haiku triage, escalation→Telegram, real `/admin/tickets`. **6B (next):
the support agent + `support_reply`/`refund` apply workers.** Rationale: Phase 5 proved the live
wire contract is where real bugs hide (CJ then, Gmail now) — prove the risky layer first, in
parallel with the owner's Workspace setup, and give 6B a proven-live substrate.

## Exit criteria (Tier-2, live)

1. A real email sent to `support@dogebuddy.com` becomes a categorized ticket visible on
   `/admin/tickets` within ~90s (one 45s poll + triage), with the `DogeBuddy/New` label applied
   in Gmail.
2. An escalation-class email (e.g. mentions a chargeback) additionally lands a Telegram alert on
   the owner's phone with a deep link to the ticket thread view.
3. A follow-up email on a resolved ticket reopens it (not a new ticket).

Mock-tier exit: full E2E suite green against `MockGmail` + stubbed triage; wire-client fixture
suite green (fixtures re-recorded from the real API once creds exist — treat unverified fixtures
as provisional, per the CJ lesson).

## Non-goals (6B or later)

No Agent SDK / LLM replies, no `support_reply`/`refund` apply workers, no `sendReply` *callers*
(the client method ships now, tested against fixtures, so 6B doesn't reopen the wire client), no
owner reply UI in admin (owner answers directly from the Gmail inbox meanwhile), no Pub/Sub
(polling only, per parent spec).

## 1. `packages/gmail` — thin hand-rolled client

House pattern: like `packages/shopify-admin` and the CJ client — plain `fetch`, no `googleapis`
SDK.

- **Auth:** service-account JWT (RS256 via node `crypto`) → Google OAuth2 token endpoint, with
  `sub = GMAIL_IMPERSONATE` (domain-wide delegation) and scope
  `https://www.googleapis.com/auth/gmail.modify` ONLY. Access tokens ~1h; refresh-ahead at ~50min;
  cached in memory (no DB table — unlike CJ there is no refresh-token state worth persisting).
- **Surface** (all against `gmail/v1/users/me/...`):
  - `getProfile()` → `{ emailAddress, historyId }` (seeds sync state)
  - `listHistory({ startHistoryId, pageToken? })` → typed pages; distinguishes the **404 =
    expired historyId** case as a typed `HistoryExpiredError`
  - `listMessages({ q?, pageToken? })` (full-resync path only)
  - `getMessage(id)` → normalized `{ id, threadId, historyId, labelIds, internalDate, headers
    (From/To/Subject/Message-ID/In-Reply-To/References), bodyText }` — body extracted from the
    `text/plain` part, falling back to stripped `text/html`; base64url decoding inside the client
  - `listLabels()` / `createLabel(name)` / `modifyMessage(id, {add,remove})`
  - `sendReply({ threadId, to, subject, inReplyTo, references, bodyText })` — builds raw RFC 2822
    with **all three threading fields** (In-Reply-To + References + matching `Re:` Subject; miss
    one and clients fork threads). Shipped + fixture-tested now; first caller arrives in 6B.
- **Errors:** non-2xx → typed `GmailApiError{status, code, message}`; 401 triggers one token
  refresh + single retry; 429/5xx → single retry with jitter then throw (the 45s cron is the
  retry loop — no deep retry stacks).
- **`MockGmail`** implements the same interface in-memory: seedable threads/messages/labels, a
  `receiveInbound()` test helper, failure/latency injection, history semantics faithful enough to
  exercise incremental sync AND `HistoryExpiredError`. Mirrors `MockSupplierAdapter`'s role.
- **Fixtures:** recorded request/response JSON for every method, replayed in unit tests
  (`gmail-contract` suite). A `GMAIL_CONTRACT=1` live mode re-records against the real mailbox
  once creds exist — same idiom as `CJ_CONTRACT`.

## 2. Ingest — pg-boss cron `support.poll-gmail`, every 45s

Job (`apps/ops/src/support/ingest.ts` + `jobs/support-poll-gmail.ts`), singleton-keyed so runs
never overlap. Skips with a **once-per-boot** info alert when Gmail env is absent (SERPAPI-skip
convention) and respects `killswitch.global`.

1. Load `gmail_sync_state.last_history_id`; if null → `getProfile()`, store, done (first run
   ingests nothing older — the mailbox is new).
2. `listHistory` from stored id, walking pages; collect **messageAdded** ids (ignore label-only
   history). On `HistoryExpiredError` → full resync via `listMessages` (mailbox is tiny) with the
   same upsert path, then re-seed from `getProfile()`.
3. Per message id → `getMessage` → classify direction: `From` = our own address (or
   `SENT`-labeled) → `outbound`, else `inbound`.
4. Upserts, all idempotent by the existing UNIQUE keys: ticket by `gmail_thread_id` (insert with
   `customer_email`, `subject`, status `new`, `last_inbound_at`; on conflict update
   `last_inbound_at` for inbound), message by `gmail_message_id` ON CONFLICT DO NOTHING
   (`direction`, `from_email`, `body_text`, `rfc_message_id` from the Message-ID header,
   `sent_at` from internalDate).
5. Inbound on a `resolved`/`waiting_on_customer` ticket → status back to `new` (reopen). Inbound
   on `escalated` stays `escalated` (owner owns it); `awaiting_approval` is a 6B state, listed
   for completeness.
6. Apply Gmail label `DogeBuddy/New` to each new inbound message (label ids resolved once and
   cached; created via `createLabel` if missing). Label application failure is a warning alert,
   never a job failure — labels are cosmetic, the DB is truth.
7. Store the **max historyId seen this batch** back to `gmail_sync_state` ONLY after all upserts
   commit (crash → re-poll re-upserts idempotently).

## 3. Triage — one Haiku call per untriaged ticket-state

Runs inline at the end of each poll (no separate cron): select tickets where `status = 'new'`.

- **Migration (one, additive):** `support_tickets` gains `sentiment text`, `is_spam boolean`,
  `escalation_reason text`, `last_triaged_at timestamptz`. No new tables.
- One `claude-haiku-4-5` Messages API structured-output call per ticket, input = subject + the
  latest inbound bodies (bounded: last 3 inbound messages, each truncated ~2k chars), output
  `{ category: toys|walks|beds|grooming|order_issue|shipping|refund_request|product_question|other,
  order_number: string|null, sentiment: positive|neutral|negative|angry, is_spam: boolean,
  escalation_flags: string[] }` where `escalation_flags` ⊆ a fixed vocabulary the PROMPT may
  suggest but ONLY CODE acts on: `legal_threat`, `chargeback_threat`, `injury`, `recall_mention`.
- **Plain-code after the call:** link `order_id` by exact lookup of `order_number` against our
  `orders` table (no fuzzy matching); write category/sentiment/is_spam/last_triaged_at.
- **Escalation decision is code, not prompt** (parent spec risk #4): escalate when any
  `escalation_flags` present, OR sentiment `angry`, OR repeat complainant (≥3 tickets from the
  same `customer_email` in 30 days), OR the triage call failed/unparseable on **two consecutive
  poll cycles for the same ticket** (better a human sees it than it rots in `new`). The parent
  list's "refund > cap" trigger belongs to 6B (no refund flow exists in 6A).
  Escalated → status `escalated`, `escalation_reason` recorded, Telegram alert via the existing
  `NotifyOwner` with a link to `${ADMIN_BASE_URL}/admin/tickets/<id>`.
- `is_spam` → status `resolved` + Gmail label `DogeBuddy/Spam`, no escalation, no further
  processing; visible under a status filter in admin.
- Otherwise → status `triaged`.
- **Spend guard:** hardcoded daily cap (`TRIAGE_MAX_CALLS_PER_DAY = 200`, counted in code via
  audit rows); at cap, tickets stay `new` (next day's poll catches up) + one warning alert.
  Triage uses the Messages API directly (no Agent SDK) with the injectable-client seam below.

## 4. Admin — `/admin/tickets` replaces the stub

Same Fastify + `html.ts` patterns as `/admin/orders`:

- **List:** escalated pinned first, then by `last_inbound_at` desc; status filter chips; each row:
  status, category, sentiment, customer, subject, linked order (link to `/admin/orders` row when
  present), age.
- **Thread view `/admin/tickets/:id`:** messages chronologically (direction-styled), triage
  verdict + escalation reason, linked order summary, and two POST actions with the existing
  CSRF/confirm conventions: **Escalate** (→ `escalated` + audit) and **Resolve** (→ `resolved` +
  audit). No reply box in 6A.

## 5. Config & settings

- New env (all optional as a group — absent ⇒ ingest skips): `GMAIL_SERVICE_ACCOUNT_EMAIL`,
  `GMAIL_SERVICE_ACCOUNT_KEY` (PEM, `\n`-escaped like typical SA keys), `GMAIL_IMPERSONATE`
  (`support@dogebuddy.com`). zod-validated as a trio in `loadConfig` (partial trio = hard config
  error, not a silent skip).
- `ANTHROPIC_API_KEY` (existing) gates triage the same way.
- No new settings keys in 6A (`workflow.support_reply.mode` etc. are 6B's); `killswitch.global`
  is honored by the cron.

## 6. Testing

- **TDD throughout** (house rule). Unit: JWT assembly (fixed clock), RFC 2822 builder (threading
  headers byte-exact), body extraction, history paging, escalation rules table-driven, repeat-
  complainant window.
- **Contract suite:** fixture replay per client method; `GMAIL_CONTRACT=1` re-records live.
- **E2E (vitest, local DB):** `MockGmail` + injectable triage stub (same seam idiom as
  `queryFn`): inbound → ticket+message+label; dedupe on re-poll; follow-up reopens; escalation →
  notify called with deep link; spam path; history-expired full-resync; cap behavior; creds-absent
  skip.
- **Review layers (house, non-optional):** adversarial spec-review Workflow BEFORE
  implementation; per-task adversarial reviewers during; final whole-branch multi-lens Workflow
  after.

## 7. Owner-side checklist (parallel work — mirrored into OWNER-CHECKLIST.md)

1. Google Workspace Business Starter, domain `dogebuddy.com`, one user `support@` (~$7/mo).
2. DNS at the registrar: SPF (`v=spf1 include:_spf.google.com ~all`) → enable DKIM 2048 in
   Workspace admin & publish the record → wait 48h → DMARC (`v=DMARC1; p=none; rua=mailto:support@dogebuddy.com`).
   (Exact host/value strings will be handed over as each becomes available — DKIM's comes from
   the Workspace admin console.)
3. GCP: new project, enable Gmail API, create service account + JSON key, note its **client id**.
4. Workspace Admin → Security → API controls → Domain-wide delegation → add that client id with
   scope `https://www.googleapis.com/auth/gmail.modify` exactly.
5. Hand Claude the SA email + key (into `apps/ops/.env`; later Railway variables) — then the
   contract suite records real fixtures and Tier-2 runs.

## Resolved design points (so the plan doesn't re-litigate)

- Polling only, 45s, `gmail.modify` scope only — parent spec decisions, unchanged.
- Hand-rolled fetch client over `googleapis` — house convention, smaller surface, fixture-friendly.
- Triage inline in the poll job, not a queue fan-out — volume is tiny; simplicity wins until it
  doesn't (the cap protects the bill either way).
- `sendReply` ships in 6A's client (fixture-tested, uncalled) so 6B never touches the wire layer.
- Sync-state write ordering (upserts commit before historyId advances) makes crash-replay safe
  without transactions spanning API calls.
- Escalation vocabulary fixed in code; the model can only *suggest* flags from that vocabulary.
