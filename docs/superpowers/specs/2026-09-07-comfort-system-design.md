# The comfort system: post-purchase lifecycle email — Design

**Status: written 2026-09-07, design approved in session.** Part 2 of the affordable-catalog pivot
— part 1 made the store able to LIST cheap slow-shipping goods honestly, and this is the
reassurance around the wait that keeps a 14-day delivery from becoming a support ticket, a
chargeback, or a one-time customer.

**Parents:** `2026-09-03-affordable-catalog-pivot-design.md` §5 (the five-email table, the voice,
and the coupon economics — this spec implements it) · `2026-09-06-origin-aware-fulfillment-design.md`
(supplies the per-leg promised window these emails quote) · `2026-08-26-phase-6b-support-agent-design.md`
(the Gmail send machinery and the proposal/approval flow reused here).

---

## 1. What this is, and what it is not

Five emails across an order's life. **Emails 1 and 2 are Shopify's own** — order confirmation and
shipping confirmation — and the right implementation is to customise those Liquid templates in the
Shopify admin. That is owner work, not code, and it is deliberately out of this build: Shopify
sends them from warmed infrastructure with far better deliverability than we can achieve, for free.

**This spec builds emails 3, 4 and 5:**

| # | When | Job |
|---|---|---|
| 3 | Order is past roughly half its promised window, nothing delivered | The WISMO killer — the email that prevents the "where is my order?" ticket |
| 4 | Any leg passes its OWN promised window unshipped | The legally-required delay notice with a real choice: keep waiting or cancel for a full refund |
| 5 | Every leg delivered | Land the relationship — thanks, a 10% code, an easy path to report a problem |

The voice is fixed by the parent spec: plain, warm, specific; never apologetic about a window we
disclosed up front, always concrete about dates.

## 2. Decisions

**D1 — the send gate is split (owner ruling 2026-09-07).** Emails 3 and 5 send automatically;
email 4 becomes a proposal the owner approves. Rationale: 3 and 5 are deterministic templates over
data we already hold, with no money implication — routing them through an approval queue would mean
approving an email per order per stage, which is a chore that gets switched off. Email 4 offers a
cancel-for-full-refund, which is a money decision and belongs beside the existing refund proposal
flow. Everything is additionally gated by `workflow.lifecycle.enabled` and the global killswitch.

**D2 — content is deterministic templates, never LLM-drafted.** It costs nothing per send, it
cannot invent a delivery date, and it means the support agent can quote back exactly what the
customer received. The claims scrubber (`sourcing/guards.ts` `CLAIM_TERMS`) runs over every
rendered body as a guard, so a template edit can never introduce a therapeutic claim.

**D3 — one email per ORDER, not per leg.** Since the origin split, an order can have a US leg and a
CN leg with different windows. Two near-identical emails an hour apart reads as broken. Each email
lists every shipment and its own window in one message.

**D4 — the promised window comes from `supplier_orders.promised_max_days`**, the per-leg value
stamped at placement. The same number drives the overdue sweep, so what the customer is told and
what pages the owner can never disagree.

## 3. Data model

One migration (`0015`), one table.

```
lifecycle_emails
  id              uuid pk
  order_id        uuid not null -> orders.id
  stage           text not null            -- 'check_in' | 'late' | 'delivered'
  status          text not null            -- 'sending' | 'sent' | 'failed' | 'superseded'
  gmail_message_id text                    -- the RFC822 Message-ID we minted, for recovery
  proposal_id     uuid                     -- 'late' only: the proposal that authorised the send
  discount_code   text                     -- 'delivered' only
  error           text
  sent_at         timestamptz
  created_at / updated_at
  UNIQUE (order_id, stage)
```

The unique `(order_id, stage)` **is** the idempotency guarantee: a stage can be claimed exactly
once per order, so a retried cron tick, a redeployed worker and a duplicated job all collapse to a
single send. Nothing else in this design needs a lock.

## 4. The trigger

A `customer.lifecycle` cron, hourly, registered with `registerCron` exactly like
`catalog.deprecation-drip`, `policy: 'singleton'` so ticks cannot overlap.

Each tick selects candidate orders and, per stage, inserts a `lifecycle_emails` row **before**
sending. Selection rules:

- **check_in** — the order is paid, has at least one leg not yet `delivered`, and
  `now > paid_at + ceil(promisedMaxDays / 2) days` where `promisedMaxDays` is the slowest leg's.
  Skipped entirely if every leg is already delivered, or the order is cancelled/refunded.
- **late** — any leg is past its own `promised_max_days` from `paid_at` and is not `shipped` or
  `delivered`. This deliberately mirrors `sweepOverdue`'s condition; the ops alert and the customer
  email fire off the same fact.
- **delivered** — every leg is `delivered`.

**Exit:** an order leaves the system when all three stages are recorded, or when it is cancelled or
fully refunded. Cancelled/refunded orders never receive `check_in` or `delivered`.

**Ordering:** a `late` claim supersedes an unsent `check_in` for the same order (status
`superseded`) — telling someone "everything's on track" an hour before "it's late" is worse than
saying nothing.

## 5. Sending

`gmail.sendNew` (a new thread, since the customer has never written to us), reusing the
contact-form ack's proven pattern:

1. Insert the `lifecycle_emails` row with `status: 'sending'` and a freshly minted
   `gmail_message_id`. The unique constraint means a second worker loses this race and stops.
