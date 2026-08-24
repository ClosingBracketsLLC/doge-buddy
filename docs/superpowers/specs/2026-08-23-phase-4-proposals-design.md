# Phase 4 — Proposals, admin dashboard, one-click links

**Date:** 2026-08-23 · **Status:** approved by Robert (brainstorming session; adversarial spec
review applied) · **Parent:** [2026-08-09-doge-buddy-design.md](2026-08-09-doge-buddy-design.md)
§Approval gates, §Phased build (Phase 4);
[2026-08-09-doge-buddy-architecture.md](2026-08-09-doge-buddy-architecture.md) §Proposals,
§Admin, §One-click links · **Pre-work:** [2026-08-23-phase-4-prework.md](2026-08-23-phase-4-prework.md)

## Goal

Every LLM workflow's output routes through one approval gate: `submitProposal()` → a `proposals`
row → an owner notification with signed one-click Approve/Reject actions → an apply job that
turns an approved `new_listing` into a live, **fulfillable** product on the store — with a
per-workflow manual/auto switch whose flip changes nothing about the audit trail. Zero LLM in
this phase; the proposal that proves the pipeline is handcrafted (seeded). Zero real money. No
new migrations — every table this phase touches (`proposals`, `admin_sessions`, `settings`,
`audit_log`, `products`, `product_variants`, `supplier_variant_mappings`, `sourcing_signals`,
`support_tickets`, `agent_runs`) shipped in migration 0000, and the payload zod schemas already
live in `packages/core/src/proposals.ts`.

The phase produces **two implementation plans** (spec-review ruling — the workstreams are
separable): **Plan A — proposal pipeline** (submitProposal, tokens, notify, one-click routes,
apply job, expiry sweep); **Plan B — admin surface** (magic-link auth, all pages, settings
editor, orders recovery UI). Plan A is independently verifiable without Plan B.

## Decisions made in brainstorming (and spec review)

