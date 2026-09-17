import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkerLoop } from "../src/worker/worker-loop.js";

// Exercises the real worker loop against real PostgreSQL rows. The workers
// here are logical: separate single-connection pools/async loops inside
// this one Vitest process, not separate OS processes (same convention as
// claim-step.test.ts's concurrent claiming tests). A real multi-process
// run is exercised by `npm run demo:workers`
// (server/src/worker/run-demo.ts) and by manually running
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
}

function startLogicalWorker(workerId: string): LogicalWorker {
  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);
  const controller = new AbortController();
  const loopPromise = runWorkerLoop(db, workerId, {
    signal: controller.signal,
    pollIntervalMs: 50,
    log: () => undefined,
    logError: () => undefined,
  });
  return { pool, db, controller, loopPromise };
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
      expect(row!.result).toEqual({
        hash: createHash("sha256").update("worker-loop-single").digest("hex"),
      });
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
