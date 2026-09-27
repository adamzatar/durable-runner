import "../load-env.js";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDbConnectionConfig } from "../db/connection-config.js";
import { createDbPool } from "../db/pool-config.js";
import { registerWorker } from "../db/worker-heartbeat.js";
import { runHeartbeatLoop } from "./heartbeat-loop.js";
import { runWorkerLoop, WORKER_POLL_INTERVAL_MS } from "./worker-loop.js";

// Real worker process entrypoint. Separate from worker/spike-worker.ts,
// which stays as the Phase 0 environment-spike artifact and does no
// claiming or execution.
//
// Coordination is exclusively through Postgres: this process takes no
// input besides its worker ID and database settings, and sends nothing back to
// a parent process over IPC. A coordinator only ever learns what this
// worker did by reading rows back from the database.
//
// The worker ID is an application-level name, not a process identity. A
// fixed ID (argv/WORKER_ID) is reused if this process is restarted; the
// PID is logged for local debugging only and is not stored or used for
// any coordination decision.
const workerId = process.argv[2] ?? process.env.WORKER_ID ?? `worker-${randomUUID()}`;

// Two signals, stopped in order. The heartbeat keeps running until the
// work loop has fully returned, so a worker finishing its last step during
// a graceful shutdown still shows up as alive while it does.
const workController = new AbortController();
const heartbeatController = new AbortController();
let exitCode = 0;

// A rejected password means RDS has rotated it since this task started (see
// db/pool-config.ts). A failed claim already ends the process, but the
// heartbeat and lease renewal log and carry on, so a worker could otherwise
// keep running on its remaining open connections without being replaced.
// This takes the same path as SIGTERM: the current step, if any, gets to
// finish on those connections, then the process exits non-zero and ECS
// starts a replacement with the current password.
const pool = createDbPool(resolveDbConnectionConfig(), {
  onCredentialRejected: () => {
    if (workController.signal.aborted) return;
    exitCode = 1;
    console.error(`[${workerId}] database rejected the password (SQLSTATE 28P01); finishing current step (if any) then stopping`);
    workController.abort();
  },
});
const db = drizzle(pool);

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
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error(`[${workerId}] fatal error`, error);
    process.exit(1);
  });
