CREATE TABLE "idempotent_effects" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"effect_type" text NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
