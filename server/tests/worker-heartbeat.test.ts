import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { WorkerNotRegisteredError, recordWorkerHeartbeat, registerWorker } from "../src/db/worker-heartbeat.js";
import { runHeartbeatLoop } from "../src/worker/heartbeat-loop.js";

// Worker heartbeats are liveness evidence only. These tests pin down both
// halves of that: heartbeats are recorded from the database clock, and
// they have no effect on step ownership in either direction (a fresh
// heartbeat does not protect an expired lease; a stale heartbeat does not
// expose a live one to recovery).
//
// Timestamps are compared inside PostgreSQL, or passed back to it as text
// so microsecond precision survives. Nothing compares a database timestamp
// against this process's clock.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let workerPool: Pool;
let db: NodePgDatabase<Record<string, never>>;

async function dbClockText(): Promise<string> {
  const result = await admin.query<{ t: string }>("select clock_timestamp()::text as t");
  return result.rows[0]!.t;
}

async function workerTimestampsText(workerId: string): Promise<{ started_at: string; last_heartbeat_at: string }> {
  const result = await admin.query<{ started_at: string; last_heartbeat_at: string }>(
    "select started_at::text, last_heartbeat_at::text from workers where id = $1",
    [workerId],
  );
  return result.rows[0]!;
}

async function sqlBool(query: string, params: unknown[]): Promise<boolean> {
  const result = await admin.query<{ ok: boolean }>(query, params);
  return result.rows[0]!.ok;
}

