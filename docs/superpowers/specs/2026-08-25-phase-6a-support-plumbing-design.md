# Phase 6A — Support email plumbing (design)

**Date:** 2026-08-25 · **Status:** approved by Robert (chat); hardened by the 4-lens adversarial
panel (40 findings folded in — see §Panel) · **Parent:** `2026-08-09-doge-buddy-design.md` §(c)
**Slicing decision:** Phase 6 ships in two slices. **6A (this doc): email plumbing, live** — Gmail
client, polling ingest, Haiku triage, escalation→Telegram, real `/admin/tickets`. **6B (next):
the support agent + `support_reply`/`refund` apply workers.** Rationale: Phase 5 proved the live
wire contract is where real bugs hide (CJ then, Gmail now) — prove the risky layer first, in
parallel with the owner's Workspace setup, and give 6B a proven-live substrate.

## Exit criteria (Tier-2, live)

1. A real email sent to `support@dogebuddy.com` becomes a categorized ticket visible on
   `/admin/tickets` within ~3 minutes (minute-cadence poll + triage), with the `DogeBuddy/New`
   label applied in Gmail.
2. An escalation-class email (e.g. mentions a chargeback) additionally lands a Telegram alert on
   the owner's phone with a deep link to the ticket thread view — including when triage is
   capped or the model is steered, via the code tripwire (§3).
3. A follow-up email on a resolved ticket reopens it (not a new ticket).
4. The owner drafting + sending a reply from the Gmail UI on a ticket thread produces exactly ONE
   outbound `support_messages` row (the sent copy) — zero draft-revision rows.

Mock-tier exit: full E2E suite green against `MockGmail` + stubbed triage; wire-client fixture
suite green (fixtures re-recorded from the real API once creds exist — treat unverified fixtures
as provisional, per the CJ lesson).

## Non-goals (6B or later)

