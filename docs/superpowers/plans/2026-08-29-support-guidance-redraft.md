# Support Agent Guidance & Reject-with-Reason Re-draft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner live control over the support agent's output — an editable operating-guidance layer the agent reads every run, and a reject-with-reason loop that re-drafts a rejected reply with the owner's correction instead of always escalating.

**Architecture:** Two cohesive additions to the existing support pipeline. (A) Guidance is a `settings` row read at prompt-build time and appended to the agent's system prompt as an authoritative section. (B) Rejecting a draft renders a reason form (both the public one-click and admin surfaces already render a confirm form); a reason re-arms the ticket (`triaged`, run-watermark nulled, session kept) and stores the reason for the next resumed run; no reason escalates exactly as today. A shared decision helper keeps both surfaces identical; a 3-cycle cap escalates.

**Tech Stack:** Fastify + hand-rolled server-rendered HTML (`apps/ops/src/http`), Drizzle + Postgres (drizzle-kit migrations), Claude Agent SDK support runner, pg-boss `support.poll-gmail` cron, the `settings` (key→jsonb) store, `audit_log`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-support-guidance-redraft-design.md` — executors read both; the spec is the authority this plan argues from.

## Global Constraints

- Both reject surfaces (`apps/ops/src/http/actions.ts` public one-click; `apps/ops/src/http/admin/routes.ts` session-authed) MUST behave identically — route both through the shared decision helper.
- Customer email content stays UNTRUSTED (rendered `JSON.stringify`'d in `formatMessage`). Owner guidance and owner reject-reasons are TRUSTED and rendered verbatim as authoritative instructions, but are length-bounded (guidance ≤ 8000 chars; reason ≤ 2000 chars) and NEVER relax a hard rule or bypass the §3 validator.
- The §3 validator (`validateSupportProposalForApproval`) still re-runs on EVERY approval — untouched.
- `POLICY_COPY` (`packages/core/src/policies.ts`) stays the single code source for public storefront pages — not made live-editable.
- Deploy ordering: migration 0007 applies to Railway BEFORE the code that reads its columns deploys (same as 6B).
- Empty guidance ⇒ byte-identical prompt to today; reason-less reject ⇒ today's terminal escalate. Backward compatible.
- Local test DB: `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy`. `apps/ops` `test` script is vitest-only — run `pnpm typecheck` separately before trusting a task green. Scoring tests need `--testTimeout=30000` on a cold DB (unrelated to this work).

## Naming (fixed across all tasks — use verbatim)

- Schema columns: `ownerRedraftFeedback` → `owner_redraft_feedback text`; `redraftCount` → `redraft_count integer not null default 0` (on `support_tickets`).
- Setting key: `'support.agent_guidance'`, default `''` (string-valued).
- `buildSupportSystemPrompt(guidance: string): string`
- `SupportRunContext.ownerGuidance: string`; `SupportRunContext.ticket.ownerRedraftFeedback: string | null`
- `onSupportProposalRejectedForRedraft(db, row, reason, now): Promise<boolean>` — RETURNS whether its `awaiting_approval`-guarded re-arm matched a row (for the atomic fallback; see Task 5/8/9).
- `resolveRejectAction(p): RejectResolution` where `RejectResolution = { kind: 'redraft' } | { kind: 'escalate_terminal' } | { kind: 'escalate_limit' }`
- New module `apps/ops/src/support/redraft.ts` exports `SUPPORT_REDRAFT_MAX`, `clearRedraftCycle`, `resolveRejectAction`, `RejectResolution` (pure; DB-touching `onSupportProposalRejectedForRedraft` stays in `support-decision.ts` and imports from here).
- `SUPPORT_REDRAFT_MAX = 2` — MUST satisfy `1 + SUPPORT_REDRAFT_MAX ≤ SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY` (currently 3), because each redraft is an agent run counted against that daily per-ticket cap (immutable audit rows a re-arm cannot reset). MAX=3 collides with the cap → escalates a cycle early with the wrong reason. Document the relationship at both constants.
- `clearRedraftCycle(): { ownerRedraftFeedback: null; redraftCount: 0 }` — spread into EVERY `.set(...)` that transitions a ticket out of the redraft-eligible cycle (see Task 7's full site list), beside the existing `escalationNotifiedAt: null` convention.
- Audit actions: `'proposal.rejected_for_redraft'`, `'settings.support_guidance_updated'`
- Escalation reasons: `'redraft_limit_reached'` (cap, paging), `'redraft_unfulfilled'` (a redraft-resume returned `no_action`, paging — never silently strand)
- System-prompt section header: `## Owner operating guidance (AUTHORITATIVE — overrides the public store policy wherever they conflict)`
- Per-run section header: `## Owner feedback on your previous draft (AUTHORITATIVE — follow it exactly)`

---

## File Structure

- `packages/db/src/schema.ts` — add two `support_tickets` columns (Task 1).
- `packages/db/migrations/0007_*.sql` — generated migration (Task 1).
- `apps/ops/src/settings.ts` — string-valued setting support + new default (Task 2).
- `apps/ops/src/agents/support-run.ts` — `buildSupportSystemPrompt(guidance)`, `SupportRunContext` fields, prompt sections (Tasks 3, 6).
- `apps/ops/src/jobs/support-agent-run.ts` — `buildContext` reads guidance + feedback; afc-cap clears (Tasks 3, 6, 7).
- `apps/ops/src/http/admin/routes.ts` — guidance page; admin reject dispatch; transition clears (Tasks 4, 7, 9).
- `apps/ops/src/http/admin/render-proposal.ts` — admin reject reason form (Task 9).
- `apps/ops/src/proposals/support-decision.ts` — redraft decision core, cap, clears (Task 5).
- `apps/ops/src/proposals/apply-support-reply.ts` — completeSend clears (Task 7).
- `apps/ops/src/http/actions.ts` — public reason form + body parse + dispatch (Task 8).

---

### Task 1: Migration 0007 + schema columns

**Files:**
- Modify: `packages/db/src/schema.ts:139-167` (`supportTickets` block)
- Create: `packages/db/migrations/0007_*.sql` (generated)
- Test: `apps/ops/test/support-guidance-redraft.test.ts` (new file, grows across tasks)

**Interfaces:**
- Produces: `supportTickets.ownerRedraftFeedback` (`text`, nullable) and `supportTickets.redraftCount` (`integer`, not null, default 0). `LockedTicket = typeof supportTickets.$inferSelect` picks both up automatically.

- [ ] **Step 1: Add the columns.** In `schema.ts`, inside the `supportTickets` `pgTable`, immediately after `agentFailureCount: integer('agent_failure_count').notNull().default(0),`:

```ts
  // Reject-with-reason re-draft loop (spec §3): the owner's latest rejection instruction for the
  // agent's next resumed run, and how many re-draft cycles this draft has been through (caps at
  // SUPPORT_REDRAFT_MAX). Both cleared/reset when the ticket leaves the cycle (apply/escalate/resolve).
  ownerRedraftFeedback: text('owner_redraft_feedback'),
  redraftCount: integer('redraft_count').notNull().default(0),
```

- [ ] **Step 2: Generate the migration.** Run: `pnpm --filter @doge-buddy/db generate`. Expected: a new `packages/db/migrations/0007_*.sql` adding both columns (`ALTER TABLE "support_tickets" ADD COLUMN ...`). Inspect it — it must ONLY touch `support_tickets` (two ADD COLUMNs). If it proposes anything else, stop and reconcile (do not hand-edit generated SQL).

