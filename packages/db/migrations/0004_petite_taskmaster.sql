ALTER TABLE "gmail_sync_state" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_sync_state" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "sentiment" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "is_spam" boolean;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "triage_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "claimed_order_number" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalation_notified_at" timestamp with time zone;