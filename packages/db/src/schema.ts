import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, numeric,
  pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())

export const productStatus = pgEnum('product_status', ['draft', 'active', 'deprecated'])
export const supplierKey = pgEnum('supplier_key', ['cj', 'mock'])
export const supplierOrderStatus = pgEnum('supplier_order_status', [
  'pending', 'created', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled', 'failed', 'needs_attention',
  'awaiting_funds',
])
export const webhookSource = pgEnum('webhook_source', ['shopify', 'cj'])
export const ticketStatus = pgEnum('ticket_status', [
  'new', 'triaged', 'awaiting_approval', 'waiting_on_customer', 'resolved', 'escalated',
])
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])
export const proposalType = pgEnum('proposal_type', ['new_listing', 'support_reply', 'refund', 'deprecate_product'])
export const proposalStatus = pgEnum('proposal_status', [
  'pending', 'approved', 'rejected', 'expired', 'applying', 'applied', 'failed',
])
export const scoreVerdict = pgEnum('score_verdict', ['keep', 'watch', 'deprecate'])
export const agentRunStatus = pgEnum('agent_run_status', ['running', 'succeeded', 'failed', 'aborted'])
export const signalSource = pgEnum('signal_source', ['cj_trending', 'web_search', 'google_trends', 'owner_manual'])

