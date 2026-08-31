# Contact form — Turnstile-gated storefront form → support ticket → Gmail-threaded reply

**Date:** 2026-08-31 · **Status:** BUILT 2026-08-31 (branch `contact-form`); live walk pending owner keys ·
**Parent:** OWNER-CHECKLIST "Publish the storefront" → *Decide before publishing* (option (a))
· **Builds on:** 6A support plumbing (ingest/triage/admin), 6B support agent (reply worker,
`X-DogeBuddy-Proposal` marker), the 2026-08-30 spam short-circuit (migration 0008).

## Problem

The privacy policy says "Email support@ (email address coming soon — see contact page)" and there
is no contact page. Robert will not print `support@dogebuddy.com` on the public site (his last
published store was flooded by bots scraping exactly that), so the storefront needs a
**Cloudflare Turnstile-gated form** that becomes a normal support ticket — and the reply has to
reach the customer *threaded*, because the whole 6B reply path (threading, send-recovery marker,
follow-up ingest) is built on a Gmail thread.

**Owner ruling (2026-08-30):** a submission immediately triggers an **acknowledgement email from
support@**. The ack *creates* the Gmail thread; the agent's reply threads onto it; the customer's
follow-ups land in it. Everything downstream then works unchanged.

## Exit criteria (Tier-2, live)

1. Submit the real `/contact` form (real Turnstile widget) from the Outlook test address → a ticket
   appears on `/admin/tickets` with the "via contact form" badge, body = the message, triaged.
2. The ack lands in the Outlook **inbox** (not Junk), `From: support@dogebuddy.com`.
3. The agent's drafted reply, approved from the phone, lands **in the same Outlook conversation**
   as the ack (`In-Reply-To` = the ack's `Message-ID`).
4. Replying to that conversation from Outlook attaches to the **same ticket** (no duplicate).
5. A submission with the honeypot filled returns the success page and creates nothing; a
   submission with a bad Turnstile token is rejected; the 6th submission from one email in a UTC
   day folds into that sender's newest ticket.
6. Recovery: the ack's `Message-ID` we set is what Gmail delivers (verified with
   `rfc822msgid:` search on the sent copy) — the ack job's idempotency depends on it (§4).

## Non-goals

Attachments (damage photos still come by reply email — the ack tells the customer so); a no-JS
fallback (Turnstile itself needs JS); storing IPs beyond the single `siteverify` call; any change to
the agent, validator, triage verdicts, or the refund path; a customer-account-gated form.

