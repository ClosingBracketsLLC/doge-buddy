# Comfort System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the three post-purchase emails that make a 7–14 day delivery survivable — the check-in that prevents the "where is my order?" ticket, the late-order delay notice with a real cancel-for-refund choice, and the delivered thank-you with a discount code — automatically, exactly once per order per stage.

**Architecture:** An hourly `customer.lifecycle` cron picks due stages from order + leg state, claims each `(order, stage)` in a new `lifecycle_emails` ledger, and sends through a **sender port** so the delivery rail is one swappable file. Content is deterministic templates in `@doge-buddy/core`, screened by the existing claims scrubber. The late-order email routes through the proposal/approval flow instead of sending itself.

**Tech Stack:** TypeScript monorepo (pnpm), drizzle-kit migrations against Postgres 17, pg-boss crons, vitest, Gmail API (`@doge-buddy/gmail`), Shopify Admin GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-07-comfort-system-design.md`

## Global Constraints

- Commands: `pnpm --filter @doge-buddy/<pkg> test`, `pnpm -r typecheck`. Dev Postgres must be up (`pnpm db:up`, port 5433).
- **The unique `(order_id, stage)` IS the idempotency guarantee.** Claim the row BEFORE sending, always. Never send first and record after.
- **Deterministic templates only — no LLM anywhere in this build** (spec D2). Every rendered body passes through the claims scrubber before it can be sent.
- **One email per ORDER, never per leg** (spec D3). A split order gets one message listing both shipments.
- **The promised window is `supplier_orders.promised_max_days`** (spec D4) — the same field `sweepOverdue` reads, so the customer email and the ops alert can never disagree. Fall back to `fulfillment.promised_max_days` only when the leg stores none.
- **It lands dark:** `workflow.lifecycle.enabled` defaults to `false`. No email can send until the owner flips it.
- Money is integer cents. Never state a delivery date the stored data doesn't support.
- Known-benign local failures (dev-DB state, pre-existing): `admin-dashboard` tests 8 and 13, `scoring-weekly-digest` freshness. Everything else must pass.

---

### Task 1: Migration 0015 — the send ledger and the new proposal type

**Files:**
- Modify: `packages/db/src/schema.ts` (`proposalType` enum ~line 22; new table after `supplierOrders`)
- Create: `packages/db/migrations/0015_*.sql` (generated, never hand-written)
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Produces: `lifecycleEmails` table; `proposal_type` enum gains `'lifecycle_email'`. Tasks 4–7 all write to this table.

- [ ] **Step 1: Write the failing tests**

In `packages/db/test/migrations.test.ts`, following that file's `pg` Client idiom:

```ts
it('lifecycle_emails allows one row per (order, stage) and rejects a duplicate (migration 0015)', async () => {
  const c = new Client({ connectionString: testUrl })
  await c.connect()
  const { rows: orderRows } = await c.query(
    `INSERT INTO orders (shopify_order_gid, is_test, email) VALUES ('gid://shopify/Order/lc', false, 'x@y.z') RETURNING id`,
  )
  const orderId = orderRows[0].id
  for (const stage of ['check_in', 'late', 'delivered']) {
    await c.query(
      `INSERT INTO lifecycle_emails (order_id, stage, status) VALUES ($1, $2, 'sending')`,
      [orderId, stage],
    )
  }
  // The ledger's whole job: a stage can be claimed exactly once per order.
  await expect(
    c.query(`INSERT INTO lifecycle_emails (order_id, stage, status) VALUES ($1, 'check_in', 'sending')`, [orderId]),
  ).rejects.toThrow(/unique|duplicate/i)
  await c.end()
})

it('proposal_type includes lifecycle_email (migration 0015)', async () => {
  const c = new Client({ connectionString: testUrl })
  await c.connect()
  const res = await c.query(`SELECT unnest(enum_range(NULL::proposal_type))::text AS v`)
  await c.end()
  expect(res.rows.map((r) => r.v)).toContain('lifecycle_email')
})
```

Also add `'lifecycle_emails'` to that file's `EXPECTED_TABLES` list and bump its "creates all 21 tables" title to 22.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @doge-buddy/db test`
Expected: FAIL — no `lifecycle_emails` relation, and the enum has four values.

- [ ] **Step 3: Implement**

`schema.ts` — extend the enum:

```ts
export const proposalType = pgEnum('proposal_type', ['new_listing', 'support_reply', 'refund', 'deprecate_product', 'lifecycle_email'])
```

