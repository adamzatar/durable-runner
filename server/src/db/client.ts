import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// One pool per process. Each worker/coordinator process creates its own —
// this is the mechanism by which independent processes each get their own
// connection to the single shared coordination store (Postgres), never a
// connection shared over IPC.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });
