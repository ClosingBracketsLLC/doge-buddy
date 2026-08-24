# Phase 4 Plan A — Proposal Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete proposal approval pipeline: `submitProposal` → Telegram notification with signed one-click Approve/Reject buttons → public action routes → `proposal.apply` job that turns an approved `new_listing` into a live, fulfillable product — plus the daily expiry sweep.

**Architecture:** New `src/proposals/` (submit, status machine, tokens, apply executor), `src/notify/` (Telegram behind a seam), `src/http/actions.ts` (public `/a/…` routes), two new job registrations. Everything follows existing house idioms: deps-object injection, guarded-UPDATE optimistic concurrency (`fulfillment/transitions.ts`), thin job adapters over executors, `includeMetadata` dead-letter hooks (`jobs/fulfillment-pay-order.ts`), audit-log conventions. **Zero migrations** — all tables exist.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Fastify 5, pg-boss 10, drizzle-orm, zod v4, vitest against real Postgres (`postgres://doge:doge@localhost:5433/doge_buddy` default). Telegram via plain `fetch` — no SDK.

**Spec:** `docs/superpowers/specs/2026-08-23-phase-4-proposals-design.md` (read first; parent: `2026-08-09-doge-buddy-architecture.md` §Proposals/§One-click links). Plan B (admin surface) is a separate plan; nothing here may depend on it.

## Global Constraints

- Branch: `feat/phase-4a-proposal-pipeline`. Commit per task, conventional commits. TDD for every task (RED evidence before implementation).
- Money is integer cents everywhere; no floats.
- No real network in `pnpm test` — Telegram gets an injected `fetchImpl`, Shopify an injected ops object.
- Audit actors: `'owner'` for human decisions, `'system'` for machine actions; `'system:auto'` appears only in `proposals.decided_by`.
- Token hashing is domain-separated: action tokens store `sha256hex('action:' + token)`. (Plan B adds `'login:'`/`'session:'` domains; never hash a bare token.)
- Public `GET /a/…` never writes to the DB, under any input. Lazy expiry flips happen on POST only (Plan A) and admin page loads (Plan B).
- New queue names, exactly: `proposal.apply` (policy `'singleton'`, producer sets `singletonKey: proposalId`, worker registered with `{ includeMetadata: true }`), `proposal.expire-sweep` (cron `30 6 * * *` via `registerCron`).
- `PROPOSAL_RETRY_OPTS = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }` — same shape as `FULFILLMENT_RETRY_OPTS`.
- Settings keys added this plan, exactly: `workflow.sourcing.mode`, `workflow.support_reply.mode`, `workflow.refund.mode`, `workflow.deprecation.mode` (all default `'manual'`), `refund.auto_max_cents` (default `2500`).
- Env vars added this plan: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (optional, required together — superRefine like the CJ pair).
- `notifyOwner` NEVER throws; it resolves `false` on failure (config-absent or send-failed) after alerting. Callers never fail because Telegram did.
- New listings: variants are inventory-untracked (`inventoryItem: { tracked: false }`); `inventorySetQuantities` is never called (spec Decisions table).
- Tests live one file per unit in `apps/ops/test/`; reruns must be dirty-DB safe (unique ids per run — use the existing `crypto.randomUUID()` style; clean up rows your test created when a shared cap/count could be affected).
- Shopify GraphQL input shapes follow `verify-live.ts`/`seed/run.ts` precedent and carry a `// FIXTURE-ASSUMPTION (2026-07 API): verify on first credential-gated run` comment where not yet proven live.

---

### Task 1: Settings widening + Phase 4 keys

