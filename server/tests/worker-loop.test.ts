import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompletionConsistencyError } from "../src/db/complete-step.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { runWorkerLoop, type WorkerLoopOptions } from "../src/worker/worker-loop.js";

// Exercises the real worker loop against real PostgreSQL rows. The workers
// here are logical: separate single-connection pools/async loops inside
// this one Vitest process, not separate OS processes (same convention as
// claim-step.test.ts's concurrent claiming tests). A real multi-process
// run is exercised by `npm run demo:workers`
// (server/src/worker/run-demo.ts), `npm run demo:recovery`
// (server/src/worker/run-recovery-demo.ts), and by manually running
// `npm run worker <id>` more than once - not by this automated suite,
// which needs to stay fast and deterministic.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;

interface LogicalWorker {
  pool: Pool;
  db: NodePgDatabase<Record<string, never>>;
  controller: AbortController;
  loopPromise: Promise<void>;
  logs: string[];
  errors: Array<{ message: string; error: unknown }>;
}

function startLogicalWorker(
  workerId: string,
  options: Pick<WorkerLoopOptions, "leaseDurationMs" | "leaseRenewalIntervalMs"> = {},
  onLog?: (message: string) => void,
): LogicalWorker {
  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);
  const controller = new AbortController();
  const logs: string[] = [];
  const errors: Array<{ message: string; error: unknown }> = [];
  const loopPromise = runWorkerLoop(db, workerId, {
    ...options,
    signal: controller.signal,
    pollIntervalMs: 50,
    log: (message) => { logs.push(message); onLog?.(message); },
    logError: (message, error) => errors.push({ message, error }),
  });
  return { pool, db, controller, loopPromise, logs, errors };
}

async function stopLogicalWorker(worker: LogicalWorker): Promise<void> {
  worker.controller.abort();
  await worker.loopPromise;
  await worker.pool.end();
}

