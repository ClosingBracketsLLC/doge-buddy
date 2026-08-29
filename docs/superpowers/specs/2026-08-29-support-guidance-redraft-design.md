# Support Agent Guidance & Reject-with-Reason Re-draft — Design

**Status:** Approved design (2026-08-29), pre-implementation.

**Goal:** Give the owner live control over what the support agent says, in two
complementary ways: (1) an editable **operating-guidance** layer the agent reads on
every run, and (2) a **reject-with-reason re-draft loop** so a rejected draft can be
handed back to the agent with the owner's correction instead of always escalating to a
human.

**Motivating finding (live Phase 6B Tier-2 walk, 2026-08-29):** the support agent
correctly drafted a return-acceptance reply because the store's hardcoded returns policy
(`packages/core/src/policies.ts`) says "if you or your dog aren't happy with an item,
contact us within 30 days … for a prepaid return label." The owner's real stance ("we
don't accept returns just because the dog didn't like it") *contradicts* that policy. So
the agent was not misbehaving — its knowledge and the owner's intent disagreed, and there
was no way to correct either without a code change. This design closes that gap.

**Tech Stack:** Fastify + server-rendered admin HTML (`apps/ops/src/http`), Drizzle +
Postgres, Claude Agent SDK support runner (`apps/ops/src/agents/support-run.ts`),
pg-boss cron (`support.poll-gmail`), the existing `settings` (key→jsonb) store and
`audit_log`.

---

## Global Constraints

- **Two decision surfaces stay in lockstep.** Every reject behaviour must be identical
  whether it arrives via the public one-click link (`apps/ops/src/http/actions.ts`, the
  Telegram/email buttons) or the session-authed admin dashboard
  (`apps/ops/src/http/admin/routes.ts`). The owner's "no" means the same thing regardless
  of surface — the existing `onSupportProposalRejected` contract.
- **Untrusted vs. trusted input is unchanged.** Customer email content stays UNTRUSTED
  (rendered as `JSON.stringify`'d data lines, never instructions — see
  `support-run.ts:formatMessage`). Owner guidance and owner reject-reasons are TRUSTED
  owner input and may be rendered into the prompt as authoritative instructions, but are
  still length-bounded and never bypass the §3 plain-code validator that gates what
  actually sends.
- **The §3 validator still gates every send.** `validateSupportProposalForApproval`
  (URL/contact/promise/DMARC/refund screens) re-runs on EVERY approval, edited or not,
  both surfaces — unchanged. Guidance and re-drafts change what the agent *drafts*, never
  what is allowed to *send*.
- **Public policy stays code-managed.** `POLICY_COPY` in `packages/core/src/policies.ts`
  remains the single source for the storefront's public policy pages
  (`apps/storefront/app/content/policies.tsx`, a Hydrogen/Oxygen app with no DB access).
  Nothing in this design makes the public storefront pages live-editable.
- **Deploy ordering (same as 6B):** migration 0007 must be applied to Railway BEFORE the
  code that reads its columns deploys, or ingest/agent-select throws every poll while
  `/healthz` stays green.
- **Backward compatibility:** empty guidance ⇒ the agent behaves exactly as today; a
  reject with no reason ⇒ today's terminal escalate, unchanged.

---

## 1. The two-layer policy model

There are two distinct things, deliberately kept separate:

- **Layer 1 — Public policy (unchanged approach).** `POLICY_COPY` in core, rendered by
  the storefront at build time and shown to the agent as its baseline via
  `policiesAsText()`. It is customer-facing legal/marketing copy; changing it is a rare
  code edit + redeploy. The storefront cannot read a live DB (Oxygen/Cloudflare Workers,
  Shopify-API-driven only), so keeping public pages static is a deliberate choice, not a
  limitation to work around.