**Files:**
- Modify: `apps/ops/src/settings.ts`
- Test: `apps/ops/test/settings.test.ts` (append to existing describe block's file)

**Interfaces:**
- Consumes: existing `SETTINGS_DEFAULTS`, `createSettings`.
- Produces (Tasks 4, 5 and Plan B consume):
  ```ts
  export type WorkflowMode = 'manual' | 'auto'
  // SettingKey now includes: 'workflow.sourcing.mode' | 'workflow.support_reply.mode'
  //   | 'workflow.refund.mode' | 'workflow.deprecation.mode' | 'refund.auto_max_cents'
  // SettingValue<'workflow.sourcing.mode'> === WorkflowMode; SettingValue<'refund.auto_max_cents'> === number
  ```

- [ ] **Step 1: Write the failing tests** (append to `apps/ops/test/settings.test.ts`):

```ts
it('defaults every workflow mode to manual and refund.auto_max_cents to 2500', async () => {
  const s = createSettings(db)
  expect(await s.get('workflow.sourcing.mode')).toBe('manual')
  expect(await s.get('workflow.support_reply.mode')).toBe('manual')
  expect(await s.get('workflow.refund.mode')).toBe('manual')
  expect(await s.get('workflow.deprecation.mode')).toBe('manual')
  expect(await s.get('refund.auto_max_cents')).toBe(2500)
})

it('round-trips a mode value as a typed string', async () => {
  const s = createSettings(db)
  await s.set('workflow.sourcing.mode', 'auto')
  expect(await s.get('workflow.sourcing.mode')).toBe('auto')
  await s.set('workflow.sourcing.mode', 'manual') // restore for rerun safety
})
```

- [ ] **Step 2: Run to verify RED.** `pnpm --filter @doge-buddy/ops test -- settings` — expect FAIL: TS error (key not in `SettingKey`) or runtime undefined default.

- [ ] **Step 3: Implement** in `apps/ops/src/settings.ts` — extend the defaults object and re-shape the value typing as a three-way conditional:

```ts
export type WorkflowMode = 'manual' | 'auto'

export const SETTINGS_DEFAULTS = {
  'killswitch.global': false,
  'workflow.fulfillment.enabled': true,
  'fulfillment.paused_for_funds': false,
  'fulfillment.spend_cap_per_order_cents': 7500,
  'fulfillment.wallet_alert_threshold_cents': 2000,
  'fulfillment.margin_floor_bps': 6000,
  'fulfillment.promised_max_days': 7,
  'workflow.sourcing.mode': 'manual',
  'workflow.support_reply.mode': 'manual',
  'workflow.refund.mode': 'manual',
  'workflow.deprecation.mode': 'manual',
  'refund.auto_max_cents': 2500,
}

export type SettingKey = keyof typeof SETTINGS_DEFAULTS
type BooleanSettingKey = 'killswitch.global' | 'workflow.fulfillment.enabled' | 'fulfillment.paused_for_funds'
type ModeSettingKey =
  | 'workflow.sourcing.mode'
  | 'workflow.support_reply.mode'
  | 'workflow.refund.mode'
  | 'workflow.deprecation.mode'
export type SettingValue<K extends SettingKey> = K extends BooleanSettingKey
  ? boolean
  : K extends ModeSettingKey
    ? WorkflowMode
    : number
```

Update the comment above the object (the "everything else is a number" sentence now reads "modes are `WorkflowMode` strings; everything else is a number"). `createSettings` needs no change — the casts flow through.

- [ ] **Step 4: Run to verify GREEN.** `pnpm --filter @doge-buddy/ops test -- settings` and `pnpm --filter @doge-buddy/ops typecheck` — both pass.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(ops): workflow mode + refund cap settings, string-typed setting values"`

---

### Task 2: Owner-notification seam + Telegram implementation + config

**Files:**
- Create: `apps/ops/src/notify/notify.ts`, `apps/ops/src/notify/telegram.ts`, `apps/ops/src/notify/capture.ts`
- Modify: `apps/ops/src/config.ts` (telegram pair), `apps/ops/.env.example`
- Test: `apps/ops/test/notify-telegram.test.ts`, extend `apps/ops/test/config.test.ts`

**Interfaces:**
- Consumes: `createAlerter`'s alert type: `(severity: 'info'|'warning'|'critical', kind: string, detail: Record<string, unknown>) => Promise<void>`.
- Produces (Tasks 4, 8, Plan B consume):
  ```ts
  // notify.ts
  export interface OwnerNotification {
    title: string
    body: string // plain text; Telegram sends title+body as one message
    actions?: { label: string; url: string }[]
  }
  /** Resolves true if delivered, false otherwise. NEVER rejects. */
  export type NotifyOwner = (n: OwnerNotification) => Promise<boolean>
  export function createNoopNotifier(alert: Alert): NotifyOwner // config-absent: alert('warning','notify_unconfigured',…) → false
  // telegram.ts
  export function createTelegramNotifier(opts: {
    botToken: string; chatId: string; alert: Alert
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  }): NotifyOwner
  // capture.ts (tests only)
  export function createCaptureNotifier(): { notify: NotifyOwner; sent: OwnerNotification[] }
  // config.ts
  // Config gains: telegram?: { botToken: string; chatId: string }
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/notify-telegram.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTelegramNotifier } from '../src/notify/telegram.ts'

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

describe('createTelegramNotifier', () => {
  const alert = vi.fn(async () => {})

  it('POSTs sendMessage with chat_id, text = title + body, and inline URL buttons', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const notify = createTelegramNotifier({
      botToken: 'tok-1', chatId: '42', alert,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return okResponse() },
    })

    const delivered = await notify({
      title: 'New listing proposal',
      body: 'Dog Snuff Pad — margin 62%\n[ ] IP check done',
      actions: [
        { label: 'Approve', url: 'https://ops.example/a/p1/approve?t=abc' },
        { label: 'Reject', url: 'https://ops.example/a/p1/reject?t=abc' },
      ],
    })

    expect(delivered).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.telegram.org/bottok-1/sendMessage')
    const body = JSON.parse(String(calls[0]!.init!.body))
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('New listing proposal\n\nDog Snuff Pad — margin 62%\n[ ] IP check done')
    expect(body.reply_markup.inline_keyboard).toEqual([[
      { text: 'Approve', url: 'https://ops.example/a/p1/approve?t=abc' },
      { text: 'Reject', url: 'https://ops.example/a/p1/reject?t=abc' },
    ]])
  })

  it('resolves false and alerts on a non-ok HTTP response — never throws', async () => {
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async () => new Response('{"ok":false,"description":"blocked"}', { status: 403 }),
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
    expect(alert).toHaveBeenCalledWith('warning', 'notify_failed', expect.objectContaining({ status: 403 }))
  })

  it('resolves false and alerts when fetch itself rejects — never throws', async () => {
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async () => { throw new Error('ECONNRESET') },
    })
    await expect(notify({ title: 'x', body: 'y' })).resolves.toBe(false)
  })

  it('omits reply_markup when there are no actions', async () => {
    const calls: { init?: RequestInit }[] = []
    const notify = createTelegramNotifier({
      botToken: 't', chatId: '1', alert,
      fetchImpl: async (_url, init) => { calls.push({ init }); return okResponse() },
    })
    await notify({ title: 'x', body: 'y' })
    expect('reply_markup' in JSON.parse(String(calls[0]!.init!.body))).toBe(false)
  })
})
```

Config tests (append to `apps/ops/test/config.test.ts`):

```ts
it('assembles the telegram block when both TELEGRAM_* vars are set', () => {
  const c = loadConfig({
    DATABASE_URL: 'postgres://u:p@h:5432/d',
    TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42',
  })
  expect(c.telegram).toEqual({ botToken: 'tok', chatId: '42' })
})

it('throws naming the missing var when only one TELEGRAM_* var is set', () => {
  expect(() =>
    loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', TELEGRAM_BOT_TOKEN: 'tok' }),
  ).toThrow(/TELEGRAM_CHAT_ID/)
})
```

- [ ] **Step 2: RED.** `pnpm --filter @doge-buddy/ops test -- notify-telegram config` — FAIL (modules/keys missing).

- [ ] **Step 3: Implement.**

`src/notify/notify.ts`:

```ts
export interface OwnerNotification {
  title: string
  body: string
  actions?: { label: string; url: string }[]
}

type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

/**
 * Owner-notification seam. Implementations NEVER reject: delivery failure resolves `false`
 * after alerting, so no caller (submitProposal, login links) can fail because Telegram did —
 * the spec's notification failure contract.
 */
export type NotifyOwner = (n: OwnerNotification) => Promise<boolean>

/** Config-absent fallback: alert-and-false, so notify-dependent paths degrade loudly, not fatally. */
export function createNoopNotifier(alert: Alert): NotifyOwner {
  return async (n) => {
    await alert('warning', 'notify_unconfigured', { title: n.title })
    return false
  }
}
```

`src/notify/telegram.ts`:

```ts
import type { NotifyOwner, OwnerNotification } from './notify.ts'

type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function createTelegramNotifier(opts: {
  botToken: string
  chatId: string
  alert: Alert
  fetchImpl?: FetchLike
}): NotifyOwner {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  return async (n: OwnerNotification): Promise<boolean> => {
    try {
      const payload: Record<string, unknown> = {
        chat_id: opts.chatId,
        text: `${n.title}\n\n${n.body}`,
      }
      if (n.actions && n.actions.length > 0) {
        payload.reply_markup = { inline_keyboard: [n.actions.map((a) => ({ text: a.label, url: a.url }))] }
      }
      const res = await fetchImpl(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        await opts.alert('warning', 'notify_failed', { status: res.status, body: bodyText.slice(0, 300) })
        return false
      }
      return true
    } catch (err) {
      await opts.alert('warning', 'notify_failed', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
}
```

`src/notify/capture.ts`:

```ts
import type { NotifyOwner, OwnerNotification } from './notify.ts'

/** Test double: records every notification, always reports delivered. */
export function createCaptureNotifier(): { notify: NotifyOwner; sent: OwnerNotification[] } {
  const sent: OwnerNotification[] = []
  return { sent, notify: async (n) => { sent.push(n); return true } }
}
```

`config.ts`: add to `EnvSchema` — `TELEGRAM_BOT_TOKEN: z.string().optional()`, `TELEGRAM_CHAT_ID: z.string().optional()`; a superRefine block mirroring the CJ pair (path `['telegram']`, message naming the missing var, e.g. `` `Telegram config requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID when either is set; missing: ${missing.join(', ')}` ``); `Config` gains `telegram?: { botToken: string; chatId: string }`; assemble when both present. `.env.example`: add a commented block under the CJ one:

```
# Telegram owner notifications — both required together. Create a bot via @BotFather; the chat
# id is your DM chat with it (message the bot once, then GET /getUpdates shows chat.id).
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
```

- [ ] **Step 4: GREEN.** `pnpm --filter @doge-buddy/ops test -- notify-telegram config` + typecheck pass.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): owner-notification seam with Telegram implementation"`

