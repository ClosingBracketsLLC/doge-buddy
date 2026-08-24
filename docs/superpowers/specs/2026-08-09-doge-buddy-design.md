# Doge Buddy — AI-Managed Dog Supply Dropshipping Store

## Context

Robert (Closing Brackets LLC) wants a fully automated dropshipping e-commerce store for dog products: an AI sourcing agent finds trending products and lists them; when a customer buys, the product is automatically purchased from the supplier and shipped to the customer; an AI support agent handles complaints/returns/refunds over email; products are scored nightly and poor performers rotated out. A future phase adds apparel (AI-managed designs + print-file prep for heat-transfer vendors like Supacolor) — v1 only keeps interface boundaries open for it.

Repo is a clean slate: `README.md` + brand assets in `assets/Doge_Buddy_Brand/` (logos, favicons; palette black `#10171a`, red `#ff3641`, beige `#ffe3ae`, orange `#ffb327`, cerulean `#145069`, blues `#005ec2`/`#00e1ff`, gold gradient `#bb6402→#f6ce18→#f5f39e`; fonts FunkyDori display + Poppins).

All platform facts below were verified against live docs on 2026-08-09 by a research workflow (full digests + architecture + risk docs in scratchpad: `digest.md`, `architecture.md`, `risks.md` — copy into `docs/superpowers/specs/` and commit during Phase 0).

## Locked decisions

| Decision | Choice |
|---|---|
| Storefront | Shopify Hydrogen 2026.4.x (React Router 7, TS, Tailwind v4) on Oxygen |
| Store | ⚠️ Shopify **Partner Dashboard "client transfer" store** (free during build, ownership transferred to LLC merchant account + paid plan at launch). NOT a Dev Dashboard "dev store" — that type cannot convert to live. Confirm with Shopify support before creating. |
| | ↳ **[2026-08-23]** Done: created as `doge-buddy-1b9crsev.myshopify.com` (custom domain `dogebuddy.com`) — the "confirm with Shopify support first" step was deliberately skipped, risk accepted. |
| Supplier | `SupplierAdapter` interface; CJ Dropshipping API 2.0 first + `MockSupplierAdapter` for tests |
| Agent runtime | One always-on Node 22 "ops" service on Railway: Fastify + Postgres + **pg-boss** (queue+cron in Postgres, no Redis) + Claude Agent SDK |
| Guardrails | Approval gates: every workflow emits `proposals` rows; manual mode = owner approves via admin dashboard + signed one-click email links; per-workflow flip to auto via settings row. Fulfillment auto-purchases from day one with spend caps. |
| Support email | Google Workspace dedicated user `support@<domain>`; Gmail API via service account + domain-wide delegation (scope `gmail.modify` only); polling ingest (no Pub/Sub) |
| LLM usage | **Fulfillment: zero LLM.** Sourcing + support: Agent SDK (`claude-sonnet-5`). Email triage + scoring judgment: single Messages API calls (`claude-haiku-4-5` / sonnet). API-key auth (SDK ToS requires it for commercial use). |
| Market | US-only; CJ US warehouses only (never silently ship from CN) |

## Monorepo layout

pnpm workspaces, TS strict, Drizzle ORM (SQL migrations), Vitest, CI = typecheck+test+migration check.

```
apps/storefront/        # Hydrogen skeleton (scaffold: npm create @shopify/hydrogen@latest -- --language ts --styling tailwind --markets none), Oxygen GitHub deploys
apps/ops/               # Fastify (webhooks, admin pages, action links) + pg-boss workers + agent runners, one Railway service
packages/core/          # domain types, zod schemas (incl. proposal payloads), money helpers
packages/db/            # Drizzle schema + migrations
packages/supplier/      # SupplierAdapter + adapters/cj + adapters/mock
packages/shopify-admin/ # Admin GraphQL client, pinned 2026-07, client-credentials token manager (24h tokens)
packages/gmail/         # Gmail client (DWD auth), threading + label helpers
```

Deployables: exactly two (storefront→Oxygen, ops→Railway+Postgres). Admin dashboard = server-rendered routes inside ops. Agent queue concurrency 1 (each Agent SDK `query()` spawns a ~1 GiB subprocess); deterministic queues concurrency 5–10.

## Data model (Postgres, money in integer cents)

- **Catalog:** `products` (shopify_product_gid, status draft/active/deprecated, category_tag), `product_variants` (price, supplier_cost_cents for margin math), `supplier_variant_mappings` (variant ↔ CJ pid/vid, warehouse_country, last_known_stock; UNIQUE(variant_id, supplier))
- **Orders:** `orders` (shopify_order_gid UNIQUE = webhook dedup anchor, **is_test** flag), `supplier_orders` (UNIQUE(order_id, supplier); `idempotency_key` UNIQUE → sent as CJ orderNumber; status pending→created→confirmed→paid→shipped→delivered / failed / needs_attention; tracking + shopify_fulfillment_gid; attempts/last_error)
- **Webhooks:** `webhook_events` (UNIQUE(source, external_event_id) — at-least-once dedup for Shopify `X-Shopify-Webhook-Id` and CJ requestId)
- **Support:** `support_tickets` (gmail_thread_id UNIQUE, status, category, order_id link, agent_session_id), `support_messages` (gmail_message_id UNIQUE, rfc_message_id for reply threading), `gmail_sync_state` (last_history_id)
- **Approval gate:** `proposals` (type new_listing/support_reply/refund/deprecate_product; status pending→approved→applying→applied /rejected/expired/failed; zod-validated `payload` jsonb; `action_token_hash` sha256 of one-click token, single-use; `expires_at` 7d; `auto_approved` + `decided_by` for audit parity in auto mode)
- **Scoring/signals:** `product_scores` (units/revenue/refunds/tickets 7d+28d, verdict keep/watch/deprecate), `sourcing_signals` (source, keyword, score, evidence_url, snapshot — append-only history)
- **Agents/audit/config:** `agent_runs` + `agent_run_events` (every SDKMessage), `audit_log` (every external action: actor, action e.g. `cj.createOrder`, entity, detail w/ CJ requestId), `settings` (key/value jsonb), `cj_auth` (token pair + expiries), `admin_sessions`, `agent_sessions` (SessionStore backing)

## Workflows