async function insertReadyStep(input: string, delayMs = 0): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, priority, task_type, payload)
     values ($1, 'READY', 0, 'hash_after_delay', $2::jsonb)`,
    [id, JSON.stringify({ input, delayMs })],
  );
  return id;
}

interface StepRow {
  id: string;
  status: string;
  result: { hash: string } | null;
  current_worker_id: string | null;
}

async function readSteps(ids: readonly string[]): Promise<StepRow[]> {
  const result = await admin.query<StepRow>(
    `select id, status, result, current_worker_id from steps where id = any($1::uuid[]) order by id`,
    [[...ids]],
  );
  return result.rows;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sqlBool(query: string, params: unknown[]): Promise<boolean> {
  const result = await admin.query<{ ok: boolean }>(query, params);
  return result.rows[0]!.ok;
}

async function leaseState(id: string): Promise<{
  status: string;
  lease_version: number;
  lease_expires_at: string | null;
  expired: boolean | null;
}> {
  const result = await admin.query(
    `select status, lease_version, lease_expires_at::text, lease_expires_at <= clock_timestamp() as expired
     from steps where id = $1`,
    [id],
  );
  return result.rows[0];
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Synchronously occupies this process's event loop. Stands in for an
// executor doing CPU-bound work, a long GC pause, or the process being
// stopped by the OS: no timer — including the lease-renewal timer — can
// fire until it returns.
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy wait
  }
}

beforeEach(async () => {
  admin = new Pool({ connectionString, max: 4 });
  await admin.query("delete from steps");
});

afterEach(async () => {
  await admin.end();
});

describe("runWorkerLoop", () => {
  it("claims, executes, and completes a single step end to end", async () => {
    const id = await insertReadyStep("worker-loop-single");
    const worker = startLogicalWorker("loop-worker-solo");

    try {
      await waitUntil(async () => {
        const [row] = await readSteps([id]);
        return row!.status === "SUCCEEDED";
      }, 5_000);

      const [row] = await readSteps([id]);
      expect(row!.result).toEqual({ hash: hashOf("worker-loop-single") });
      expect(row!.current_worker_id).toBeNull();
    } finally {
      await stopLogicalWorker(worker);
    }
  }, 10_000);

  it("drives multiple READY steps to SUCCEEDED across multiple concurrent worker loops", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => insertReadyStep(`worker-loop-multi-${i}`, 20)),
    );
    const workers = [
      startLogicalWorker("loop-worker-a"),
      startLogicalWorker("loop-worker-b"),
      startLogicalWorker("loop-worker-c"),
    ];

    try {
      await waitUntil(async () => {
        const rows = await readSteps(ids);
        return rows.every((row) => row.status === "SUCCEEDED");
      }, 10_000);

      const rows = await readSteps(ids);
      expect(rows).toHaveLength(ids.length);
      for (const row of rows) {
        expect(row.status).toBe("SUCCEEDED");
        expect(row.result).not.toBeNull();
        expect(row.current_worker_id).toBeNull();
      }
    } finally {
      await Promise.all(workers.map(stopLogicalWorker));
    }
  }, 15_000);

  it("renews the lease while executing a step that outlasts it, and completes at the same lease_version", async () => {
    // Lease 600ms, renewal every 100ms, step takes 2000ms: without
    // renewal the lease would expire a third of the way through and
    // completion (which requires an unexpired lease) would be rejected.
    // No recovery sweep runs in this test.
    const id = await insertReadyStep("worker-loop-renewal", 2_000);
    const worker = startLogicalWorker("loop-worker-renewal", { leaseDurationMs: 600, leaseRenewalIntervalMs: 100 });

    try {
      await waitUntil(async () => (await leaseState(id)).status === "RUNNING", 5_000);
      const claimed = await leaseState(id);

      // Wait until the database clock is past the first deadline observed
      // (the claim's, or an early renewal's). The step must still be
      // RUNNING at the same version, with a later, still-live deadline —
      // only a renewal after that observation can explain that.
      await waitUntil(() => sqlBool("select clock_timestamp() > $1::timestamptz as ok", [claimed.lease_expires_at]), 5_000);
      const renewed = await leaseState(id);
      expect(renewed.status).toBe("RUNNING");
      expect(renewed.lease_version).toBe(1);
      expect(renewed.expired).toBe(false);
      expect(
        await sqlBool("select $1::timestamptz > $2::timestamptz as ok", [renewed.lease_expires_at, claimed.lease_expires_at]),
      ).toBe(true);

      await waitUntil(async () => (await leaseState(id)).status === "SUCCEEDED", 5_000);
      const [row] = await readSteps([id]);
      expect(row!.result).toEqual({ hash: hashOf("worker-loop-renewal") });
      expect((await leaseState(id)).lease_version).toBe(1);
      expect(worker.errors).toEqual([]);
    } finally {
      await stopLogicalWorker(worker);
    }
  }, 15_000);

  it("keeps renewing through a shutdown requested mid-step, so the step still completes", async () => {
    const id = await insertReadyStep("worker-loop-shutdown-mid-step", 1_500);
    const worker = startLogicalWorker("loop-worker-graceful", { leaseDurationMs: 500, leaseRenewalIntervalMs: 80 });

    await waitUntil(async () => (await leaseState(id)).status === "RUNNING", 5_000);
    worker.controller.abort();
    await worker.loopPromise;
    await worker.pool.end();

    // The step ran three lease-durations past the abort and still
    // completed: the shutdown signal stops new claims, not renewal.
    const state = await leaseState(id);
    expect(state.status).toBe("SUCCEEDED");
    expect(state.lease_version).toBe(1);
    expect(worker.errors).toEqual([]);
  }, 15_000);

  it("dead-letters malformed input immediately through the guarded failure path", async () => {
    const id = randomUUID();
    await admin.query(
      `insert into steps (id, status, task_type, payload)
       values ($1, 'READY', 'hash_after_delay', '{"input":"","delayMs":0}'::jsonb)`, [id],
    );
    const worker = startLogicalWorker("loop-worker-invalid");
    try {
      await waitUntil(async () => (await leaseState(id)).status === "DEAD_LETTERED", 5_000);
      const state = await admin.query(
        `select attempt_count, lease_version, current_worker_id, lease_expires_at, last_error,
                clock_timestamp() < created_at + interval '30 seconds' as before_original_lease_deadline
         from steps where id = $1`, [id],
      );
      expect(state.rows[0]).toMatchObject({ attempt_count: 1, lease_version: 1, current_worker_id: null,
        lease_expires_at: null, before_original_lease_deadline: true });
      expect(state.rows[0].last_error).toMatch(/input/);
      expect(worker.logs.filter((line) => line.includes(`claimed step ${id}`))).toHaveLength(1);
    } finally {
      await stopLogicalWorker(worker);
    }
    expect(await recoverExpiredSteps(drizzle(admin))).toEqual([]);
  });

  it("reports a valid task's runtime failure as RETRY_WAIT without waiting for expiry", async () => {
    const id = randomUUID();
    await admin.query(
      `insert into steps (id, status, task_type, payload)
       values ($1, 'READY', 'fail_then_hash', '{"input":"runtime-failure","failuresBeforeSuccess":2}')`, [id],
    );
    const worker = startLogicalWorker("loop-worker-retry");
    try {
      await waitUntil(async () => (await leaseState(id)).status === "RETRY_WAIT", 5_000);
      const state = await admin.query(
        `select attempt_count, lease_version, current_worker_id, lease_expires_at, last_error,
                clock_timestamp() < created_at + interval '30 seconds' as before_original_lease_deadline
         from steps where id = $1`, [id],
      );
      expect(state.rows[0]).toMatchObject({ attempt_count: 1, lease_version: 1, current_worker_id: null,
        lease_expires_at: null, before_original_lease_deadline: true });
      expect(state.rows[0].last_error).toMatch(/deterministic failure on attempt 1/);
    } finally {
      await stopLogicalWorker(worker);
    }
  });

  it("a worker whose lease expires before reporting runtime failure logs rejection without compensation", async () => {
    const id = randomUUID();
    await admin.query(
      `insert into steps (id, status, task_type, payload)
       values ($1, 'READY', 'fail_then_hash', '{"input":"lost-failure","failuresBeforeSuccess":2}')`, [id],
    );
    const worker = startLogicalWorker("loop-worker-lost-failure", { leaseDurationMs: 100, leaseRenewalIntervalMs: 50 },
      (message) => { if (message.includes("execution started")) blockEventLoop(250); });
    try {
      await waitUntil(async () => worker.logs.some((line) => line.includes("failure rejected")), 5_000);
      const result = await admin.query(
        `select status, current_worker_id, attempt_count, lease_version, last_error, result,
                lease_expires_at <= clock_timestamp() as expired from steps where id = $1`, [id],
      );
      expect(result.rows[0]).toEqual({ status: "RUNNING", current_worker_id: "loop-worker-lost-failure",
        attempt_count: 1, lease_version: 1, last_error: null, result: null, expired: true });
      expect(worker.logs.filter((line) => line.includes(`claimed step ${id}`))).toHaveLength(1);
    } finally {
      await stopLogicalWorker(worker);
    }
  });

  it("loses the lease when the event loop is blocked past the deadline: completion is rejected, and after recovery the step runs again at the next lease_version", async () => {
    // Lease 500ms, renewal every 50ms, step takes 1800ms. Partway in, the
    // event loop is blocked for 1200ms, so no renewal can fire; the last
    // renewal that did land set a deadline at most ~500ms into the block.
    const id = await insertReadyStep("worker-loop-blocked", 1_800);
    const worker = startLogicalWorker("loop-worker-blocked", { leaseDurationMs: 500, leaseRenewalIntervalMs: 50 });

    try {
      await waitUntil(async () => (await leaseState(id)).status === "RUNNING", 5_000);
      blockEventLoop(1_200);

      // First run: renewal resumes after the block and is rejected, the
      // executor still finishes (nothing cancels it), and completion is
      // rejected. No sweep has run, so the row is still RUNNING under this
      // worker at version 1 — expired, with no result.
      await waitUntil(
        async () => worker.errors.some((entry) => entry.error instanceof CompletionConsistencyError),
        5_000,
      );
      expect(worker.logs.some((line) => line.includes("lease renewal rejected"))).toBe(true);
      const afterFirstRun = await leaseState(id);
      expect(afterFirstRun.status).toBe("RUNNING");
      expect(afterFirstRun.lease_version).toBe(1);
      expect(afterFirstRun.expired).toBe(true);
      const [unfinished] = await readSteps([id]);
      expect(unfinished!.result).toBeNull();

      // Recovery, then the same worker loop claims it again as a new
      // generation and this time completes. The work executed twice; its
      // completion was recorded once.
      expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 1, status: "READY" }]);
      await waitUntil(async () => (await leaseState(id)).status === "SUCCEEDED", 10_000);
      const final = await leaseState(id);
      expect(final.lease_version).toBe(2);
      const [row] = await readSteps([id]);
      expect(row!.result).toEqual({ hash: hashOf("worker-loop-blocked") });
      expect(worker.logs.filter((line) => line.includes(`claimed step ${id}`))).toHaveLength(2);
    } finally {
      await stopLogicalWorker(worker);
    }
  }, 20_000);

  it("stops polling and returns after the signal is aborted", async () => {
    const worker = startLogicalWorker("loop-worker-shutdown");
    // No work exists, so the loop is in its poll-sleep. Abort should
    // resolve the loop promise promptly rather than waiting out the full
    // poll interval or hanging forever.
    const start = Date.now();
    worker.controller.abort();
    await worker.loopPromise;
    expect(Date.now() - start).toBeLessThan(1_000);
    await worker.pool.end();
  });
});