and add the table (place it after `supplierOrders`, with the other fulfillment-adjacent tables):

```ts
/** Which post-purchase email this row records. `check_in` = the WISMO killer, `late` = the
 *  delay notice with the cancel-for-refund right, `delivered` = the thank-you + discount code. */
export const lifecycleStage = pgEnum('lifecycle_stage', ['check_in', 'late', 'delivered'])
export const lifecycleEmailStatus = pgEnum('lifecycle_email_status', ['sending', 'sent', 'failed', 'superseded'])

export const lifecycleEmails = pgTable('lifecycle_emails', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  stage: lifecycleStage('stage').notNull(),
  status: lifecycleEmailStatus('status').notNull().default('sending'),
  // The RFC822 Message-ID we minted before sending. After a crash mid-send this is what lets the
  // next tick ask the mail provider "did this actually go out?" instead of guessing.
  providerMessageId: text('provider_message_id'),
  // `late` only: the proposal whose approval authorised this send.
  proposalId: uuid('proposal_id').references(() => proposals.id),
  // `delivered` only: the unique code minted for this customer, kept so support can look it up.
  discountCode: text('discount_code'),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('lifecycle_emails_order_stage_uq').on(t.orderId, t.stage)])
```

Then generate and apply:

```bash
pnpm --filter @doge-buddy/db generate
DATABASE_URL=postgres://doge:doge@localhost:5433/doge_buddy pnpm --filter @doge-buddy/db migrate
```

Read the generated SQL before continuing: it must CREATE two enums and one table, and ALTER the existing `proposal_type` enum with `ADD VALUE`. If it drops and recreates `proposal_type`, stop — that would break every existing proposal row.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @doge-buddy/db test` → PASS. Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): migration 0015 — lifecycle_emails send ledger and the lifecycle_email proposal type"
```

---

### Task 2: The templates — deterministic, scrubbed, in core

**Files:**
- Create: `packages/core/src/lifecycle.ts`
- Modify: `packages/core/src/index.ts` (re-export), `packages/core/src/proposals.ts` (payload schema + union)
- Test: `packages/core/test/lifecycle.test.ts`

**Interfaces:**
- Produces: `renderLifecycleEmail(stage, input): { subject: string; bodyText: string }`; `LifecycleEmailInput`; `LifecycleEmailPayloadSchema` added to `ProposalPayloadSchema`. Tasks 4–7 consume all three.

- [ ] **Step 1: Write the failing tests**

```ts
import { renderLifecycleEmail, type LifecycleEmailInput } from '@doge-buddy/core'

const base: LifecycleEmailInput = {
  orderNumber: '1042',
  customerName: 'Ada',
  shipments: [
    { origin: 'CN', minDays: 7, maxDays: 14, arrivesFrom: '2026-09-18', arrivesTo: '2026-09-25', trackingNumber: null, status: 'confirmed' },
  ],
}

it('the check-in states dates, needs nothing from the customer, and never apologises for a disclosed window', () => {
  const { subject, bodyText } = renderLifecycleEmail('check_in', base)
  expect(subject).toContain('1042')
  expect(bodyText).toContain('Sep 18')
  expect(bodyText).toContain('Sep 25')
  // The whole job of this email is to need no reply — no CTA beyond "reply if anything's off".
  expect(bodyText).not.toMatch(/sorry|apologi[sz]e/i)
})

it('a split order lists BOTH shipments in one email, not one email each', () => {
  const { bodyText } = renderLifecycleEmail('check_in', {
    ...base,
    shipments: [
      { origin: 'US', minDays: 3, maxDays: 7, arrivesFrom: '2026-09-10', arrivesTo: '2026-09-14', trackingNumber: '1Z1', status: 'shipped' },
      { origin: 'CN', minDays: 7, maxDays: 14, arrivesFrom: '2026-09-18', arrivesTo: '2026-09-25', trackingNumber: null, status: 'confirmed' },
    ],
  })
  expect(bodyText).toContain('Sep 14')
  expect(bodyText).toContain('Sep 25')
  expect(bodyText).toMatch(/two (shipments|parcels)/i)
})

it('the late email carries the cancel-for-full-refund right in plain words', () => {
  const { bodyText } = renderLifecycleEmail('late', base)
  expect(bodyText).toMatch(/cancel/i)
  expect(bodyText).toMatch(/full refund/i)
  // Never buried: the choice appears before any closing pleasantry.
  expect(bodyText.indexOf('cancel')).toBeLessThan(bodyText.length / 2)
})

it('the delivered email carries the discount code and a way to report a problem', () => {
  const { bodyText } = renderLifecycleEmail('delivered', { ...base, discountCode: 'DOGE-ABC123' })
  expect(bodyText).toContain('DOGE-ABC123')
  expect(bodyText).toMatch(/10%/)
})

it('every rendered body passes the claims scrubber', () => {
  for (const stage of ['check_in', 'late', 'delivered'] as const) {
    const { bodyText, subject } = renderLifecycleEmail(stage, { ...base, discountCode: 'X' })
    expect(findClaimViolations(`${subject} ${bodyText}`)).toEqual([])
  }
})

it('renders nothing it cannot support: a shipment with no window omits dates rather than inventing them', () => {
  const { bodyText } = renderLifecycleEmail('check_in', {
    ...base,
    shipments: [{ origin: 'US', minDays: null, maxDays: null, arrivesFrom: null, arrivesTo: null, trackingNumber: null, status: 'confirmed' }],
  })
  expect(bodyText).not.toMatch(/\bundefined\b|\bnull\b|NaN/)
})
```

