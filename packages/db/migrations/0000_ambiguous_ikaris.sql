CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'applying', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proposal_type" AS ENUM('new_listing', 'support_reply', 'refund', 'deprecate_product');--> statement-breakpoint
CREATE TYPE "public"."score_verdict" AS ENUM('keep', 'watch', 'deprecate');--> statement-breakpoint
CREATE TYPE "public"."signal_source" AS ENUM('cj_trending', 'web_search', 'google_trends', 'owner_manual');--> statement-breakpoint
CREATE TYPE "public"."supplier_key" AS ENUM('cj', 'mock');--> statement-breakpoint
CREATE TYPE "public"."supplier_order_status" AS ENUM('pending', 'created', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled', 'failed', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'triaged', 'awaiting_approval', 'waiting_on_customer', 'resolved', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."webhook_source" AS ENUM('shopify', 'cj');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow" text NOT NULL,
	"trigger_ref" text,
	"model" text,
	"session_id" text,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"total_cost_usd" numeric,
	"model_usage" jsonb,
	"num_turns" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workflow" text,
	"transcript" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_auth" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"access_token" text,
	"access_expires_at" timestamp with time zone,
	"refresh_token" text,
	"refresh_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_history_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_order_gid" text NOT NULL,
	"shopify_order_number" text,
	"email" text,
	"customer_name" text,
	"is_test" boolean NOT NULL,
	"financial_status" text,
	"fulfillment_status" text,
	"total_cents" integer,
	"shipping_address" jsonb,
	"raw_payload" jsonb,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_shopify_order_gid_unique" UNIQUE("shopify_order_gid")
);
--> statement-breakpoint
CREATE TABLE "product_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"score_date" date NOT NULL,
	"units_sold_7d" integer DEFAULT 0 NOT NULL,
	"units_sold_28d" integer DEFAULT 0 NOT NULL,
	"revenue_28d_cents" integer DEFAULT 0 NOT NULL,
	"refund_count_28d" integer DEFAULT 0 NOT NULL,
	"ticket_count_28d" integer DEFAULT 0 NOT NULL,
	"days_live" integer DEFAULT 0 NOT NULL,
	"score" numeric,
	"verdict" "score_verdict",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"shopify_variant_gid" text,
	"shopify_inventory_item_gid" text,
	"sku" text NOT NULL,
	"price_cents" integer NOT NULL,
	"compare_at_cents" integer,
	"supplier_cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_shopify_variant_gid_unique" UNIQUE("shopify_variant_gid"),
	CONSTRAINT "product_variants_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_product_gid" text,
	"handle" text,
	"title" text,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"category_tag" text,
	"created_from_proposal_id" uuid,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_shopify_product_gid_unique" UNIQUE("shopify_product_gid")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "proposal_type" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_workflow" text NOT NULL,
	"agent_run_id" uuid,
	"ticket_id" uuid,
	"product_id" uuid,
	"order_id" uuid,
	"auto_approved" boolean DEFAULT false NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"action_token_hash" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcing_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "signal_source" NOT NULL,
	"keyword" text,
	"supplier_product_id" text,
	"score" numeric,
	"evidence_url" text,
	"snapshot" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"supplier" "supplier_key" NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "supplier_order_status" DEFAULT 'pending' NOT NULL,
	"supplier_order_id" text,
	"shipment_order_id" text,
	"logistic_name" text,
	"product_amount_cents" integer,
	"postage_amount_cents" integer,
	"total_amount_cents" integer,
	"tracking_number" text,
	"tracking_synced_to_shopify_at" timestamp with time zone,
	"shopify_fulfillment_gid" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "supplier_variant_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier" "supplier_key" NOT NULL,
	"supplier_product_id" text NOT NULL,
	"supplier_variant_id" text NOT NULL,
	"warehouse_country" text DEFAULT 'US' NOT NULL,
	"last_known_stock" integer,
	"stock_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"from_email" text,
	"body_text" text,
	"rfc_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_gmail_message_id_unique" UNIQUE("gmail_message_id")
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"customer_email" text,
	"subject" text,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"category" text,
	"order_id" uuid,
	"agent_session_id" text,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_gmail_thread_id_unique" UNIQUE("gmail_thread_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "webhook_source" NOT NULL,
	"external_event_id" text NOT NULL,
	"topic" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_scores" ADD CONSTRAINT "product_scores_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_variant_mappings" ADD CONSTRAINT "supplier_variant_mappings_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_scores_product_date_uq" ON "product_scores" USING btree ("product_id","score_date");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_orders_order_supplier_uq" ON "supplier_orders" USING btree ("order_id","supplier");--> statement-breakpoint
CREATE UNIQUE INDEX "svm_variant_supplier_uq" ON "supplier_variant_mappings" USING btree ("variant_id","supplier");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_event_uq" ON "webhook_events" USING btree ("source","external_event_id");