---

### Task 3: Proposal status machine + action tokens

**Files:**
- Create: `apps/ops/src/proposals/transitions.ts`, `apps/ops/src/proposals/tokens.ts`
- Test: `apps/ops/test/proposal-transitions.test.ts`

**Interfaces:**
- Consumes: `proposals` table from `@doge-buddy/db`.
- Produces (Tasks 4-7, Plan B consume):
  ```ts
  // transitions.ts
  export type ProposalStatusDb = 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
  export class IllegalProposalTransitionError extends Error { constructor(from, to) }
  export class StaleProposalStatusError extends Error { constructor(from, to) }
  export function canTransitionProposal(from: ProposalStatusDb, to: ProposalStatusDb): boolean
  export type ProposalPatch = Partial<{
    decidedBy: string; decidedAt: Date; actionTokenHash: string | null
    appliedAt: Date; applyError: string; payload: unknown
  }>
  export async function applyProposalTransition(db, proposalId: string, from, to, patch?): Promise<void>
  // tokens.ts
  export function generateActionToken(): { token: string; hash: string }
  export function hashActionToken(token: string): string // sha256hex('action:' + token)
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/proposal-transitions.test.ts`. Mirror `fulfillment-transitions` structure: a `it.each` sweep of the legal matrix plus targeted DB cases. Legal matrix, exactly: `pending → approved | rejected | expired`; `approved → applying | failed` (the `failed` edge is the dead-letter path when retries exhaust before the job ever claims the row — Task 6 depends on it); `applying → applied | failed`; terminal (`rejected`, `expired`, `applied`, `failed`) → nothing; self-transitions always illegal. Include:

```ts
import { createDb, proposals } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyProposalTransition, canTransitionProposal,
  IllegalProposalTransitionError, StaleProposalStatusError,
} from '../src/proposals/transitions.ts'
import { generateActionToken, hashActionToken } from '../src/proposals/tokens.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

describe('proposal transitions', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  async function seed(status: 'pending' | 'approved' | 'applying' = 'pending') {
    const [row] = await db.insert(proposals).values({
      type: 'new_listing', status, summary: 'test', payload: { type: 'new_listing' },
      sourceWorkflow: 'seed',
    }).returning()
    return row!
  }

  it('pending -> approved persists decidedBy/decidedAt and nulls the token hash', async () => {
    const row = await seed('pending')
    await applyProposalTransition(db, row.id, 'pending', 'approved', {
      decidedBy: 'owner', decidedAt: new Date(), actionTokenHash: null,
    })
    const [after] = await db.select().from(proposals).where(eq(proposals.id, row.id))
    expect(after!.status).toBe('approved')
    expect(after!.decidedBy).toBe('owner')
    expect(after!.actionTokenHash).toBeNull()
  })

  it('guarded UPDATE: two concurrent pending->approved races produce exactly one winner', async () => {
    const row = await seed('pending')
    const race = await Promise.allSettled([
      applyProposalTransition(db, row.id, 'pending', 'approved', { decidedBy: 'owner' }),
      applyProposalTransition(db, row.id, 'pending', 'rejected', { decidedBy: 'owner' }),
    ])
    const rejected = race.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleProposalStatusError)
  })

  it('illegal pair throws before any DB write', async () => {
    const row = await seed('pending')
    await expect(applyProposalTransition(db, row.id, 'pending', 'applied')).rejects.toBeInstanceOf(
      IllegalProposalTransitionError,
    )
  })

  it('canTransitionProposal encodes the exact matrix', () => {
    expect(canTransitionProposal('pending', 'approved')).toBe(true)
    expect(canTransitionProposal('pending', 'rejected')).toBe(true)
    expect(canTransitionProposal('pending', 'expired')).toBe(true)
    expect(canTransitionProposal('approved', 'applying')).toBe(true)
    expect(canTransitionProposal('approved', 'failed')).toBe(true)
    expect(canTransitionProposal('applying', 'applied')).toBe(true)
    expect(canTransitionProposal('applying', 'failed')).toBe(true)
    expect(canTransitionProposal('approved', 'applied')).toBe(false)
    expect(canTransitionProposal('applied', 'pending')).toBe(false)
    expect(canTransitionProposal('pending', 'pending')).toBe(false)
  })
})

describe('action tokens', () => {
  it('generateActionToken returns a base64url token whose domain-separated hash matches', () => {
    const { token, hash } = generateActionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url, unpadded
    expect(hash).toBe(hashActionToken(token))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('a bare (undomained) sha256 of the token does NOT match — domain separation is real', () => {
    const { token, hash } = generateActionToken()
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(createHash('sha256').update(token).digest('hex')).not.toBe(hash)
  })
})
```

