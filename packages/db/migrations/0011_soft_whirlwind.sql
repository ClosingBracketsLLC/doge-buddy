ALTER TYPE "public"."signal_source" ADD VALUE 'trends_rising';--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decision_context" jsonb;