(`findClaimViolations` lives in `apps/ops/src/sourcing/guards.ts`. If importing ops from core is not allowed by the package graph — check `packages/core/package.json` — move the CLAIM_TERMS list into core in this task and re-export it from guards.ts, since the scrubber is shared vocabulary, not sourcing-specific.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @doge-buddy/core test`
Expected: FAIL — `renderLifecycleEmail` is not exported.

- [ ] **Step 3: Implement**

`packages/core/src/lifecycle.ts`:

```ts
/** One shipment's state as the CUSTOMER should hear it. Dates are pre-formatted ISO strings from
 *  the caller (which owns the clock); this module never computes "now". */
export interface LifecycleShipment {
  origin: string
  minDays: number | null
  maxDays: number | null
  /** ISO date, or null when this shipment has no quoted window (pre-pivot rows). */
  arrivesFrom: string | null
  arrivesTo: string | null
  trackingNumber: string | null
  status: string
}

export interface LifecycleEmailInput {
  orderNumber: string
  customerName: string | null
  shipments: LifecycleShipment[]
  discountCode?: string
}

export type LifecycleStage = 'check_in' | 'late' | 'delivered'

export function renderLifecycleEmail(stage: LifecycleStage, input: LifecycleEmailInput): { subject: string; bodyText: string }
```

Write the three bodies to the parent spec's voice: plain, warm, specific; concrete about dates; never apologetic about a window we disclosed. Rules the tests pin:
- A shipment with no window contributes a line about *what* is coming and its tracking, with no date claim at all — never `undefined`, never a made-up estimate.
- Two or more shipments get a one-line preamble naming that the order arrives in two parcels, then a line each.
- `late` puts the keep-waiting-or-cancel choice in the first half of the body.
- `delivered` includes the code, its expiry, and a plain "reply if something's wrong" line.

`proposals.ts` — the payload for the `late` proposal:

```ts
export const LifecycleEmailPayloadSchema = z.object({
  type: z.literal('lifecycle_email'),
  stage: z.literal('late'),
  orderId: z.uuid(),
  /** The rendered body, screened and stored, so what the owner approves is EXACTLY what sends. */
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1),
  /** The shipment states this body was rendered from — the owner is approving a claim about the
   *  world, and this records which world it was. */
  shipments: z.array(z.object({ origin: z.string(), status: z.string(), arrivesTo: z.string().nullable() })).min(1),
})
```

and add it to `ProposalPayloadSchema`'s union.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @doge-buddy/core test` → PASS. Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): deterministic lifecycle email templates + the lifecycle_email payload schema"
```

---

### Task 3: Stage selection — a pure function over order + leg state

**Files:**
- Create: `apps/ops/src/lifecycle/select.ts`
- Test: `apps/ops/test/lifecycle-select.test.ts`

**Interfaces:**
- Produces: `dueStages(input: StageSelectionInput): LifecycleStage[]`. Task 5's cron consumes it.
- Consumes: `LifecycleStage` (Task 2).

**Why pure:** the boundary conditions (half a window, past a window, all delivered) are where the bugs live, and they must be testable without a database or a clock.

- [ ] **Step 1: Write the failing tests**

```ts
const legs = (…) => …  // small builder over { status, promisedMaxDays, paidAt }