- [ ] **Step 2: RED.** `pnpm --filter @doge-buddy/ops test -- proposal-transitions` — FAIL (modules missing).

- [ ] **Step 3: Implement.** `src/proposals/transitions.ts` is a structural clone of `fulfillment/transitions.ts` over the `proposals` table (same class shapes, same guarded UPDATE with `.returning({ id: proposals.id })`, matrix as in the test). `src/proposals/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'

/**
 * One-click action token: 32 random bytes, base64url. Only the DOMAIN-SEPARATED sha256
 * (`'action:' + token`) is ever stored — Plan B's login/session tokens hash under 'login:' /
 * 'session:' so the three kinds can never satisfy each other's lookups.
 */
export function hashActionToken(token: string): string {
  return createHash('sha256').update(`action:${token}`).digest('hex')
}

export function generateActionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashActionToken(token) }
}
```

- [ ] **Step 4: GREEN** + typecheck.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): proposal status machine + domain-separated action tokens"`

---

### Task 4: submitProposal

**Files:**
- Create: `apps/ops/src/proposals/submit.ts`
- Test: `apps/ops/test/proposal-submit.test.ts`

**Interfaces:**
- Consumes: `ProposalPayloadSchema` and the per-type schemas from `@doge-buddy/core`; `Settings` (Task 1); `NotifyOwner` (Task 2); `generateActionToken` (Task 3); `SendOpts` from `../fulfillment/types.ts`; alert.
- Produces (Task 5's enqueue shape, Task 8 and Plan B consume):
  ```ts
  export interface SubmitProposalDeps {
    db: Db
    settings: Settings
    notify: NotifyOwner
    enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
    alert: Alert
    adminBaseUrl?: string
  }
  export interface SubmitProposalInput {
    type: 'new_listing' | 'support_reply' | 'refund' | 'deprecate_product'
    summary: string
    payload: unknown
    sourceWorkflow: string
    agentRunId?: string; ticketId?: string; productId?: string; orderId?: string
  }
  export async function submitProposal(deps, input): Promise<{ id: string; status: 'pending' | 'approved' }>
  export const PROPOSAL_RETRY_OPTS = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }
  export function enqueueProposalApply(enqueue, proposalId: string): Promise<void>
  //   = enqueue('proposal.apply', { proposalId }, { ...PROPOSAL_RETRY_OPTS, singletonKey: proposalId })
  ```
- Mode key map (exact): `new_listing → 'workflow.sourcing.mode'`, `support_reply → 'workflow.support_reply.mode'`, `refund → 'workflow.refund.mode'`, `deprecate_product → 'workflow.deprecation.mode'`.

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/proposal-submit.test.ts`. Setup: real db, `createSettings(db)`, `createCaptureNotifier()`, `enqueue = vi.fn()`, `alert = vi.fn()`, `adminBaseUrl: 'https://ops.test'`. A minimal valid new_listing payload helper:

```ts
function newListingPayload() {
  return {
    type: 'new_listing', title: 'Dog Snuff Pad', descriptionHtml: '<p>x</p>',
    categoryTag: 'toys', imageUrls: ['https://cf.cjdropshipping.com/x.png'], shipsFrom: 'US',
    deliveryMinDays: 3, deliveryMaxDays: 7,
    variants: [{ sku: `SKU-${crypto.randomUUID()}`, priceCents: 2999, supplierCostCents: 1414,
      supplier: 'cj', supplierProductId: 'cjp-1', supplierVariantId: 'cjv-1' }],
  }
}
```

Cases (each asserts against the DB row + capture + enqueue + audit):
1. **manual mode:** returns `{status:'pending'}`; row has non-null `actionTokenHash` (64-hex), `autoApproved=false`; ONE captured notification whose `actions` are exactly `[{label:'Approve', url:`https://ops.test/a/${id}/approve?t=…`}, {label:'Reject', …/reject?t=…}]` with the SAME `t` on both; body contains `'IP check done'` and `'TikTok Creative Center'`; `enqueue` NOT called; an `audit_log` row `action='proposal.created', actor='system'`.
2. **the token in the notification hashes to the stored actionTokenHash** (extract `t` from the URL, `hashActionToken(t)` equals row value).
3. **auto mode** (`await settings.set('workflow.sourcing.mode','auto')`, restore after): returns `{status:'approved'}`; row `autoApproved=true, decidedBy='system:auto'`, `decidedAt` set, `actionTokenHash` null; NO notification; `enqueue` called once with `('proposal.apply', {proposalId: id}, {retryLimit:5, retryBackoff:true, retryDelay:30, singletonKey: id})`; audit rows for BOTH `proposal.created` and `proposal.approve`.
4. **refund auto-cap fallback:** mode `workflow.refund.mode='auto'`, refund payload with `amountCents: 5000` (> default cap 2500) → lands `pending` with a token + notification (manual path). Same payload with `amountCents: 1000` → `approved` auto path. Restore mode after.
5. **invalid payload rejects** (`type:'new_listing'` with no title) → throws zod error, NO row inserted.
6. **notify failure still lands pending:** deps.notify = `async () => false` → returns pending, row exists, no throw.

- [ ] **Step 2: RED.** `pnpm --filter @doge-buddy/ops test -- proposal-submit` — FAIL.

- [ ] **Step 3: Implement** `src/proposals/submit.ts`:

```ts
import { proposals, auditLog, type createDb } from '@doge-buddy/db'
import {
  NewListingPayloadSchema, SupportReplyPayloadSchema, RefundPayloadSchema,
  DeprecateProductPayloadSchema, type ProposalType,
} from '@doge-buddy/core'
import type { SendOpts } from '../fulfillment/types.ts'
import type { NotifyOwner } from '../notify/notify.ts'
import type { Settings, SettingKey } from '../settings.ts'
import { generateActionToken } from './tokens.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

const PAYLOAD_SCHEMAS = {
  new_listing: NewListingPayloadSchema,
  support_reply: SupportReplyPayloadSchema,
  refund: RefundPayloadSchema,
  deprecate_product: DeprecateProductPayloadSchema,
} as const

const MODE_KEYS: Record<ProposalType, SettingKey & `workflow.${string}.mode`> = {
  new_listing: 'workflow.sourcing.mode',
  support_reply: 'workflow.support_reply.mode',
  refund: 'workflow.refund.mode',
  deprecate_product: 'workflow.deprecation.mode',
}

export const PROPOSAL_RETRY_OPTS = { retryLimit: 5, retryBackoff: true, retryDelay: 30 }

export function enqueueProposalApply(
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>,
  proposalId: string,
): Promise<void> {
  return enqueue('proposal.apply', { proposalId }, { ...PROPOSAL_RETRY_OPTS, singletonKey: proposalId })
}
```

then `submitProposal` per the spec §2: parse payload (schema per type; throw on invalid); read mode; the refund cap check (`mode === 'auto' && type === 'refund' && parsed.amountCents > await settings.get('refund.auto_max_cents')` → treat as manual); **manual**: `generateActionToken()`, insert row (`status:'pending'`, actionTokenHash), audit `proposal.created` (actor `'system'`, entityType `'proposal'`, entityId id, detail `{type, sourceWorkflow, mode:'manual'}`), then if `deps.adminBaseUrl` build both URLs and `notify` (title = `New ${type} proposal`, body = summary + `\n\n[ ] IP check done` + `\nRitual: check TikTok Creative Center (Pet Supplies, US, 7d) — paste anything interesting into the dashboard` + dashboard link line `${adminBaseUrl}/admin/proposals/${id}`), else `alert('warning','notify_unconfigured',{proposalId})`; **auto**: insert approved row (fields per test 3), audit `proposal.created` + `proposal.approve` (detail `{via:'auto'}`), `enqueueProposalApply`. Return `{id, status}`.

- [ ] **Step 4: GREEN** + typecheck + full ops suite still green.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): submitProposal — validated single entry with auto/manual mode switch"`

---

### Task 5: Public one-click action routes

**Files:**
- Create: `apps/ops/src/http/actions.ts`
- Modify: `apps/ops/src/server.ts` (register plugin; `ServerDeps` gains `actions?: ActionRouteDeps`)
- Test: `apps/ops/test/action-routes.test.ts`

**Interfaces:**
- Consumes: `hashActionToken`, `applyProposalTransition`, `StaleProposalStatusError` (Task 3), `enqueueProposalApply` (Task 4).
- Produces:
  ```ts
  export interface ActionRouteDeps {
    db: Db
    enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
    alert: Alert
  }
  export function actionRoutes(deps: ActionRouteDeps): FastifyPluginAsync
  // server.ts registers it with NO prefix: routes are GET/POST /a/:proposalId/approve and /a/:proposalId/reject
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/action-routes.test.ts`, via `buildServer({ pool, isQueueReady: () => true, actions: deps })` + `app.inject`. Seed helper inserts a pending proposal with `generateActionToken()` (keep the raw token). Cases:
1. **GET approve with valid token → 200**, HTML contains the summary and a `<form method="post"` — and **no DB write**: row unchanged (status, updatedAt) after the GET.
2. **GET with garbage token → 200 friendly page** (contains `already handled or expired`), not 404/401 — and identical page body for: unknown proposal id, wrong token, already-decided row (no state oracle).
3. **POST approve with valid token → 303 redirect** to the GET (or 200 page — pick 200 page with 'Approved ✓'; assert body contains `Approved`); row now `approved, decidedBy='owner'`, `actionTokenHash` NULL, `decidedAt` set; `enqueue` called once with the Task 4 shape; audit `proposal.approve` with `detail.via='link'`.
4. **Second POST with the same token → friendly page**, still exactly one enqueue, row untouched.
5. **Concurrent double-POST (Promise.all of two injects) → exactly one wins:** afterwards status `approved`, ONE enqueue call, no 500s (both responses 200).
6. **POST reject** → `rejected`, no enqueue, audit `proposal.reject`.
7. **Expired pending row + POST → row flips to `expired`** (audit `proposal.expired`, actor `'system'`), friendly page, no enqueue. Seed with `expiresAt: new Date(Date.now() - 1000)`.
8. **GET on that expired row → friendly page and NO write** (status still `pending` after a GET — lazy flip is POST-only).

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement** `src/http/actions.ts`. Route params `{ proposalId }`, query `{ t }`. Shared lookup: select row by id; `valid = row && row.actionTokenHash !== null && timingSafeEqual(hashActionToken(t), row.actionTokenHash) && row.status === 'pending' && row.expiresAt > new Date()` (guard `timingSafeEqual` with equal-length buffers, the webhook-verify pattern). GET: valid → confirm page (`html` via simple template literals with an `esc()` helper for the summary — hand-rolled here; Plan B centralizes), else → friendly page. POST: if row pending+expired → `applyProposalTransition(db, id, 'pending', 'expired')` (catch `StaleProposalStatusError` — a race means someone else handled it) + audit + friendly page. If valid → try `applyProposalTransition(db, id, 'pending', decision, { decidedBy: 'owner', decidedAt: new Date(), actionTokenHash: null })`; on `StaleProposalStatusError` → friendly page; on success → audit (`proposal.approve`/`proposal.reject`, actor `'owner'`, `detail: { via: 'link' }`), approve additionally `enqueueProposalApply`, render the confirmation ("Approved ✓ — the listing will go live shortly" / "Rejected ✓"). Friendly page: one shared function, constant copy `This link was already handled or has expired.` `server.ts`: `if (deps.actions) await app.register(actionRoutes(deps.actions))`.

- [ ] **Step 4: GREEN** + typecheck + full ops suite.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): public one-click approve/reject action routes"`

