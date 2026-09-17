CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "steps_running_lease_idx" ON "steps" USING btree (lease_expires_at ASC) WHERE status = 'RUNNING';