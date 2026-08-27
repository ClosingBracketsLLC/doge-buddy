CREATE TABLE "agent_session_entries" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"session_id" text NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"uuid" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "auth_results" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_agent_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_agent_prompted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "agent_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_entries_uuid_uq" ON "agent_session_entries" USING btree ("session_id","subpath","uuid") WHERE "agent_session_entries"."uuid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_session_entries_lookup_idx" ON "agent_session_entries" USING btree ("project_key","session_id","subpath","seq");