---

### Task 6: proposal.apply job — executor, dead-letter, queue + index wiring

**Files:**
- Create: `apps/ops/src/proposals/run-apply.ts`, `apps/ops/src/jobs/proposal-apply.ts`
- Modify: `apps/ops/src/queue.ts` (queue + worker), `apps/ops/src/index.ts` (assemble `ProposalShopifyOps` + thread deps; also wire `notify` + `actions` + submit deps built here)
- Test: `apps/ops/test/proposal-apply.test.ts`

**Interfaces:**
- Consumes: Task 3 transitions; `products`, `productVariants`, `supplierVariantMappings` tables; `NewListingPayloadSchema`.
- Produces:
  ```ts
  export interface ProposalShopifyOps {
    findProductByHandle(handle: string): Promise<{ id: string } | null>
    productSet(input: Record<string, unknown>): Promise<{ productId: string; variants: { id: string; sku?: string }[] }>
    listPublications(): Promise<{ id: string; name: string }[]>
    publishablePublish(productId: string, publicationId: string): Promise<void>
  }
  export interface ApplyProposalDeps { db: Db; alert: Alert; shopify: ProposalShopifyOps }
  export function proposalHandle(proposalId: string): string // `db-proposal-${proposalId}`
  export async function executeApplyProposal(deps, proposalId: string): Promise<void>
  export async function deadLetterApplyProposal(deps, proposalId: string, err: unknown): Promise<void>
  // jobs/proposal-apply.ts: proposalApplyHandler(deps) — Pick<JobWithMetadata<{proposalId:string}>,
  //   'id'|'name'|'data'|'retryCount'|'retryLimit'>, structural clone of fulfillmentPayOrderHandler
  ```

