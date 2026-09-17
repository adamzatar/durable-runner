import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { abortableSleep } from "../abortable-sleep.js";
import { recordWorkerHeartbeat } from "../db/worker-heartbeat.js";

// Heartbeats are observability, not authority: nothing that decides step
// ownership reads them. The interval therefore only trades database writes
// for how fresh the liveness evidence is. The one relationship that matters
// is that it is much shorter than STEP_LEASE_DURATION_MS (30s), so that a
// reader of `workers` sees a worker stop heartbeating (several missed 2s
// beats) before a recently renewed lease expires on the healthy path.
// Prior renewal failures or delays can instead make the lease expire first;
// this interval relationship is not a bound on either observation.
export const WORKER_HEARTBEAT_INTERVAL_MS = 2_000;

export interface HeartbeatLoopOptions {
  intervalMs?: number;
  signal: AbortSignal;
  logError?: (message: string, error: unknown) => void;
}

/**
 * Records a heartbeat for `workerId` every `intervalMs` until `signal`
 * aborts. Assumes registerWorker has already run (registration is the
 * first heartbeat, so this sleeps before its first write).
 *
 * Runs independently of the claim/execute loop, for the whole life of the
 * worker process, busy or idle. It never touches `steps`.
 *
 * Sequential, not setInterval: each write is awaited before the next wait
 * starts, so a slow database cannot cause overlapping heartbeat writes to
 * pile up. A failed write is logged and the loop carries on — a worker that
 * cannot reach PostgreSQL just stops producing liveness evidence, which is
 * exactly what the evidence is meant to show.
 */
export async function runHeartbeatLoop<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
  options: HeartbeatLoopOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const { signal } = options;

  while (!signal.aborted) {
    await abortableSleep(intervalMs, signal);
    if (signal.aborted) break;
    try {
      await recordWorkerHeartbeat(db, workerId);
    } catch (error) {
      logError(`[${workerId}] heartbeat failed`, error);
    }
  }
}