- [ ] **Step 3: Apply locally.** Run: `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate`. Expected: `migrations applied`.

- [ ] **Step 4: Write the failing test.** Create `apps/ops/test/support-guidance-redraft.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getDb } from './helpers/db.ts' // use the repo's existing test-db helper; match a sibling test's import
import { sql } from 'drizzle-orm'

describe('migration 0007: support_tickets redraft columns', () => {
  it('adds owner_redraft_feedback and redraft_count with correct defaults', async () => {
    const { db } = getDb()
    const { rows } = await db.execute(sql`
      select column_name, data_type, column_default, is_nullable
      from information_schema.columns
      where table_name = 'support_tickets'
        and column_name in ('owner_redraft_feedback', 'redraft_count')
      order by column_name`)
    const byName = Object.fromEntries((rows as any[]).map((r) => [r.column_name, r]))
    expect(byName['owner_redraft_feedback'].is_nullable).toBe('YES')
    expect(byName['redraft_count'].data_type).toBe('integer')
    expect(byName['redraft_count'].is_nullable).toBe('NO')
    expect(String(byName['redraft_count'].column_default)).toContain('0')
  })
})
```

Note: before writing, open one existing `apps/ops/test/*.test.ts` that hits the DB and copy its exact db-helper import and setup (the repo already has one — `support-agent-run.test.ts` or `support-run.test.ts`). Use that helper rather than the placeholder import above.

- [ ] **Step 5: Run the test.** `DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/ops exec vitest run test/support-guidance-redraft.test.ts`. Expected: PASS (columns exist after Step 3).

- [ ] **Step 6: Typecheck + commit.** `pnpm typecheck` (0 errors), then:

```bash
git add packages/db/src/schema.ts packages/db/migrations apps/ops/test/support-guidance-redraft.test.ts
git commit -m "feat(support): migration 0007 — owner_redraft_feedback + redraft_count"
```

---

### Task 2: String-valued setting `support.agent_guidance` (+ generic settings-catalog integration)

**Files:**
- Modify: `apps/ops/src/settings.ts`
- Modify: `apps/ops/src/http/admin/routes.ts` (`settingKind`, `SettingRow`/`setSettingValue`/`renderSettingRow`, the GET/POST `/admin/settings` catalog loop)
- Test: `apps/ops/test/support-guidance-redraft.test.ts` + the existing admin settings-page test

**Interfaces:**
- Produces: `SETTINGS_DEFAULTS['support.agent_guidance'] = ''`; `createSettings(db).get('support.agent_guidance')` returns `string`; `.set('support.agent_guidance', string)` accepts a string.

**PANEL FINDING (correctness/money/completeness — 3 lenses): the generic `/admin/settings` page breaks.** It iterates `Object.keys(SETTINGS_DEFAULTS)` through `settingKind()` (`routes.ts:~96`), which buckets any non-boolean, non-`.mode` key as `'number'`. A naive add would render guidance as `<input type="number">`, let a save coerce it to a number, then crash every support run at `guidance.trim()`; it also breaks `SettingRow.value`'s type (a typecheck failure `pnpm typecheck` will catch). This task MUST also: give `settingKind` a `'string'` bucket; widen `SettingRow.value` + `setSettingValue` with a `string` arm; and EXCLUDE string-valued keys from the generic `/admin/settings` catalog (guidance is edited ONLY via `/admin/guidance`, Task 4).

- [ ] **Step 1: Add the default.** In `settings.ts`, add to `SETTINGS_DEFAULTS` (after the scoring keys):

```ts
  'support.agent_guidance': '',
```

- [ ] **Step 2: Add the string-key type mapping.** Below the existing `ModeSettingKey` type, add:

```ts
type StringSettingKey = 'support.agent_guidance'
```

Then change `SettingValue` to map string keys → `string`:

```ts
export type SettingValue<K extends SettingKey> = K extends BooleanSettingKey
  ? boolean
  : K extends ModeSettingKey
    ? WorkflowMode
    : K extends StringSettingKey
      ? string
      : number
```

- [ ] **Step 2b: Integrate with the generic settings catalog (`apps/ops/src/http/admin/routes.ts`).** This is mandatory — skipping it breaks the page and can crash every support run.
  - Widen `type SettingKind = 'boolean' | 'mode' | 'number' | 'string'`.
  - `settingKind`: add `if (typeof def === 'string' && !key.endsWith('.mode')) return 'string'` BEFORE the final `return 'number'` (mode keys have string defaults too, so keep the `.mode` check first):

    ```ts
    function settingKind(key: SettingKey): SettingKind {
      const def = SETTINGS_DEFAULTS[key]
      if (typeof def === 'boolean') return 'boolean'
      if (key.endsWith('.mode')) return 'mode'
      if (typeof def === 'string') return 'string'
      return 'number'
    }
    ```
  - Widen `SettingRow.value` and `setSettingValue`'s `value` param to `boolean | WorkflowMode | number | string`, and add a `case 'string':` to `setSettingValue` (a `settingsApi.set as (k, v: string) => Promise<void>` setter). This keeps types sound now that `get(key)` over the union can yield `string`.
  - EXCLUDE string keys from the generic catalog: in the GET `/admin/settings` loop that builds `SettingRow`s from `Object.keys(SETTINGS_DEFAULTS)`, filter out keys where `settingKind(key) === 'string'` (they are edited only via `/admin/guidance`). In the POST `/admin/settings` handler, reject a `key` whose `settingKind` is `'string'` (return the existing invalid-key page) so it can never be written through the numeric path.
  - `renderSettingRow` needs no `'string'` branch since string keys are filtered out — but add a defensive `default`/throw so a future string key can't silently render as a number.

- [ ] **Step 3: Write the failing test** (append to `support-guidance-redraft.test.ts`):

```ts
import { createSettings } from '../src/settings.ts'

describe('settings: support.agent_guidance', () => {
  it('defaults to empty string and round-trips a string', async () => {
    const { db } = getDb()
    const settings = createSettings(db)
    expect(await settings.get('support.agent_guidance')).toBe('')
    await settings.set('support.agent_guidance', 'No returns just because the dog disliked it.')
    expect(await settings.get('support.agent_guidance')).toBe('No returns just because the dog disliked it.')
  })
})
```

- [ ] **Step 4: Run** the test (same vitest command as Task 1 Step 5). Expected: PASS.

- [ ] **Step 4b: Catalog regression test.** In the existing admin settings-page test (find it via `grep -rl "admin/settings" apps/ops/test`), assert that with `support.agent_guidance` present in `SETTINGS_DEFAULTS`: (a) `GET /admin/settings` does NOT render a control for `support.agent_guidance` (it is filtered out), and (b) `POST /admin/settings` with `key=support.agent_guidance` is rejected (invalid-key page) and does not change the stored value. If no such test file exists, add these assertions to `support-guidance-redraft.test.ts`.

- [ ] **Step 5: Typecheck.** `pnpm typecheck` — 0 errors (the widened `SettingKind`/`SettingRow.value`/`setSettingValue` must satisfy the `/admin/settings` call sites — a naive additive type change alone FAILS here, per the panel).

- [ ] **Step 6: Commit.**