async function insertRunningStep(workerId: string, leaseOffsetMs: number): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, current_worker_id, lease_version, lease_expires_at, task_type, payload)
     values ($1, 'RUNNING', $2, 1, clock_timestamp() + ($3::int * interval '1 millisecond'),
             'hash_after_delay', '{"input":"heartbeat-fixture","delayMs":0}'::jsonb)`,
    [id, workerId, leaseOffsetMs],
  );
  return id;
}

async function stepSnapshot(id: string): Promise<unknown> {
  const result = await admin.query<{ row: unknown }>("select to_jsonb(s) as row from steps s where id = $1", [id]);
  return result.rows[0]!.row;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  workerPool = new Pool({ connectionString, max: 1 });
  db = drizzle(workerPool);
});

afterAll(async () => {
  await admin.end();
  await workerPool.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
  await admin.query("delete from workers");
});

describe("registerWorker", () => {
  it("creates a workers row whose started_at and last_heartbeat_at are one database-clock instant", async () => {
    const before = await dbClockText();
    await registerWorker(db, "hb-register");
    const after = await dbClockText();

    const row = await workerTimestampsText("hb-register");
    expect(row.last_heartbeat_at).toBe(row.started_at);
    expect(
      await sqlBool("select $1::timestamptz between $2::timestamptz and $3::timestamptz as ok", [
        row.started_at,
        before,
        after,
      ]),
    ).toBe(true);
  });

  it("re-registering the same ID (a restart) resets started_at to a later instant", async () => {
    await registerWorker(db, "hb-restart");
    const first = await workerTimestampsText("hb-restart");

    await registerWorker(db, "hb-restart");
    const second = await workerTimestampsText("hb-restart");

    expect(await sqlBool("select $1::timestamptz > $2::timestamptz as ok", [second.started_at, first.started_at])).toBe(
      true,
    );
    expect(second.last_heartbeat_at).toBe(second.started_at);
    const count = await admin.query("select 1 from workers where id = $1", ["hb-restart"]);
    expect(count.rowCount).toBe(1);
  });

  it("rejects a blank worker ID", async () => {
    await expect(registerWorker(db, "  ")).rejects.toThrow(/non-empty workerId/);
  });
});

describe("recordWorkerHeartbeat", () => {
  it("advances last_heartbeat_at to the database clock and leaves started_at alone", async () => {
    await registerWorker(db, "hb-advance");
    const registered = await workerTimestampsText("hb-advance");

    const before = await dbClockText();
    await recordWorkerHeartbeat(db, "hb-advance");
    const after = await dbClockText();

    const row = await workerTimestampsText("hb-advance");
    expect(row.started_at).toBe(registered.started_at);
    expect(
      await sqlBool("select $1::timestamptz > $2::timestamptz as ok", [row.last_heartbeat_at, registered.last_heartbeat_at]),
    ).toBe(true);
    expect(
      await sqlBool("select $1::timestamptz between $2::timestamptz and $3::timestamptz as ok", [
        row.last_heartbeat_at,
        before,
        after,
      ]),
    ).toBe(true);
  });

  it("fails loudly for a worker that never registered instead of inventing a row", async () => {
    await expect(recordWorkerHeartbeat(db, "hb-unregistered")).rejects.toThrow(WorkerNotRegisteredError);
    const rows = await admin.query("select 1 from workers where id = $1", ["hb-unregistered"]);
    expect(rows.rowCount).toBe(0);
  });

  it("does not touch any step the worker owns: no lease extension, no version change", async () => {
    await registerWorker(db, "hb-owner");
    const liveStep = await insertRunningStep("hb-owner", 30_000);
    const expiredStep = await insertRunningStep("hb-owner", -1_000);
    const liveBefore = await stepSnapshot(liveStep);
    const expiredBefore = await stepSnapshot(expiredStep);

    await recordWorkerHeartbeat(db, "hb-owner");
    await recordWorkerHeartbeat(db, "hb-owner");

    // Byte-for-byte identical rows, including lease_expires_at and
    // updated_at at microsecond precision.
    expect(await stepSnapshot(liveStep)).toEqual(liveBefore);
    expect(await stepSnapshot(expiredStep)).toEqual(expiredBefore);
  });
});

describe("heartbeat and lease are separate facts", () => {
  it("a fresh heartbeat does not protect an expired lease from recovery", async () => {
    await registerWorker(db, "hb-fresh");
    const stepId = await insertRunningStep("hb-fresh", -1_000);
    await recordWorkerHeartbeat(db, "hb-fresh");

    const recovered = await recoverExpiredSteps(db);

    expect(recovered.map((step) => step.id)).toEqual([stepId]);
    const row = await admin.query<{ status: string }>("select status from steps where id = $1", [stepId]);
    expect(row.rows[0]!.status).toBe("READY");
  });

  it("a stale heartbeat does not make a live lease recoverable", async () => {
    await registerWorker(db, "hb-stale");
    // The worker has apparently been silent for an hour: suspicious, but
    // its lease on this step has not expired, so it keeps the step.
    await admin.query("update workers set last_heartbeat_at = clock_timestamp() - interval '1 hour' where id = $1", [
      "hb-stale",
    ]);
    const stepId = await insertRunningStep("hb-stale", 30_000);
    const before = await stepSnapshot(stepId);

    const recovered = await recoverExpiredSteps(db);

    expect(recovered).toEqual([]);
    expect(await stepSnapshot(stepId)).toEqual(before);
  });

  it("a step owned by a worker ID with no workers row at all is still governed only by its lease", async () => {
    const liveStep = await insertRunningStep("never-registered", 30_000);
    const expiredStep = await insertRunningStep("never-registered", -1_000);

    const recovered = await recoverExpiredSteps(db);

    expect(recovered.map((step) => step.id)).toEqual([expiredStep]);
    const live = await admin.query<{ status: string }>("select status from steps where id = $1", [liveStep]);
    expect(live.rows[0]!.status).toBe("RUNNING");
  });
});

describe("runHeartbeatLoop", () => {
  it("keeps advancing the heartbeat until aborted, then stops writing", async () => {
    await registerWorker(db, "hb-loop");
    const registered = await workerTimestampsText("hb-loop");
    const controller = new AbortController();
    const errors: unknown[] = [];

    const loop = runHeartbeatLoop(db, "hb-loop", {
      intervalMs: 20,
      signal: controller.signal,
      logError: (_message, error) => errors.push(error),
    });

    // Two distinct advances, not just one, so this is a loop and not a
    // single write.
    let seen = registered.last_heartbeat_at;
    for (let i = 0; i < 2; i += 1) {
      const previous = seen;
      await waitUntil(async () => {
        const row = await workerTimestampsText("hb-loop");
        seen = row.last_heartbeat_at;
        return sqlBool("select $1::timestamptz > $2::timestamptz as ok", [seen, previous]);
      }, 2_000);
    }

    controller.abort();
    await loop;

    const stopped = await workerTimestampsText("hb-loop");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await workerTimestampsText("hb-loop")).last_heartbeat_at).toBe(stopped.last_heartbeat_at);
    expect(errors).toEqual([]);
  });
});
