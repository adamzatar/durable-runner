import "../load-env.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { registerWorker } from "../db/worker-heartbeat.js";
import { runHeartbeatLoop } from "./heartbeat-loop.js";
import { runWorkerLoop, WORKER_POLL_INTERVAL_MS } from "./worker-loop.js";

// Real worker process entrypoint. Separate from worker/spike-worker.ts,
// which stays as the Phase 0 environment-spike artifact and does no
// claiming or execution.
//
// Coordination is exclusively through Postgres: this process takes no
// input besides its worker ID and DATABASE_URL, and sends nothing back to
// a parent process over IPC. A coordinator only ever learns what this
// worker did by reading rows back from the database.
//
// The worker ID is an application-level name, not a process identity. A
// fixed ID (argv/WORKER_ID) is reused if this process is restarted; the
// PID is logged for local debugging only and is not stored or used for
// any coordination decision.
const workerId = process.argv[2] ?? process.env.WORKER_ID ?? `worker-${randomUUID()}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// Two signals, stopped in order. The heartbeat keeps running until the
// work loop has fully returned, so a worker finishing its last step during
// a graceful shutdown still shows up as alive while it does.
const workController = new AbortController();
const heartbeatController = new AbortController();

function shutdown(signal: string) {
  console.log(`[${workerId}] received ${signal}, finishing current step (if any) then stopping`);
  workController.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  // Registration failing is fatal: a worker that can't reach PostgreSQL at
  // startup has nothing useful to do.
  await registerWorker(db, workerId);
  console.log(`[${workerId}] registered, pid ${process.pid}`);

  const heartbeat = runHeartbeatLoop(db, workerId, { signal: heartbeatController.signal });
  try {
    await runWorkerLoop(db, workerId, { pollIntervalMs: WORKER_POLL_INTERVAL_MS, signal: workController.signal });
  } finally {
    heartbeatController.abort();
    await heartbeat;
  }
  // No "stopped" row update: the workers row is left with its last
  // heartbeat, same as after a crash. Nothing reads a clean-shutdown marker.
  await pool.end();
}

main()
  .then(() => {
    console.log(`[${workerId}] stopped, pool closed`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[${workerId}] fatal error`, error);
    process.exit(1);
  });
