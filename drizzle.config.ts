import { defineConfig } from "drizzle-kit";

// Generates migrations from server/src/db/schema.ts, which holds both the
// real `steps` table (Milestone 3) and the retained Phase 0 `spike_events`
// table. Other tables are added there only when a milestone needs them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/src/db/schema.ts",
  out: "./server/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
