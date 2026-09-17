CREATE TABLE "spike_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