No Agent SDK / LLM replies, no `support_reply`/`refund` apply workers, no `sendReply` *callers*
(the client method ships now, tested against fixtures, so 6B doesn't reopen the wire client), no
owner reply UI in admin (owner answers directly from the Gmail inbox meanwhile — the ingest
handles that, see draft/SENT rules in §2), no Pub/Sub (polling only, per parent spec).

## 1. `packages/gmail` — thin hand-rolled client

House pattern: like `packages/shopify-admin` and the CJ client — plain `fetch`, no `googleapis`
SDK.

- **Auth:** service-account JWT (RS256 via node `crypto`) → Google OAuth2 token endpoint, with
  `sub = GMAIL_IMPERSONATE` (domain-wide delegation) and scope
  `https://www.googleapis.com/auth/gmail.modify` ONLY. Access tokens ~1h; refresh-ahead at ~50min;
  cached in memory.
- **Surface** (all against `gmail/v1/users/me/...`):
  - `getProfile()` → `{ emailAddress, historyId }`
  - `listHistory({ startHistoryId, pageToken? })` → typed pages of history records (each with its
    record `id` and `messagesAdded`); a **404 on this endpoint** is the typed
    `HistoryExpiredError`
  - `listMessages({ q?, pageToken?, includeSpamTrash? })` (resync path)
  - `getMessage(id, { format })` — `format: 'metadata'` (headers only; used for the filter
    decision) or `'full'`. Normalized shape: `{ id, threadId, labelIds, internalDate, headers,
    bodyText }` where `headers` includes **From / To / Cc / Delivered-To (repeating — collect all
    occurrences) / Subject / Message-ID / In-Reply-To / References**. NO `historyId` in the
    normalized shape (its semantics — latest state change — make it a sync-state trap; §2.7).
    A **404 on this endpoint** is the typed `MessageGoneError` (deleted drafts/mail — routine,
    never fatal; §2.3).
  - **Body extraction is recursive:** walk the MIME part tree depth-first — first `text/plain`
    leaf with `body.data`, else first `text/html` leaf tag-stripped, else top-level
    `payload.body.data` (single-part messages have no `parts[]`); parts carrying only
    `attachmentId` are ignored. Contract fixtures MUST include a nested
    multipart/mixed-with-attachment message and a single-part message.
  - `listLabels()` / `createLabel(name)` / `modifyMessage(id, {add,remove})`
  - `sendReply({ threadId, to, subject, inReplyTo, references, bodyText })` — builds raw RFC 2822
    **with `From: SUPPORT_ADDRESS` stamped by the client** (alias mode: an unstamped From would be
    rewritten to the authenticated `admin@`, leaking the admin address — §5). Unit test asserts
    the From header AND all three threading fields byte-exact. Shipped + fixture-tested now;
    first caller arrives in 6B.
- **Address handling:** every address comparison anywhere in this phase (direction, filter,
  customer identity) is on **RFC 5322 parsed, lowercased addr-specs** — never substring/raw-header
  matches (`"support@dogebuddy.com" <x@evil.com>` must not match). Stored `customer_email` /
  `from_email` are the parsed lowercase address only.
- **Errors:** non-2xx → typed `GmailApiError{status, code, reason, message}`; 401 → one token
  refresh + single retry; 429 AND **403 with reason `userRateLimitExceeded` /
  `rateLimitExceeded` / `dailyLimitExceeded`** → single jittered retry then a typed rate-limit
  error (distinct from 403 permission errors, so a quota blip is never misdiagnosed as broken
  DWD); 5xx → single jittered retry then throw. The poll cadence is the outer retry loop.
- **`MockGmail`** implements the same interface in-memory: seedable threads/messages/labels, a
  `receiveInbound()` helper, draft-autosave simulation (new message id per revision + deletion of
  the prior one), failure/latency injection, faithful history semantics (incremental,
  `HistoryExpiredError`, `MessageGoneError`).
- **Fixture scrubbing contract:** recorded fixtures MUST exclude Authorization headers; the
  JWT/token-exchange path is unit-tested with a throwaway test key and NEVER fixture-recorded;
  `GMAIL_CONTRACT=1` records only owner-seeded test messages; the recorder asserts no fixture
  file contains `Bearer ` or `PRIVATE KEY` and fails the run if one does.

## 2. Ingest — pg-boss job `support.poll-gmail`, every minute

**Cadence reality (panel):** pg-boss hard-floors schedules at one fire/minute, and the house
`registerCron` creates standard-policy queues with no overlap protection. Therefore: cron
`* * * * *`; **extend `registerCron` to accept a queue `policy` + schedule `singletonKey`** and
create this queue with `policy: 'singleton'`, `singletonKey: 'support.poll-gmail'`. Queue
options pinned: `expireInSeconds: 120`, `retryLimit: 0` (the cadence is the retry loop; a
Railway hard-kill mid-poll must not black out ingest for pg-boss's default 15-minute expiry).
Every external call inside the handler carries its own timeout well under the expiry. The job
skips (no-op) when Gmail env is absent (once-per-boot info alert), when `killswitch.global` is
on, or when **`workflow.support.enabled`** (new setting, default true — the support-scoped kill
lever) is off.

1. Load `gmail_sync_state.last_history_id`; if null → `getProfile()`, store its historyId, done.
2. `listHistory` from the stored id, walking pages; collect `messagesAdded` ids. On
   `HistoryExpiredError` → **bounded resync**: capture `getProfile().historyId` FIRST (store
   nothing yet), then `listMessages` with `q = "to:S OR cc:S OR deliveredto:S"` (S =
   `SUPPORT_ADDRESS`) plus `includeSpamTrash: true`, processed **page-by-page with per-page
   commits** (a mid-resync failure resumes, never restarts), then ALSO re-walk messages of known
   ticket threads' `threadId`s (the q-filter can't see follow-ups that dropped the address);
   finally store the pre-captured historyId. Messages arriving during the resync are covered by
   the pre-capture + idempotent upserts.
3. Per message id → `getMessage(id, {format:'metadata'})` first. **Skip outright:** any message
   whose labelIds include `DRAFT` (Gmail autosaves create a new message id per revision — the
   owner's own replies would otherwise flood the DB with unsent draft snapshots) or `TRASH`.
   `MessageGoneError` → skip + debug log (routine: deleted draft revisions), never fail the
   poll. **Support filter:** process iff (a) any parsed To/Cc/Delivered-To address equals
   `SUPPORT_ADDRESS`, OR (b) the `threadId` already has a `support_tickets` row. Only for
   matches: fetch `format:'full'` for the body. `SPAM`-labeled messages that pass the filter are
   processed normally (the tripwire + triage handle them); the metadata-first fetch is also what
   makes §5's privacy claim true — bodies are read only for support mail.
4. **Direction: the `SENT` label is the SOLE outbound signal.** From-header claims are attacker
   forgeable (DMARC is `p=none`) and are never used for direction. Everything without `SENT` is
   `inbound`.
5. Upserts, idempotent by the UNIQUE keys, with **every side effect keyed on the message row
   actually inserting** (`INSERT ... ON CONFLICT DO NOTHING RETURNING id`; no row returned = seen
   before = no side effects — this is what makes crash replay and resync safe: no reopen storms,
   no duplicate escalations, no label churn). On first-insert of an inbound message: bump ticket
   `last_inbound_at = GREATEST(existing, internalDate)`; reopen `resolved`/`waiting_on_customer`
   → `new` (an `escalated` ticket stays escalated — the owner owns it); create the ticket if the
   thread has none (`customer_email` = parsed From addr-spec; a thread whose first
   ingested message is outbound takes its customer from the To addr-spec).
6. **Code tripwire (at ingest, not triage):** on each first-inserted inbound message, a plain
   substring screen of subject+body against a fixed keyword list (chargeback, dispute, lawsuit /
   attorney / legal action, injury / hurt / vet, recall) → immediate escalation (§3 mechanics).
   This is the deterministic safety floor: it cannot be starved by the triage cap or steered by
   prompt injection. Model triage only ever ADDS escalations.
7. Apply Gmail label `DogeBuddy/New` to first-inserted inbound messages. Label ids cached; on a
   label-related 400/404 from `modifyMessage`, invalidate the cache and re-resolve/create once;
   `createLabel` duplicate-name error = "exists" → re-list for the id. Label failures are
   warning alerts, never job failures.
8. **Sync state:** store the max **history-record `id`** (BigInt compare — historyIds are
   uint64-as-strings; lexicographic max corrupts state) across the walked `listHistory` records
   ONLY — never `getMessage` historyIds, never `getProfile` outside seed/resync. Advance only
   after the batch's upserts commit, via guarded
   `UPDATE gmail_sync_state SET last_history_id = $new WHERE last_history_id < $new` (defense
   against any residual overlap).
9. **Failure visibility:** `gmail_sync_state` gains `consecutive_failures int` +
   `last_success_at timestamptz`. Warning alert at 5 consecutive failed polls; critical alert +
   Telegram notify at 20 (~20 min of outage); reset on success. `/admin` health shows
   `last_success_at`.

## 3. Triage — Haiku, capped, code-floored

Runs inline at the end of each poll. Selection: `status = 'new'` **OR (`status = 'triaged'` AND
`last_inbound_at > last_triaged_at`)** — a follow-up with escalation-class content on an
already-triaged ticket must re-triage. Oldest `last_inbound_at` first; **per-cycle cap 20
tickets** (bounds poll duration); per-call **30s timeout** via AbortController on the injectable
Anthropic client (a hung call must not stall ingest).

- **Migration (one, additive):** `support_tickets` += `sentiment text`, `is_spam boolean`,
  `escalation_reason text`, `last_triaged_at timestamptz`, `triage_failure_count int not null
  default 0`, `claimed_order_number text`, `escalation_notified_at timestamptz`;
  `gmail_sync_state` += the two §2.9 columns.
- One `claude-haiku-4-5` structured-output call per selected ticket: input = subject + last 3
  inbound bodies (each truncated ~2k chars); output `{ category:
  toys|walks|beds|grooming|order_issue|shipping|refund_request|product_question|other,
  order_number: string|null, sentiment: positive|neutral|negative|angry, is_spam: boolean,
  escalation_flags: string[] ⊆ [legal_threat, chargeback_threat, injury, recall_mention] }`.
  Prompt treats email content as untrusted data; but the design assumes outputs CAN be steered —
  the tripwire (§2.6) is the floor.
- **Order linking (ownership-checked):** normalize the extracted number and the stored
  `shopify_order_number` identically (strip leading `#` + whitespace — the DB currently holds
  BOTH formats: webhook path stores bare, reconcile stores `#`-prefixed; compare with
  normalization in SQL). Link `order_id` ONLY when that order's customer email equals the
  ticket's `customer_email` (parsed, case-insensitive) — Shopify order numbers are sequential
  and guessable, and a hostile email must not link a victim's order. On mismatch or no match:
  store `claimed_order_number` and surface "claimed, unverified" in admin. 6B inherits this rule.
- **Decision precedence, pinned:**
  1. Ingest tripwire (already escalated → triage skips the ticket).
  2. `is_spam` → status `resolved` + Gmail label `DogeBuddy/Spam`; spam tickets are EXCLUDED
     from the repeat-complainant count and never escalate (the tripwire already caught anything
     dangerous phrased as spam).
  3. Escalate when: any `escalation_flags`, OR sentiment `angry`, OR repeat complainant (≥3
     non-spam tickets from this `customer_email` created in the last 30 days, current included),
     OR `triage_failure_count` reaches 2 (incremented per failed/timed-out/unparseable attempt,
     reset on success and on reopen — survives redeploys by being a column).
  4. Otherwise → `triaged`.
- **All triage status writes are guarded transitions** (`UPDATE ... WHERE id = $1 AND status =
  'new'` / the selected status) so a concurrent owner Resolve/Escalate in admin is never
  clobbered; zero rows updated = skip silently.
- **Escalation mechanics (shared with the tripwire):** commit `escalated` + `escalation_reason`
  FIRST, then notify. `escalation_notified_at` stamps success; `NotifyOwner` returning false
  leaves it NULL and the next poll retries (at-least-once). All escalations in one poll cycle
  collapse into ONE Telegram message (deep links per ticket); max 10 escalation notifications
  per UTC day, overflow batched into a single summary alert (alert-bombing bound).
- **Per-sender flood bound:** after 5 tickets created by one `customer_email` in a UTC day,
  further new threads from that sender fold into the newest existing ticket as messages
  (+ one warning alert) — an attacker must not starve triage or page the phone at will.
- **Spend guard:** one audit row per triage ATTEMPT (action `support.triage`) written BEFORE the
  API call (fail-closed counting); cap = `TRIAGE_MAX_CALLS_PER_DAY = 200` counted since UTC
  midnight; at cap, tickets stay `new` and ONE warning alert fires per UTC day (guarded by
  checking for that day's existing cap-warning audit row). The §2.6 tripwire keeps
  escalation-class mail alerting even at cap.
- **Pre-triage spam short-circuit (amended 2026-08-30, pre-publish anti-spam hardening —
  migration 0008):** ingest keeps `support_tickets.gmail_spam` (did the ticket's LATEST inbound sit
  in Gmail's own SPAM folder; set in the same statement as `last_inbound_at` so an out-of-order
  older message never overrides it). A **spam candidate** is `gmail_spam AND order_id IS NULL AND
  no `orders` row under the sender's email` — tripwired tickets are `escalated` and outside the
  selection anyway. Two effects: (1) the selection ORDER BY puts candidates BEHIND all other
  tickets, so a spam flood can never delay a real ticket; (2) once the daily cap is reached a
  candidate is resolved as spam + labeled `DogeBuddy/Spam` WITHOUT a model call and without a
  spend row (audit `support.triage_spam_shortcircuit {mode: at_cap}`), while real tickets wait for
  the next UTC day as before (the loop `continue`s past them instead of `break`ing so the
  candidates behind them still clear). While the cap has room a candidate still gets the Haiku
  verdict — deliberately: the live walks showed Gmail spam-foldering a legitimate pre-purchase
  question from a new Outlook sender (no order yet, by definition), which an always-skip rule
  would auto-resolve unseen. The boolean setting `support.spam_shortcircuit.always` (default
  false) switches to always-skip (`{mode: always}`) for an owner who prefers zero spend on that
  class. Short-circuited tickets are `is_spam = true`, so the repeat-complainant tally excludes
  them exactly like model-verdict spam.

## 4. Admin — `/admin/tickets` replaces the stub

Same Fastify + `html.ts` patterns as `/admin/orders` — all customer-controlled strings (subject,
bodies, addresses) rendered through the established escaping helpers, as plain text only (no
HTML rendering of bodies; `white-space: pre-wrap`).

- **List:** escalated pinned first, then `last_inbound_at` desc; status filter chips (spam under
  its `resolved` + `is_spam` filter); each row: status, category, sentiment, customer, subject,
  linked order (or "claimed #N, unverified"), age.
- **Thread view `/admin/tickets/:id`:** messages chronologically (direction-styled), triage
  verdict + escalation reason, linked-order summary, and two POST actions with the existing
  confirm/audit conventions, both as guarded transitions (`WHERE status = $expected`):
  **Escalate** and **Resolve**.
- `/admin` health row: `last_success_at` of the poll + consecutive-failure count.

## 5. Config & settings

- **Alias mode (owner decision 2026-08-25, supersedes the parent spec's dedicated user):** ONE
  Workspace user `admin@dogebuddy.com`; `support@dogebuddy.com` is an alias on it. The pipeline
  impersonates the PRIMARY user; the `SUPPORT_ADDRESS` filter (§2.3) is load-bearing.
  **Accepted tradeoffs (owner, knowingly):**
  1. Ingest reads **header metadata** of everything in the admin mailbox; full bodies are
     fetched ONLY for messages that pass the support filter (the two-phase fetch in §2.3 is what
     makes this claim true — keep it true).
  2. An odd delivery path (bare BCC) may miss the header match; rule (b) catches known-ticket
     follow-ups, the rest stays un-ticketed in the inbox (fails safe).
  3. **SA-key blast radius:** `gmail.modify` on the impersonated PRIMARY account includes send;
     key compromise = read/modify/send-as on the owner's entire admin mailbox (password-reset
     mail for every service registered to it included), and DWD is domain-wide by construction —
     `GMAIL_IMPERSONATE` is app config, not an authorization boundary. Mitigations: key lives
     ONLY in gitignored `apps/ops/.env` + Railway variables, never in logs/alert detail/fixtures
     (§1 scrubbing contract), rotate on any suspicion, and revisit the dedicated-user escape
     hatch as `admin@` accumulates registrations.
  **Escape hatch:** dedicated `support@` user later = two-var config change (`GMAIL_IMPERSONATE`
  → new user; filter then matches everything). **6B note:** `sendReply` stamps
  `From: SUPPORT_ADDRESS` (§1); one-time owner check that Gmail "Send mail as" lists the alias.
- New env (all-or-none group; partial group = hard config error, absent group ⇒ ingest skips):
  `GMAIL_SERVICE_ACCOUNT_EMAIL`, `GMAIL_SERVICE_ACCOUNT_KEY` (PEM, `\n`-escaped — `loadDotEnv`
  does NOT unescape; config parsing must `replace(/\\n/g, '\n')`), `GMAIL_IMPERSONATE`
  (`admin@dogebuddy.com`), `SUPPORT_ADDRESS` (`support@dogebuddy.com`). **Live-verified
  2026-08-25:** SA JWT → DWD token → `getProfile` OK against the real mailbox.
- New settings key: `workflow.support.enabled` (boolean, default true) — the support-scoped kill
  lever, flippable from `/admin/settings` without a redeploy. `killswitch.global` also honored.

## 6. Testing

- **TDD throughout.** Unit: JWT assembly (fixed clock, test key), RFC 2822 builder (From + three
  threading headers byte-exact), recursive body extraction (nested multipart, single-part,
  attachment-only parts), address parsing/comparison (display-name spoof cases), history paging,
  BigInt historyId max, tripwire keywords, escalation precedence table-driven, repeat-complainant
  and per-sender-flood windows, order-number normalization + ownership check.
- **Contract suite:** fixture replay per client method incl. the 403-quota shape and
  `MessageGoneError`; `GMAIL_CONTRACT=1` re-records live under the §1 scrubbing contract.
- **E2E (vitest, local DB, `MockGmail` + injectable triage stub):** inbound → ticket + message +
  label; re-poll dedupe (zero side effects on replay); follow-up reopens; owner draft-churn →
  zero rows, sent copy → one outbound row; `MessageGoneError` mid-batch → poll completes +
  historyId advances; history-expired → bounded resync, NO reopen storm, NO duplicate
  escalations; spoofed `From: support@` classified inbound; tripwire fires at cap; spam
  precedence; ownership-mismatch → claimed-unverified; escalation notify-retry; guarded
  transitions vs concurrent admin action; creds-absent + kill-lever skips.
- **Review layers (house, non-optional):** this panel (done — see §Panel); per-task adversarial
  reviewers during implementation; final whole-branch multi-lens Workflow after.

## 7. Owner-side items (state as of 2026-08-25 — mirrored in OWNER-CHECKLIST.md)

DONE: Workspace (`admin@` + `support@` alias), SPF, DKIM published, GCP project + Gmail API +
service account + key (org-policy override was needed — new-org Secure-by-Default blocks SA
keys), domain-wide delegation authorized, creds in `apps/ops/.env`, chain live-verified.
REMAINING: DMARC TXT after DKIM has been live ~48h (`v=DMARC1; p=none;
rua=mailto:support@dogebuddy.com`); Gmail "Send mail as" alias check (6B); Railway env vars at
6A deploy time.

## Panel (adversarial spec review, 2026-08-25)

4 lenses (gmail-contract, data-idempotency, security-privacy, ops-failure), 40 findings, all
dispositioned into the sections above. The design-changing ones: minute-cadence + singleton
queue policy (45s cron impossible in pg-boss; registerCron had no overlap protection);
first-insert-keyed side effects (resync would have reopened every resolved ticket and re-paged
escalations); `MessageGoneError` skip (a deleted draft would have wedged ingest permanently);
DRAFT/TRASH exclusion (owner's own drafts would have been persisted); SENT-only direction (From
is forgeable under `p=none`); ingest-time code tripwire + spam/escalation precedence (model
outputs are steerable; is_spam must not veto the safety floor); order-ownership check (sequential
guessable order numbers); metadata-first fetch (makes the privacy tradeoff wording true);
resync ordering + bounding (pre-captured historyId, q-filtered, per-page commits); sendReply
From-stamping (alias mode would have leaked admin@); fixture scrubbing contract;
`workflow.support.enabled` kill lever; consecutive-failure alerting.
