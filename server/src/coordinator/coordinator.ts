import "../load-env.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDbConnectionConfig } from "../db/connection-config.js";
import { createDbPool } from "../db/pool-config.js";
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

const controller = new AbortController();
let exitCode = 0;

// The recovery loop logs a failed sweep and tries again next tick, which is
// right for a transient outage but would go on forever if the password has
// been rotated since this process started. Stopping with a non-zero exit
// lets ECS start a replacement that reads the current password (see
// db/pool-config.ts).
const pool = createDbPool(resolveDbConnectionConfig(), {
  onCredentialRejected: () => {
    if (controller.signal.aborted) return;
    exitCode = 1;
    console.error("[coordinator] database rejected the password (SQLSTATE 28P01); stopping so a replacement can start with the current credential");
    controller.abort();
  },
});
const db = drizzle(pool);

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
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error("[coordinator] fatal error", error);
    process.exit(1);
  });
