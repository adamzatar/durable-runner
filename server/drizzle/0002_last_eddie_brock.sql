ALTER TABLE "steps" ADD COLUMN "task_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "payload" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "result" jsonb;