Form tickets cannot carry a refund proposal until the customer has replied by email: the money
gate is `dmarcPasses(latest inbound.auth_results)` and a web submission has no
`Authentication-Results` header to pass it (`auth_results` is NULL by construction, §2.5). This is
the safe direction and it is deliberate — the validator says so explicitly rather than reporting a
generic authentication failure (`refund_sender_unauthenticated` / "contact-form ticket: no
authenticated sender until the customer replies by email"), so the reason never reads like a
spoofing incident. Everything else (reply, escalate, no_action) works unchanged on a form ticket.

## 1. Storefront — `/contact` (Hydrogen / Oxygen)

- **Route** `apps/storefront/app/routes/contact.tsx`: loader exposes `{ siteKey, enabled }`
  (`enabled` = both `PUBLIC_TURNSTILE_SITE_KEY` and `OPS_BASE_URL` set). Fields: **name** (≤100),
  **email** (≤254, must parse), **order number** (optional, ≤20 chars, `#` allowed), **message**
  (10–4000 chars), a visually-hidden **honeypot** `website` (`autocomplete=off`, `tabindex=-1`,
  off-screen — not `display:none`, which some bots respect), the Turnstile widget
  (`cf-turnstile` div + `https://challenges.cloudflare.com/turnstile/v0/api.js` deferred), submit.
  Disabled state (`!enabled`): render the page with "The contact form is temporarily unavailable
  — please try again later." and no form. Never prints the support address.
- **Action** (`export async function action`): reads the form, forwards
  `{ name, email, orderNumber, message, turnstileToken, honeypot, ip }` as JSON to
  `${OPS_BASE_URL}/public/contact` with a 10s timeout; `ip` = `cf-connecting-ip` header, else the
  first `x-forwarded-for` entry, else null. Maps ops' response: `200 {ok:true}` → success state
  ("Sent!" / "A confirmation from Doge Buddy Support is on its way — reply to it to add anything
  (photos included)." — deliberately never names `support@dogebuddy.com`, per the Problem
  statement's own constraint); `400 {error:'validation', fields}` → inline field errors, form
  re-rendered with values;
  `400 {error:'turnstile'}` → "Verification failed — please try again"; `429` → "Too many messages
  right now — please try again later"; `503`/network error → the unavailable copy. The honeypot
  is ALSO checked in the action (filled → render success without calling ops). A rejected
  submission resets the Turnstile widget (its token is single-use, so the re-rendered form would
  otherwise resubmit an already-redeemed token on the next try); validation errors on keys the
  form doesn't render an inline `<span>` for (e.g. `turnstileToken`) show as a banner instead of
  being silently dropped.
- **CSP** (`entry.server.tsx`): add `https://challenges.cloudflare.com` to `script-src`,
  `frame-src`, and `connect-src` (Turnstile loads a script and an iframe and posts to itself).
  *Implementation note:* Hydrogen's `createContentSecurityPolicy` REPLACES (does not merge)
  `scriptSrc`/`frameSrc`, so `entry.server.tsx` repeats Hydrogen's `default-src` list on those two
  directives plus `challenges.cloudflare.com`; `connectSrc` merges.
- **Nav/policy**: footer gets `{to: '/contact', title: 'Contact'}`; `POLICY_COPY` privacy line
  becomes "Use the contact form at /contact to access or delete your data." (the storefront
  renders `POLICY_COPY`; the agent quotes it — run it through the existing validator regression
  test like every policy paragraph).
- **Env** (`apps/storefront/.env.example` + Oxygen): `PUBLIC_TURNSTILE_SITE_KEY`, `OPS_BASE_URL`
  (`https://doge-buddyops-production.up.railway.app`, no trailing slash). Local dev without them
  → the disabled page. Turnstile's documented test keys (`1x00000000000000000000AA` site /
  `1x0000000000000000000000000000000AA` secret — always pass; `2x…`/`2x…` — always fail) are
  what the local + CI E2E use.

## 2. Ops — `POST /public/contact`

New Fastify plugin `apps/ops/src/http/contact.ts`, registered from `index.ts` **only when both
`config.gmail` and `config.turnstile` are set** (the ack needs Gmail; without a Turnstile secret
the endpoint must not exist — the storefront then sees a 404 and shows the unavailable copy, same
as 503). JSON body, 8KB limit. Order of checks — each is a hard stop:

1. **Honeypot** non-empty → `200 {ok:true}` and NOTHING is stored (bots see success); one audit
   row `support.form_honeypot` (no content, no email — just a count), capped at 100 honeypot
   audit rows per UTC day.
2. **Validation** (same rules as §1, server-authoritative; email lower-cased/trimmed) →
   `400 {ok:false, error:'validation', fields:{...}}`.
3. **Turnstile** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
   (form-encoded `secret`, `response`, `remoteip` when known; injectable `fetch`; 5s timeout).
   `success !== true` (or network failure) → `400 {error:'turnstile'}`. Tokens are single-use, so a
   replayed submission fails here by construction.
4. **Global daily cap**: `CONTACT_MAX_PER_DAY = 100` accepted submissions per UTC day, counted
   from `support.form_submission` audit rows (one per accepted submission, written INSIDE the
   ticket transaction below). At cap → `429 {error:'capped'}` + ONE `support_form_capped` warning
   alert per UTC day (guarded by that day's `support.form_capped` audit row — the triage-cap
   idiom). A flood costs at most 100 acks/day (Workspace allows 2,000 sends/day).
5. **One transaction** (mirrors `ingestMessageId`'s atomic block, reusing its exported helpers):
   - **per-sender fold**: `findFloodFoldTarget(tx, now, email)` (exported from ingest.ts) — a
     sender already at `MAX_TICKETS_PER_SENDER_PER_DAY` (5) today lands as a message on their
     newest ticket instead of a new one (+ the existing fold warning alert after commit); the
     `support_sender_flood` alert fires once per sender per UTC day (audit
     `support.form_flood_alerted`).
   - else **create the ticket**: `source = 'form'`, `gmail_thread_id = 'form:<ticketId>'`
     (placeholder — see §3), `customer_email`, `subject = 'Contact form: ' + first 60 chars of
     the message` (or `'Contact form: order #<n>'` when an order number was given), `status
     'new'`, `gmail_spam false`.
   - **inbound message**: `gmail_message_id = 'form:<uuid>'`, `direction 'inbound'`,
     `from_email`, `body_text = "Name: <name>\nOrder number (claimed): <n or —>\n\n<message>"`,
     `rfc_message_id null`, `auth_results null`, `sent_at = now`.
   - `last_inbound_at = greatest(...)`, guarded reopen of a folded `resolved`/
     `waiting_on_customer` ticket, and the **code tripwire** (`tripwireHit(subject, body)` →
     escalate + `escalation_notified_at = null` + `clearRedraftCycle()`) — the exact steps
     ingest runs, extracted into a shared `recordInboundOnTicket(tx, …)` helper so the two paths
     cannot drift (ingest is refactored to call it; its tests stay green).
   - audit `support.form_submission {ticketId, folded, ip: null}`.
   - enqueue `support.form-ack {ticketId}` **from inside the tx** using the same `queue.boss
     .send` closure pattern the poll uses (pg-boss writes to the same Postgres — if the tx rolls
     back, no job). *Implementation note:* the ack job is enqueued **after** commit (pg-boss
     sends on its own connection); the poll's 5th stage re-enqueues any form ticket still on its
     placeholder after 2 minutes, which gives the same no-ticket-without-ack guarantee.
6. `200 {ok:true}`. Escalation notify for a tripwired form ticket rides the next poll cycle's
   `notifyPendingEscalations` (it selects by `escalation_notified_at IS NULL`, source-agnostic).

A plugin-scoped error handler answers `500 {ok:false,error:'internal'}` — raw errors never reach
the client.

Everything triage does afterwards is unchanged: Haiku verdict (spam / category / order number →
ownership-checked link), repeat-complainant, agent selection, draft → Telegram → approve.
`gmail_spam` is false for form tickets, so the spam short-circuit never touches them.

**Per-IP limiting** is deliberately absent: Turnstile is the bot gate and Railway's proxy IP is
the only thing ops reliably sees; the honeypot + per-email fold + daily cap bound the damage.

## 3. Schema — migration 0009 (additive)

`support_tickets` += `source text NOT NULL DEFAULT 'email'` (`'email' | 'form'`). No new
message column: form-originated message ids use the `form:` prefix, and a tiny shared helper
`isGmailMessageId(id) = !id.startsWith('form:')` guards every Gmail call that iterates
`support_messages` (`labelSpam` in triage.ts, `applyLabel` callers, the reply worker's recovery
scan input). `gmail_thread_id` stays `NOT NULL UNIQUE`: the `form:<ticketId>` placeholder is
unique by construction and is REPLACED by the real thread id by the ack job.

## 4. Ack job — `support.form-ack`

Queue policy `stately`, `singletonKey: ticketId`, `retryLimit 5`, `retryDelay 60`,
`retryBackoff true`, `expireInSeconds 120`. Worker:

1. Load the ticket. If `gmail_thread_id` no longer starts with `form:` → already acked → no-op
   (audit `support.form_ack_skipped`).
2. **Idempotency across a crash between send and DB write**: the ack's RFC `Message-ID` is
   generated by us, deterministically: `<form-ack-<ticketId>@dogebuddy.com>`. Before sending,
   search `gmail.listMessages({ q: 'in:sent rfc822msgid:<that id>' })`; a hit means a previous
   attempt sent and crashed → recover its `threadId` from the hit and skip to step 4. (Exit
   criterion 6 verifies live that Gmail delivers the client-supplied `Message-ID` unchanged; if it
   does NOT, the fallback is documented in the plan: accept a duplicate ack on that rare crash —
   the customer gets two confirmations, nothing else is affected.)
3. **Send** via a new `gmail.sendNew({ to, subject, bodyText, messageId, extraHeaders })` —
   `packages/gmail` gains `buildNewRaw` (same sanitizing/encoding as `buildReplyRaw`, no
   `In-Reply-To`/`References`, no `Re:` prefix, explicit `Message-ID`) and the client method
   (POST `/messages/send` without `threadId`; **excluded from retry like `sendReply`**). MockGmail
   mirrors it (records the raw, assigns a new thread, honours the given Message-ID so
   `rfc822msgid:` search works in tests). Subject: `Re: <ticket subject>` is wrong here — use
   `We got your message — Doge Buddy Support`. Body (plain text, fixed copy, NOT agent-written):
   "Hi <name>, thanks for reaching out — we've received your message and will reply in this
   email thread, usually within one business day. If you're writing about a damaged or wrong
   item, please reply here with a photo. — Doge Buddy Support". (Runs through
   `validateReplyBody` in a unit test like every policy paragraph — it must never carry a
   promise token near an action token.)
4. **One transaction**: `UPDATE support_tickets SET gmail_thread_id = <real threadId> WHERE id =
   $1 AND gmail_thread_id = 'form:'||$1` (guarded — a concurrent duplicate worker matching 0
   rows stops here) + insert the outbound `support_messages` row (`gmail_message_id` = the sent
   Gmail id, `direction 'outbound'`, `from_email support@`, `body_text` = the ack,
   `rfc_message_id` = our Message-ID, `sent_at now`) `ON CONFLICT DO NOTHING`.
5. Failure after 5 retries → dead-letter alert `support_form_ack_failed {ticketId}` (Telegram);
   the ticket still exists and is triaged/agent-drafted — but the reply worker will hold the reply
   (§5) until the placeholder is gone, and the Telegram alert tells Robert why.

## 5. Reply worker — two small changes in `apply-support-reply.ts`

- **Placeholder guard** (before the recovery scan, which calls `getThread`): if
  `ticket.gmailThreadId` starts with `form:` → throw a *retryable* error (`form ack not sent
  yet`) so pg-boss retries the apply on its normal schedule; the proposal stays `applying`. With
  the ack job's 5×60s backoff this resolves itself within minutes in the normal case; a
  dead-lettered ack is already paging Robert (§4.5).
- **`In-Reply-To` fallback**: today it is the latest inbound's `rfc_message_id` and a null is
  terminal. New rule: latest inbound's id **else the latest OUTBOUND's id** (the ack — every form
  ticket has one once the placeholder is gone); still terminal if neither exists. `References`
  keeps its existing dedupe-chain builder (the ack's id is the root). A customer who replied to
  the ack has an inbound with a real id, so the fallback only ever fires on the first reply.
- Recovery scan: unchanged (it reads the real thread), but its `messages` input is filtered with
  `isGmailMessageId` so a `form:` id is never handed to `getMessage`.

Ingest needs no change for follow-ups: the customer's reply carries `In-Reply-To` = the ack's
Message-ID and the ack's thread id, so BOTH `findTicketByThread` and `findTicketByReferences`
(which reads outbound rows too) resolve it to the ticket.

## 6. Admin

`/admin/tickets` list + detail: a "via contact form" badge next to the subject when
`source = 'form'`; the detail view's message list already renders direction/body, so the form
message (with its `Name:`/`Order number (claimed):` header lines) and the ack read naturally.
Nothing else.

## 7. Config

- ops `config.ts`: `TURNSTILE_SECRET_KEY` (optional) → `config.turnstile?: { secretKey }`.
  `CONTACT_MAX_PER_DAY` stays a code constant (a setting is YAGNI until a flood proves otherwise).
- storefront: `PUBLIC_TURNSTILE_SITE_KEY`, `OPS_BASE_URL` (§1).
- `.env.example` files updated; OWNER-CHECKLIST gets the click-path (Cloudflare → Turnstile →
  Add widget → hostname `dogebuddy.com` + the Oxygen preview host → Managed mode → copy both keys;
  Railway var; Oxygen vars via the Hydrogen channel → Storefront settings → Environments; a
  redeploy of each).

## 8. Testing

- `contact.test.ts` (ops, real DB like the other support suites): honeypot → 200 + nothing
  stored + one audit row; validation matrix; Turnstile fail / network fail → 400 (stubbed fetch
  asserting the exact siteverify request shape incl. `remoteip`); cap → 429 + one alert/day;
  fold at the 6th ticket; ticket + message + audit + job are one transaction (a forced failure on
  the job enqueue leaves no ticket); tripwire keyword in the message → `escalated` with
  `escalation_notified_at null`; `gmail_spam false`, `source 'form'`, placeholder thread id.
- `support-form-ack.test.ts`: happy path (MockGmail: one sent raw with our Message-ID, thread
  swapped, outbound row with `rfc_message_id`); already-acked → no-op; crash recovery (a sent copy
  exists for the Message-ID → no second send, thread recovered); guarded swap loses the race →
  no outbound row duplication; the ack copy passes `validateReplyBody`.
- `apply-support-reply.test.ts` additions: placeholder → retryable throw, no send; In-Reply-To
  falls back to the ack's id and `References` starts with it; a `form:` message id never reaches
  `getMessage`.
- Ingest refactor: existing `support-ingest.test.ts` stays green untouched (the helper extraction
  is behaviour-preserving) + one test that a reply to the ack attaches by References even when
  Gmail assigns a new thread id.
- `packages/gmail`: `buildNewRaw` (headers, no Re:, Message-ID present, RFC 2047 subject) and
  MockGmail `sendNew` + `rfc822msgid:` search.
- Storefront: `contact.test.tsx` for the action's response mapping and the honeypot short-circuit
  (mocked `fetch`); the E2E storefront test (if any) uses Turnstile's always-pass test keys.
- Live (Tier-2): the exit criteria above, run from the main checkout with Robert.

## 9. Owner-side items (mirrored to OWNER-CHECKLIST)

Create the Turnstile widget (Cloudflare account, free) → two keys; `TURNSTILE_SECRET_KEY` on
Railway; `PUBLIC_TURNSTILE_SITE_KEY` + `OPS_BASE_URL` on Oxygen (all environments); migration
0009 on Railway BEFORE the push (the new endpoint reads `source`); push; then the live walk (§Exit
criteria) from the Outlook test address — reply-on-thread only, per the test-address rule.
