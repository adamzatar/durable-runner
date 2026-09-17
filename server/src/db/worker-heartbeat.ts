import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// Worker liveness evidence. Nothing here reads or writes `steps`: a
// heartbeat is not a lease renewal and never extends, grants, or revokes
// ownership of any step. See renew-step-lease.ts for the per-step
// ownership write, and recover-expired-steps.ts for why recovery ignores
// this table entirely.

export class WorkerNotRegisteredError extends Error {
  constructor(workerId: string) {
    super(`heartbeat for worker ${workerId} matched no workers row; registerWorker must run first`);
    this.name = "WorkerNotRegisteredError";
  }
}

type WorkerTimestampsRow = {
  started_at: Date;
  last_heartbeat_at: Date;
};

/**
 * Registers `workerId` at process start, or re-registers it if a row with
 * that ID already exists (a restart under a fixed ID such as "worker-b").
 *
 * Registration counts as the first heartbeat: started_at and
 * last_heartbeat_at are the same database instant. clock_timestamp() is
 * read once in the subquery so both columns get that one value rather than
 * two evaluations microseconds apart.
 *
 * Re-registering resets started_at. The previous incarnation's row is
 * overwritten, not preserved — this table records the latest process that
 * used the ID, not a history of processes.
 */
export async function registerWorker<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
): Promise<{ startedAt: Date; lastHeartbeatAt: Date }> {
  if (workerId.trim().length === 0) {
    throw new Error("registerWorker requires a non-empty workerId");
  }

  const result = await db.execute<WorkerTimestampsRow>(sql`
    insert into workers (id, started_at, last_heartbeat_at)
    select ${workerId}, db_clock.ts, db_clock.ts
    from (select clock_timestamp() as ts) as db_clock
    on conflict (id) do update
      set started_at = excluded.started_at,
          last_heartbeat_at = excluded.last_heartbeat_at
    returning started_at, last_heartbeat_at
  `);

  const row = result.rows[0] as WorkerTimestampsRow;
  return { startedAt: row.started_at, lastHeartbeatAt: row.last_heartbeat_at };
}

/**
 * Records that `workerId` reached PostgreSQL just now, by the database's
 * clock. This is the whole meaning of a heartbeat: it does not claim the
 * worker is still alive after this statement, that its executor is making
 * progress, or that it owns anything.
 *
 * An UPDATE rather than an upsert, so a heartbeat for an ID that never
 * registered fails loudly instead of silently inventing a started_at.
 */
export async function recordWorkerHeartbeat<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
): Promise<{ lastHeartbeatAt: Date }> {
  const result = await db.execute<Pick<WorkerTimestampsRow, "last_heartbeat_at">>(sql`
    update workers
    set last_heartbeat_at = clock_timestamp()
    where id = ${workerId}
    returning last_heartbeat_at
  `);

  const row = result.rows[0];
  if (!row) {
    throw new WorkerNotRegisteredError(workerId);
  }
  return { lastHeartbeatAt: row.last_heartbeat_at };
}