it('check_in fires past HALF the slowest leg window, not before', () => {
  const input = { paidAt: daysAgo(7), legs: [leg({ promisedMaxDays: 14 })], already: [], cancelled: false }
  expect(dueStages({ ...input, paidAt: daysAgo(6) })).not.toContain('check_in')
  expect(dueStages(input)).toContain('check_in')
})

it('a 14-day CN leg does not trigger check_in on the day a 7-day US leg does', () => {
  expect(dueStages({ paidAt: daysAgo(4), legs: [leg({ promisedMaxDays: 7 })], already: [], cancelled: false })).toContain('check_in')
  expect(dueStages({ paidAt: daysAgo(4), legs: [leg({ promisedMaxDays: 14 })], already: [], cancelled: false })).not.toContain('check_in')
})

it('late fires when ANY leg passes its OWN window unshipped', () => {
  const mixed = [leg({ promisedMaxDays: 7, status: 'shipped' }), leg({ promisedMaxDays: 14, status: 'confirmed' })]
  expect(dueStages({ paidAt: daysAgo(15), legs: mixed, already: [], cancelled: false })).toContain('late')
  expect(dueStages({ paidAt: daysAgo(10), legs: mixed, already: [], cancelled: false })).not.toContain('late')
})

it('late supersedes an unsent check_in — never "on track" an hour before "it is late"', () => {
  const stages = dueStages({ paidAt: daysAgo(15), legs: [leg({ promisedMaxDays: 14 })], already: [], cancelled: false })
  expect(stages).toEqual(['late'])
})

it('delivered fires only when EVERY leg is delivered', () => {
  const partly = [leg({ status: 'delivered' }), leg({ status: 'shipped' })]
  expect(dueStages({ paidAt: daysAgo(20), legs: partly, already: [], cancelled: false })).not.toContain('delivered')
  const all = [leg({ status: 'delivered' }), leg({ status: 'delivered' })]
  expect(dueStages({ paidAt: daysAgo(20), legs: all, already: [], cancelled: false })).toContain('delivered')
})

it('a stage already recorded is never due again', () => {
  const input = { paidAt: daysAgo(20), legs: [leg({ status: 'delivered' })], already: ['delivered' as const], cancelled: false }
  expect(dueStages(input)).toEqual([])
})

it('a cancelled or fully refunded order gets nothing further', () => {
  expect(dueStages({ paidAt: daysAgo(20), legs: [leg({ status: 'cancelled' })], already: [], cancelled: true })).toEqual([])
})

