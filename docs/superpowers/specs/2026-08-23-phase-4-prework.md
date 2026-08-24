# Phase 4 pre-work (carried out of Phase 3 completion + the 2026-08-23 live-verification day)

Deferred items and constraints that must land before or during Phase 4 (proposals + admin +
one-click links — parent: `2026-08-09-doge-buddy-design.md` §Phased build,
`2026-08-09-doge-buddy-architecture.md` §§Proposals/Admin/One-click links). None block starting
the Phase 4 design. Two Phase-3 leftovers were already fixed on 2026-08-23 and are recorded here
only so they don't resurface: the pay-order executor's null-`shipment_order_id` dead-end
(commit c96b371 — CJ's createOrderV3 never returns a shipment id; the executor now falls back to
the SD order code) and the dead `SUPPLIER` env var (commit 25c1d93).

1. **Email transport is Phase 4's one genuinely new piece of infrastructure.** The verify
   criterion is literally "email arrives" (proposal Approve/Reject links, and magic-link admin
   login), but no mail-sending code or dependency exists anywhere in the repo —
   `createAlerter` only writes `audit_log` + pino — and the Gmail/Workspace/DWD stack is a
   Phase 6 deliverable (architecture §Phase 6). A transport decision (see brainstorming Q1) and
   a minimal `sendOwnerEmail` seam must land in the first Phase 4 task that emails anything.
   Whatever is chosen, the seam should be swappable for the Phase 6 Gmail client.

2. **`SettingValue` must widen before the mode switch exists.** `apps/ops/src/settings.ts` types
   setting values as `boolean | number` only; the spec's `workflow.<type>.mode` keys are the
   strings `'manual' | 'auto'`. Widen the typing (per-key value-type map, keeping the existing
   keys' inference intact) in the first Phase 4 task touching settings — `submitProposal` reads
   the mode, so this is on the critical path.

3. **Nothing enforces proposal expiry.** `proposals.expires_at` defaults to `now() + 7 days` at
   insert (migration 0000) but no code ever flips status to `'expired'`. The action-link task
   must at minimum enforce it lazily (a click on an expired-but-still-`pending` row renders the
   friendly already-handled page and transitions it), and the design should decide whether a
   sweep also exists so the dashboard's pending count doesn't lie (see brainstorming Q3).

4. **`applyTransition`'s guarded-UPDATE pattern is the single-use-link mechanism — reuse it.**
   "Second click rejected" and "auto/manual, one code path" both reduce to the same
   optimistic-concurrency idiom fulfillment already uses (`transitions.ts`: `UPDATE … WHERE
   status = from`, `StaleStatusError` on 0 rows). Phase 4 should build a proposals status
   machine on the same shape rather than inventing a second idiom. Land with the
   `submitProposal`/action-link tasks.

5. **Tier-2 verification is parked on the Railway deploy (and partly on Hydrogen/Oxygen).**
   One-click links and magic-link login are only end-to-end provable with a public
   `ADMIN_BASE_URL` (Railway URL or a `cloudflared` tunnel) — the same gap that still blocks CJ
   webhook-signature verification. And the architecture's verify line wants the approved product
   "published to the Hydrogen publication, visible on storefront": the Hydrogen sales channel
   (Phase 2 Tier-2, owner checklist) doesn't exist on the store yet — `listPublications`
   currently returns only Online Store / Shop / Point of Sale. Tier 1 verifies against a
   localhost base URL + the Online Store publication; Tier 2 parks on the two owner items.

6. **The real-money `payOrder` id question stays open until the Phase 7 canary.** Sandbox
   orders pay via `simulatePay` (payBalanceV2 rejects them with HTTP 400), so the fallback that
   now passes the SD order code to `payBalanceV2` for real orders has never executed against a
   real order. First canary order verifies it; if payBalanceV2 wants a different id, the
   executor's fallback (not the schema) is the fix point. Tracked here so Phase 7 doesn't
   rediscover it.

7. **CJ webhook signature scheme is still doc-only** (`base64(hmacSHA256(openId, rawBody))`
   under one of three guessed header names — `docs/cj-api-notes.md` §Still unverified). First
   live CJ webhook after the Railway deploy settles it; if verification rejects it, log raw
   headers and compare before changing the scheme. Must land before real webhook traffic
   matters, which is before Phase 4's exit at the latest.

## Questions for the Phase 4 brainstorming session (decisions land in the design doc)

1. **Email transport:** pull the Gmail stack forward from Phase 6, or use an interim
   transactional sender (e.g. Resend/SES free tier) behind the `sendOwnerEmail` seam until
   Phase 6 replaces it? The spec says "via Gmail client, from support@" but names no interim
   mechanism (architecture §Sourcing step 3 vs §Phase 6).
2. **Auto-mode granularity:** the spec's per-workflow keys (`workflow.sourcing.mode`,
   `workflow.support_reply.mode`, `workflow.refund.mode`, `workflow.deprecation.mode`) — confirm
   that shape, and confirm `refund.auto_max_cents` (design §guardrails; omitted from the
   architecture settings block) joins `SETTINGS_DEFAULTS` now even though refunds arrive Phase 6.
3. **Expiry enforcement:** lazy-at-click only, or lazy + cron sweep (the dashboard's
   pending-proposal count and the weekly email digest both read better with a sweep)?
4. **Admin rendering:** confirm server-rendered EJS/JSX-lite + htmx-style forms inside
   `apps/ops` (architecture §Admin) and pick the concrete template approach — nothing is
   installed yet. Also: admin routes as a sibling Fastify plugin behind an auth `preHandler` in
   the existing `buildServer`, per the `http/webhooks.ts` pattern? Whatever renders, note that
   `audit_log.detail` now stores **attacker-controlled bytes** (`webhook.cj.rejected` captures
   raw headers/body from unauthenticated requests) — any admin page that displays audit detail
   must escape it (stored-XSS hazard).
5. **Canary-gate mechanism (decide the seam now, build in Phase 7):** risks §canary wants
   per-order owner approval for the first ~10 real orders, but fulfillment deliberately never
   creates proposals (architecture §Failure philosophy) and its toggle is on/off, not
   auto/manual. Likeliest resolution: a `fulfillment.canary_hold` setting that parks new
   supplier_orders in a pre-place hold surfaced on /admin/orders — but that's Robert's call.
6. **Proposal FK hygiene:** keep `proposals.agent_run_id/ticket_id/product_id/order_id` as
   loose uuids (as designed) or add FK constraints in a Phase 4 migration?
7. **Audit actor for human decisions:** the convention today is `actor: 'system'` everywhere;
   settle `'owner'` vs the email address for approve/reject/settings edits (proposals.decided_by
   already anticipates a human value).

Everything the schema needs already exists (proposals, admin_sessions, settings, audit_log —
migration 0000; payload zod schemas in `packages/core/src/proposals.ts`): Phase 4 is code, not
migrations, with the possible exception of Q6's FK decision.