```bash
git add apps/ops/src/settings.ts apps/ops/test/support-guidance-redraft.test.ts
git commit -m "feat(support): string-valued setting support.agent_guidance"
```

---

### Task 3: Owner guidance in the agent system prompt

**Files:**
- Modify: `apps/ops/src/agents/support-run.ts` (`buildSupportSystemPrompt`, `SupportRunContext`, `runSupportAgent:235`)
- Modify: `apps/ops/src/jobs/support-agent-run.ts` (`buildContext:994` + its caller near line 305)
- Test: `apps/ops/test/support-run.test.ts`

**Interfaces:**
- Consumes: setting `support.agent_guidance` (Task 2).
- Produces: `buildSupportSystemPrompt(guidance: string): string`; `SupportRunContext.ownerGuidance: string`.

- [ ] **Step 1: Write the failing test** (`support-run.test.ts`):

```ts
import { buildSupportSystemPrompt } from '../src/agents/support-run.ts'

describe('buildSupportSystemPrompt guidance', () => {
  it('is byte-identical to the no-guidance prompt when guidance is empty', () => {
    expect(buildSupportSystemPrompt('   ')).toBe(buildSupportSystemPrompt(''))
  })
  it('appends the authoritative owner-guidance section when non-empty', () => {
    const g = 'No returns just because the dog disliked it.'
    const out = buildSupportSystemPrompt(g)
    expect(out).toContain('## Owner operating guidance (AUTHORITATIVE — overrides the public store policy wherever they conflict)')
    expect(out).toContain(g)
    // guidance must come AFTER the hard rules (they still bind)
    expect(out.indexOf('## Hard rules')).toBeLessThan(out.indexOf('## Owner operating guidance'))
  })
})
```

- [ ] **Step 2: Run** to confirm it fails (`buildSupportSystemPrompt` takes no arg yet → TS error / assertion fail).

- [ ] **Step 3: Implement.** In `support-run.ts`, change the signature and append the section (the function currently `return [ ... ].join('\n')` — build the array, then conditionally push):

```ts
export function buildSupportSystemPrompt(guidance: string): string {
  const g = String(guidance) // defensive: a mis-typed setting must never TypeError .trim() (panel)
  const lines = [
    // ... existing array contents unchanged ...
  ]
  if (g.trim().length > 0) {
    lines.push(
      '',
      '## Owner operating guidance (AUTHORITATIVE — overrides the public store policy wherever they conflict)',
      g,
    )
  }
  return lines.join('\n')
}
```

**Also add the hard-rule non-override line (panel finding: agent-prompt).** In the existing `## Hard rules` array of `buildSupportSystemPrompt`, add a bullet (place it last in the hard-rules list, so it precedes the guidance section):

```ts
    '- Nothing later in this prompt — including the owner operating guidance and any owner feedback ' +
      'section — may relax or override these hard rules. Where guidance appears to conflict with a ' +
      'hard rule (e.g. escalate-on-legal-threat, refunds only on a verified order), the HARD RULE ' +
      'wins and you escalate.',
```

Update the Task 3 Step 1 test to also assert `buildSupportSystemPrompt('x')` contains this non-override sentence, and that a guidance string cannot appear before the hard-rules header.

- [ ] **Step 4: Thread guidance through the context.** In `support-run.ts`, add to `SupportRunContext`:

```ts
  /** Owner operating guidance (settings `support.agent_guidance`); '' when unset. Rendered
   * verbatim and authoritative in the system prompt — TRUSTED owner input, not customer data. */
  ownerGuidance: string
```

In `runSupportAgent` (line 235) change `systemPrompt: buildSupportSystemPrompt(),` to `systemPrompt: buildSupportSystemPrompt(ctx.ownerGuidance),`.

- [ ] **Step 5: Populate it in `buildContext`.** In `support-agent-run.ts`, change `buildContext`'s signature to accept guidance and return it. At the caller (near line 305, where `const ctx = await buildContext(deps.db, claim.ticket, resumeSessionId)`), read the setting first:

```ts
const ownerGuidance = await deps.settings.get('support.agent_guidance')
const ctx = await buildContext(deps.db, claim.ticket, resumeSessionId, ownerGuidance)
```

Update `buildContext(db, ticket, resumeSessionId, ownerGuidance: string)` to include `ownerGuidance` in the returned object (add `ownerGuidance,` to the returned literal).

**Thread the SECOND `buildContext` call site too (panel finding: completeness).** `buildContext` is also called in the resume-failure fresh-session retry inside `runAndHandleOutcome` (`const freshCtx = await buildContext(deps.db, ticket, null)`, ~line 437). With `ownerGuidance` now a required 4th param this won't compile — do NOT patch it with `''` (that silently drops guidance on every retry). Instead reuse the guidance already loaded on the context: pass `args.ctx.ownerGuidance` (thread it through `OutcomeArgs` if that scope lacks `ctx`). Add a test asserting the resume-failure retry still carries non-empty guidance.

- [ ] **Step 6: Run + typecheck.** `vitest run test/support-run.test.ts` (PASS) and `pnpm typecheck` (0). Fix any other `buildSupportSystemPrompt()` / `buildContext(` call sites the compiler flags (there should be exactly the ones above; tests that call `buildSupportSystemPrompt()` must pass `''`).

- [ ] **Step 7: Commit.**

```bash
git add apps/ops/src/agents/support-run.ts apps/ops/src/jobs/support-agent-run.ts apps/ops/test/support-run.test.ts
git commit -m "feat(support): owner guidance appended to agent system prompt"
```

---

### Task 4: Admin guidance edit page

**Files:**
- Modify: `apps/ops/src/http/admin/routes.ts` (add `GET`/`POST /admin/guidance`, nav link)
- Test: `apps/ops/test/admin-guidance.test.ts` (new; model it on the existing admin route test — find it via `grep -rl "authed" apps/ops/test`)

**Interfaces:**
- Consumes: `createSettings(deps.db)`, the `authed`, `layout`, `html`, `safeHandle` helpers already in `routes.ts`.
- Produces: routes `GET /admin/guidance`, `POST /admin/guidance`; audit `settings.support_guidance_updated`.

- [ ] **Step 1: Write the failing test.** Model setup on the existing admin-routes test (same Fastify app builder + session cookie helper). Assertions:

```ts
// GET renders current value
// - seed settings 'support.agent_guidance' = 'existing rule'
// - GET /admin/guidance (authed) → 200, body contains 'existing rule' and a <textarea
// POST saves + audits
// - POST /admin/guidance (authed) form body guidance='new rule' → 303 or 200
// - settings.get('support.agent_guidance') === 'new rule'
// - one audit_log row action='settings.support_guidance_updated'
// length bound
// - POST with guidance of 8001 chars → 400, setting unchanged
```

Write these as three `it(...)` blocks using the test app + authed cookie, mirroring the existing admin test's request helper.

- [ ] **Step 2: Run** → fails (routes 404).

- [ ] **Step 3: Implement the GET.** In `routes.ts`, alongside the other `authed.get('/admin/...')` handlers:

```ts
authed.get('/admin/guidance', async (_request, reply) => {
  return safeHandle('guidance', reply, async () => {
    const settings = createSettings(deps.db)
    const current = await settings.get('support.agent_guidance')
    return reply.code(200).type('text/html; charset=utf-8').send(
      layout('Agent guidance', html`
        <h1>Support agent operating guidance</h1>
        <p>Authoritative for the agent — overrides the public store policy where they conflict. Max 8000 characters.</p>
        <form method="post" action="/admin/guidance">
          <textarea name="guidance" rows="18" cols="90">${current}</textarea>
          <div><button type="submit">Save</button></div>
        </form>`),
    )
  })
})
```

(Confirm `createSettings` is imported in `routes.ts`; if not, add `import { createSettings } from '../../settings.ts'`. Confirm `html` auto-escapes interpolations — it does for the ticket views; `${current}` in a textarea is safe text.)

- [ ] **Step 4: Implement the POST.**

```ts
authed.post('/admin/guidance', async (request, reply) => {
  return safeHandle('guidance', reply, async () => {
    const { guidance } = (request.body ?? {}) as { guidance?: string }
    const value = typeof guidance === 'string' ? guidance : ''
    if (value.length > 8000) {
      return reply.code(400).type('text/html; charset=utf-8')
        .send(layout('Agent guidance', html`<p>Too long (${String(value.length)} chars; max 8000). Not saved.</p>`))
    }
    const settings = createSettings(deps.db)
    const previous = await settings.get('support.agent_guidance')
    await settings.set('support.agent_guidance', value)
    await deps.db.insert(auditLog).values({
      actor: 'owner',
      action: 'settings.support_guidance_updated',
      entityType: 'settings',
      entityId: 'support.agent_guidance',
      detail: { newLength: value.length, previousLength: previous.length },
    })
    return reply.code(303).header('location', '/admin/guidance').send()
  })
})
```

- [ ] **Step 5: Add a nav link.** Find the admin index/nav render (the `/admin` landing or the shared `layout` header) and add a link to `/admin/guidance` (mirror how existing links like `/admin/runs` are listed).

- [ ] **Step 6: Run + typecheck.** `vitest run test/admin-guidance.test.ts` (PASS), `pnpm typecheck` (0). Confirm the admin POST body parser accepts `application/x-www-form-urlencoded` (the admin plugin already handles form posts for existing decision routes — verify a sibling POST test passes a form body the same way).

- [ ] **Step 7: Commit.**

```bash
git add apps/ops/src/http/admin/routes.ts apps/ops/test/admin-guidance.test.ts
git commit -m "feat(support): admin page to edit agent operating guidance"
```

---

### Task 5: Re-draft decision core (redraft.ts + support-decision.ts)

**Files:**
- Create: `apps/ops/src/support/redraft.ts` (pure helpers: `SUPPORT_REDRAFT_MAX`, `clearRedraftCycle`, `resolveRejectAction`, `RejectResolution`)
- Modify: `apps/ops/src/proposals/support-decision.ts` (DB: `onSupportProposalRejectedForRedraft`, `onSupportProposalRejected` opts + clears)
- Test: `apps/ops/test/redraft.test.ts` (pure) + `apps/ops/test/support-decision.test.ts` (DB, extend)

**Interfaces:**
- Produces (redraft.ts): `SUPPORT_REDRAFT_MAX = 2`, `clearRedraftCycle()`, `resolveRejectAction`, `RejectResolution`.
- Produces (support-decision.ts): `onSupportProposalRejectedForRedraft(...) → Promise<boolean>` (matched?), and an `opts` param on `onSupportProposalRejected`.

**PANEL FINDINGS folded in:** cap=2 (reconcile with the daily run cap); `onSupportProposalRejectedForRedraft` returns whether its guarded re-arm matched (atomic fallback in Tasks 8/9); `onSupportProposalRejected` clears via `clearRedraftCycle()`.

- [ ] **Step 1: Write failing tests** (`support-decision.test.ts`). Cover the decision matrix and the re-arm writes (use the DB helper; seed a ticket + a pending support_reply + a pending sibling refund):

```ts
import { resolveRejectAction, SUPPORT_REDRAFT_MAX } from '../src/support/redraft.ts'
import { onSupportProposalRejectedForRedraft } from '../src/proposals/support-decision.ts'

describe('resolveRejectAction', () => {
  const base = { reason: 'x', action: 'redraft', redraftCount: 0, ticketStatus: 'awaiting_approval' }
  it('redrafts when reason present, action=redraft, awaiting_approval, under cap', () =>
    expect(resolveRejectAction(base)).toEqual({ kind: 'redraft' }))
  it('escalate_terminal when reason blank', () =>
    expect(resolveRejectAction({ ...base, reason: '  ' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_terminal when action != redraft', () =>
    expect(resolveRejectAction({ ...base, action: 'escalate' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_terminal when ticket not awaiting_approval', () =>
    expect(resolveRejectAction({ ...base, ticketStatus: 'waiting_on_customer' })).toEqual({ kind: 'escalate_terminal' }))
  it('escalate_limit at the cap', () =>
    expect(resolveRejectAction({ ...base, redraftCount: SUPPORT_REDRAFT_MAX })).toEqual({ kind: 'escalate_limit' }))
})

describe('onSupportProposalRejectedForRedraft', () => {
  it('expires the sibling, stores feedback, re-arms triaged, keeps session, nulls run watermark, keeps prompted watermark', async () => {
    // seed: ticket awaiting_approval, agentSessionId='sess-1', lastAgentPromptedAt=T,
    //       lastAgentRunAt=T, redraftCount=0; a pending support_reply row + pending refund sibling
    // act: onSupportProposalRejectedForRedraft(db, {id: replyId, ticketId, type: 'support_reply'}, 'no returns for dislike', () => new Date())
    // assert ticket row:
    //   status='triaged', ownerRedraftFeedback='no returns for dislike', redraftCount=1,
    //   lastAgentRunAt=null, lastAgentFinishedAt=null, agentFailureCount=0,
    //   lastAgentPromptedAt=T (unchanged), agentSessionId='sess-1' (unchanged)
    // assert sibling refund row: status='expired'; one audit 'proposal.sibling_rejected'
    // assert one audit 'proposal.rejected_for_redraft' with detail.redraft_count=1
  })
})
```

Fill in the seed/asserts using the file's existing seeding helpers (this test file already seeds tickets+proposals for the `onSupportProposalRejected` tests — reuse them).

- [ ] **Step 2: Run** → fails (symbols undefined).

- [ ] **Step 3: Create `apps/ops/src/support/redraft.ts`** (pure helpers, no DB):

```ts
// SUPPORT_REDRAFT_MAX MUST satisfy 1 + SUPPORT_REDRAFT_MAX <= SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY
// (jobs/support-agent-run.ts, currently 3): each redraft is an agent run counted against that
// immutable daily per-ticket cap, which a re-arm cannot reset. MAX=3 collided with the cap and
// escalated a cycle early with the wrong reason (panel finding). MAX=2 => original draft + 2
// redraft runs = 3 runs = the cap, and the redraft_limit_reached terminal path stays reachable.
export const SUPPORT_REDRAFT_MAX = 2

/** Spread into EVERY `.set(...)` that transitions a ticket out of the redraft-eligible cycle, beside
 * the existing `escalationNotifiedAt: null` convention — see Task 7's full site list. Leaving these
 * stale re-feeds the agent a dead, authoritative correction on a later run (panel finding). */
export function clearRedraftCycle(): { ownerRedraftFeedback: null; redraftCount: 0 } {
  return { ownerRedraftFeedback: null, redraftCount: 0 }
}

export type RejectResolution = { kind: 'redraft' } | { kind: 'escalate_terminal' } | { kind: 'escalate_limit' }

/** Pure decision shared by both reject surfaces so they never diverge. */
export function resolveRejectAction(p: {
  reason: string
  action: string
  redraftCount: number
  ticketStatus: string
}): RejectResolution {
  if (p.reason.trim().length === 0 || p.action !== 'redraft') return { kind: 'escalate_terminal' }
  if (p.ticketStatus !== 'awaiting_approval') return { kind: 'escalate_terminal' }
  if (p.redraftCount >= SUPPORT_REDRAFT_MAX) return { kind: 'escalate_limit' }
  return { kind: 'redraft' }
}
```

