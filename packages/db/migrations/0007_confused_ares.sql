ALTER TABLE "support_tickets" ADD COLUMN "owner_redraft_feedback" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "redraft_count" integer DEFAULT 0 NOT NULL;