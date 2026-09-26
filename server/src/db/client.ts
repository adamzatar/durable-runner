import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDbConnectionConfig } from "./connection-config.js";
import { createDbPool } from "./pool-config.js";
import * as schema from "./schema.js";

// One pool per process. Each worker/coordinator process creates its own —
// this is the mechanism by which independent processes each get their own
// connection to the single shared coordination store (Postgres), never a
// connection shared over IPC.
export const pool = createDbPool(resolveDbConnectionConfig());

export const db = drizzle(pool, { schema });