`support-decision.ts` imports `resolveRejectAction`/`clearRedraftCycle` from `../support/redraft.ts`. Put the `resolveRejectAction` unit tests in `apps/ops/test/redraft.test.ts` (the matrix from Step 1). Also add `SUPPORT_AGENT_MAX_RUNS_PER_TICKET_PER_DAY`'s doc comment (in `support-agent-run.ts`) noting the `1 + SUPPORT_REDRAFT_MAX` relationship.

- [ ] **Step 4: Add `onSupportProposalRejectedForRedraft`.** In the same file, mirroring `onSupportProposalRejected`'s sibling-expiry + guarded-update shape:

```ts
/**
 * Reject-with-reason (spec §3): instead of escalating, hand the ticket back to the agent. Expires
 * the sibling proposal (the agent reconsiders the whole response), stores the owner's correction,
 * and re-arms the ticket for a resumed re-draft run — KEEPING agentSessionId (resume) and
 * last_agent_prompted_at (so the resume's message filter yields zero new thread messages; the
 * feedback is the run's substantive input). Nulls last_agent_run_at so selectAndEnqueueAgentRuns
 * picks it up. Guarded on `awaiting_approval` — a re-draft against any other status is a no-op
 * (caller resolves that to a terminal escalate). Atomic via the caller's `tx`.
 */
export async function onSupportProposalRejectedForRedraft(
  db: DbOrTx,
  row: { id: string; ticketId: string | null; type: string },
  reason: string,
  now: () => Date,
): Promise<boolean> {
  if (row.ticketId === null || !isSupportProposalType(row.type)) return false
  const ticketId = row.ticketId
  const siblingType = SIBLING_TYPE[row.type]

  const expiredSiblings = await db
    .update(proposals)
    .set({ status: 'expired' })
    .where(and(eq(proposals.ticketId, ticketId), eq(proposals.type, siblingType), eq(proposals.status, 'pending')))
    .returning({ id: proposals.id })
  if (expiredSiblings.length > 0) {
    await db.insert(auditLog).values(
      expiredSiblings.map((s) => ({
        actor: 'system', action: 'proposal.sibling_rejected', entityType: 'proposal', entityId: s.id,
        detail: { ticketId, rejectedProposalId: row.id, rejectedType: row.type, viaRedraft: true },
      })),
    )
  }

  const rearmed = await db
    .update(supportTickets)
    .set({
      status: 'triaged',
      ownerRedraftFeedback: reason,
      redraftCount: sql`${supportTickets.redraftCount} + 1`,
      agentFailureCount: 0,
      lastAgentRunAt: null,
      lastAgentFinishedAt: null,
      // KEEP agentSessionId (resume) and lastAgentPromptedAt (zero-new-message resume filter).
    })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'awaiting_approval')))
    .returning({ redraftCount: supportTickets.redraftCount })

  if (rearmed.length > 0) {
    await db.insert(auditLog).values({
      actor: 'owner', action: 'proposal.rejected_for_redraft', entityType: 'support_ticket', entityId: ticketId,
      detail: { rejectedProposalId: row.id, rejectedType: row.type, reason_len: reason.length, redraft_count: rearmed[0].redraftCount },
    })
  }
  return rearmed.length > 0 // false => caller falls back to onSupportProposalRejected in the SAME tx (atomic fallback)
}
```

Add `sql` to the drizzle imports if not present. NOTE: the sibling-expiry runs before the guarded re-arm; if the re-arm matches 0 rows, the caller's fallback still escalates the (already-sibling-expired) ticket — which is exactly the terminal outcome, so the early sibling-expiry is harmless.

- [ ] **Step 5: Parameterize `onSupportProposalRejected` for the cap + add clears.** Change its signature to accept optional `opts` and set the new columns null/0 in BOTH guarded updates:

```ts
export async function onSupportProposalRejected(
  db: DbOrTx,
  row: { id: string; ticketId: string | null; type: string },
  opts?: { awaitingApprovalReason?: string; awaitingApprovalNotify?: boolean },
): Promise<void> {
  // ... sibling expiry unchanged ...
  const awaitingReason = opts?.awaitingApprovalReason ?? 'owner_rejected_draft'
  const awaitingNotify = opts?.awaitingApprovalNotify ?? false // false = pre-stamped silent
  await db.update(supportTickets).set({
      status: 'escalated', escalationReason: awaitingReason,
      escalationNotifiedAt: awaitingNotify ? null : new Date(),
      agentSessionId: null, ...clearRedraftCycle(),
    }).where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'awaiting_approval')))
  // waiting_on_customer branch unchanged EXCEPT add the redraft clear:
  await db.update(supportTickets).set({
      status: 'escalated', escalationReason: 'refund_promise_unbacked', escalationNotifiedAt: null,
      agentSessionId: null, ...clearRedraftCycle(),
    }).where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'waiting_on_customer')))
}
```

Import `clearRedraftCycle` from `../support/redraft.ts`.

The `escalate_limit` path is then `onSupportProposalRejected(tx, row, { awaitingApprovalReason: 'redraft_limit_reached', awaitingApprovalNotify: true })` — paging, and it clears feedback/count like every terminal reject.

- [ ] **Step 6: Run + typecheck.** `vitest run test/support-decision.test.ts` (PASS), `pnpm typecheck` (0). Existing `onSupportProposalRejected` tests still pass (opts is optional; defaults reproduce old behavior + the harmless extra null/0 sets).

- [ ] **Step 7: Commit.**

```bash
git add apps/ops/src/proposals/support-decision.ts apps/ops/test/support-decision.test.ts
git commit -m "feat(support): reject-with-reason decision core + cap + terminal clears"
```

---

### Task 6: Owner feedback in the per-run prompt

**Files:**
- Modify: `apps/ops/src/agents/support-run.ts` (`SupportRunContext.ticket`, `buildSupportPrompt`)
- Modify: `apps/ops/src/jobs/support-agent-run.ts` (`buildContext` ticket literal)
- Test: `apps/ops/test/support-run.test.ts`

**Interfaces:**
- Consumes: `supportTickets.ownerRedraftFeedback` (Task 1).
- Produces: `SupportRunContext.ticket.ownerRedraftFeedback: string | null`; a prompt section.

- [ ] **Step 1: Write the failing test** (`support-run.test.ts`). Build a minimal `SupportRunContext` (copy the shape an existing `buildSupportPrompt` test uses) and assert:

