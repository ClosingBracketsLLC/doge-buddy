# Doge Buddy v1 — System Architecture

**Author:** system architect agent · **Date:** 2026-08-09 · **Status:** Proposed for build

Design principle: v1 is the smallest system that automatically sells and ships real dog products behind the locked guardrails. Everything else (apparel, multi-supplier, full-auto everything, analytics warehouse) only influences *interface boundaries*, never adds code.

Opinionated calls made in this doc (with rationale inline): **pnpm workspaces (no Turborepo)**, **pg-boss instead of BullMQ** (one datastore, satisfies "Postgres + job queue" with no Redis), **Drizzle ORM**, **admin dashboard lives inside the ops service** (no third deployable), **LLM calls in exactly 2.5 workflows** (sourcing agent, support agent, one-shot scoring judgment) — fulfillment is 100% deterministic.

---

## 1. Monorepo layout & tooling

```
doge-buddy/
├── package.json                  # pnpm workspace root, engines: node >=22
├── pnpm-workspace.yaml
├── tsconfig.base.json            # strict: true, moduleResolution: NodeNext (ops), verbatimModuleSyntax
├── .github/workflows/ci.yml      # typecheck + test + drizzle migration check on PR
├── apps/
│   ├── storefront/               # Hydrogen (React Router 7 skeleton, 2026.4.x), deployed to Oxygen
│   │   └── ...skeleton layout unchanged (app/routes fs-routes, +types/)
│   └── ops/                      # THE always-on service (Railway): Fastify HTTP + pg-boss workers, one process
│       ├── src/http/             # webhook receivers, admin dashboard routes, one-click action links
│       ├── src/jobs/             # one file per job name (see §3)
│       ├── src/agents/           # Agent SDK runners: sourcing.ts, support.ts + MCP tool servers
│       └── src/admin/            # server-rendered admin pages (see §5)
└── packages/
    ├── core/                     # domain types, zod schemas, money helpers, Result type. Zero deps on I/O.
    ├── db/                       # Drizzle schema (schema.ts), migrations/, typed query helpers
    ├── supplier/                 # SupplierAdapter interface + adapters/cj/ + adapters/mock/
    ├── shopify-admin/            # Admin GraphQL client: client-credentials token manager (24h tokens),
    │                             #   pinned API version 2026-07, typed mutations (productSet, refundCreate w/ @idempotent, …)
    └── gmail/                    # Gmail client: service-account DWD auth (impersonate support@), threading helpers, label sync
```

**Tooling decisions**

