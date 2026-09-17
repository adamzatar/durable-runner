import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// SPIKE-ONLY TABLE. Exists to prove that a real Drizzle migration, plus
// reads/writes from independent processes against shared PostgreSQL state,
// work in this environment (tasks/00-environment-spike.md). Not part of
// the real schema (runs/steps/workers/attempts/events) — delete once
// Phase 0 is reviewed.
export const spikeEvents = pgTable("spike_events", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
