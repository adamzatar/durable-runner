import "../load-env.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Milestone 4 demo launcher: real child processes, not logical loops.
// Inserts a handful of hash_after_delay steps, spawns 3 real
// `worker.ts` processes, waits for every step to reach SUCCEEDED by
// polling Postgres, then prints the durable results and stops the
// workers. Worker-to-task attribution is visible in each worker's own
// inherited stdout (see worker-loop.ts's log lines) - this milestone does
// not persist a completed_by_worker_id column, see docs/architecture.md.

const tsxBin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const workerScript = fileURLToPath(new URL("./worker.ts", import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWorker(id: string): ChildProcess {
  return spawn(tsxBin, [workerScript, id], { stdio: "inherit" });
}

const DEMO_STEPS = [
  { input: "durable-runner-demo-1", delayMs: 1500 },
  { input: "durable-runner-demo-2", delayMs: 1500 },
  { input: "durable-runner-demo-3", delayMs: 1500 },
  { input: "durable-runner-demo-4", delayMs: 500 },
  { input: "durable-runner-demo-5", delayMs: 500 },
];

async function insertDemoSteps(): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, payload] of DEMO_STEPS.entries()) {
    const id = randomUUID();
    await pool.query(
      `insert into steps (id, status, priority, task_type, payload)
       values ($1, 'READY', $2, 'hash_after_delay', $3::jsonb)`,
      [id, DEMO_STEPS.length - index, JSON.stringify(payload)],
    );
    ids.push(id);
  }
  return ids;
}

interface StepRow {
  id: string;
  status: string;
  result: { hash: string } | null;
  lease_version: number;
}

async function readSteps(ids: readonly string[]): Promise<StepRow[]> {
  const result = await pool.query<StepRow>(
    `select id, status, result, lease_version from steps where id = any($1::uuid[]) order by id`,
    [[...ids]],
  );
  return result.rows;
}

async function waitForCompletion(ids: readonly string[], timeoutMs: number): Promise<StepRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readSteps(ids);
    if (rows.every((row) => row.status === "SUCCEEDED")) {
      return rows;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for demo steps to complete; last statuses: ${rows
          .map((row) => `${row.id}=${row.status}`)
          .join(", ")}`,
      );
    }
    await sleep(200);
  }
}

async function main() {
  console.log("[demo] inserting demo steps");
  const ids = await insertDemoSteps();

  console.log("[demo] starting 3 real worker processes: a, b, c");
  const workers = {
    a: startWorker("worker-a"),
    b: startWorker("worker-b"),
    c: startWorker("worker-c"),
  };

  try {
    const rows = await waitForCompletion(ids, 30_000);
    console.log("[demo] all steps SUCCEEDED:");
    for (const row of rows) {
      console.log(`  ${row.id}  lease_version=${row.lease_version}  result=${JSON.stringify(row.result)}`);
    }
  } finally {
    console.log("[demo] stopping workers");
    workers.a.kill("SIGTERM");
    workers.b.kill("SIGTERM");
    workers.c.kill("SIGTERM");
    await sleep(500);
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[demo] failed:", error);
  process.exit(1);
});
