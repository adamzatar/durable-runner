import { defineConfig } from "drizzle-kit";

// Spike-only config: points at the one spike table defined in
// server/src/db/schema.ts. Will be revisited once the real schema
// (runs/steps/workers/attempts/events) replaces it.
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/src/db/schema.ts",
  out: "./server/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