### (a) Sourcing — cron `sourcing.weekly` (Mondays)
1. **Plain:** CJ `product/listV2` (pet category, `countryCode=US`, `verifiedWarehouse=1`, trending/new flags, ≤10 pages ≈ 500 points) → normalize into `sourcing_signals`, dedupe vs catalog + recently rejected → top ~15 candidates by margin potential.
2. **Agent SDK** (`claude-sonnet-5`, maxTurns 25, maxBudgetUsd 0.75, `settingSources: []`, `tools: []` + allowlist `mcp__cj__*`, WebSearch/WebFetch): triangulate demand (must have evidence beyond CJ's shared trending list), screen for IP/trademark red flags, pick ≤3 winners, return structured output (**JSON Schema draft-07**) — full listing drafts (title, description, price ≥60% gross margin after freight, images, metafields).
3. **Plain:** insert `proposals(new_listing)` → owner email (summary + Approve/Reject links + standing "check TikTok Creative Center manually" line).
4. On approval (`sourcing.apply-proposal`): `productSet` (DRAFT; CJ CDN image URLs as `originalSource`; metafields `dogebuddy.ships_from`/`delivery_min_days`/`delivery_max_days` with storefront `PUBLIC_READ` access) → ACTIVE → `publishablePublish` to the **Hydrogen storefront's publicationId** (products are NOT visible otherwise) → `inventorySetQuantities` (@idempotent) → insert catalog rows → CJ `webhook/product/subscribe`.

**Trend signals stack (ToS-verified):** CJ trending (official API) = discovery; Google Trends = validation (apply for official alpha now; bridge via SerpApi `google_trends` engine); agent WebSearch = qualitative baseline; TikTok Creative Center = manual owner ritual only (no compliant API). **Skip** Amazon (PA-API dead, Creators API needs 10 affiliate sales/30d), Reddit (commercial approval required), scraping anything.

### (b) Fulfillment — `orders/paid` webhook. Zero LLM.
Webhook handler: verify HMAC-SHA256 of **raw body** vs client secret → `webhook_events` insert ON CONFLICT DO NOTHING → enqueue → ack <1s. Job chain (pg-boss `singletonKey` = order gid, bounded retries + backoff):
1. `fulfillment.place-order`: hard-abort if `is_test` (Bogus orders must never spend CJ money) → kill-switch/settings gate → upsert `supplier_orders`, resume from current status if exists (crash-safe) → map line items to CJ vids (unmapped → needs_attention) → **re-verify US stock** `stock/queryByVid` (stockout → needs_attention, never CN fallback) → `freightCalculate` from US, pick cheapest within promised window → **margin + spend-cap gate:** projected total ≤ `spend_cap_per_order_cents` AND wallet balance AND margin ≥ floor vs supplier price at listing time (price drift → block + alert) → `createOrderV3` `payType:3` (create only), `orderNumber = idempotency_key` (CJ rejects dupes = 2nd idempotency layer); re-check actual orderAmount vs cap → `confirmOrder`.
   > **[2026-08-23 correction]** Live CJ does **not** reject duplicate `orderNumber`s — retries placed second chargeable orders. The adapter's `order/list` pre-check (filter `orderNumbers=`, matched client-side on `orderNum`) is the *only* idempotency layer. See `docs/cj-api-notes.md`.
2. `fulfillment.pay-order`: `payBalanceV2`. Error 1600100 (insufficient balance) → **pause queue** (park jobs AWAITING_FUNDS, don't retry-spam) + owner email. Create/pay as separate jobs = the kill-switch seam.
3. Tracking: CJ ORDER/LOGISTICS webhooks (verify `Base64(HmacSHA256(openId, raw body))`, ack <3s) → `fulfillment.sync-tracking`: query order `fulfillmentOrders` → `fulfillmentCreate` (trackingInfo, notifyCustomer:true) / `fulfillmentTrackingInfoUpdate`. Tracking auto-surfaces on Hydrogen account pages — no custom tracking page.
4. **Safety-net crons:** `fulfillment.reconcile` hourly (Shopify `orders(query:"updated_at:>=…")` + CJ `getOrderDetailBatch` — webhooks are hints, polls are truth; catches paid orders with no supplier_orders row); `cj.wallet-monitor` 4h (`getBalance` < threshold → alert; **no top-up API exists — this is the #1 full-auto risk**); `shopify.webhook-audit` daily (Shopify silently DELETES failing subscriptions after 8 retries/~4h — re-register); `cj.token-refresh` (CJ access token 15d, refresh ~day 13; Shopify tokens 24h, refresh-ahead hourly).

### (c) Support — cron `support.poll-gmail` every 45s
1. **Plain ingest:** `users.history.list` from stored historyId (2 quota units/call; on 404 full resync) → upsert tickets by thread, insert messages, apply Gmail label `DogeBuddy/New` (re-apply per message — labels don't inherit).
2. **Triage:** one `claude-haiku-4-5` Messages API structured-output call → {category, order_number, sentiment, is_spam}; plain code links order. **Hardcoded escalation list (code, not prompt):** legal/chargeback threats, pet/person injury, recalls, refund > cap, repeat complainants, unclassifiable → straight to owner.
3. **Agent SDK** (session per ticket, resumed on follow-ups; Postgres SessionStore so sessions survive redeploys; `tools: []` + read-only `mcp__gmail__read_thread`/`mcp__shopify__get_order`/`mcp__cj__get_tracking`/`mcp__cj__dispute_confirm_info`/`mcp__db__*` and **exactly one write tool: `create_proposal`**). Prompt injection via customer email is architecturally inert — the agent cannot send email or move money. System prompt embeds verbatim published policies as the only citable source; a plain-code validator rejects promised actions outside the allowed set.
4. **Apply:** `support_reply` → RFC 2822 reply (threadId + In-Reply-To + References + matching Subject — all three or clients fork threads) via `users.messages.send`, idempotent through proposal status transition. `refund` → Shopify `refundCreate` with **mandatory `@idempotent` key = proposal id** (2026-04 API; keys live 24h — check `order.refunds` before issuing older ones) → optional CJ dispute: `disputeConfirmInfo` first (valid reasons/amounts), then `disputes/create` with `businessDisputeId = proposal id`; poll to resolution. CJ refunds land in our wallet; customer refund is the Shopify step; both audit-logged.

### (d) Scoring — cron `scoring.nightly`
Plain SQL metrics → `product_scores` → deterministic flag rules (e.g. live ≥21d ∧ units_28d ≤1; refund rate >25%) → optional single sonnet structured-output call for judgment → `proposals(deprecate_product)` batched into a weekly digest email. On approval: product → DRAFT, unpublish, `deprecated`, CJ unsubscribe. Never delete. Stock-driven auto-pause: US stock 0 → set Shopify inventory 0 (keep URL/SEO); 0 for N days → replacement flag.

## SupplierAdapter (packages/supplier)

One implementation, two consumers: called directly by fulfillment code, wrapped thin as MCP tools (`tool()` + `createSdkMcpServer`) for agents. Key methods: `searchProducts`, `getProduct`, `getVariantStock`, `quoteShipping`, `placeOrder({idempotencyKey,…})` (MUST be idempotent — on retry, query CJ `order/list?orderIds=` for the orderNumber before creating), `confirmOrder`, `payOrder`, `getOrderStatus`, `getTracking`, `getBalance`, `getDisputeOptions`, `openDispute`, `getDispute`, `verifyWebhook`, `parseWebhook`. CJ client: token manager persisted in `cj_auth` (getAccessToken is server-cached 24h — never per-request), global 1-rps token bucket (free-tier QPS), daily points ledger (listV2 = 50 pts, budget 50k/day; sourcing capped at 25k so fulfillment never starves), `sandbox` flag wiring CJ's sandbox (`createOrderV3` sandbox + `simulatePay` + `sandbox/updateStatus` 300→400→500→600→700 + `updateTrackNumber`). Mock adapter: in-memory catalog, failure/latency/1600100/price-drift injection, test endpoint to advance status. Future apparel adapter = same interface + separate `PrintOnDemandCapable` capability interface; v1's only concession is `supplier` being a column, not a constant.
   > **[2026-08-23 correction]** The actual query param is `orderNumbers=`, and order/list echoes the key as `orderNum` (its `orderId` is an unrelated internal numeric id). The `sandbox` flag on this line's neighborhood is `isSandbox: 1` (integer) — any other spelling silently places a REAL chargeable order. See `docs/cj-api-notes.md`.

## Admin dashboard + one-click links (routes in ops)

Magic-link login (email → `admin_sessions` cookie). Pages: `/admin` (health: wallet balance, queue depth, kill switches, pending proposals), `/admin/proposals` (approve/reject/edit-then-approve with zod re-validation), `/admin/orders` (needs_attention pinned + Retry), `/admin/tickets` (thread view + escalate takeover), `/admin/settings` (kill switches, per-workflow auto/manual, caps, manual signal paste), `/admin/runs` (agent cost + transcript). Action links: random 32-byte token, sha256 stored; **GET renders confirm page (never mutates — scanners prefetch), POST transitions atomically** (`UPDATE … WHERE status='pending'`), single-use, 7-day expiry.

Settings keys: `killswitch.global`, `workflow.fulfillment.enabled`, `workflow.{sourcing,support_reply,refund,deprecation}.mode` (manual/auto), `fulfillment.spend_cap_per_order_cents` (7500), `fulfillment.wallet_alert_threshold_cents`, `refund.auto_max_cents`. One code path: `submitProposal()` checks mode — manual → pending+email; auto → auto-approved + applied immediately, identical audit trail.

## Storefront v1

Skeleton routes restyled, near-zero new routes: home (hero + featured + trust strip "Ships from US warehouses · 3–7 day delivery"), collections (4 automated by `category_tag` tag: Toys & Play, Walks & Travel, Beds & Comfort, Grooming & Care), PDP (+ beige US-warehouse delivery badge from metafields), cart → hosted checkout (`cart.checkoutUrl`, never custom), search, policies (shipping/returns/privacy naming CJ + Google Workspace + Anthropic as processors — Shopify Payments prerequisites), account.* untouched (= the tracking page). Tailwind v4 `@theme` brand tokens; self-hosted woff2 fonts, display font preloaded; **verify FunkyDori webfont license — Poppins fallback if not licensed.** Product + Organization JSON-LD via `getSeoMeta` (not in skeleton by default). Skip: blog, i18n, reviews, wishlists, popups, custom checkout/tracking.

## Key risk mitigations (build-blocking)

1. **Store type** — client-transfer store confirmed with Shopify support before any store-coupled code [foundation].
2. **Order idempotency** — deterministic orderNumber from Shopify order id; state-machine row before API call; query-before-create on retry; create/confirm/pay as 3 steps with cap check between [before-first-real-order].
3. **Reconciliation pollers as truth** on both Shopify and CJ; webhook subscriptions audited daily [before-first-real-order].
4. **Support agent has no money/email tools** — proposals only; escalation list in code [foundation].
5. **US-stock re-verify at order time**, hard block on CN fallback; FTC Mail Order Rule delay-notification job (delay → notify customer with revised date + cancel/full-refund option) [before-first-real-order].
6. **Category exclusions in sourcing (day one):** supplements/vitamins, CBD/hemp, flea-tick pesticides (EPA), medicated shampoos, consumables/treats (FDA), health-claim "calming" products; claims-scrubber on listing copy; IP/trademark screen per candidate; CPSC recall poller (weekly, official API) → auto-unpublish on hit [foundation → before-full-auto].
7. **Cost circuit breakers:** every `query()` gets maxTurns + maxBudgetUsd + AbortController watchdog (no built-in wall-clock timeout; `query()` throws after error results — try/catch in workers, record cost first); daily global agent-spend breaker pauses agent queues (fulfillment unaffected — no LLM) [foundation].
8. **Canary launch:** first ~10 real orders owner-approved despite auto design, per-order cap ~$30, daily cap ~$100, wallet funded ~$150; one self-purchase to verify the physical loop. Passing the canary IS the gate to true auto [before-full-auto].

## Phased build (each independently verifiable)

- **Phase 0 — Foundations.** pnpm workspace, tsconfig, core+db packages (full schema, migrations), pg-boss, Fastify `/healthz`, CI, Railway deploy + Postgres. Commit design docs to `docs/superpowers/specs/`. *Verify: fresh-DB migration; demo job runs on deployed instance.*
- **Phase 1 — Shopify + supplier plumbing.** Client-transfer store (after Shopify support confirmation) + Dev Dashboard app `doge-buddy-ops` (scopes: read/write products, orders, inventory, publications, files, customers(read), merchant-managed fulfillment orders; request `read_all_orders` approval early — else only 60 days of order history). `packages/shopify-admin` (24h client-credentials token manager, pinned 2026-07), webhook receiver (HMAC, dedup, enqueue-then-ack), `packages/supplier` (interface + mock + CJ auth/rate-limited client, fixture-tested). *Verify: scripted DRAFT product appears in admin; replayed webhook dedupes; CJ getAccessToken→getBalance round-trip; mock passes shared adapter contract suite.*
- **Phase 2 — Storefront.** Scaffold Hydrogen, link, brand tokens/fonts, PDP badge, JSON-LD, collections, policy pages, Oxygen GitHub integration (dev-store deploys are private — fine). *Verify: browse→cart→Bogus Gateway checkout (> $1) lands a `test:true` order; Lighthouse pass. Watch anecdotal ~10 test-order cap — cancel as you go.*
- **Phase 3 — Fulfillment (the money path).** Jobs (b) vs MockSupplierAdapter → CJ order methods → CJ webhooks + reconcile + wallet monitor. *Verify (no real money): mock layer E2E incl. cap-exceeded, duplicate webhook, kill-switch mid-flight; CJ sandbox layer full pipeline; failure-injection drills (webhook outage → reconciliation catch-up, 429 storm, wallet-empty pause/resume, crash mid-create → no duplicate); production path hard-skips `is_test`.*
- **Phase 4 — Proposals + admin + links.** *Verify: seeded proposal → email → one-click approve → live product on storefront; second click rejected; auto-mode flip bypasses email but keeps audit.*
- **Phase 5 — Sourcing agent.** MCP tool servers, runner with budgets + `agent_runs` persistence, draft-07 output schema, weekly cron, signals. *Verify: manual trigger → valid productSet payloads w/ real CJ vids + US stock → approved → live listing with correct margin; cost < budget; points < 25k.*
- **Phase 6 — Support agent.** Workspace user, DNS (SPF → DKIM 2048 → 48h → DMARC p=none), GCP SA + DWD (`gmail.modify` only), polling ingest, Haiku triage, agent + SessionStore, apply jobs. *Verify: test email → ticket + labels; approved reply threads correctly in Gmail AND Outlook; refund retried → single refund (@idempotent); follow-up resumes same session across a redeploy.*
- **Phase 7 — Scoring + launch.** Nightly scoring vs seeded data. Launch cutover: transfer store to LLC merchant account → Basic plan → Oxygen production public → custom domain Primary → re-register Customer Account API URIs → Shopify Payments + Shopify Tax (free to $100k lifetime) → final policies → merge SPF records (Google + Shopify, one TXT) → **canary phase (risk #8)** → flip to auto.

Standing ops: quarterly Shopify API bump (3 breaking changes in the last 12 months), monthly CJ docs re-check, DMARC tighten none→quarantine→reject, budget at Sonnet $3/$15 (intro $2/$10 ends 2026-08-31).

## Costs (run-rate during build)

Railway ~$10–20/mo · Google Workspace 1 seat ~$7/mo · SerpApi entry tier (until Google Trends alpha approval) ~$0–50/mo · Claude API: sourcing ≤$0.75/wk + support ≤$0.50/ticket + pennies for triage/scoring · Shopify + Oxygen free until launch (then Basic ~$39/mo) · CJ API free tier (1 rps, 50k points/day — sufficient).

## Open items for Robert (non-blocking, needed by the phase noted)

1. Domain name + DNS access (Phase 6 email, Phase 7 launch) — you said you own one; tell me which.
2. Confirm client-transfer store path with Shopify support (Phase 1 — I'll draft the question).
3. FunkyDori webfont/embedding license check (Phase 2 — Poppins fallback otherwise).
4. Accounts/credentials as phases need them: Shopify Partners, CJ account + API key, Google Workspace + GCP, Anthropic API key, Railway; CJ wallet top-up is manual (canary ~$150).
5. Apply for Google Trends official API alpha (free; Phase 5 benefits).
