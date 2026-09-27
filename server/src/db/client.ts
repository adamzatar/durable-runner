import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDbConnectionConfig } from "./connection-config.js";
import { createDbPool } from "./pool-config.js";
import * as schema from "./schema.js";

// The API entrypoint registers here to stop the process when the database
// rejects its password (see onCredentialRejected in pool-config.ts). The
// other user of this pool, the migrator, runs for seconds and simply fails,
// so it registers nothing.
let credentialRejectedListener: ((error: Error) => void) | undefined;

export function onDbCredentialRejected(listener: (error: Error) => void): void {
  credentialRejectedListener = listener;
}

// One pool per process. Each worker/coordinator process creates its own —
// this is the mechanism by which independent processes each get their own
// connection to the single shared coordination store (Postgres), never a
// connection shared over IPC.
export const pool = createDbPool(resolveDbConnectionConfig(), {
  onCredentialRejected: (error) => credentialRejectedListener?.(error),
});

export const db = drizzle(pool, { schema });
