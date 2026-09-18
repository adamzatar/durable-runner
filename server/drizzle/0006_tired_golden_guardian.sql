CREATE TABLE "step_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"step_id" uuid NOT NULL,
	"worker_id" text,
	"event_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "step_events_stream_idx" ON "step_events" USING btree (xid ASC,id ASC);--> statement-breakpoint
CREATE INDEX "step_events_step_idx" ON "step_events" USING btree (step_id,xid ASC,id ASC);