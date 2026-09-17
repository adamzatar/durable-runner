CREATE TYPE "public"."step_status" AS ENUM('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "step_status" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_worker_id" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "steps_running_requires_owner" CHECK (status <> 'RUNNING' OR (current_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_version > 0))
);
--> statement-breakpoint
CREATE INDEX "steps_claimable_idx" ON "steps" USING btree (priority DESC,available_at ASC,id ASC) WHERE status = 'READY';