```ts
it('renders the owner-feedback section verbatim when present', () => {
  const ctx = makeCtx({ ownerRedraftFeedback: 'Decline: we do not accept returns for "dog disliked it".' })
  const out = buildSupportPrompt(ctx)
  expect(out).toContain('## Owner feedback on your previous draft (AUTHORITATIVE — follow it exactly)')
  expect(out).toContain('Decline: we do not accept returns for "dog disliked it".')
})
it('omits the section when feedback is null', () => {
  const out = buildSupportPrompt(makeCtx({ ownerRedraftFeedback: null }))
  expect(out).not.toContain('## Owner feedback on your previous draft')
})
```

(`makeCtx` = a small helper in the test that fills the required `SupportRunContext` fields, setting `ticket.ownerRedraftFeedback`. Add `ownerRedraftFeedback` to whatever ticket fixture the existing tests already use.)

- [ ] **Step 2: Run** → fails (field/section missing).

- [ ] **Step 3: Add the field** to `SupportRunContext.ticket` in `support-run.ts`:

```ts
    escalationReason: string | null
    ownerRedraftFeedback: string | null
```

- [ ] **Step 4: Render the section** in `buildSupportPrompt`, immediately AFTER the prior-proposals block (`lines.push('', '## Prior support proposals for this ticket', ...)`) and BEFORE the message-thread block:

```ts
if (ticket.ownerRedraftFeedback && ticket.ownerRedraftFeedback.trim().length > 0) {
  lines.push(
    '',
    '## Owner feedback on your previous draft (AUTHORITATIVE — follow it exactly)',
    'The owner reviewed your last proposed reply and REJECTED it with this instruction. It overrides ' +
      'your prior reasoning and the public store policy wherever they conflict (but NOT the hard rules ' +
      'above). Re-draft your response to comply; do not repeat the rejected approach. You MUST either ' +
      'propose a re-drafted reply or escalate — do NOT take no_action.',
    ticket.ownerRedraftFeedback,
  )
}
```

- [ ] **Step 5: Populate it in `buildContext`** (`support-agent-run.ts`) — add to the returned `ticket` literal:

```ts
      escalationReason: ticket.escalationReason,
      ownerRedraftFeedback: ticket.ownerRedraftFeedback,
```

- [ ] **Step 6: Run + typecheck.** `vitest run test/support-run.test.ts` (PASS), `pnpm typecheck` (0). Fix any `SupportRunContext` fixtures the compiler flags (add `ownerRedraftFeedback` to them).

- [ ] **Step 7: Commit.**

```bash
git add apps/ops/src/agents/support-run.ts apps/ops/src/jobs/support-agent-run.ts apps/ops/test/support-run.test.ts
git commit -m "feat(support): owner re-draft feedback rendered into the per-run prompt"
```

---

### Task 7: Feedback/count lifecycle — clear at EVERY exit + no_action-strand fix

**PANEL FINDINGS (5 lenses + 1 blocker):** the original 3-clear-point list was grossly incomplete, and a `no_action` result on a redraft-resume strands the ticket forever. This task enforces the invariant — *every write that transitions a ticket out of the redraft-eligible cycle clears both columns* — via the shared `clearRedraftCycle()` spread, AND upgrades a `no_action` redraft-resume to a paging escalate.