- **Layer 2 — Owner operating guidance (new, live).** A DB-backed, owner-edited text
  block the agent reads on every run, layered ON TOP of Layer 1 and **authoritative where
  the two conflict**. This is internal operating guidance ("here is when we actually say
  no"), distinct from the public page. The owner accepts that the agent's operating rules
  may intentionally differ from the public copy.

---

## 2. Subsystem A — Editable operating guidance

### 2.1 Storage

- A single `settings` row, key **`support.agent_guidance`**, value = a JSON string holding
  the owner's free-text guidance (default `""`). No migration — reuses the existing typed
  settings store (`apps/ops/src/settings.ts`, `SETTINGS_DEFAULTS`).
- Add `'support.agent_guidance': ''` to `SETTINGS_DEFAULTS` so reads never miss.
- Bound the stored value to a sane maximum (**8000 characters**); the save handler rejects
  anything longer with a readable error rather than truncating.
- Every successful save writes an `audit_log` row: `action: 'settings.support_guidance_updated'`,
  `actor` = the admin session identity, `detail` carrying the new length and a hash or the
  previous value for history (previous value is fine — it is owner text, not a secret).

### 2.2 Admin UI

- A new server-rendered page under `/admin` (e.g. `GET /admin/guidance`), session-authed
  like the rest of the dashboard, rendered from `apps/ops/src/http/admin/`.
- Contents: a labelled `<textarea>` pre-filled with the current guidance, a Save button
  (`POST /admin/guidance`), the last-edited timestamp, and one line of help text stating
  that guidance is authoritative and overrides the public policy where they conflict.
- A link to this page from the existing admin index/nav.
- `POST /admin/guidance` validates length, writes the setting, writes the audit row, and
  re-renders the page with a saved confirmation. CSRF/session protection identical to the
  existing admin POST routes.

### 2.3 Agent integration

- `buildSupportSystemPrompt()` gains a parameter `guidance: string` (callers thread the
  live value read from settings). When `guidance.trim()` is non-empty, append a final
  section:

  ```
  ## Owner operating guidance (AUTHORITATIVE — overrides the public store policy wherever they conflict)
  <guidance verbatim>
  ```

  When empty, the section is omitted entirely (byte-for-byte today's prompt).
- The guidance is TRUSTED owner text and is rendered verbatim (not JSON-escaped) — it is
  the one authoritative instruction source in the prompt besides the hard rules. It never
  relaxes a hard rule: the hard rules (no off-platform contact, refunds only per verified
  order + validator, sign-off, escalate-on-legal-threat, etc.) still bind, and the prompt
  ordering keeps the hard rules before guidance so a guidance edit cannot, e.g., authorize
  a refund on an unverified sender (the validator would block it regardless).
- `support-run.ts` reads the setting once per run (via the settings accessor already wired
  into the ops app) and passes it to `buildSupportSystemPrompt`.

---

## 3. Subsystem B — Reject-with-reason re-draft loop

### 3.1 The reject form (both surfaces)

- **Public one-click route (`apps/ops/src/http/actions.ts`):**
  `GET /a/:proposalId/reject?t=<token>` STOPS acting and instead **renders an HTML form**:
  a reason `<textarea>` and two submit buttons — **"Re-draft with this reason"** and
  **"Just escalate to me."** The single-use token is carried in a hidden field; the GET
  does not consume it. Submitting `POST /a/:proposalId/reject` consumes the token and
  performs the decision.
  - Security bonus: a GET that no longer mutates removes a real footgun — link
    prefetchers, mail scanners, and chat-preview crawlers can no longer trigger a reject
    by fetching the URL. (The approve link stays one-click GET for now; only reject needs
    text input. Approve-as-confirm is explicitly out of scope — §7.)
- **Admin dashboard (`apps/ops/src/http/admin/routes.ts`):** the proposal view gains the
  same reason textarea + two actions next to Reject, POSTing to the session-authed reject
  handler. Both handlers converge on the same decision logic.
- Token semantics are unchanged otherwise: single-use, redacted in logs
  (`apps/ops/src/http/redact.ts`), "already handled" page on a spent/again token.

### 3.2 Decision split

The reject POST carries `reason` (may be empty) and the chosen action:

- **No reason / "Just escalate to me" ⇒ terminal escalate.** Calls today's
  `onSupportProposalRejected` unchanged: expire the sibling proposal, escalate the ticket
  (`owner_rejected_draft`, pre-stamped silent for the `awaiting_approval` case;
  `refund_promise_unbacked`, paging, for the already-shipped `waiting_on_customer` case),
  clear `agentSessionId`. Fully backward-compatible.
- **Reason given + "Re-draft with this reason" ⇒ re-draft.** Only valid when the ticket is
  `awaiting_approval` (a draft not yet sent). Calls a new sibling function
  `onSupportProposalRejectedForRedraft(tx, row, reason, now)` in
  `apps/ops/src/proposals/support-decision.ts`, in ONE transaction with the proposal's own
  `rejected` transition + audit:
  1. Expire the ticket's still-`pending` sibling proposal (the paired reply/refund) — the
     agent will reconsider the whole response, so a stale sibling must not survive. Audited
     `proposal.sibling_rejected` (existing action), same as the terminal path.
  2. Store the correction: `support_tickets.owner_redraft_feedback = reason` (trimmed,
     length-bounded to **2000 chars** at the handler; longer is refused with a readable
     error).
  3. `support_tickets.redraft_count = redraft_count + 1`.
  4. Re-arm for a fresh agent run: set ticket `status = 'triaged'`, `last_agent_run_at =
     NULL`, and `last_agent_finished_at = NULL` — this satisfies `selectAndEnqueueAgentRuns`
     (`apps/ops/src/support/agent-select.ts`), whose primary branch is `last_agent_run_at IS
     NULL` (a re-draft has no new inbound, so nulling the run watermark is what makes it
     selectable). Reset `agent_failure_count = 0`. **KEEP `last_agent_prompted_at` as-is** —
     `buildContext` (`support-agent-run.ts`) filters the resume's messages with `isResume &&
     lastAgentPromptedAt !== null ? sentAt > promptedAt : ALL`; keeping the prior watermark
     yields ZERO new thread messages (correct — no customer wrote; the owner-feedback section
     is the run's substantive new input), whereas nulling it would flip the filter to ALL
     messages while the resume note claims "only new," misleading the agent.
  5. **Keep `agentSessionId`** — the re-draft resumes the agent's existing session so it has
     its prior reasoning and rejected draft in context.
  6. Audit `proposal.rejected_for_redraft` with `detail: { ticketId, reason_len,
     redraft_count }`.
- Guard on ticket status exactly like `onSupportProposalRejected` (optimistic concurrency);
  a re-draft against a ticket no longer `awaiting_approval` matches 0 rows and falls back to
  the terminal escalate path (a second reject, a concurrent tab).

### 3.3 The re-draft run

- `selectAndEnqueueAgentRuns` selects the re-armed `triaged` ticket (predicate already
  satisfied by the nulled watermark) and enqueues `support.agent-run`.
- At prompt-build time (`buildSupportPrompt` in `support-run.ts`), when
  `ticket.owner_redraft_feedback` is non-empty, insert a section (before the message
  thread, after the prior-proposals section):

  ```
  ## Owner feedback on your previous draft (AUTHORITATIVE — follow it exactly)
  The owner reviewed your last proposed reply and REJECTED it with this instruction.
  It overrides your prior reasoning and the public store policy wherever they conflict.
  Re-draft your response to comply; do not repeat the rejected approach.

  <owner_redraft_feedback verbatim>
  ```

  Owner feedback is TRUSTED and rendered verbatim (same trust class as guidance).
- The agent resumes (`isResume` path), drafts a new reply → new `support_reply` proposal →
  ticket flips to `awaiting_approval` via the existing submit path → owner is notified with
  the new draft. Normal approve/reject/again applies.
- **Resume mechanics (verified against the code):** `buildContext` sets `isResume =
  resumeSessionId !== null`, so the resume is driven by the kept `agentSessionId`, never by
  the run watermark — nulling `last_agent_run_at` does not affect `isResume`. With
  `last_agent_prompted_at` KEPT (§3.2 step 4), the message filter yields zero new thread
  messages, and `buildSupportPrompt`'s resume note ("only the new messages since your last
  run") is truthful. The owner-feedback section is the run's substantive new input. This is
  a normal resume of an existing session with no new customer mail — coherent, not an edge
  case.
- **Feedback lifecycle:** `owner_redraft_feedback` holds only the LATEST rejection reason;
  a subsequent reject-for-redraft overwrites it. It is CLEARED (`NULL`) and `redraft_count`
  reset to 0 at every point the ticket leaves the cycle, and each of these is a concrete,
  named write the plan must cover:
  - **approval → applied:** the `support_reply` apply worker (`completeSend`) clears both
    when the re-drafted reply ships.
  - **terminal escalate** (no-reason reject, cap reached, or the `waiting_on_customer`
    unbacked case): `onSupportProposalRejected` (and the `redraft_limit_reached` escalate)
    clear both in the same guarded write that sets `status='escalated'`.
  - **resolve:** the admin resolve transition clears both.
  Leaving them stale is a bug (a future reopen would show the agent a dead correction), so
  each transition owns its clear.

### 3.4 Loop cap

- Constant `SUPPORT_REDRAFT_MAX = 3` (co-located with the agent-select constants).
- While `redraft_count < SUPPORT_REDRAFT_MAX`, the reject form offers "Re-draft with this
  reason."
- At `redraft_count >= SUPPORT_REDRAFT_MAX`, the form replaces the re-draft option with a
  notice ("re-drafted 3× — rejecting again escalates to you"), and a reason-carrying reject
  is routed to the terminal escalate path with escalation reason
  `redraft_limit_reached` (paging, `escalationNotifiedAt` NULL — the owner needs to take
  this one over). The owner can choose "Just escalate to me" at any count.

---

## 4. Data model changes

- **Migration 0007** (`packages/db`), `support_tickets`:
  - `owner_redraft_feedback text` (nullable).
  - `redraft_count integer not null default 0`.
- **Settings:** new default key `support.agent_guidance` (value `""`) — no migration
  (settings is key→jsonb).
- **New audit actions:** `proposal.rejected_for_redraft`,
  `settings.support_guidance_updated`. (`proposal.sibling_rejected`, `proposal.reject`,
  `proposal.approve` are reused unchanged.)
- **New escalation reason:** `redraft_limit_reached` (paging).

---

## 5. Data flow (happy path)

```
Owner taps Reject (Telegram/admin)
  → GET renders reject form (reason box + 2 buttons)     [no mutation, token intact]
  → Owner types reason, taps "Re-draft with this reason"
  → POST /a/:id/reject  (token consumed)
      tx: proposal→rejected + audit
          expire sibling proposal (+audit)
          ticket.owner_redraft_feedback = reason; redraft_count++
          ticket.status = 'triaged'; watermark nulled; afc=0; keep agentSessionId
          audit proposal.rejected_for_redraft
  → next support.poll-gmail cycle: selectAndEnqueueAgentRuns picks the triaged ticket
  → support.agent-run resumes the session; prompt carries the owner-feedback section
  → agent drafts new reply → new support_reply proposal → ticket 'awaiting_approval'
  → owner notified with the new draft → Approve → §3 validator re-run → send → threads
  → on apply: owner_redraft_feedback cleared, redraft_count reset
```

---

## 6. Error handling & edge cases

- **Re-draft on a ticket whose reply already shipped** (`waiting_on_customer`): impossible
  by guard — re-draft only matches `awaiting_approval`. A reason-carrying reject against a
  shipped ticket falls through to the terminal path.
- **Sibling refund present:** expired on re-draft (§3.2 step 1); the resumed agent may
  propose a fresh refund or none, per the new guidance/feedback.
- **Empty reason but "Re-draft" chosen:** treated as no reason ⇒ terminal escalate (the UI
  should prevent this, but the handler is defensive).
- **Guidance edit mid-cycle:** the agent reads guidance fresh each run, so an edit applies
  to the next re-draft immediately; no stale snapshot.
- **Concurrency:** all ticket writes are status-guarded optimistic updates (existing house
  pattern); 0-row outcomes are normal and silent.
- **Token reuse / double submit:** unchanged single-use semantics; the "already handled"
  page covers a spent token.
- **Migration-before-deploy:** enforced operationally (Global Constraints); tests run
  against a migrated DB.

---

## 7. Out of scope (YAGNI)

- Live-editable PUBLIC storefront policy pages (would require an ops API the Oxygen
  storefront calls per render, or Shopify metaobjects — disproportionate for legal copy).
- Structured multi-topic guidance / per-category policy rows — one free-text block suffices;
  revisit only if it grows unwieldy.
- Persistent "learning" beyond the guidance block (e.g. auto-appending reject reasons into
  guidance) — the owner edits guidance explicitly.
- Approve-as-confirmation-page — only reject needs text input; approve stays one-click.
- Editing the current hardcoded returns policy wording — a separate, optional small code
  edit the owner may request independently.

---

## 8. Testing strategy

- **Unit — guidance:** `buildSupportSystemPrompt('')` is byte-identical to today; non-empty
  guidance appends exactly the one authoritative section; length bound enforced; save
  writes setting + audit.
- **Unit — decision split:** reason ⇒ `onSupportProposalRejectedForRedraft` (ticket
  triaged, watermark nulled, feedback stored, count incremented, session kept, sibling
  expired); no reason ⇒ `onSupportProposalRejected` (escalated, session cleared) unchanged;
  cap reached ⇒ terminal escalate with `redraft_limit_reached`.
- **Unit — prompt:** `buildSupportPrompt` renders the owner-feedback section verbatim when
  present, omits it when absent, and keeps customer bodies JSON-escaped.
- **Unit — form:** GET renders the form and does NOT mutate/consume the token; POST
  consumes it and dispatches on action.
- **Unit — lifecycle:** feedback + count cleared on apply/escalate/resolve.
- **E2E:** full loop — draft → reject-with-reason → re-arm → re-draft run (resume) → new
  proposal → approve → validator re-run → send. Assert one send, correct threading fields,
  and that a second inbound after the cycle starts clean (feedback cleared).
- **Regression:** existing reject/escalate tests still pass (terminal path untouched).

---

## 9. Exit criteria

1. Owner can edit operating guidance in the admin dashboard; a new ticket's draft reflects
   it on the next run with no redeploy.
2. Guidance is authoritative over the public policy in the prompt, but never relaxes a hard
   rule and never bypasses the §3 validator.
3. Rejecting a draft opens the reason form on both surfaces; a reason re-drafts (agent
   resumes, produces a compliant new draft the owner can approve); no reason escalates as
   today.
4. The loop caps at 3 re-drafts, then escalates; feedback and count clear when the ticket
   leaves the cycle.
5. Migration 0007 applies cleanly; empty guidance + no-reason reject reproduce today's
   behaviour exactly.
