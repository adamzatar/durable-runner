import "../load-env.js";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { RECOVERY_SWEEP_INTERVAL_MS, runRecoveryLoop } from "./recovery-loop.js";

// Coordinator process entrypoint: lease-expiry recovery and due retry
// promotion. It is a separate local process rather than
// a loop inside the Fastify server so that it can be started, stopped, or
// killed independently of the API and the workers — a dead coordinator
// delays recovery, it does not change who holds authority over a step.
//
// Like the workers, it has its own connection pool and coordinates only
// through PostgreSQL rows. It does not know which workers exist, does not
// read heartbeats, and does not signal workers.

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const controller = new AbortController();

function shutdown(signal: string) {
  console.log(`[coordinator] received ${signal}, stopping after the current sweep`);
  controller.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`[coordinator] started, pid ${process.pid}, sweeping every ${RECOVERY_SWEEP_INTERVAL_MS}ms`);

runRecoveryLoop(db, { signal: controller.signal })
  .then(() => pool.end())
  .then(() => {
    console.log("[coordinator] stopped, pool closed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[coordinator] fatal error", error);
    process.exit(1);
  });