**Files:**
- Modify: `apps/ops/src/proposals/apply-support-reply.ts` (`completeSend` — BOTH the `waiting_on_customer` flip AND the hand-back-to-`triaged` branch)
- Modify: `apps/ops/src/http/admin/routes.ts` (`TICKET_TRANSITIONS` `.set`)
- Modify: `apps/ops/src/jobs/support-agent-run.ts` (afc-cap/stuck `agent_failed` escalates; the agent's own `escalate` OUTCOME in `runAndHandleOutcome`; `escalateRunCapped`; the `no_action` branch)
- Modify: `apps/ops/src/support/agent-select.ts` (`escalateOrphans`, `escalateUnbackedRefundPromises`)
- Modify: `apps/ops/src/support/ingest.ts` (the tripwire escalate)
- Modify: `apps/ops/src/proposals/run-apply.ts` (`deadLetterApplyProposal` `apply_failed`)
- Test: `apps/ops/test/support-guidance-redraft.test.ts`

**Interfaces:**
- Consumes: `clearRedraftCycle` (Task 5), `supportTickets.ownerRedraftFeedback`/`.redraftCount`, `SupportRunContext.ticket.ownerRedraftFeedback` (Task 6).

- [ ] **Step 1: Write failing tests.** Seed a ticket with `ownerRedraftFeedback='x'`, `redraftCount=1`, drive each transition, assert both columns clear:
  - admin `POST /admin/tickets/:id/escalate` and `/resolve` clear both.
  - completeSend `waiting_on_customer` flip clears (focused apply test).
  - the ingest tripwire escalate clears (feed a trigger-word inbound to a triaged ticket with feedback set).
  - the agent `escalate` OUTCOME clears (stub the run to emit `escalate`).
  - **`no_action` on a redraft-resume ⇒ the ticket ESCALATES (`redraft_unfulfilled`, paging) and clears** (stub the resumed run to emit `no_action` with `ownerRedraftFeedback` set on the ctx; assert `status='escalated'`, `escalationReason='redraft_unfulfilled'`, `escalationNotifiedAt` NULL, both columns cleared — NOT left in `triaged`).

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Apply `clearRedraftCycle()` at every exit site.** Spread `...clearRedraftCycle()` into each `.set(...)` below (import from `../support/redraft.ts` / relative path). Place it beside the existing `escalationNotifiedAt: null` in each, and add a one-line comment `// redraft-cycle clear (see support/redraft.ts) — keep beside escalationNotifiedAt`:
  - `apply-support-reply.ts` completeSend: the `waiting_on_customer` flip AND the hand-back-to-`triaged` branch (the 0-row-flip recovery).
  - `admin/routes.ts` `TICKET_TRANSITIONS`: `.set({ status: transition.to, ...clearRedraftCycle() })`.
  - `support-agent-run.ts`: the two `agent_failed` escalates; the agent's own `outcome === 'escalate'` branch in `runAndHandleOutcome`; `escalateRunCapped` (`agent_run_cap`).
  - `agent-select.ts`: `escalateOrphans` and `escalateUnbackedRefundPromises`.
  - `ingest.ts`: the tripwire escalate `.set`.
  - `run-apply.ts`: `deadLetterApplyProposal`'s `apply_failed` escalate `.set`.
  Also add a convention note next to `support_tickets`'s `escalationNotifiedAt` CRITICAL-1 comment (schema or the most-referenced escalate site) pointing future escalate-writers at `clearRedraftCycle()`.

- [ ] **Step 4: no_action-strand fix.** In `runAndHandleOutcome`'s `no_action` branch (`support-agent-run.ts`), when the run consumed owner feedback — `args.ctx.ticket.ownerRedraftFeedback` non-empty — do NOT take the normal no_action path. Instead escalate (paging), guarded on the ticket still being `triaged`:

```ts
// A redraft-resume that returns no_action would otherwise sit in `triaged` forever (never
// re-selected: last_agent_run_at stays set, no new inbound; not awaiting_approval so no orphan
// backstop) — silently swallowing the owner's correction. Upgrade to a paging escalate.
if (args.ctx.ticket.ownerRedraftFeedback && args.ctx.ticket.ownerRedraftFeedback.trim().length > 0) {
  await deps.db.update(supportTickets)
    .set({ status: 'escalated', escalationReason: 'redraft_unfulfilled', escalationNotifiedAt: null,
           agentSessionId: null, ...clearRedraftCycle() })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.status, 'triaged')))
  // ... then take the same "authoritative outcome recorded" bookkeeping the other outcomes use
  //     (agent_run audit / last_agent_finished_at) so the run is finalized, and RETURN.
}
```

Place this at the TOP of the no_action branch so it pre-empts the normal no_action handling. Confirm the surrounding finalization (finished-at stamp, spend audit) still runs for this path.

- [ ] **Step 5: Run + typecheck.** `vitest run test/support-guidance-redraft.test.ts` (PASS), `pnpm typecheck` (0). Re-run the existing support-agent-run, agent-select, apply-support-reply, ingest, and run-apply suites — the extra `...clearRedraftCycle()` on a ticket with no feedback set is a harmless null/0 write, so those must stay green.

- [ ] **Step 6: Commit.**

```bash
git add apps/ops/src/proposals/apply-support-reply.ts apps/ops/src/http/admin/routes.ts apps/ops/src/jobs/support-agent-run.ts apps/ops/src/support/agent-select.ts apps/ops/src/support/ingest.ts apps/ops/src/proposals/run-apply.ts apps/ops/test/support-guidance-redraft.test.ts
git commit -m "feat(support): clear redraft cycle at every ticket exit + no_action-resume escalate"
```

---

### Task 8: Public reject form — reason capture + dispatch (actions.ts)

**Files:**
- Modify: `apps/ops/src/http/actions.ts`
- Test: `apps/ops/test/actions.test.ts` (existing)

**Interfaces:**
- Consumes: `resolveRejectAction`, `onSupportProposalRejectedForRedraft`, `onSupportProposalRejected` (Task 5); the ticket's current `status` + `redraftCount` (fetch alongside the proposal).
- Produces: reason form on GET reject; POST reject dispatch.

- [ ] **Step 1: Write failing tests** (`actions.test.ts`, mirror existing cases):
  - GET `/a/:id/reject?t=<valid>` for a support_reply → body contains `<textarea name="reason"` and two submit buttons (`value="redraft"`, `value="escalate"`). (Approve GET unchanged.)
  - POST `/a/:id/reject?t=<valid>` with form body `reason=no+returns...&action=redraft`, ticket `awaiting_approval`, count 0 → ticket re-armed `triaged`, `ownerRedraftFeedback` set, proposal `rejected`. (Assert via DB.)
  - POST reject with `action=escalate` (or empty reason) → ticket `escalated` (terminal), as today.
  - POST reject with `reason` present but `redraftCount = SUPPORT_REDRAFT_MAX` → ticket `escalated`, reason `redraft_limit_reached`.
  - Reason > 2000 chars → the friendly/again page, ticket unchanged (refused).

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3: Parse the body.** The plugin currently registers a urlencoded parser that DISCARDS the body (lines ~114-120). Replace it with one that parses into an object so `request.body` carries `reason`/`action`:

```ts
fastify.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    try {
      const params = new URLSearchParams(body as string)
      done(null, Object.fromEntries(params.entries()))
    } catch (err) {
      done(err instanceof Error ? err : new Error('bad form body'), undefined)
    }
  },
)
```

(Approve's POST reads nothing from the body, so this is compatible — it just now populates `request.body` for reject.)

- [ ] **Step 4: Reason form on GET reject — SUPPORT TYPES ONLY.** The `/a/` route also serves sourcing/product proposals, whose reject must stay a plain single-button confirm. Gate the reason UI on the proposal type. Change `confirmPage` to take `isSupportReject` and `redraftCount`:

```ts
function confirmPage(
  proposalId: string, decision: Decision, summary: string, token: string,
  isSupportReject: boolean, redraftCount: number,
): string {
  const label = decision === 'approve' ? 'Approve' : 'Reject'
  const action = `/a/${proposalId}/${decision}?t=${encodeURIComponent(token)}`
  // Approve, and reject of a NON-support proposal (e.g. sourcing): unchanged single-button confirm.
  if (decision === 'approve' || !isSupportReject) {
    return page(`<p>${esc(summary)}</p><form method="post" action="${action}"><button type="submit">${label}</button></form>`)
  }
  const canRedraft = redraftCount < SUPPORT_REDRAFT_MAX
  return page(`
    <p>${esc(summary)}</p>
    <form method="post" action="${action}">
      <p><label>Reason for the agent (optional — leave blank to escalate to you):<br>
        <textarea name="reason" rows="6" cols="70" maxlength="2000"></textarea></label></p>
      ${canRedraft
        ? `<button type="submit" name="action" value="redraft">Re-draft with this reason</button> `
        : `<p>Re-drafted ${SUPPORT_REDRAFT_MAX}× already — rejecting again escalates to you.</p>`}
      <button type="submit" name="action" value="escalate">Just escalate to me</button>
    </form>`)
}
```

`handleGet` computes `isSupportReject = decision === 'reject' && (row.type === 'support_reply' || row.type === 'refund') && row.ticketId !== null`, and when true looks up the ticket's `redraftCount` (`select redraftCount from support_tickets where id = row.ticketId`); otherwise passes `false, 0`. Import `SUPPORT_REDRAFT_MAX` and `supportTickets`.

- [ ] **Step 5: Dispatch in `handlePost`.** In the `isSupportRejectDecision` branch, read `reason`/`action` from `request.body`, enforce the 2000-char bound, fetch the ticket's `status` + `redraftCount`, and dispatch:

```ts
// handlePost gains a `formBody` param (the parsed urlencoded body); the route passes request.body.
// Replace the fixed onSupportProposalRejected call for support rejects with:
const body = (formBody ?? {}) as { reason?: string; action?: string }
const rawReason = body.reason ?? ''
if (rawReason.length > 2000) return reasonTooLongPage() // readable refusal — NOT friendlyPage (panel: minor)
const reason = rawReason
const [ticket] = await deps.db.select({ status: supportTickets.status, redraftCount: supportTickets.redraftCount })
  .from(supportTickets).where(eq(supportTickets.id, row.ticketId!))
const resolution = resolveRejectAction({ reason, action: body.action ?? 'escalate', redraftCount: ticket?.redraftCount ?? 0, ticketStatus: ticket?.status ?? '' })
await deps.db.transaction(async (tx) => {
  await applyProposalTransition(tx, proposalId, 'pending', status, { decidedBy: 'owner', decidedAt: new Date(), actionTokenHash: null })
  await tx.insert(auditLog).values({ actor: 'owner', action: 'proposal.reject', entityType: 'proposal', entityId: proposalId, detail: { via: 'link', resolution: resolution.kind } })
  const r = { id: row.id, ticketId: row.ticketId, type: row.type }
  if (resolution.kind === 'redraft') {
    // ATOMIC FALLBACK (panel: correctness): if the guarded re-arm matched 0 rows (ticket left
    // awaiting_approval since the pre-tx read), escalate terminally in the SAME tx — never leave
    // the ticket rejected+sibling-expired but neither re-armed nor escalated.
    const rearmed = await onSupportProposalRejectedForRedraft(tx, r, reason, () => new Date())
    if (!rearmed) await onSupportProposalRejected(tx, r)
  } else if (resolution.kind === 'escalate_limit') {
    await onSupportProposalRejected(tx, r, { awaitingApprovalReason: 'redraft_limit_reached', awaitingApprovalNotify: true })
  } else {
    await onSupportProposalRejected(tx, r)
  }
})
```

Add a `reasonTooLongPage()` next to the other `page(...)` helpers: `page('<p>Reason too long (max 2000 characters) — nothing was changed. Go back and shorten it.</p>')`. Thread `request.body` into `handlePost` (add the `formBody` param; the reject POST route passes `request.body`, approve passes `undefined`). Add imports: `supportTickets`, `resolveRejectAction`, `onSupportProposalRejectedForRedraft`, `onSupportProposalRejected` (already imported), `SUPPORT_REDRAFT_MAX`. `handleGet` already closes over `deps` for the redraftCount lookup.

- [ ] **Step 6: Run + typecheck.** `vitest run test/actions.test.ts` (PASS), `pnpm typecheck` (0). Re-run existing actions cases (approve path, token reuse, expiry) to confirm no regression from the parser change.

- [ ] **Step 7: Commit.**

```bash
git add apps/ops/src/http/actions.ts apps/ops/test/actions.test.ts
git commit -m "feat(support): public reject form captures a reason and re-drafts"
```

---

### Task 9: Admin reject form — reason capture + dispatch (routes.ts + render-proposal.ts)

**Files:**
- Modify: `apps/ops/src/http/admin/render-proposal.ts` (`renderDecisionForms` — reject reason UI)
- Modify: `apps/ops/src/http/admin/routes.ts` (the `isSupportRejectDecision` branch, lines ~922-946)
- Test: `apps/ops/test/admin-*.test.ts` (the proposal-decision admin test)

**Interfaces:**
- Consumes: same Task 5 helpers; the ticket's `status` + `redraftCount`.
- Produces: admin reject dispatch identical to Task 8's public one.

- [ ] **Step 1: Write failing tests** mirroring Task 8's four DB assertions, but via `POST /admin/proposals/:id/reject` with a session cookie and form body `reason=...&action=redraft|escalate`.

- [ ] **Step 2: Run** → fails.

- [ ] **Step 3a: Thread redraftCount into the proposal view (panel: the "view already loads the ticket" premise is FALSE).** `loadProposalDetailExtras` (`routes.ts:~717`) returns `{}` for `support_reply` and, even for `refund`, does not include `redraftCount`/ticket status. Extend it (or add a small loader) to fetch the linked ticket's `redraftCount` + `status` for BOTH `support_reply` and `refund` proposals, add them to `ProposalDetailExtras`, and pass them to `renderDecisionForms`. `renderDecisionForms(p: ProposalRow)` currently has no ticket data — give it a `redraftCount` (default 0 when no ticket).

- [ ] **Step 3b: Admin reason form.** In `render-proposal.ts` `renderDecisionForms`, for `support_reply`/`refund` proposals, add to the reject form a `<textarea name="reason" maxlength="2000">` and two submit buttons (`name="action" value="redraft"` / `value="escalate"`), gated on `redraftCount < SUPPORT_REDRAFT_MAX` (from Step 3a). Use the same copy as Task 8.

- [ ] **Step 4: Admin dispatch.** In `routes.ts`, replace the fixed `onSupportProposalRejected(tx, ...)` call at line ~945 with the same `resolveRejectAction` dispatch as Task 8 Step 5 — INCLUDING the atomic fallback (`if (!await onSupportProposalRejectedForRedraft(tx, r, reason, now)) await onSupportProposalRejected(tx, r)`). Read `reason`/`action` from `request.body`; on `reason.length > 2000` return the existing 400 `layout` page (readable). Fetch ticket status+redraftCount. Keep the existing `edited` audit detail and add `resolution: resolution.kind`.

- [ ] **Step 5: Run + typecheck.** Admin decision tests PASS; `pnpm typecheck` 0. Confirm the existing admin reject (no reason) test still escalates.

- [ ] **Step 6: Commit.**

```bash
git add apps/ops/src/http/admin/render-proposal.ts apps/ops/src/http/admin/routes.ts apps/ops/test
git commit -m "feat(support): admin reject form captures a reason and re-drafts"
```

---

### Task 10: End-to-end — reject→re-draft→approve loop + guidance-affects-draft

**Files:**
- Test: `apps/ops/test/support-guidance-redraft.e2e.test.ts` (new; model on `support-agent.e2e.test.ts`)

**Interfaces:**
- Consumes: everything above. Uses the e2e's stubbed `queryFn` to make the agent emit a first draft, then (on resume) a corrected draft.

- [ ] **Step 1: Write the E2E.** Model setup + stubbed SDK on `support-agent.e2e.test.ts`. Assert the full loop:

```
1. Seed a triaged ticket with a linked/verified order (or a plain product question).
2. Run the agent (stub emits a `propose` reply). → proposal pending, ticket awaiting_approval.
3. POST reject with reason='decline: no returns for dislike', action=redraft (public or admin surface).
   → proposal rejected; ticket triaged; ownerRedraftFeedback set; redraftCount=1; agentSessionId kept.
4. Run selectAndEnqueueAgentRuns → the ticket is selected (last_agent_run_at is null).
5. Run the agent again (stub asserts the prompt CONTAINS the owner-feedback section verbatim; emits a
   corrected `propose` reply). → new proposal pending; ticket awaiting_approval.
6. Approve the new proposal → §3 validator runs → apply sends (stub Gmail) → ticket waiting_on_customer;
   ownerRedraftFeedback cleared; redraftCount reset to 0.
7. Guidance: set support.agent_guidance='X'; assert a fresh run's system prompt contains the guidance
   section (buildContext → runSupportAgent path, or assert buildSupportSystemPrompt via the ctx.ownerGuidance).
```

Use the stub to (a) verify the resumed prompt carries the feedback, and (b) return a corrected draft. Assert one send.

**Additional cases (panel findings):**
- **no_action-on-redraft:** a separate scenario where the resumed run's stub emits `no_action` → assert the ticket ESCALATES (`redraft_unfulfilled`, paging, `escalationNotifiedAt` NULL) and the redraft columns clear — it is NOT left stranded in `triaged`.
- **cap = 2:** after 2 redraft cycles, the 3rd reject-with-reason routes to `redraft_limit_reached` (paging), and confirm the ticket did not trip `agent_run_cap` first (original + 2 redraft runs = 3 = the daily cap, fits).
- **resume-failure retry keeps guidance:** with non-empty `support.agent_guidance`, force the primary resume to fail so the fresh-session retry runs, and assert its system prompt still carries the guidance section (Task 3's second `buildContext` call site).

- [ ] **Step 2: Run** the e2e (with the local DB). Iterate until green.

- [ ] **Step 3: Full suite + typecheck.** `DATABASE_URL=… pnpm --filter @doge-buddy/ops test` (scoring files need `--testTimeout=30000` on a cold DB — run those separately if needed) and `pnpm typecheck` (0). All green.

- [ ] **Step 4: Commit.**

```bash
git add apps/ops/test/support-guidance-redraft.e2e.test.ts
git commit -m "test(support): e2e reject-with-reason re-draft loop + guidance"
```

---

## Global Constraints (repeated for executors)

See the top block — every task's requirements include it. Key: both reject surfaces identical (shared `resolveRejectAction`); guidance/reason TRUSTED but bounded and never bypass the validator; migration-before-deploy on Railway; empty-guidance/no-reason paths reproduce today's behavior exactly.