| Concern | Choice | Why |
|---|---|---|
| Package manager | **pnpm** workspaces | Standard for TS monorepos; `pnpm -r --filter` is enough — no Turborepo/Nx in v1 (two apps, five packages; build graph is trivial) |
| Language | TypeScript 5.9, `strict`, single `tsconfig.base.json` | Storefront extends it with Hydrogen's Vite/RR7 settings; ops packages use NodeNext ESM |
| ORM/migrations | **Drizzle + drizzle-kit** | SQL-first, migrations are plain SQL files reviewable in PRs, no runtime magic |
| Job queue + cron | **pg-boss** | Locked decision says "Postgres + a job queue" — pg-boss is exactly that: queues, cron scheduling, retries with backoff, and **singleton/dedup keys** (which we lean on for idempotency), all in the Postgres we already run. Swap to BullMQ+Redis only if throughput ever demands it (it won't at this scale). |
| HTTP server (ops) | Fastify | Raw-body access for HMAC verification, fast, minimal |
| Runtime | Node 22 (Hydrogen skeleton requires ^22\|\|^24) | One version everywhere |
| Testing | Vitest + recorded-fixture tests for CJ/Shopify envelopes | Digest recommendation: pin adapter tests against recorded responses so interface drift fails CI |

**Deployables: exactly two.** `apps/storefront` → Oxygen (GitHub integration, main→production, branches→preview). `apps/ops` → Railway (one service, one Postgres). The admin dashboard is routes inside ops — a third deployable is YAGNI.

**Ops process model:** one Node process runs both Fastify and the pg-boss workers. Agent jobs (`agent` queue) run at **concurrency 1** initially — each Agent SDK `query()` spawns a ~1 GiB `claude` subprocess; on a 2 GB Railway instance that's the safe ceiling. Deterministic queues (`fulfillment.*`, `support.poll`, etc.) run at concurrency 5–10; they're just HTTP calls.

---

## 2. Postgres data model

All money columns are integer cents (`_cents`). All tables get `created_at`/`updated_at` timestamptz defaults. Primary keys are `id uuid default gen_random_uuid()` unless noted.

### Catalog & supplier mapping

```sql
products (
  id uuid PK,
  shopify_product_gid text UNIQUE,        -- gid://shopify/Product/…
  handle text, title text,
  status text CHECK (IN ('draft','active','deprecated')),
  category_tag text,                      -- 'toys' | 'walks' | 'beds' | 'grooming' → drives automated collections
  created_from_proposal_id uuid REFERENCES proposals,
  deprecated_at timestamptz
)

product_variants (
  id uuid PK,
  product_id uuid REFERENCES products,
  shopify_variant_gid text UNIQUE,
  shopify_inventory_item_gid text,
  sku text UNIQUE,                        -- our SKU, format DB-<short>
  price_cents int, compare_at_cents int,
  supplier_cost_cents int                 -- last known CJ item cost, for margin/spend-cap math
)

supplier_variant_mappings (               -- the Shopify-variant <-> CJ-variant join
  id uuid PK,
  variant_id uuid REFERENCES product_variants,
  supplier text CHECK (IN ('cj','mock')),
  supplier_product_id text,               -- CJ pid
  supplier_variant_id text,               -- CJ vid — the unit of ordering/stock/freight
  warehouse_country text DEFAULT 'US',
  last_known_stock int, stock_checked_at timestamptz,
  UNIQUE (variant_id, supplier)
)
```

### Orders & fulfillment

```sql
orders (
  id uuid PK,
  shopify_order_gid text UNIQUE,          -- dedup anchor for the orders/paid webhook
  shopify_order_number text,
  email text, customer_name text,
  is_test boolean NOT NULL,               -- Shopify test flag; test orders NEVER reach a real supplier
  financial_status text, fulfillment_status text,
  total_cents int,
  shipping_address jsonb,
  raw_payload jsonb,
  paid_at timestamptz
)

supplier_orders (                         -- one row per (order, supplier) — the idempotency ledger
  id uuid PK,
  order_id uuid REFERENCES orders,
  supplier text,
  idempotency_key text UNIQUE,            -- = 'DB-' || orders.shopify_order_gid id part; sent to CJ as orderNumber
  status text CHECK (IN ('pending','created','confirmed','paid','shipped','delivered','cancelled','failed','needs_attention')),
  supplier_order_id text, shipment_order_id text,   -- CJ orderId / shipmentOrderId
  logistic_name text,
  product_amount_cents int, postage_amount_cents int, total_amount_cents int,
  tracking_number text, tracking_synced_to_shopify_at timestamptz,
  shopify_fulfillment_gid text,
  attempts int DEFAULT 0, last_error text,
  paid_at timestamptz,
  UNIQUE (order_id, supplier)
)

webhook_events (                          -- at-least-once dedup for BOTH Shopify and CJ webhooks
  id uuid PK,
  source text CHECK (IN ('shopify','cj')),
  external_event_id text,                 -- X-Shopify-Webhook-Id / CJ requestId
  topic text, payload jsonb,
  received_at timestamptz, processed_at timestamptz,
  UNIQUE (source, external_event_id)
)
```

### Support

```sql
support_tickets (
  id uuid PK,
  gmail_thread_id text UNIQUE,
  customer_email text, subject text,
  status text CHECK (IN ('new','triaged','awaiting_approval','waiting_on_customer','resolved','escalated')),
  category text,                          -- triage output: where_is_my_order | return_refund | product_question | spam | other
  order_id uuid REFERENCES orders,        -- linked by triage when order number/email matches
  agent_session_id text,                  -- Agent SDK session — resumed on every new inbound message
  last_inbound_at timestamptz
)

support_messages (
  id uuid PK,
  ticket_id uuid REFERENCES support_tickets,
  gmail_message_id text UNIQUE,           -- dedup for history.list polling
  direction text CHECK (IN ('inbound','outbound')),
  from_email text, body_text text,
  rfc_message_id text,                    -- for In-Reply-To/References when replying
  sent_at timestamptz
)

gmail_sync_state ( id int PK DEFAULT 1, last_history_id bigint )   -- single row
```

### The approval gate (generic across workflows)

```sql
proposals (
  id uuid PK,
  type text CHECK (IN ('new_listing','support_reply','refund','deprecate_product')),
  status text CHECK (IN ('pending','approved','rejected','expired','applying','applied','failed')),
  summary text,                           -- one-paragraph human summary shown in email + dashboard
  payload jsonb,                          -- type-specific, zod-validated (see below)
  source_workflow text,                   -- 'sourcing' | 'support' | 'scoring'
  agent_run_id uuid REFERENCES agent_runs,
  ticket_id uuid, product_id uuid, order_id uuid,   -- nullable back-refs for dashboard context
  auto_approved boolean DEFAULT false,    -- true when the workflow toggle was 'auto' — row still exists for audit
  decided_by text,                        -- 'owner' | 'system:auto'
  decided_at timestamptz, applied_at timestamptz, apply_error text,
  action_token_hash text,                 -- sha256 of the one-click link token; nulled once decided
  expires_at timestamptz                  -- default now() + 7 days
)
```

`payload` shapes (zod schemas in `packages/core`): `new_listing` = full `productSet`-ready draft (title, description html, variants w/ price+cost+CJ vid, image URLs, category_tag, metafield values); `refund` = orderId, line items, amounts, whether to also open a CJ dispute (+ disputeReasonId from `disputeConfirmInfo`); `support_reply` = ticketId + full draft body; `deprecate_product` = productId + evidence metrics.

### Scoring, signals, agents, audit, config

```sql
product_scores (
  id uuid PK, product_id uuid, score_date date,
  units_sold_7d int, units_sold_28d int, revenue_28d_cents int,
  refund_count_28d int, ticket_count_28d int, days_live int,
  score numeric, verdict text CHECK (IN ('keep','watch','deprecate')),
  UNIQUE (product_id, score_date)
)

sourcing_signals (                        -- SourcingSignal adapter output; append-only history
  id uuid PK, source text CHECK (IN ('cj_trending','web_search','google_trends','owner_manual')),
  keyword text, supplier_product_id text,
  score numeric, evidence_url text, snapshot jsonb, fetched_at timestamptz
)

agent_runs (
  id uuid PK, workflow text, trigger_ref text,      -- e.g. ticket id, 'cron:2026-08-10'
  model text, session_id text,
  status text CHECK (IN ('running','succeeded','failed','aborted')),
  total_cost_usd numeric, model_usage jsonb, num_turns int,
  started_at timestamptz, finished_at timestamptz
)

agent_run_events ( id bigserial PK, run_id uuid, seq int, message jsonb )  -- every SDKMessage, full audit trail

audit_log (                               -- every externally-visible action by any actor
  id bigserial PK,
  actor text,                             -- 'fulfillment' | 'sourcing_agent' | 'support_agent' | 'owner' | 'admin_ui'
  action text,                            -- 'cj.createOrder', 'shopify.refundCreate', 'gmail.send', 'proposal.approve', …
  entity_type text, entity_id text,
  detail jsonb,                           -- request/response ids (CJ requestId!), amounts
  created_at timestamptz
)

settings ( key text PK, value jsonb, updated_at timestamptz )   -- see §7
cj_auth  ( id int PK DEFAULT 1, access_token text, access_expires_at timestamptz,
           refresh_token text, refresh_expires_at timestamptz )
admin_sessions ( id uuid PK, token_hash text, expires_at timestamptz )
agent_sessions ( session_id text PK, workflow text, transcript jsonb[] )   -- Agent SDK SessionStore backing table
```

---

## 3. Workflows end-to-end

Queue/cron names are literal pg-boss names. **Plain** = deterministic TypeScript, **LLM** = model call.

### (a) Weekly sourcing → listing proposal → Shopify product

**Trigger:** cron `sourcing.weekly` (pg-boss schedule, Mondays 06:00 owner-local).

1. **Plain — candidate harvest.** CJ `product/listV2` with `productFlag=0` (Trending) + `1` (New), pet category, `countryCode=US`, `verifiedWarehouse=1`, `orderBy=1`; ≤10 pages (≤500 pts, well inside the daily points budget). Normalize into `sourcing_signals` (source `cj_trending`). Dedupe against `supplier_variant_mappings` and recently-rejected proposals. Keep top ~15 candidates by margin potential (sell price bands vs cost).
2. **LLM — sourcing agent** (job `agent.sourcing`, one Agent SDK run, `claude-sonnet-5`, `effort: 'medium'`, `maxTurns: 25`, `maxBudgetUsd: 0.75`, `settingSources: []`, `tools: []` + allowlist `mcp__cj__*`, `WebSearch`, `WebFetch`). Tools: `cj.get_product_detail`, `cj.get_reviews`, `cj.get_stock`, `cj.quote_freight`. The agent triangulates (candidate must show demand evidence beyond CJ's shared trending list — web search sweep), picks ≤3 winners, and returns **structured output** (`outputFormat: json_schema`, draft-07): full listing drafts with title/description/price (target ≥60% gross margin after freight)/images/metafields.
3. **Plain — proposal.** Insert one `proposals(type='new_listing')` per draft, generate action token, email the owner (via Gmail client, from support@) with summary + Approve/Reject links + dashboard link. Email also carries the standing "check TikTok Creative Center (Pet Supplies, US, 7d) — paste anything interesting into the dashboard" manual ritual line.
4. **Gate.** Owner approves (one-click or dashboard, optionally after editing `payload` in the dashboard).
5. **Plain — apply** (job `sourcing.apply-proposal`, idempotent via proposal status transition `approved→applying` in one UPDATE … WHERE status='approved'):
   `productSet` (status DRAFT, variants, images via CJ CDN URLs as `originalSource`, metafields `dogebuddy.ships_from` / `dogebuddy.delivery_min_days` / `dogebuddy.delivery_max_days`) → flip ACTIVE → `publishablePublish` to the **Hydrogen storefront's publicationId** → `inventorySetQuantities` (@idempotent key = proposal id) → insert `products`/`product_variants`/`supplier_variant_mappings` → CJ `webhook/product/subscribe` for the pids. Mark proposal `applied`; audit-log every mutation.

### (b) Fulfillment: paid order → CJ purchase → tracking. **Zero LLM.**

**Trigger:** Shopify `orders/paid` webhook → `POST /webhooks/shopify` (verify `X-Shopify-Hmac-Sha256` against raw body; insert into `webhook_events` with `ON CONFLICT DO NOTHING` — if conflict, ack and stop; enqueue; **ack < 1s**).

Job chain (each job has pg-boss `singletonKey` = shopify order gid, retry with exponential backoff):

1. **`fulfillment.place-order`** (plain):
   - Load/insert `orders` row. **Abort permanently if `is_test`** (record, never call a real supplier — a Bogus-gateway order must never spend CJ wallet money).
   - Check `killswitch.global` and `workflow.fulfillment.enabled` settings → if off, mark `needs_attention`, notify owner, stop.
   - Upsert `supplier_orders` (`ON CONFLICT (order_id, supplier) DO NOTHING`); if row already ≥ `created`, skip to its current step (crash-safe resume).
   - Map line items → CJ vids via `supplier_variant_mappings`; unmapped item → `needs_attention` + owner email.
   - `adapter.getVariantStock()` re-verify **US** stock (search-time stock is volatile); if US stock gone → `needs_attention` (never silently ship from CN — breaks the delivery promise).
   - `adapter.quoteShipping({ fromCountry: 'US', … })`, pick cheapest option within the promised delivery window.
   - **Spend-cap gate (plain code, before any money moves):** projected total ≤ `fulfillment.spend_cap_per_order_cents` AND ≤ current wallet balance (`adapter.getBalance()`). Fail → `needs_attention`.
   - `adapter.placeOrder()` → CJ `createOrderV3` with `payType: 3` (create only), `shopLogisticsType: 1`, `orderNumber = idempotency_key` (CJ rejects duplicate orderNumbers — second layer of idempotency). Store `supplier_order_id`, `shipment_order_id`, actual `orderAmount`. Re-check actual `orderAmount` against the cap (quote drift). `confirmOrder` → status `confirmed` → enqueue next.
     > **[2026-08-23]** Live CJ differs: `shopLogisticsType: 2` (1 demands a `storageId`), `platform` is REQUIRED (and `api` in every casing is rejected — we send `shopify`), address fields are the `shipping*` names, `shipmentOrderId`/`orderAmount` come back **null** at creation, and CJ does **not** reject duplicate `orderNumber`s. `docs/cj-api-notes.md` is authoritative.
2. **`fulfillment.pay-order`** (plain): `payBalanceV2(shipmentOrderId)` → status `paid`. Error `1600100` (insufficient balance) → `needs_attention` + immediate owner "wallet empty" email. Keeping create and pay as separate jobs is the natural cap/kill-switch seam — flipping fulfillment off mid-flight strands orders at `confirmed`, spending nothing.
3. **Tracking:** CJ `LOGISTICS`/`ORDER` webhooks → `POST /webhooks/cj` (verify HmacSHA256 signature keyed on `openId`, dedupe, ack <3s) → enqueue **`fulfillment.sync-tracking`**: `adapter.getTracking()` → update `supplier_orders.tracking_number` → Shopify: query order `fulfillmentOrders` → `fulfillmentCreate` (line items, trackingInfo, `notifyCustomer: true`) or `fulfillmentTrackingInfoUpdate` on changes → store `shopify_fulfillment_gid`. Tracking then surfaces automatically on the customer's Hydrogen account order page.
4. **Safety nets (cron):**
   - `fulfillment.reconcile` hourly: Shopify `orders(query: "updated_at:>=<checkpoint>")` poll + CJ `getOrderDetailBatch` for all non-terminal `supplier_orders` — webhooks are hints, this is truth.
   - `cj.wallet-monitor` every 4h: `getBalance()`; below `fulfillment.wallet_alert_threshold_cents` (default 20 × average order cost) → owner email + dashboard banner. **This is the #1 full-auto risk (top-up is manual-only) — it gets its own job.**
   - `shopify.webhook-audit` daily: `webhookSubscriptions` query, re-create anything Shopify silently removed (8-retries/4h policy deletes failing subscriptions).
   - `cj.token-refresh` daily: refresh CJ access token at ~day 13 of 15; persist in `cj_auth`.

**Failure philosophy:** fulfillment never creates proposals; failures become `supplier_orders.status='needs_attention'` rows in the dashboard's Orders view + an owner email. An LLM adds nothing here.

### (c) Support: inbound email → triage → gated reply/refund

**Triggers:** cron `support.poll-gmail` every 45s (polling first — 2 quota units/call, zero Pub/Sub infra; upgrade to `users.watch` push later only if latency matters).

1. **Plain — ingest.** `users.history.list` from `gmail_sync_state.last_history_id` (on 404/expired historyId: full `messages.list` resync). New inbound messages → upsert `support_tickets` by `gmail_thread_id`, insert `support_messages`, apply Gmail label `DogeBuddy/New` (re-applied per message — thread labels don't inherit). Enqueue `support.handle-message` per ticket.
2. **LLM — triage** (single `claude-haiku-4-5` Messages API call, structured output): `{category, order_number?, sentiment, is_spam}`. Plain code links `order_id` by order number/email lookup. Spam → label `DogeBuddy/Resolved`, stop.
3. **LLM — support agent** (job `agent.support`, Agent SDK, `claude-sonnet-5`, `maxTurns: 20`, `maxBudgetUsd: 0.50`, `tools: []` + allowlist `mcp__gmail__read_thread`, `mcp__shopify__get_order`, `mcp__cj__get_tracking`, `mcp__cj__dispute_confirm_info`, `mcp__db__*` (read), and **`mcp__proposals__create_proposal`** — the *only* write tool). Session per ticket: first message creates a session, `agent_session_id` stored on the ticket; follow-ups `resume` it (Postgres `SessionStore` so sessions survive Railway redeploys). **The guardrail lives in the tool surface:** the agent cannot send email or move money; it can only look things up and file a proposal.
   - Simple question → `proposals(type='support_reply')` with draft body.
   - Refund request → agent calls `cj.dispute_confirm_info` first (valid reasons/amounts — never hardcoded), then `proposals(type='refund')` covering both the Shopify customer refund and the optional CJ dispute.
   - Ticket → `awaiting_approval`, label `DogeBuddy/AwaitingApproval`, owner email with the draft inline + Approve & Send / Reject links.
4. **Plain — apply** (`support.apply-proposal`):
   - `support_reply`: build RFC 2822 reply (matching Subject, `In-Reply-To`/`References` from the stored `rfc_message_id`) → `users.messages.send` with `{raw, threadId}` — idempotent via proposal status transition; label `WaitingOnCustomer`.
   - `refund`: Shopify `refundCreate` with **`@idempotent` key = proposal id** (mandatory on 2026-04 API; also makes queue retries safe) → then, if included, CJ `disputes/create` with `businessDisputeId = proposal id` → poll `getDisputeDetail` via a follow-up job until `finallyDeal`. CJ refunds land in *our wallet*; the customer refund is the Shopify step — both always recorded in `audit_log`.

### (d) Nightly scoring → deprecation proposal

**Trigger:** cron `scoring.nightly` 03:00 UTC.

1. **Plain.** SQL over `orders`/`supplier_orders`/`support_tickets` per product → insert `product_scores` (units 7d/28d, revenue, refund + ticket counts, days_live). Deterministic flag rules: e.g. `days_live ≥ 21 AND units_28d ≤ 1`, or `refund_count_28d / units_28d > 0.25` → candidate `deprecate`.
2. **LLM (one shot, optional).** For flagged products only: **one** plain Messages API structured-output call (`claude-sonnet-5`, no Agent SDK) with the metric table + recent trend signals → `{verdict, reasoning}` per product. Pure SQL flags with no judgment call skip this step entirely.
3. **Plain.** `proposals(type='deprecate_product')` with evidence; weekly digest email rather than per-product noise. On approval (`scoring.apply-proposal`): Shopify product → DRAFT, unpublish from Hydrogen publication, `products.status='deprecated'`, CJ `webhook/product/unsubscribe`. Never auto-delete.

---

## 4. SupplierAdapter interface

Lives in `packages/supplier`. **One implementation, two consumers:** called directly by the deterministic fulfillment pipeline, and wrapped thinly as MCP tools for agents.

```ts
// packages/supplier/src/types.ts
export type SupplierKey = 'cj' | 'mock';           // future: 'supacolor'

export interface SupplierAdapter {
  readonly key: SupplierKey;

  // -- discovery (sourcing agent) --
  searchProducts(q: {
    keyword?: string; categoryId?: string; countryCode?: string;
    trending?: boolean; page?: number; pageSize?: number;
    minPrice?: number; maxPrice?: number;
  }): Promise<SupplierProductSummary[]>;
  getProduct(supplierProductId: string): Promise<SupplierProductDetail>;      // variants, images, weights, reviews count

  // -- pre-order checks (fulfillment + sourcing) --
  getVariantStock(supplierVariantId: string): Promise<WarehouseStock[]>;      // per-warehouse, incl. country + verified flag
  quoteShipping(q: {
    fromCountry: string; toCountry: string; toZip?: string;
    items: { supplierVariantId: string; quantity: number }[];
  }): Promise<ShippingOption[]>;                    // { name, priceCents, minDays, maxDays }

  // -- order lifecycle (fulfillment; placeOrder MUST be idempotent on idempotencyKey) --
  placeOrder(req: {
    idempotencyKey: string;                         // becomes CJ orderNumber
    shippingAddress: Address;
    items: { supplierVariantId: string; quantity: number }[];
    logisticName: string; fromCountry: string;
  }): Promise<{ supplierOrderId: string; shipmentOrderId?: string;
                productAmountCents: number; postageAmountCents: number; totalAmountCents: number }>;
  confirmOrder(supplierOrderId: string): Promise<void>;
  payOrder(shipmentOrderId: string): Promise<{ paid: boolean; failureReason?: 'insufficient_balance' | string }>;
  getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus>;      // normalized enum
  getTracking(supplierOrderId: string): Promise<TrackingInfo | null>;         // null until shipped

  // -- money & disputes (wallet monitor, support agent) --
  getBalance(): Promise<{ availableCents: number; frozenCents: number }>;
  getDisputeOptions(supplierOrderId: string): Promise<DisputeOptions>;        // valid reasons + max amounts (confirm step)
  openDispute(req: { supplierOrderId: string; idempotencyKey: string; reasonId: string;
                     kind: 'refund' | 'reissue'; amountCents: number;
                     message: string; evidenceUrls?: string[] }): Promise<{ disputeId: string }>;
  getDispute(disputeId: string): Promise<DisputeStatus>;                      // pending | refunded | reissued | rejected

  // -- webhooks --
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): boolean;
  parseWebhook(rawBody: Buffer): SupplierWebhookEvent;                        // normalized {type:'order'|'logistics'|'stock', …}
}
```

**CJ implementation notes** (`adapters/cj/`): one shared HTTP client with (1) token manager persisting to `cj_auth` (reuse ~15 days, refresh ~day 13, never fetch per request — tokens are server-cached 24h); (2) a **global 1-rps token bucket** (free tier QPS) with 429/`pointsInfo` backoff; (3) a daily points-budget counter (list calls = 50 pts) that hard-stops sourcing crawls before starving fulfillment; (4) uniform `{code,result,message,data,requestId}` envelope handling, logging `requestId` into `audit_log` on every failure; (5) a `sandbox: boolean` constructor flag wiring `createOrderV3`'s sandbox mode + `simulatePay`/`updateStatus`/`updateTrackNumber` helpers for tests.

**MockSupplierAdapter** (`adapters/mock/`): in-memory catalog of 3 fake dog products, instant deterministic responses, `placeOrder` records to a table, an admin/test endpoint advances status `created→paid→shipped(+tracking)→delivered`. Used in Phase 3 E2E tests and available in the dev environment via `SUPPLIER=mock`.

**Where apparel slots in later:** a future POD adapter implements the same `SupplierAdapter` (its `placeOrder` items just reference POD SKUs) **plus** a separate capability interface — `interface PrintOnDemandCapable { submitArtwork(...): Promise<PrintAssetRef>; }` — discovered via a type guard. Nothing in v1 references it; the only v1 concession is that `supplier` is a column, not a constant, everywhere.

---

## 5. Admin dashboard & one-click links

Routes inside `apps/ops` (server-rendered EJS/JSX-lite pages + a sprinkle of htmx-style forms — no SPA build). Auth: single owner, **magic-link login** (email a link to the owner address → `admin_sessions` cookie, 30-day expiry). No user management.

**Pages (the whole v1 scope):**

| Route | Content |
|---|---|
| `/admin` | Health strip: CJ wallet balance + alert state, queue depth, last webhook received, kill-switch states; pending-proposal count |
| `/admin/proposals` | Queue, filterable by type/status. Detail view renders the typed payload (listing preview with images; reply draft; refund breakdown) with **Approve / Reject / Edit-then-approve** (edit = JSON form patch of `payload`, re-validated by zod) |
| `/admin/orders` | `orders` ⋈ `supplier_orders` list; `needs_attention` pinned on top with a Retry button (re-enqueues the stalled job) |
| `/admin/tickets` | Ticket list + thread view (from `support_messages`), manual "escalate to me" takeover button (sets `escalated`, stops the agent) |
| `/admin/settings` | Kill switches + per-workflow auto/manual toggles + spend caps (writes `settings`), owner-manual signal paste box (→ `sourcing_signals`) |
| `/admin/runs` | `agent_runs` list with cost, drill into `agent_run_events` transcript |

**Signed one-click email links.** On proposal creation: `token = randomBytes(32).base64url`; store `sha256(token)` in `proposals.action_token_hash`. Links:

```
https://ops.dogebuddy.com/a/<proposalId>/approve?t=<token>
https://ops.dogebuddy.com/a/<proposalId>/reject?t=<token>
```

`GET` renders a confirmation page (summary + a real `<form method=POST>` button — email scanners prefetch GETs, so **GET never mutates**). `POST` verifies hash, checks `status='pending'` and `expires_at`, transitions atomically (`UPDATE … WHERE status='pending'`), nulls the token hash (single use), enqueues the apply job, audit-logs `proposal.approve` with actor `owner`. Expired/used → friendly "already handled / open dashboard" page.

---

## 6. Hydrogen storefront v1 scope

**Scaffold:** `npm create @shopify/hydrogen@latest -- --language ts --styling tailwind --markets none`, then `shopify hydrogen link` + `env pull`. Pin `@shopify/hydrogen` 2026.4.x / CLI 13.x / RR 7.16.x; keep the skeleton's conventions untouched (fs-routes, `+types/`, `createHydrogenContext`). Do **not** touch the framework-neutral developer preview.

**Pages (skeleton routes, restyled — near-zero new routes):** home (hero + featured collection + trust strip: "Ships from US warehouses · 3–7 day delivery"), `collections.$handle` + `collections.all`, `products.$handle`, cart (hosted checkout via `cart.checkoutUrl` — no custom checkout, ever), search, `policies.*` (shipping, returns/refunds, privacy naming CJ + Google Workspace as processors — Shopify Payments prerequisites), account.* skeleton unchanged (order history + tracking surfaces automatically from our `fulfillmentCreate` pushes — this **is** the tracking page, build nothing).

**Collections:** four automated Shopify collections keyed on the sourcing agent's `category_tag` product tag — **Toys & Play, Walks & Travel, Beds & Comfort, Grooming & Care** — plus "All". Nav is those five links. No mega-menu, no manual curation.

**Delivery badge:** PDP query adds `shipsFrom: metafield(namespace:"dogebuddy", key:"ships_from")`, `deliveryMin/Max` metafields (definitions created by ops via Admin API with `access.storefront: PUBLIC_READ` — without that they're invisible). Renders a beige badge: "🇺🇸 Ships from US warehouse — arrives in 3–7 days".

**Brand:** Tailwind v4 `@theme` tokens in `tailwind.css` (`--color-ink:#10171a; --color-doge-red:#ff3641; --color-cream:#ffe3ae; --color-amber:#ffb327; --color-cerulean:#145069; --color-blue:#005ec2; --color-cyan:#00e1ff;` + gold gradient utility `#bb6402→#f6ce18→#f5f39e` for CTAs/accents). Fonts self-hosted woff2 in `public/fonts` with `@font-face` + `font-display: swap`, preload the display font in `root.tsx`; **verify FunkyDori's webfont-embedding license before shipping it — Poppins (OFL) is the fallback display face if it's not licensed.** FunkyDori for headings/logo lockups only; Poppins for everything else.

**Include in v1 (cheap, high-value):** Product JSON-LD + Organization/WebSite JSON-LD via `getSeoMeta`'s `jsonLd`; the skeleton's sitemap/robots as-is.

**Skip in v1:** blog, markets/i18n/currency (US-only), reviews, wishlists, discounts UI beyond the skeleton's `discount.$code`, subscriptions, email-capture popups, custom order-tracking page, A/B anything, predictive-search tuning, cookie-consent banner (revisit at launch; backend consent mode is on by default in 2026.4).

---

## 7. Config, secrets, and the auto/manual toggle

**Secrets (Railway env for ops; Hydrogen channel env for storefront; `.env` local via `env pull` — never committed):**

```
# ops
DATABASE_URL
SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET       # client-credentials grant, 24h tokens
SHOPIFY_WEBHOOK_SECRET                                              # = client secret (HMAC)
CJ_API_KEY, CJ_OPEN_ID                                              # openId = CJ webhook HMAC key
GOOGLE_SA_KEY_JSON, GMAIL_IMPERSONATE=support@dogebuddy.com          # DWD service account, gmail.modify scope only
ANTHROPIC_API_KEY                                                   # API-key auth (required by SDK ToS for commercial use)
ADMIN_BASE_URL, SESSION_SECRET, OWNER_EMAIL=robert@closingbrackets.com
SUPPLIER=cj|mock                                                    # adapter selection per environment
# storefront (managed by Hydrogen channel)
SESSION_SECRET, PUBLIC_STORE_DOMAIN, PUBLIC_STOREFRONT_API_TOKEN, PUBLIC_CUSTOMER_ACCOUNT_API_CLIENT_ID
```

**Runtime config = the `settings` table** (editable at `/admin/settings`, no redeploy):

```
killswitch.global                       = false      # true ⇒ every job no-ops at its gate check
workflow.fulfillment.enabled            = true       # fulfillment is on/off, not auto/manual — it's always automatic per locked decision
workflow.sourcing.mode                  = 'manual'   # 'manual' | 'auto'
workflow.support_reply.mode             = 'manual'
workflow.refund.mode                    = 'manual'
workflow.deprecation.mode               = 'manual'
fulfillment.spend_cap_per_order_cents   = 7500
fulfillment.wallet_alert_threshold_cents= 40000
support.poll_interval_seconds           = 45
```

**Toggle mechanism (one code path, no branching sprawl):** every workflow *always* creates a `proposals` row. A single function `submitProposal(p)` checks `workflow.<type>.mode`: `manual` → status `pending`, token, owner email; `auto` → status `approved`, `auto_approved=true`, `decided_by='system:auto'`, apply job enqueued immediately. Flipping a workflow to full-auto later is a settings row change; the audit trail and dashboard visibility are identical in both modes. (Refund auto mode additionally enforces a `refund.auto_max_cents` cap — above it, always manual.)

---

## 8. Phased build order

Each phase ends with explicit verification; nothing depends on a later phase.

**Phase 0 — Foundations (repo + rails).** pnpm workspace, `tsconfig.base`, `packages/core` + `packages/db` (full schema above, drizzle migrations), pg-boss wired, Fastify skeleton with `/healthz`, CI (typecheck+test+migration check), deploy ops to Railway with Postgres.
*Verify:* migrations apply on fresh DB; a `demo.ping` job enqueued via a script executes on the deployed instance; `/healthz` green.

**Phase 1 — Shopify + supplier plumbing (no UI, no agents).** Create the **Partner Dashboard client-transfer store** (⚠️ *not* a Dev Dashboard dev store — that type can't convert at launch; confirm with Shopify support first). Create the `doge-buddy-ops` app in the Dev Dashboard, scopes per digest (incl. requesting `read_all_orders` approval now). Build `packages/shopify-admin` (token manager for 24h client-credentials tokens, pinned 2026-07) and the webhook receiver (HMAC, `webhook_events` dedup, enqueue-then-ack) + `shopify.webhook-audit` job. Build `packages/supplier` interface + **MockSupplierAdapter** + CJ auth/token manager + rate-limited client (fixture-tested).
> **[2026-08-23]** Store + custom-distribution app created; the support confirmation was deliberately skipped (risk accepted) — see `docs/OWNER-CHECKLIST.md`.
*Verify:* script creates a DRAFT product via `productSet` and it appears in admin; a manually-placed dev-store order fires `orders/paid` into `webhook_events` exactly once (replay the delivery → dedup proves out); CJ `getAccessToken`→`getBalance` round-trip succeeds against the real API; mock adapter passes the shared adapter contract test suite.

**Phase 2 — Storefront.** Scaffold Hydrogen, link to the store, apply brand tokens/fonts, PDP metafield badge, JSON-LD, collections, policies pages. Oxygen GitHub integration (preview deploys — note dev stores get 0 public environments; previews are private, fine for now).
*Verify:* full browse→cart→**Bogus Gateway** checkout on the dev store (amount > $1); order appears in Shopify admin flagged `test`; Lighthouse pass on home/PDP; fonts/colors render on preview URL. Mind the anecdotal ~10 test-order cap — cancel test orders as you go.

**Phase 3 — Fulfillment pipeline (the money path).** Implement jobs (b) end-to-end against **MockSupplierAdapter**, then the CJ adapter's order methods, then CJ webhooks + reconcile + wallet monitor.
*Verify — E2E without real money, two layers:*
1. *Mock layer:* Bogus test order on dev store → (temporarily allow `is_test` in the dev environment **only when `SUPPLIER=mock`**) → mock order placed → test endpoint advances to shipped with fake tracking → assert Shopify fulfillment created, tracking visible on the account order page, `supplier_orders` terminal, audit rows present. Also test: cap exceeded → `needs_attention`; duplicate webhook → single supplier order; kill switch mid-flight → stalls at `confirmed`, resumes on re-enable.
2. *CJ sandbox layer:* integration test with `sandbox` flag: `createOrderV3` → `confirmOrder` → `sandbox/simulatePay` → `sandbox/updateStatus` 300→400→500→600→700 + `updateTrackNumber` → assert full status/tracking sync into our tables and Shopify.
Production guard re-verified: real code path hard-skips `is_test` orders.

**Phase 4 — Proposals, admin dashboard, one-click links.** `proposals` machinery, `submitProposal` with mode switch, magic-link auth, all `/admin` pages, signed action links, settings editor.
*Verify:* seed a fake `new_listing` proposal → email arrives → one-click approve creates a real DRAFT→ACTIVE product on the dev store, published to the Hydrogen publication, visible on the storefront; second click on the same link is rejected; reject path + expiry path tested; toggle flip to `auto` bypasses the email and still writes the audit trail.

**Phase 5 — Sourcing agent.** MCP tool servers for CJ (`packages/supplier` wrapped via `tool()`/`createSdkMcpServer`), Agent SDK runner with budget/turn caps + `agent_runs`/`agent_run_events` persistence, structured-output listing schema (draft-07!), weekly cron, signal storage.
*Verify:* trigger `sourcing.weekly` manually → inspect the run transcript in `/admin/runs` → proposals contain valid `productSet` payloads with real CJ vids and US stock → approve one → live product on storefront with correct margin, images, badge; cost per run recorded and < budget; points consumption logged < 25k.

**Phase 6 — Support agent.** Workspace user support@, DNS (SPF → DKIM 2048 → wait 48h → DMARC `p=none`), GCP project + service account + DWD (`gmail.modify` only), `packages/gmail`, polling ingest, Haiku triage, Agent SDK support runner with Postgres SessionStore, reply/refund apply jobs.
*Verify:* send a test email from a personal address → ticket + labels appear; agent files a `support_reply` proposal; approve → threaded reply lands correctly in Gmail *and* Outlook (threading headers proof); refund path: test order → refund proposal → approve → Shopify refund with idempotency key (retry the job, assert no double refund); follow-up email resumes the same session id; redeploy ops mid-thread and confirm session resume still works (SessionStore proof).

**Phase 7 — Scoring + launch.** `scoring.nightly` + deprecation proposals (verify against seeded synthetic sales data: correct flags, digest email, approved deprecation unpublishes). **Launch cutover checklist:** transfer store ownership to the Closing Brackets LLC merchant account → pick Basic plan → make Oxygen production environment public → attach custom domain as Primary → re-register Customer Account API URIs for the production domain → enable Shopify Payments + Shopify Tax (US registrations) → publish final policy pages → merge SPF records (Google + Shopify) into the single TXT → real $5 self-purchase as the final E2E: paid order → CJ auto-purchase (real wallet, small top-up) → tracking → delivery → then flip `workflow.fulfillment.enabled` confidence and go live.

**Standing operations after launch:** monthly CJ docs re-check (CJ's own recommendation), quarterly Shopify API version bump calendar item, weekly TikTok manual ritual in the sourcing email, DMARC tightening `none→quarantine→reject` as reports come clean, and watch Sonnet pricing revert to $3/$15 after 2026-08-31 in the budget assumptions.