// -- Catalog --
export const products = pgTable('products', {
  id: id(),
  shopifyProductGid: text('shopify_product_gid').unique(),
  handle: text('handle'),
  title: text('title'),
  status: productStatus('status').notNull().default('draft'),
  categoryTag: text('category_tag'),
  createdFromProposalId: uuid('created_from_proposal_id'),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const productVariants = pgTable('product_variants', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  shopifyVariantGid: text('shopify_variant_gid').unique(),
  shopifyInventoryItemGid: text('shopify_inventory_item_gid'),
  sku: text('sku').notNull().unique(),
  priceCents: integer('price_cents').notNull(),
  compareAtCents: integer('compare_at_cents'),
  supplierCostCents: integer('supplier_cost_cents'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supplierVariantMappings = pgTable('supplier_variant_mappings', {
  id: id(),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id),
  supplier: supplierKey('supplier').notNull(),
  supplierProductId: text('supplier_product_id').notNull(),
  supplierVariantId: text('supplier_variant_id').notNull(),
  warehouseCountry: text('warehouse_country').notNull().default('US'),
  lastKnownStock: integer('last_known_stock'),
  stockCheckedAt: timestamp('stock_checked_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('svm_variant_supplier_uq').on(t.variantId, t.supplier)])

// -- Orders & fulfillment --
export const orders = pgTable('orders', {
  id: id(),
  shopifyOrderGid: text('shopify_order_gid').notNull().unique(),
  shopifyOrderNumber: text('shopify_order_number'),
  email: text('email'),
  customerName: text('customer_name'),
  isTest: boolean('is_test').notNull(),
  financialStatus: text('financial_status'),
  fulfillmentStatus: text('fulfillment_status'),
  totalCents: integer('total_cents'),
  shippingAddress: jsonb('shipping_address'),
  rawPayload: jsonb('raw_payload'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supplierOrders = pgTable('supplier_orders', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  supplier: supplierKey('supplier').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: supplierOrderStatus('status').notNull().default('pending'),
  supplierOrderId: text('supplier_order_id'),
  shipmentOrderId: text('shipment_order_id'),
  logisticName: text('logistic_name'),
  productAmountCents: integer('product_amount_cents'),
  postageAmountCents: integer('postage_amount_cents'),
  totalAmountCents: integer('total_amount_cents'),
  trackingNumber: text('tracking_number'),
  trackingSyncedToShopifyAt: timestamp('tracking_synced_to_shopify_at', { withTimezone: true }),
  // The `tracking_number` value that was actually pushed to Shopify as of
  // `tracking_synced_to_shopify_at` — distinct from `tracking_number` itself, which can change
  // again after a sync (e.g. a carrier correction). `run-sync-tracking.ts` compares the two to
  // decide no-op vs. update without needing a second round-trip to Shopify.
  trackingSyncedValue: text('tracking_synced_value'),
  shopifyFulfillmentGid: text('shopify_fulfillment_gid'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('supplier_orders_order_supplier_uq').on(t.orderId, t.supplier),
  // Guards `findCjSupplierOrder`'s (apps/ops) unordered, unlimited SELECT keyed on
  // (supplier, supplier_order_id) — without this, a colliding supplier_order_id (e.g. from a
  // supplier-side id reuse, or a bug elsewhere) could make that lookup silently return the wrong
  // row. Partial (WHERE supplier_order_id IS NOT NULL) because the column is legitimately NULL
  // for every row that hasn't been placed with the supplier yet (multiple such rows are normal
  // and must not collide with each other).
  uniqueIndex('supplier_orders_supplier_supplier_order_id_uq')
    .on(t.supplier, t.supplierOrderId)
    .where(sql`${t.supplierOrderId} IS NOT NULL`),
])

export const webhookEvents = pgTable('webhook_events', {
  id: id(),
  source: webhookSource('source').notNull(),
  externalEventId: text('external_event_id').notNull(),
  topic: text('topic'),
  payload: jsonb('payload'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('webhook_events_source_event_uq').on(t.source, t.externalEventId)])

// -- Support --
export const supportTickets = pgTable('support_tickets', {
  id: id(),
  gmailThreadId: text('gmail_thread_id').notNull().unique(),
  customerEmail: text('customer_email'),
  subject: text('subject'),
  status: ticketStatus('status').notNull().default('new'),
  category: text('category'),
  orderId: uuid('order_id').references(() => orders.id),
  agentSessionId: text('agent_session_id'),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  sentiment: text('sentiment'),
  isSpam: boolean('is_spam'),
  escalationReason: text('escalation_reason'),
  lastTriagedAt: timestamp('last_triaged_at', { withTimezone: true }),
  triageFailureCount: integer('triage_failure_count').notNull().default(0),
  claimedOrderNumber: text('claimed_order_number'),
  // Whether the ticket's LATEST inbound message sat in Gmail's own SPAM folder at ingest time
  // (ingest keeps it in step with last_inbound_at). Read by triage's pre-LLM spam short-circuit:
  // Gmail-spam + no order on file + no tripwire → deprioritized behind real mail and, at the daily
  // cap (or always, by setting), resolved as spam without a model call. A follow-up that lands in
  // the INBOX flips it back to false.
  gmailSpam: boolean('gmail_spam').notNull().default(false),
  // CRITICAL-1 (binding, referenced across ingest/triage/agent-run/agent-select/run-apply/admin):
  // every UPDATE that transitions a ticket INTO 'escalated' clears this, or a ticket escalated+
  // notified once, then resolved, then re-escalated stays permanently invisible to
  // notifyPendingEscalations' `escalation_notified_at IS NULL` selection. Task 7 convention: an
  // escalate/resolve/waiting_on_customer write that leaves the redraft cycle must ALSO clear the two
  // redraft columns below — spread `...clearRedraftCycle()` (support/redraft.ts) beside this field.
  escalationNotifiedAt: timestamp('escalation_notified_at', { withTimezone: true }),
  // Three deliberately distinct support-agent watermarks (6B §1):
  //  - last_agent_run_at:      stamped at CLAIM, before the SDK call — the loop/claim guard.
  //  - last_agent_finished_at: stamped on every authoritative outcome — wall-clock, and the ONLY
  //    column comparable to last_agent_run_at. `run_at` newer than `finished_at` means "claimed but
  //    never finished", which is what stuck-run recovery detects.
  //  - last_agent_prompted_at: the ticket's own MESSAGE-time prompt watermark (set to the run's
  //    thread snapshot), used to filter a resumed run's thread. NOT comparable to the two above.
  lastAgentRunAt: timestamp('last_agent_run_at', { withTimezone: true }),
  lastAgentPromptedAt: timestamp('last_agent_prompted_at', { withTimezone: true }),
  lastAgentFinishedAt: timestamp('last_agent_finished_at', { withTimezone: true }),
  agentFailureCount: integer('agent_failure_count').notNull().default(0),
  // Reject-with-reason re-draft loop (spec §3): the owner's latest rejection instruction for the
  // agent's next resumed run, and how many re-draft cycles this draft has been through (caps at
  // SUPPORT_REDRAFT_MAX). Both cleared/reset when the ticket leaves the cycle (apply/escalate/resolve).
  ownerRedraftFeedback: text('owner_redraft_feedback'),
  redraftCount: integer('redraft_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const supportMessages = pgTable('support_messages', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => supportTickets.id),
  gmailMessageId: text('gmail_message_id').notNull().unique(),
  direction: messageDirection('direction').notNull(),
  fromEmail: text('from_email'),
  bodyText: text('body_text'),
  rfcMessageId: text('rfc_message_id'),
  authResults: text('auth_results'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const gmailSyncState = pgTable('gmail_sync_state', {
  id: integer('id').primaryKey().default(1),
  lastHistoryId: bigint('last_history_id', { mode: 'bigint' }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  updatedAt: updatedAt(),
})

// -- Approval gate --
export const proposals = pgTable('proposals', {
  id: id(),
  type: proposalType('type').notNull(),
  status: proposalStatus('status').notNull().default('pending'),
  summary: text('summary').notNull(),
  payload: jsonb('payload').notNull(),
  sourceWorkflow: text('source_workflow').notNull(),
  agentRunId: uuid('agent_run_id'),
  ticketId: uuid('ticket_id'),
  productId: uuid('product_id'),
  orderId: uuid('order_id'),
  autoApproved: boolean('auto_approved').notNull().default(false),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  applyError: text('apply_error'),
  actionTokenHash: text('action_token_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('proposals_status_idx').on(t.status)])

// -- Scoring & signals --
export const productScores = pgTable('product_scores', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id),
  scoreDate: date('score_date').notNull(),
  unitsSold7d: integer('units_sold_7d').notNull().default(0),
  unitsSold28d: integer('units_sold_28d').notNull().default(0),
  revenue28dCents: integer('revenue_28d_cents').notNull().default(0),
  refundCount28d: integer('refund_count_28d').notNull().default(0),
  ticketCount28d: integer('ticket_count_28d').notNull().default(0),
  daysLive: integer('days_live').notNull().default(0),
  score: numeric('score'),
  verdict: scoreVerdict('verdict'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('product_scores_product_date_uq').on(t.productId, t.scoreDate)])

export const sourcingSignals = pgTable('sourcing_signals', {
  id: id(),
  source: signalSource('source').notNull(),
  keyword: text('keyword'),
  supplierProductId: text('supplier_product_id'),
  score: numeric('score'),
  evidenceUrl: text('evidence_url'),
  snapshot: jsonb('snapshot'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// -- Agents, audit, config --
export const agentRuns = pgTable('agent_runs', {
  id: id(),
  workflow: text('workflow').notNull(),
  triggerRef: text('trigger_ref'),
  model: text('model'),
  sessionId: text('session_id'),
  status: agentRunStatus('status').notNull().default('running'),
  totalCostUsd: numeric('total_cost_usd'),
  modelUsage: jsonb('model_usage'),
  numTurns: integer('num_turns'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const agentRunEvents = pgTable('agent_run_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id),
  seq: integer('seq').notNull(),
  message: jsonb('message').notNull(),
  createdAt: createdAt(),
})

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  detail: jsonb('detail'),
  createdAt: createdAt(),
}, (t) => [index('audit_log_action_idx').on(t.action), index('audit_log_entity_idx').on(t.entityType, t.entityId)])

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})

export const cjAuth = pgTable('cj_auth', {
  id: integer('id').primaryKey().default(1),
  accessToken: text('access_token'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  refreshToken: text('refresh_token'),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
  updatedAt: updatedAt(),
})

export const adminSessions = pgTable('admin_sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const agentSessions = pgTable('agent_sessions', {
  sessionId: text('session_id').primaryKey(),
  workflow: text('workflow'),
  transcript: jsonb('transcript'),
  updatedAt: updatedAt(),
})

export const agentSessionEntries = pgTable('agent_session_entries', {
  seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
  projectKey: text('project_key').notNull(),
  sessionId: text('session_id').notNull(),
  subpath: text('subpath').notNull().default(''),
  uuid: text('uuid'),
  entry: jsonb('entry').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('agent_session_entries_uuid_uq').on(t.sessionId, t.subpath, t.uuid).where(sql`${t.uuid} IS NOT NULL`),
  index('agent_session_entries_lookup_idx').on(t.projectKey, t.sessionId, t.subpath, t.seq),
])
