import "../load-env.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { runWorkerLoop, WORKER_POLL_INTERVAL_MS } from "./worker-loop.js";

// Real worker process entrypoint (Milestone 4). Separate from
// worker/spike-worker.ts, which stays as the Phase 0 environment-spike
// artifact and does no claiming or execution.
//
// Coordination is exclusively through Postgres: this process takes no
// input besides its worker ID and DATABASE_URL, and sends nothing back to
// a parent process over IPC. A coordinator only ever learns what this
// worker did by reading rows back from the database.
const workerId = process.argv[2] ?? process.env.WORKER_ID ?? `worker-${randomUUID()}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const controller = new AbortController();

function shutdown(signal: string) {
  console.log(`[${workerId}] received ${signal}, finishing current step (if any) then stopping`);
  controller.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`[${workerId}] started, pid ${process.pid}`);

runWorkerLoop(db, workerId, { pollIntervalMs: WORKER_POLL_INTERVAL_MS, signal: controller.signal })
  .then(() => pool.end())
  .then(() => {
    console.log(`[${workerId}] stopped, pool closed`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[${workerId}] fatal error`, error);
    process.exit(1);
  });
