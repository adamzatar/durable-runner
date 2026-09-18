ALTER TABLE "steps" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_attempt_count_nonnegative" CHECK (attempt_count >= 0);--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_max_attempts_positive" CHECK (max_attempts >= 1);