2. Send via `gmail.sendNew` with `X-DogeBuddy-Lifecycle: <orderId>:<stage>` in `extraHeaders`.
3. Mark `sent`.

A process killed between (1) and (3) leaves a `sending` row. Recovery mirrors `form-ids.ts`: the
next tick searches Gmail for the minted `rfc822msgid:` — found means it really did send (mark
`sent`), not found after a staleness threshold means it did not (retry). The claim carries its
timestamp so a stale claim can be taken over rather than stranding the order forever.

Subject lines carry the order number so a customer reply threads sensibly and the support agent has
context. A reply lands in Gmail and becomes an ordinary ticket through the existing ingest — no new
inbound path.

## 6. Email 4 as a proposal

A new proposal type `lifecycle_email` with its own payload schema (order id, stage, rendered body,
the leg statuses it was rendered from) and an apply executor that performs the send in §5. Governed
by `workflow.lifecycle.mode` (`manual` | `auto`), defaulting to `manual`, exactly like the other
workflow modes on `/admin/settings`.

Approving it sends the delay notice. The customer's reply — "cancel it" — arrives as a normal
support ticket and flows through the existing refund proposal machinery. **No new refund path is
built here**; that is deliberate, because the refund flow already carries the money gates,
`dmarcPasses` sender authentication, and the owner approval this decision needs.

## 7. The coupon (email 5)

Shopify `discountCodeBasicCreate`: 10% off, single use, 90-day expiry, no stacking, one unique code
per order, stored on the `lifecycle_emails` row so a support conversation can look it up.

**The live 2026-07 Admin schema must be introspected before writing this call.** Every prior
Shopify surface in this repo has differed from documentation (`productUpdate(product:)` not
`input:`, no `productCreateMedia`, `collectionCreate` sources not `ruleSet`) — a schema check is the
first step of the implementation task, not an afterthought.

Economics, from the parent spec: on a $16.99 sale at ~55% margin (~$9.35 contribution) a 10% code
costs about $1.70, and only if they order again.

## 8. Deliverability — the known constraint

Emails 3–5 are first contact from `support@dogebuddy.com` to someone who never wrote to us, and the
6B live walk established that **Outlook.com silently drops first-contact mail from this domain**
until reputation builds. This is a real limit on the WISMO killer's reach and it is not solvable in
code.

What this design does about it:

- **Records every send and its outcome** in `lifecycle_emails`, so the gap is visible rather than
  assumed. Not a bounce-processing pipeline — just an honest record of what we attempted.
- **Leans on Shopify for emails 1 and 2**, which is where the highest-value expectation-setting
  happens anyway, and which does not touch our sending reputation at all.
- **Keeps email 4 owner-approved**, so the one legally load-bearing message is never silently
  skipped without a human seeing it.
- **Depends on DMARC**, already on the owner checklist. Finishing it is what actually moves
  deliverability; this spec does not pretend otherwise.

## 9. Settings and control surface

- `workflow.lifecycle.enabled` (boolean, default **false** — the build lands dark and is switched on
  deliberately).
- `workflow.lifecycle.mode` (`manual` | `auto`, default `manual`) — governs email 4's proposals.
- The global killswitch stops everything, as everywhere else.
- `/admin` shows lifecycle sends alongside the other agent/job activity.

## 10. Explicitly NOT in scope

- **Emails 1 and 2** — Shopify Liquid template customisation, owner work.
- **Bounce processing / suppression lists.** We record outcomes; we do not build an ESP.
- **Marketing email.** This is transactional lifecycle mail only. Anything promotional beyond the
  post-delivery thank-you needs consent handling this spec does not build.
- **SMS.** Same reason, with its own consent regime.
- **A new refund path.** Email 4's replies use the existing one.

## 11. Risks

| Risk | Handling |
|---|---|
| A template bug reaches every customer before the owner sees it | Lands dark (`enabled` false); deterministic templates are unit-tested against fixed fixtures; the claims scrubber guards every rendered body |
| Double-sending after a crash | Unique `(order_id, stage)` plus the mint-then-search recovery in §5 |
| "On track" sent just before "late" | The `late` claim supersedes an unsent `check_in` (§4) |
| Emails quoting a window that disagrees with the ops alert | Both read `supplier_orders.promised_max_days` (D4) |
| Outlook silently dropping the WISMO killer | §8 — recorded, mitigated where possible, honestly stated |
| Coupon abuse | Single use, 90-day expiry, no stacking, one code per order |

## 12. Test plan

- **Stage selection at boundaries**: a leg one day inside its window vs one day past; a 14-day CN
  leg not triggering `check_in` on the same day a 7-day US leg does.
- **Ledger**: a second tick for a stage already recorded sends nothing.
- **Crash recovery**: a `sending` row whose message IS findable by `rfc822msgid:` marks `sent`
  without re-sending; one that is not, after the staleness threshold, retries.
- **Split orders**: one email listing both shipments, not two emails.
- **Supersede**: an unsent `check_in` yields to a `late` claim.
- **Exit**: cancelled and fully refunded orders receive nothing further.
- **Scrubber**: a template containing a claim term is rejected, not sent.
- **Proposal round trip**: email 4 creates a proposal; approving it sends; rejecting it does not.
- **Coupon**: a unique code per order, persisted, with expiry and single-use set.