- [ ] **Step 1: Write the failing tests** — `apps/ops/test/proposal-apply.test.ts`. Fake ops:

```ts
function fakeShopify(overrides: Partial<ProposalShopifyOps> = {}): ProposalShopifyOps & { calls: string[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls,
    findProductByHandle: async () => { calls.push('find'); return null },
    productSet: async (input) => {
      calls.push(`productSet:${String((input as { status?: string }).status)}`)
      n += 1
      const variants = ((input as { variants?: { sku?: string }[] }).variants ?? [{}]).map((v, i) => ({
        id: `gid://shopify/ProductVariant/${n}00${i}`, sku: v.sku,
      }))
      return { productId: `gid://shopify/Product/${n}`, variants }
    },
    listPublications: async () => [{ id: 'pub-1', name: 'Online Store' }, { id: 'pub-2', name: 'Shop' }],
    publishablePublish: async (_p, pub) => { calls.push(`publish:${pub}`) },
    ...overrides,
  }
}
```

Cases:
1. **Happy path:** seed `approved` new_listing proposal (payload from Task 4's helper) → execute → row `applied` with `appliedAt`; `products` row exists with `createdFromProposalId=id`, `shopifyProductGid='gid://shopify/Product/1'`, `handle=proposalHandle(id)`; `product_variants` row per payload variant (matched by sku, `priceCents`, `supplierCostCents` set, `shopifyVariantGid` set); `supplier_variant_mappings` row per variant (`supplier:'cj'`, payload's pid/vid, joined via the variant row); ops call order starts `['find','productSet:DRAFT', 'productSet:ACTIVE', 'publish:pub-1', 'publish:pub-2']`; the DRAFT productSet input carried `handle`, `metafields` incl. `{namespace:'dogebuddy', key:'ships_from'}`, and every variant had `inventoryItem: { tracked: false }`; audit `proposal.applied`.
2. **Fulfillability proof:** after the happy path, the inserted mapping row joins back: select `supplier_variant_mappings ⋈ product_variants` by payload sku → non-null `supplierCostCents` and `shopifyVariantGid` (the exact fields `loadMappings` requires — the spec's "not optional bookkeeping" test).
3. **Resume idempotency (crash after create):** seed proposal in `applying`; pre-insert the `products` row with the gid (simulating crash after step 2); fake's `findProductByHandle` returns the product; execute → NO `productSet:DRAFT` call (calls contain `productSet:ACTIVE` but not `:DRAFT`), still ends `applied`, variants/mappings present (onConflictDoNothing re-runs cleanly).
4. **Resume without local row:** proposal `applying`, no products row, `findProductByHandle` returns `{id:'gid://shopify/Product/9'}` → no DRAFT create; local row inserted with that gid; `applied`.
5. **Dispatch no-ops:** proposal in `applied` → execute returns without any ops call, audit `proposal.apply_skipped`. Same for `rejected`.
6. **Online Store publish failure → throws** (`publishablePublish` overridden to throw for pub-1): row stays `applying`, error propagates (pg-boss will retry).
7. **Non-essential publish failure → applied:** override throws only for pub-2 → `applied`, an alert fired (`publish_partial_failure`).
8. **Unimplemented type:** seed approved `refund` proposal (valid payload) → execute throws `/unimplemented/`; then `deadLetterApplyProposal(deps, id, err)` → row `failed`, `applyError` starts `'unimplemented'`, alert fired.
9. **deadLetter from `applying`** also works (matrix covers `applying → failed`); from `approved` — `approved → applying → failed`? No: dead-letter transitions whatever current status is among `approved|applying` to `failed` via the matrix (`approved→applying` then `applying→failed` is TWO steps — instead the matrix must allow it directly; **add `approved → failed` and keep `applying → failed`** in Task 3's matrix — update Task 3's test matrix accordingly when writing it: `approved: ['applying','failed']`).

*(Task 3's matrix already carries `approved: ['applying', 'failed']` for exactly this path.)*

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement.**

`src/proposals/run-apply.ts` — `proposalHandle = (id) => 'db-proposal-' + id`. `executeApplyProposal`: load row (missing → throw, job retries); switch on status: `approved` → `applyProposalTransition(db, id, 'approved', 'applying')` catching `StaleProposalStatusError` (re-read; if now `applying` continue, else audit `proposal.apply_skipped` + return); `applying` → continue (resume); else → audit `proposal.apply_skipped` `{status}` + return. Then dispatch on `row.type`; only `new_listing` implemented:

```ts
const payload = NewListingPayloadSchema.parse(row.payload)
const handle = proposalHandle(proposalId)

