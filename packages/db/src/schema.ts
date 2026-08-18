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
}, (t) => [uniqueIndex('supplier_orders_order_supplier_uq').on(t.orderId, t.supplier)])

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
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const gmailSyncState = pgTable('gmail_sync_state', {
  id: integer('id').primaryKey().default(1),
  lastHistoryId: bigint('last_history_id', { mode: 'bigint' }),
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