| Question | Decision |
| --- | --- |
| Owner notification transport | **Telegram bot, permanently** — Robert's call, overriding the parent's "email via Gmail from support@". Plain `fetch` to `api.telegram.org`, no SDK; signed links ride as inline URL buttons. The parent's "email arrives" verify criterion reads "notification arrives" accordingly. Phase 6's Gmail stack becomes customer-email only — the interim-sender problem (prework Q1) disappears. |
| Notification content rule | Summary-level content + action buttons only; full payloads live behind the admin link. Moot for `new_listing` (product data), load-bearing from Phase 6 (customer content must not transit Telegram). |
| Notification failure contract | `notifyOwner` **never throws to callers**: config absent *or* send failed → alert-and-continue, identical contract. `submitProposal` never fails because Telegram did. Failed login-link sends don't count against the login rate cap (the cap counts successful sends). |
| Admin rendering | Typed template-literal functions in TypeScript — no template engine, no build step. A tagged `html` helper auto-escapes every interpolation (audit detail stores attacker-controlled bytes — see prework); `raw()` opt-out for pre-built fragments. |
| Proposal expiry | Lazy **and** swept. Lazy transitions execute only on `POST /a/…` and on **authed admin page loads** — never on public `GET /a/…`, which just renders the friendly page (preserves "GET never mutates" against scanners). Daily sweep flips the rest. Expiry flips audit as actor `'system'` (the existing machine-actor convention). |
| Admin decision route | `POST /admin/proposals/:id/approve\|reject` — session-authed, same guarded UPDATE as the link route minus the token check, same expiry gate, **also nulls `action_token_hash`** (a dashboard decision invalidates outstanding links), audit actor `'owner'` with `detail.via: 'admin'` (links log `via: 'link'`). Edit-then-approve = the same route with an optional patched payload, zod-re-validated before the guarded UPDATE. |
| Login vs session rows | One `admin_sessions` table, **domain-separated hashes** (no migration): login rows store `sha256('login:' + token)` (15-min expiry), session rows `sha256('session:' + token)` (30-day). The auth preHandler and the consume route look up disjoint hash spaces, so an unconsumed login token can never pass as a session cookie. |
| Login consume | Mirrors `/a/`: `GET /admin/login/consume?t=` renders a confirm page; the **POST** consumes the token and sets the cookie (Telegram's link preview fetches GETs too). |
| Phase 7 canary gate (seam only) | Pre-place hold: a future `fulfillment.canary_hold` setting parks new supplier orders pre-place, surfaced on `/admin/orders` with a Release action. Fulfillment stays proposal-free. Phase 4 builds `/admin/orders` hold-capable; Phase 7 adds the setting. |
| Auto-mode granularity | Per-workflow string settings as the parent spec'd: `workflow.{sourcing,support_reply,refund,deprecation}.mode` = `'manual' \| 'auto'`, default `'manual'`. `refund.auto_max_cents` (default 2500) joins `SETTINGS_DEFAULTS` **and is enforced at submit**: auto + `refund` + amount above cap → falls back to the manual path (parent guardrail). |
| CJ `webhook/product/subscribe` after listing | **Deferred to Phase 5** (recorded deviation): product-change webhooks serve sourcing/stock sync, which doesn't exist yet. Everything else the parent's apply step mandates lands now (see §6). |
| Prework item 7 (CJ webhook signature) | **Already settled live 2026-08-23**, before this spec: signature rides the `sign` header; registration + real deliveries proven end-to-end (see `docs/cj-api-notes.md` §Webhooks). No Phase 4 work item. |
| Proposal link columns | Stay loose uuids (no FK migration), as originally designed. |
| Audit actors | `'owner'` for human decisions; `'system'` for machine actions (sweeps, lazy flips, apply job) — matching the existing convention; `'system:auto'` appears only in `decided_by`. |
| SESSION_SECRET | Dropped (deviation from parent env list). Sessions are opaque random tokens stored sha256-server-side — nothing needs signing. |
| Exit tiers | Tier 1 **includes** the credential-gated real-store walkthrough (prework #5 ruling: the credentials exist on the dev machine; this is verify-live-class, not parked). Only the deployed-URL/Telegram-live/storefront-visible checks are Tier 2. |

## 1. Module layout & data flow

All in `apps/ops` (composition in `src/index.ts`, per the existing deps-injection convention):

- `src/proposals/` — `submitProposal()`, the proposal status machine (guarded-UPDATE idiom
  copied from `fulfillment/transitions.ts`), token helpers (`randomBytes(32).base64url`;
  domain-prefixed sha256 hex digests).
- `src/notify/` — `notifyOwner({title, body, actions: [{label, url}]})` seam; Telegram
  implementation (inline URL buttons); capture implementation for tests.
- `src/http/admin/` — one Fastify plugin (sibling of `http/webhooks.ts`). Route inventory,
  exhaustively: public `GET/POST /a/:id/approve`, `GET/POST /a/:id/reject`; login
  `GET/POST /admin/login`, `GET/POST /admin/login/consume`; session-authed pages `GET /admin`,
  `GET /admin/proposals`, `GET /admin/proposals/:id`, `GET /admin/orders`, `GET /admin/tickets`
  (empty state until Phase 6), `GET /admin/runs` (empty state until Phase 5),
  `GET /admin/settings`; session-authed actions `POST /admin/proposals/:id/approve|reject`,
  `POST /admin/orders/:id/recover`, `POST /admin/settings`, `POST /admin/signals`.
- `src/jobs/` — `proposal.apply` queue (pg-boss **singleton on proposal id**, registered with
  `{ includeMetadata: true }` so the dead-letter hook actually fires — pay-order's pattern, not
  `registerCron`) and a daily `proposal.expire-sweep` cron (which *is* `registerCron`).
- `src/settings.ts` — `SettingValue` widened via a per-key type map (prework #2); new keys above.

Flow: `submitProposal` → (manual) `pending` + token + Telegram buttons │ (auto) `approved` +
`auto_approved` + apply enqueued → decision (link POST or admin POST) → `approved`/`rejected` →
apply job → `applying` → create → publish → map → `applied`. Identical audit rows either mode.

## 2. submitProposal — the single entry point

`submitProposal(deps, p)` where `p = {type, summary, payload, sourceWorkflow, agentRunId?,
ticketId?, productId?, orderId?}`:

1. Validate `payload` against the type's zod schema from `@doge-buddy/core` — reject invalid
   input at the door, not at apply time.
2. Read the workflow's mode from settings (`new_listing`→`workflow.sourcing.mode`,
   `support_reply`→`workflow.support_reply.mode`, `refund`→`workflow.refund.mode`,
   `deprecate_product`→`workflow.deprecation.mode`). **Auto-mode guardrail:** `refund` with
   `amountCents > refund.auto_max_cents` is treated as manual regardless of the mode setting.
3. **manual:** insert `pending` with token hash (expiry = schema default, now()+7d); audit
   `proposal.created`; `notifyOwner` with summary, the "IP check done" checklist line and the
   TikTok Creative Center ritual line (risks §content; the ritual's paste box ships in §5),
   Approve/Reject buttons (`{ADMIN_BASE_URL}/a/{id}/approve?t=…`), and a dashboard link.
   Notify failure or absence → alert; the proposal still lands `pending` — never silently lost.
4. **auto:** insert `approved`, `auto_approved=true`, `decided_by='system:auto'`,
   `decided_at=now()`, no token, no notification; enqueue apply immediately; audit both
   `proposal.created` and `proposal.approve` — the trail reads identically to a manual approve.

## 3. One-click action links (public, unauthenticated by design)

- `GET /a/:id/approve|reject?t=<token>` — **never mutates, ever** (scanners and Telegram link
  previews prefetch GETs; an expired-but-pending row is *not* flipped here). Valid pending
  unexpired token → confirmation page (summary + a real `<form method=POST>` button). Anything
  else → one uniform friendly "already handled or expired" page (HTTP 200, no state oracle).
- `POST /a/:id/approve|reject` — verifies `sha256('action:' + t) == action_token_hash`
  (timing-safe), then one atomic guarded UPDATE: `SET status='approved'|'rejected',
  decided_by='owner', decided_at=now(), action_token_hash=NULL WHERE id=:id AND
  status='pending' AND expires_at > now()`. Zero rows → if the row is `pending` and expired,
  lazily flip to `expired` (audit actor `'system'`), then in every zero-row case render the
  friendly page — the guarded UPDATE *is* the single-use mechanism. On approve: enqueue
  `proposal.apply`. Audit `proposal.approve` / `proposal.reject`, actor `'owner'`,
  `detail.via: 'link'`.

## 4. Magic-link admin auth

Single owner, no user management. `GET /admin/login` renders a "Send me a login link" button;
`POST /admin/login` generates a one-time login token (32B; `sha256('login:'+token)` into
`admin_sessions`, 15-minute expiry), DMs `{ADMIN_BASE_URL}/admin/login/consume?t=…` via
`notifyOwner`, capped at 5 **successful sends**/hour (the webhook-capture idiom). `GET
/admin/login/consume?t=` renders a confirm page; its **POST** verifies + deletes the login row,
creates a session row (`sha256('session:'+fresh token)`, 30-day expiry), sets an `httpOnly;
Secure; SameSite=Lax` cookie with the opaque token. The `/admin` preHandler checks
`sha256('session:'+cookie)` against an unexpired row — login rows live in a disjoint hash
space and can never authenticate a page. Expired rows are deleted opportunistically on any
auth check. The `/a/` routes are deliberately outside this gate — their token is their auth.

## 5. Admin pages (server-rendered, template literals, auto-escaped)

- `/admin` — health strip: CJ wallet balance + alert state, queue depth, last webhook received,
  kill-switch states, pending-proposal count.
- `/admin/proposals` (+ `?type=&status=` filters) and `/admin/proposals/:id` — typed payload
  rendering (listing preview with images for `new_listing`; generic key/value for other types
  until their phases), with Approve / Reject / Edit-then-approve posting to the session-authed
  decision route (§Decisions).
- `/admin/orders` — the parent's full `orders ⋈ supplier_orders` view with `needs_attention`
  rows pinned on top showing their `lastError` reason; recovery buttons (→ pending /
  → confirmed / → cancelled) that apply the legal transition **and re-send
  `fulfillment.place-order`** exactly as the runbook prescribes (this page replaces the
  runbook's raw SQL); built hold-capable for the Phase 7 canary.
- `/admin/tickets` — `support_tickets` listing; empty state until Phase 6.
- `/admin/settings` — editor over the `SETTINGS_DEFAULTS` catalog, typed per key (boolean
  toggle / number field / mode select), writing through `settings.set` with an audit row per
  change (actor `'owner'`); plus the **manual-signal paste box** (parent §admin): a textarea
  POSTing to `/admin/signals`, inserting a `sourcing_signals` row with source `'owner_manual'`
  — the destination of the notification's TikTok ritual line.
- `/admin/runs` — `agent_runs` listing; empty state until Phase 5.

## 6. Apply pipeline + expiry sweep

`proposal.apply` executor dispatches on **current status**: `approved` → claim via guarded
`approved→applying`; `applying` → resume (a crashed/retried job); anything else → audited
no-op. The `new_listing` apply (the only type wired this phase):

1. Re-validate payload. Derive a **deterministic product handle from the proposal id** — the
   idempotency key for the whole step.
2. On resume (or before create): probe Shopify by that handle (`seed/run.ts`'s
   find-before-create idiom); if absent, `productSet` (status DRAFT, variants with
   price/sku, CJ CDN image URLs as `originalSource`, `dogebuddy.*` metafields). **Immediately**
   persist the local `products` row (`shopify_product_gid`, `created_from_proposal_id`) — the
   gid lands before anything else can crash.
3. `product_variants` rows (shopify_variant_gid matched by sku from productSet's return,
   price + supplier-cost cents from the payload) and `supplier_variant_mappings` rows
   (supplier `'cj'`, the payload's CJ pid/vid) — **without these, fulfillment parks every
   order for the product as `unmapped_item`**; they are not optional bookkeeping.
4. `inventorySetQuantities` from the payload's stock figure (parent-mandated).
5. Flip ACTIVE; `publishablePublish` to every publication from `listPublications`
   (per-publication failure containment). Outcome rule: product ACTIVE **and** the Online
   Store publication succeeded → `applied` (other publication failures audit + alert);
   otherwise the job throws into pg-boss retries.
6. `applied` + `applied_at`. Deferred (recorded deviation): CJ `webhook/product/subscribe` —
   Phase 5.

Other proposal types throw `unimplemented` → retries exhaust → dead-letter hook parks `failed`
+ `apply_error` + alert (nothing creates them before their phases anyway).

`proposal.expire-sweep` (daily cron): one UPDATE flipping `pending` rows past `expires_at` to
`expired`; an audit row per flipped id (actor `'system'`).

## 7. Config

`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — optional, required together (superRefine, like the
CJ pair); absence degrades per the notification failure contract. `ADMIN_BASE_URL` — already
required in deployment for the webhook audit; action/magic links require it too, so the admin
plugin registers only when it is set (mirroring how webhook routes gate on their config), and
local dev sets `ADMIN_BASE_URL=http://localhost:3001` in `.env`.

## 8. Testing & exit criteria

TDD throughout (RED before implement). All tests local: real Postgres, captured notifier,
`app.inject`, injected fake Shopify client for apply. Must-cover: token round-trip; second
click rejected **by the guarded UPDATE under concurrency** (two simultaneous POSTs, one
winner); public GET never writes (including on expired rows); uniform friendly page leaks
nothing; lazy (POST + admin-load) and swept expiry paths; auto-mode audit parity; refund
auto-cap fallback to manual; apply resume idempotency (crash after productSet → no duplicate
product — the handle probe test); variant/mapping rows land (a fulfillment-planner test proves
the applied product is mappable); edit-then-approve re-validation rejects schema-breaking
patches; login/session hash domain separation (login token ≠ session); login rate cap counts
only successes; session expiry; every admin page escapes hostile audit/payload bytes.

**Exit Tier 1 (completes the phase):** everything above green in CI, **plus** the
credential-gated seeded-proposal walkthrough against the real store (DRAFT→ACTIVE→published to
Online Store, variants + mappings persisted) — verify-live-class, run by hand with the
existing `.env` credentials.
**Exit Tier 2 (parked on owner items, tracked on OWNER-CHECKLIST):** real Telegram message
with working buttons through the Railway URL; product visible on the actual storefront once
the Hydrogen channel exists (Phase 2 Tier-2 item).

## Out of scope (locked by parent design)

`support_reply`/`refund` apply execution (Phase 6 — schemas + generic detail view only),
`deprecate_product` apply (Phase 5/7), the sourcing agent and any MCP tooling (Phase 5),
CJ `webhook/product/subscribe` on new listings (Phase 5, recorded above),
`workflow.fulfillment.enabled`'s semantics (unchanged — on/off, not a mode), the canary hold
setting itself (Phase 7 — only `/admin/orders`' capability lands now), admin styling beyond
functional, Telegram interactive callbacks (buttons are plain URLs; no bot webhook).