// 1. Resolve the Shopify product exactly once, across crashes: local row first, then handle probe.
const [existing] = await db.select().from(products).where(eq(products.createdFromProposalId, proposalId))
let productGid = existing?.shopifyProductGid ?? null
if (!productGid) {
  productGid = (await deps.shopify.findProductByHandle(handle))?.id ?? null
}
let variantGids: { id: string; sku?: string }[] = []
if (!productGid) {
  // FIXTURE-ASSUMPTION (2026-07 API): ProductSetInput shape per verify-live.ts precedent —
  // verify on the first credential-gated run (Task 8).
  const created = await deps.shopify.productSet({
    title: payload.title,
    handle,
    descriptionHtml: payload.descriptionHtml,
    status: 'DRAFT',
    productOptions: [{ name: 'Title', values: payload.variants.map((v, i, all) => ({
      name: all.length === 1 ? 'Default Title' : v.sku })) }],
    files: payload.imageUrls.map((url) => ({ originalSource: url, contentType: 'IMAGE' })),
    metafields: [
      { namespace: 'dogebuddy', key: 'ships_from', type: 'single_line_text_field', value: payload.shipsFrom },
      { namespace: 'dogebuddy', key: 'delivery_min_days', type: 'number_integer', value: String(payload.deliveryMinDays) },
      { namespace: 'dogebuddy', key: 'delivery_max_days', type: 'number_integer', value: String(payload.deliveryMaxDays) },
    ],
    variants: payload.variants.map((v, i, all) => ({
      sku: v.sku,
      price: centsToUsd(v.priceCents),
      ...(v.compareAtCents ? { compareAtPrice: centsToUsd(v.compareAtCents) } : {}),
      inventoryItem: { tracked: false },
      optionValues: [{ optionName: 'Title', name: all.length === 1 ? 'Default Title' : v.sku }],
    })),
  })
  productGid = created.productId
  variantGids = created.variants
}
// 2. Local products row — gid lands before anything else can crash.
await db.insert(products).values({
  shopifyProductGid: productGid, handle, title: payload.title, status: 'active',
  categoryTag: payload.categoryTag, createdFromProposalId: proposalId,
}).onConflictDoNothing({ target: products.shopifyProductGid })
const [productRow] = await db.select().from(products).where(eq(products.shopifyProductGid, productGid))
// 3. product_variants + supplier_variant_mappings (idempotent; matched by sku).
for (const v of payload.variants) {
  const gid = variantGids.find((g) => g.sku === v.sku)?.id ?? null
  await db.insert(productVariants).values({
    productId: productRow!.id, shopifyVariantGid: gid, sku: v.sku,
    priceCents: v.priceCents, compareAtCents: v.compareAtCents ?? null,
    supplierCostCents: v.supplierCostCents,
  }).onConflictDoNothing({ target: productVariants.sku })
  const [variantRow] = await db.select().from(productVariants).where(eq(productVariants.sku, v.sku))
  await db.insert(supplierVariantMappings).values({
    variantId: variantRow!.id, supplier: v.supplier,
    supplierProductId: v.supplierProductId, supplierVariantId: v.supplierVariantId,
  }).onConflictDoNothing()
}
// 4. ACTIVE + publish. Online Store success is required for 'applied'; others alert-and-continue.
await deps.shopify.productSet({ id: productGid, status: 'ACTIVE' })
const publications = await deps.shopify.listPublications()
for (const pub of publications) {
  try {
    await deps.shopify.publishablePublish(productGid, pub.id)
  } catch (err) {
    if (pub.name === 'Online Store') throw err
    await deps.alert('warning', 'publish_partial_failure', { proposalId, publication: pub.name,
      error: err instanceof Error ? err.message : String(err) })
  }
}
await applyProposalTransition(db, proposalId, 'applying', 'applied', { appliedAt: new Date() })
// audit proposal.applied (actor 'system', entityType 'proposal', detail { productGid })
```

(`centsToUsd` from `@doge-buddy/core`. `variantGids` empty on the resume path — gid lookups then yield null, which `onConflictDoNothing` upserts tolerate; a later re-apply after a fresh create backfills.) Other types: `throw new Error('unimplemented proposal type: ' + row.type)`. `deadLetterApplyProposal`: read row; if status `approved` or `applying` → `applyProposalTransition(db, id, status, 'failed', { applyError: String(message).slice(0, 500) })` + alert `'critical', 'proposal_apply_failed'`; else no-op.

`src/jobs/proposal-apply.ts`: structural clone of `fulfillmentPayOrderHandler` (same `Pick<JobWithMetadata…>` type, same retryCount>=retryLimit dead-letter + nested alert guard), over `executeApplyProposal`/`deadLetterApplyProposal` with `{ proposalId: string }` data.

`queue.ts`: add `const PROPOSAL_APPLY_QUEUE = 'proposal.apply'`; `FulfillmentQueueDeps` gains `proposalShopify?: ProposalShopifyOps`; in `startQueue`, mirror the pay-order block — `createQueueRetrying(boss, PROPOSAL_APPLY_QUEUE, { name: PROPOSAL_APPLY_QUEUE, policy: 'singleton' })` + `boss.work(PROPOSAL_APPLY_QUEUE, { includeMetadata: true }, proposalApplyHandler({ db, alert: deps.alert, shopify: deps.proposalShopify ?? stub }))` where `stub` rejects `'shopify not configured'` on every method (the syncTracking stub pattern).

`index.ts`: assemble `proposalShopify` from the real client when `config.shopify` (wrapping `findProductByHandle`, `productSet`, `listPublications`, `publishablePublish` with the client bound — mirroring the `shopifyOps` assembly); build `notify` (`config.telegram ? createTelegramNotifier({...config.telegram, alert}) : createNoopNotifier(alert)`); pass `actions: { db, enqueue, alert }` into `buildServer`'s deps (enqueue available from the started queue — follow how webhookDeps threads it).

- [ ] **Step 4: GREEN** + typecheck + **full ops suite** (`pnpm --filter @doge-buddy/ops test`).

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): proposal.apply job — new_listing goes live and fulfillable"`