it('a leg with no stored window falls back to the settings default', () => {
  const input = { paidAt: daysAgo(4), legs: [leg({ promisedMaxDays: null })], already: [], cancelled: false, fallbackMaxDays: 7 }
  expect(dueStages(input)).toContain('check_in')
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run --root apps/ops test/lifecycle-select.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export interface StageSelectionInput {
  paidAt: Date
  now?: Date
  legs: { status: string; promisedMaxDays: number | null }[]
  /** Stages already recorded in `lifecycle_emails` for this order — never re-sent. */
  already: LifecycleStage[]
  cancelled: boolean
  /** `fulfillment.promised_max_days`, used only for legs storing no window of their own. */
  fallbackMaxDays?: number
}

/** Returns the stages due for this order RIGHT NOW, in send order. At most one stage per tick:
 *  `late` outranks `check_in` (telling someone "on track" an hour before "it's late" is worse
 *  than saying nothing), and `delivered` is terminal. */
export function dueStages(input: StageSelectionInput): LifecycleStage[]
```

Rules, in order: a cancelled order returns `[]`; `delivered` when every leg is `delivered`; `late` when any leg is past its own window and not `shipped`/`delivered`; `check_in` when past half the slowest window and nothing is delivered yet. Filter out anything in `already`, and if both `late` and `check_in` qualify, return only `late`.

- [ ] **Step 4: Run to verify they pass** — that file; then `pnpm --filter @doge-buddy/ops typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/lifecycle/select.ts apps/ops/test/lifecycle-select.test.ts
git commit -m "feat(lifecycle): pure stage selection over per-leg windows"
```

---

### Task 4: The sender port and its Gmail adapter

**Files:**
- Create: `apps/ops/src/lifecycle/sender.ts`
- Test: `apps/ops/test/lifecycle-sender.test.ts`

**Interfaces:**
- Produces: `LifecycleSender` (`send`, `findSent`) and `createGmailLifecycleSender(gmail)`. Task 5 depends only on the interface.

**Why a port:** the delivery rail is an open question — `support@` via Gmail works today, but Outlook.com is known to drop first-contact mail from this domain, and a transactional ESP on a subdomain may replace it. Everything above this interface must not care.

- [ ] **Step 1: Write the failing tests**

```ts
it('send mints a new thread with the lifecycle marker header', async () => {
  const gmail = mockGmail()
  const sender = createGmailLifecycleSender(gmail)
  await sender.send({
    to: 'buyer@example.com', subject: 'Quick update on order #1042',
    bodyText: 'body', messageId: '<lc-1@dogebuddy.com>',
    headers: { 'X-DogeBuddy-Lifecycle': 'order-1:check_in' },
  })
  const [sent] = gmail.sentNew
  expect(sent.messageId).toBe('<lc-1@dogebuddy.com>')
  expect(sent.extraHeaders?.['X-DogeBuddy-Lifecycle']).toBe('order-1:check_in')
})

it('findSent reports true when the minted Message-ID is already in the mailbox (crash recovery)', async () => {
  const gmail = mockGmail({ existingMessageIds: ['<lc-1@dogebuddy.com>'] })
  const sender = createGmailLifecycleSender(gmail)
  expect(await sender.findSent('<lc-1@dogebuddy.com>')).toBe(true)
  expect(await sender.findSent('<lc-2@dogebuddy.com>')).toBe(false)
})

it('findSent searches by rfc822msgid, not by subject', async () => {
  const gmail = mockGmail()
  await createGmailLifecycleSender(gmail).findSent('<lc-1@dogebuddy.com>')
  expect(gmail.queries[0]).toContain('rfc822msgid:')
})
```

(`mockGmail` — use `@doge-buddy/gmail`'s existing mock if it covers `sendNew` + `listMessages`; otherwise a small local fake in this test file.)

- [ ] **Step 2: Run to verify they fail** — FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/** The one thing the lifecycle cron needs from a mail rail. Kept deliberately tiny so swapping
 *  Gmail for a transactional ESP (a likely move — Outlook.com drops first-contact mail from this
 *  domain, see the spec's deliverability section) is one new implementation and no caller changes. */
export interface LifecycleSender {
  send(msg: { to: string; subject: string; bodyText: string; messageId: string; headers: Record<string, string> }): Promise<void>
  /** Did a message with this Message-ID actually go out? The crash-recovery question: a claim row
   *  left in `sending` means we do not know, and only the provider does. */
  findSent(messageId: string): Promise<boolean>
}

export function createGmailLifecycleSender(gmail: GmailClient): LifecycleSender
```

`send` calls `gmail.sendNew`; `findSent` calls `gmail.listMessages({ q: \`rfc822msgid:${bare(messageId)}\` })` and returns whether any id came back, stripping the angle brackets exactly as the contact-form ack's recovery does.

- [ ] **Step 4: Run to verify they pass** — that file; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/lifecycle/sender.ts apps/ops/test/lifecycle-sender.test.ts
git commit -m "feat(lifecycle): sender port with a Gmail adapter (rail is swappable)"
```

---

### Task 5: The cron — claim, send, record, recover

**Files:**
- Create: `apps/ops/src/jobs/customer-lifecycle.ts`
- Modify: `apps/ops/src/index.ts` (cron registration), `apps/ops/src/queue.ts` if a queue constant belongs there
- Test: `apps/ops/test/lifecycle-cron.test.ts`

**Interfaces:**
- Consumes: `dueStages` (Task 3), `LifecycleSender` (Task 4), `renderLifecycleEmail` (Task 2), `lifecycleEmails` (Task 1).
- Produces: `executeCustomerLifecycle(deps)`, `customerLifecycleHandler(deps)`, `CUSTOMER_LIFECYCLE_QUEUE`.

- [ ] **Step 1: Write the failing tests**

```ts
it('claims the row BEFORE sending, and marks it sent after', async () => {
  const { deps, sender } = makeDeps()
  await seedOrder({ paidAt: daysAgo(8), legs: [{ status: 'confirmed', promisedMaxDays: 14 }] })
  await executeCustomerLifecycle(deps)
  const [row] = await db.select().from(lifecycleEmails)
  expect(row.stage).toBe('check_in')
  expect(row.status).toBe('sent')
  expect(row.providerMessageId).toBeTruthy()
  expect(sender.sent).toHaveLength(1)
})

it('a second tick sends nothing for a stage already recorded', async () => {
  // run twice; exactly one send, one row
})

it('does not send when workflow.lifecycle.enabled is false (lands dark)', async () => {
  await settings.set('workflow.lifecycle.enabled', false)
  await executeCustomerLifecycle(deps)
  expect(sender.sent).toHaveLength(0)
})

it('the global killswitch stops it', async () => { /* killswitch.global true -> zero sends */ })

it('recovery: a stale `sending` row whose message IS in the mailbox is marked sent, never re-sent', async () => {
  // seed a `sending` row with a known providerMessageId, sender.findSent -> true
  expect(sender.sent).toHaveLength(0)
  expect((await reload(row)).status).toBe('sent')
})

it('recovery: a stale `sending` row whose message is NOT in the mailbox is retried', async () => {
  // findSent -> false, claim older than the staleness threshold -> exactly one send
})

it('a send failure records `failed` with the error and does not block other orders', async () => {
  // two due orders, sender throws for the first -> second still sends, first row is `failed`
})

it('a split order gets ONE email naming both shipments', async () => {
  // two legs, different windows -> one row, one send, body contains both dates
})

it('the late stage creates a proposal instead of sending', async () => {
  await seedOrder({ paidAt: daysAgo(20), legs: [{ status: 'confirmed', promisedMaxDays: 14 }] })
  await executeCustomerLifecycle(deps)
  expect(sender.sent).toHaveLength(0)
  const [proposal] = await db.select().from(proposals).where(eq(proposals.type, 'lifecycle_email'))
  expect(proposal.status).toBe('pending')
})

it('a body that fails the claims scrubber is recorded failed and never sent', async () => {
  // inject a template stub returning a claim term
})
```

- [ ] **Step 2: Run to verify they fail** — FAIL, module not found.

- [ ] **Step 3: Implement**

Per tick:

1. Read `killswitch.global` and `workflow.lifecycle.enabled`; return immediately unless enabled and not killed.
2. **Recovery pass first:** every `lifecycle_emails` row in `sending` older than `SEND_CLAIM_STALE_MS` (15 minutes) — ask `sender.findSent(providerMessageId)`. True → mark `sent`. False → re-send under the same claim (the Message-ID is unchanged, so a late-arriving duplicate is still deduplicated by the provider).
3. **Selection:** orders paid, not test, with at least one supplier order leg, joined to their legs and their existing `lifecycle_emails` stages; run `dueStages` per order.
4. For each due stage: render, scrub, then either
   - `late` → `submitProposal` with type `lifecycle_email` and the rendered body, and record the ledger row with that `proposalId` and status `sent` only once the proposal's apply executor actually sends (Task 6 owns that transition); or
   - `check_in` / `delivered` → insert the claim (`sending`), send, mark `sent`.
5. Every order isolated in its own try/catch — one order's failure is recorded on its row and never stops the batch, mirroring `run-reconcile.ts`'s sweeps.

Register in `index.ts` beside the other crons:

```ts
// `customer.lifecycle` (comfort-system spec §4): hourly post-purchase email pass — the check-in
// that prevents a WISMO ticket, the late-order delay notice (as a proposal), and the delivered
// thank-you. Lands dark: `workflow.lifecycle.enabled` defaults false.
const lifecycleDeps: CustomerLifecycleDeps = { db, settings, alert, sender: createGmailLifecycleSender(gmail), submit: submitProposal, submitDeps, now: () => new Date() }
await registerCron(queue.boss, 'customer.lifecycle', '0 * * * *', customerLifecycleHandler(lifecycleDeps))
```

Registered only when Gmail is configured, the same conditional the support crons already use.

- [ ] **Step 4: Run to verify they pass** — that file plus `npx vitest run --root apps/ops test/lifecycle-*.test.ts`; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/jobs/customer-lifecycle.ts apps/ops/src/index.ts apps/ops/test
git commit -m "feat(lifecycle): hourly customer.lifecycle cron — claim, send, record, recover"
```

---

### Task 6: The late-order email as a proposal

**Files:**
- Create: `apps/ops/src/proposals/apply-lifecycle-email.ts`
- Modify: `apps/ops/src/proposals/run-apply.ts` (executor map ~line 28), `apps/ops/src/settings.ts`
- Test: `apps/ops/test/lifecycle-proposal.test.ts`

**Interfaces:**
- Consumes: `LifecycleEmailPayloadSchema` (Task 2), `LifecycleSender` (Task 4), `lifecycleEmails` (Task 1).
- Produces: `applyLifecycleEmail` registered in the executor map; setting `workflow.lifecycle.mode`.

- [ ] **Step 1: Write the failing tests**

```ts
it('approving a lifecycle_email proposal sends exactly the approved body', async () => {
  const row = await seedProposal({ type: 'lifecycle_email', status: 'approved', payload })
  await executeApplyProposal(deps, row.id)
  expect(sender.sent[0]!.bodyText).toBe(payload.bodyText)
  expect(sender.sent[0]!.subject).toBe(payload.subject)
})

it('marks the ledger row sent, with the proposal id recorded', async () => { /* … */ })

it('a rejected proposal never sends', async () => { /* status rejected -> executor not run, zero sends */ })

it('re-applying an already-applied proposal does not send twice', async () => {
  // the ledger's unique (order, stage) plus the row's `sent` status short-circuit
})

it('workflow.lifecycle.mode defaults to manual', async () => {
  expect(SETTINGS_DEFAULTS['workflow.lifecycle.mode']).toBe('manual')
})
```

- [ ] **Step 2: Run to verify they fail** — FAIL.

- [ ] **Step 3: Implement**

`settings.ts` — add to `SETTINGS_DEFAULTS`:

```ts
  // Comfort system (spec 2026-09-07). `enabled` is the master switch and lands FALSE: the build
  // ships dark and the owner turns it on deliberately. `mode` governs the late-order email only —
  // it offers a cancel-for-full-refund, which is a money decision and gets an approval.
  'workflow.lifecycle.enabled': false,
  'workflow.lifecycle.mode': 'manual',
```

and add `'workflow.lifecycle.enabled'` to `BooleanSettingKey` and `'workflow.lifecycle.mode'` to `ModeSettingKey`.

`apply-lifecycle-email.ts` — parse the payload, look up (or claim) the `lifecycle_emails` row for `(orderId, 'late')`, send via the port, mark `sent` with `proposalId`, and return. A row already `sent` returns without sending, so a re-applied proposal is a no-op.

`run-apply.ts` — add `lifecycle_email: applyLifecycleEmail` to the executor map.

- [ ] **Step 4: Run to verify they pass** — that file, plus `npx vitest run --root apps/ops test/proposal-apply.test.ts`; typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/ops/src/proposals apps/ops/src/settings.ts apps/ops/test
git commit -m "feat(lifecycle): late-order email routes through the proposal/approval flow"
```

---

### Task 7: The discount code

**Files:**
- Modify: `packages/shopify-admin/src/operations.ts`, `apps/ops/src/jobs/customer-lifecycle.ts`
- Test: `packages/shopify-admin/test/operations.test.ts`, `apps/ops/test/lifecycle-cron.test.ts`

**Interfaces:**
- Produces: `discountCodeBasicCreate(client, args): Promise<{ codeId: string; code: string }>`; the `delivered` stage mints and persists a code.

- [ ] **Step 1: INTROSPECT THE LIVE SCHEMA FIRST — before writing any of it**

Every Shopify surface in this repo has differed from the docs (`productUpdate(product:)` not `input:`, no `productCreateMedia`, `collectionCreate` sources not `ruleSet`). Run a read-only introspection against the live 2026-07 Admin API for `discountCodeBasicCreate` and `DiscountCodeBasicInput` — its argument name, the shape of `customerGets`/`customerSelection`, how `appliesOncePerCustomer` and `usageLimit` are spelled, and whether `endsAt` is on the input or the parent. Write what you find into a comment at the top of the new operation before implementing it. **If the introspection contradicts anything below, the live schema wins and this task's code changes to match.**

- [ ] **Step 2: Write the failing tests**

```ts
it('creates a single-use 10% code with an expiry', async () => {
  const { client, calls } = makeClient(() =>
    gql({ discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } }))
  const result = await discountCodeBasicCreate(client, {
    code: 'DOGE-ABC123', percentage: 0.1, endsAt: '2026-12-06T00:00:00Z', title: 'Comfort system — order 1042',
  })
  expect(result.code).toBe('DOGE-ABC123')
  const { variables } = lastGraphqlCall(calls)
  // Shape asserted against what Step 1's introspection actually returned.
  expect(JSON.stringify(variables)).toContain('DOGE-ABC123')
})

it('throws ShopifyUserError on userErrors', async () => { /* mirrors the file's existing idiom */ })
```

and in the cron test:

```ts
it('the delivered email mints a unique code per order and persists it', async () => {
  await seedOrder({ paidAt: daysAgo(20), legs: [{ status: 'delivered', promisedMaxDays: 14 }] })
  await executeCustomerLifecycle(deps)
  const [row] = await db.select().from(lifecycleEmails).where(eq(lifecycleEmails.stage, 'delivered'))
  expect(row.discountCode).toMatch(/^DOGE-/)
  expect(sender.sent[0]!.bodyText).toContain(row.discountCode!)
})

it('a discount-code failure records `failed` and sends nothing (never a thank-you with no code)', async () => { /* … */ })
```

- [ ] **Step 3: Run to verify they fail** — FAIL.

- [ ] **Step 4: Implement**

The operation, following that file's `assertNoUserErrors` idiom. Code format `DOGE-` + 6 uppercase alphanumerics from `randomUUID`, checked against the ledger for collisions. Discount: 10%, `usageLimit: 1`, no stacking, `endsAt` = now + 90 days. Mint the code BEFORE rendering the body, so a failure means no email rather than a thank-you promising a code that does not exist.

- [ ] **Step 5: Run to verify they pass** — `npx vitest run --root packages/shopify-admin` and the ops lifecycle tests; `pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-admin apps/ops
git commit -m "feat(lifecycle): unique single-use 10% code on the delivered email"
```

---

### Task 8: Admin surface, docs, full verification

**Files:**
- Modify: `apps/ops/src/http/admin/` (the settings page picks up new keys automatically — verify), `docs/ROADMAP.md`, `docs/OWNER-CHECKLIST.md`

- [ ] **Step 1: Verify the switches are reachable**

Confirm `workflow.lifecycle.enabled` and `workflow.lifecycle.mode` render on `/admin/settings` (the page is driven by `SETTINGS_DEFAULTS`; if booleans and modes are hardcoded lists there, add these two). A switch the owner cannot find is a switch that never gets turned on.

- [ ] **Step 2: Full suites**

```bash
pnpm --filter @doge-buddy/core test
pnpm --filter @doge-buddy/db test
pnpm --filter @doge-buddy/shopify-admin test
pnpm --filter @doge-buddy/ops test
pnpm --filter @doge-buddy/storefront test
pnpm -r typecheck
```

Expected: green except the three known dev-DB failures.

- [ ] **Step 3: Docs**

- `ROADMAP.md`: the comfort system is built and dark; name the switch that turns it on.
- `OWNER-CHECKLIST.md`: (a) **migration 0015 before the code deploys**, same strict order as 0013/0014; (b) customise Shopify's order-confirmation and shipping-confirmation Liquid templates — emails 1 and 2, owner work, deliberately not code; (c) flip `workflow.lifecycle.enabled` when ready, and watch the first sends; (d) the DMARC `rua` currently points at `support@dogebuddy.com`, so aggregate-report XML lands in the support mailbox — worth pointing at a dedicated address or a free DMARC digest service.

- [ ] **Step 4: Commit**

```bash
git add docs/ apps/ops
git commit -m "docs: comfort system built and dark — switch, deploy order, and the two Shopify templates that stay owner work"
```

---

## Self-Review Notes

- **Spec coverage:** §1 scope (3/4/5 only) → Tasks 2–7 · §2 D1 split gate → Tasks 5–6 · D2 deterministic + scrubbed → Task 2 · D3 one email per order → Tasks 2, 3, 5 · D4 per-leg window → Task 3 · §3 ledger → Task 1 · §4 trigger and exits → Tasks 3, 5 · §5 sending and recovery → Tasks 4, 5 · §6 proposal → Task 6 · §7 coupon → Task 7 · §8 deliverability → the sender port (Task 4) keeps the rail swappable, and Task 8 records the `rua` finding · §9 settings → Task 6 · §12 test plan → distributed across every task.
- **Type consistency:** `LifecycleStage` defined in Task 2 and used by Tasks 3, 5, 6 · `LifecycleSender` defined in Task 4, consumed in Tasks 5, 6 · `lifecycleEmails` columns from Task 1 match every write in Tasks 5–7 · `renderLifecycleEmail(stage, input)` argument order identical everywhere.
- **Ordering:** 1 → 2 → 3 → 4 → 5 (each depends on the prior), then 6 and 7 (independent of each other, both need 5), then 8.
- **Open decision this plan does NOT resolve:** the delivery rail. Task 4's port exists precisely so that swapping Gmail for a transactional ESP on a subdomain is one new implementation of two methods, with no caller changes. If that decision lands before this plan is executed, it becomes a ninth task rather than a rewrite.