---

### Task 7: Daily expiry sweep

**Files:**
- Create: `apps/ops/src/jobs/proposal-expire-sweep.ts`
- Modify: `apps/ops/src/index.ts` (one `registerCron` line: `await registerCron(queue.boss, 'proposal.expire-sweep', '30 6 * * *', proposalExpireSweepHandler(db))`)
- Test: `apps/ops/test/proposal-expire-sweep.test.ts`

**Interfaces:**
- Consumes: `proposals`, `auditLog` tables.
- Produces: `proposalExpireSweepHandler(db): PgBoss.WorkHandler<object>`.

- [ ] **Step 1: Write the failing tests:** seed three proposals — pending+expired (`expiresAt` past), pending+fresh, approved+past-expiry — run `await proposalExpireSweepHandler(db)([{ id: 'j1', name: 'proposal.expire-sweep', data: {} }] as never)`; assert: first → `expired` with an `audit_log` row (`action='proposal.expired'`, `actor='system'`, `entityId` = its id), second still `pending`, third still `approved` (decided rows never expire). Second run → no new audit rows (idempotent).

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement:** one guarded bulk UPDATE `set({ status: 'expired' }).where(and(eq(proposals.status,'pending'), lt(proposals.expiresAt, new Date()))).returning({ id: proposals.id })`, then one audit insert per returned id.

- [ ] **Step 4: GREEN** + typecheck.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): daily proposal expiry sweep"`

---

### Task 8: Seeded-proposal walkthrough script + docs + workspace gate

**Files:**
- Create: `apps/ops/scripts/seed-proposal.ts`; `package.json` script `"seed-proposal": "tsx scripts/seed-proposal.ts"`
- Modify: `README.md` (add seed-proposal to the manual-scripts section), `docs/OWNER-CHECKLIST.md` (Phase 4 Tier-2 line: Telegram-through-Railway + storefront visibility)
- Test: none new (this is the credential-gated Tier-1 harness itself)

**Interfaces:** consumes `submitProposal` (Task 4) with production deps.

- [ ] **Step 1: Write the script.** `loadDotEnv` (the verify-live pattern); build real deps: `createDb(DATABASE_URL)`, `createSettings`, real Telegram notifier when `config.telegram` else console-printing notifier, `enqueue` via a short-lived `PgBoss` (`send` + `stop` — the deploy-check idiom), `alert` via `createAlerter(db, log)` with a console-backed logger object (`{ info: (o, m) => console.log(m, o), warn: …, error: … }` — scripts don't pull in pino; the verify-live console convention), `adminBaseUrl` from config (default `http://localhost:3001`). Submit a handcrafted `new_listing` proposal using the live-verified CJ dog-toy product (pid `1952308304475578369`, vid `1952308304731430913`, image `https://cf.cjdropshipping.com/0b3c7db4-94ce-46f9-b3d9-9ff6551b29eb.png`, cost 1414¢, price 2999¢, sku `DB-SNUFFPAD-01`), summary `'Seed: Dog Snuff Pad — margin 53%'`. Print: proposal id, the two action URLs (from the captured/real notification), and next-step instructions (`run 'pnpm --filter @doge-buddy/ops dev' and click Approve; watch the apply job take it live`). Idempotent-ish: if a pending/applied proposal with this summary already exists, print it and exit instead of duplicating.

- [ ] **Step 2: Run the Tier-1 walkthrough by hand** (documented as the task's verification, credential-gated): `pnpm --filter @doge-buddy/ops seed-proposal` → Telegram message arrives (or URLs print) → `pnpm --filter @doge-buddy/ops dev` in a second terminal → click Approve → confirm page → POST → watch logs: apply job runs, real DRAFT→ACTIVE product on the store, publications published; verify in Shopify admin; verify `products`/`product_variants`/`supplier_variant_mappings` rows exist; then `productDelete` cleanup NOT automated — record the product URL in the run output and delete via admin when done testing (or re-use for Tier 2 storefront visibility).

- [ ] **Step 3: Update docs.** README manual-scripts section gains `seed-proposal`; OWNER-CHECKLIST Phase-4 Tier-2 item added ("Telegram buttons through the Railway URL; storefront visibility — parked on Hydrogen channel").

- [ ] **Step 4: Workspace gate.** `pnpm -r typecheck && pnpm -r test` — all green.

- [ ] **Step 5: Commit.** `git commit -m "feat(ops): seed-proposal walkthrough script; Phase 4A docs"`

---

**Tier 2 (parked on owner items — not in this plan's execution):** real Telegram buttons through the deployed Railway URL (needs the TELEGRAM_* vars added to Railway and a redeploy); storefront visibility of the applied product (needs the Hydrogen channel — Phase 2 Tier-2 owner item). Tracked on `docs/OWNER-CHECKLIST.md`. Plan B (admin surface: magic-link auth, pages, settings editor, orders recovery UI) is the phase's second plan and starts only after this plan's final gate is green.
