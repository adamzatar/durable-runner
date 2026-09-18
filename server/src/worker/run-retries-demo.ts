import "../load-env.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Real local coordinator/worker processes, ordinary retry values (500ms,
// 1s for these tasks). SQL samples show durable state; committed-operation
// logs show brief RUNNING/READY states that polling can miss. No IPC or
// durable history is added. The final verdict requires PostgreSQL rows.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 5_000 });
const children: Array<{ process: ChildProcess; done: Promise<void>; closed: boolean }> = [];
let output = "";
let interrupted = false;
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

function start(script: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url)), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { process: child, done: Promise.resolve(), closed: false };
  record.done = new Promise((resolve) => {
    child.once("error", (error) => { console.error(error); interrupted = true; });
    child.once("close", () => { record.closed = true; resolve(); });
  });
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on("data", (data: Buffer) => { output += data.toString(); process.stdout.write(data); });
  }
  children.push(record);
}

const tasks = [
  { id: randomUUID(), label: "retry-success", input: "hello", failuresBeforeSuccess: 2, terminal: "SUCCEEDED" },
  { id: randomUUID(), label: "poison", input: "poison", failuresBeforeSuccess: 99, terminal: "DEAD_LETTERED" },
] as const;

interface Row {
  id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  lease_version: number;
  current_worker_id: string | null;
  lease_expires_at: string | null;
  payload: unknown;
  result: { hash: string } | null;
  last_error: string | null;
}

async function readRows() {
  const result = await pool.query<{ row: Row; observed_at: string }>(
    `select to_jsonb(s) as row, clock_timestamp()::text as observed_at
     from steps s where id = any($1::uuid[]) order by id`, [tasks.map((task) => task.id)],
  );
  return result.rows;
}

function assertFinal(rows: Row[]) {
  assert.equal(rows.length, tasks.length);
  for (const task of tasks) {
    const row = rows.find((r) => r.id === task.id)!;
    assert.equal(row.status, task.terminal);
    assert.equal(row.attempt_count, 3);
    assert.equal(row.max_attempts, 3);
    assert.equal(row.lease_version, 3);
    assert.equal(row.current_worker_id, null);
    assert.equal(row.lease_expires_at, null);
    assert.deepEqual(row.payload, { input: task.input, failuresBeforeSuccess: task.failuresBeforeSuccess });
    if (task.terminal === "SUCCEEDED") {
      assert.deepEqual(row.result, { hash: createHash("sha256").update(task.input).digest("hex") });
      assert.equal(row.last_error, "fail_then_hash deterministic failure on attempt 2");
    } else {
      assert.equal(row.result, null);
      assert.equal(row.last_error, "fail_then_hash deterministic failure on attempt 3");
    }
  }
}

async function main() {
  let success = false;
  try {
    const pending = await pool.query("select id from steps where status not in ('SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED') limit 1");
    assert.equal(pending.rowCount, 0, "refusing to run with unrelated non-terminal steps");
    for (const task of tasks) {
      await pool.query(
        `insert into steps (id, status, task_type, payload, max_attempts)
         values ($1, 'READY', 'fail_then_hash', $2::jsonb, 3)`,
        [task.id, JSON.stringify({ input: task.input, failuresBeforeSuccess: task.failuresBeforeSuccess })],
      );
      console.log(`[demo] ${task.label}: ${task.id}, READY attempt_count 0 / lease_version 0, max_attempts 3`);
    }
    for (const { row } of await readRows()) {
      assert.equal(row.status, "READY");
      assert.equal(row.attempt_count, 0);
      assert.equal(row.lease_version, 0);
    }
    start("../coordinator/coordinator.ts");
    start("./worker.ts", ["retry-worker-a"]);
    start("./worker.ts", ["retry-worker-b"]);
    const watchdog = Date.now() + 30_000;
    const lastSamples = new Map<string, string>();
    for (;;) {
      if (interrupted || children.some((child) => child.closed)) throw new Error("demo interrupted or child exited unexpectedly");
      const samples = await readRows();
      for (const { row, observed_at } of samples) {
        assert(row.attempt_count <= 3, "a fourth attempt was observed");
        const key = `${row.status}/${row.attempt_count}/${row.lease_version}`;
        if (lastSamples.get(row.id) !== key) {
          console.log(`[demo] DB ${observed_at}: ${row.id} ${key}`);
          lastSamples.set(row.id, key);
        }
      }
      if (samples.length === 2 && samples.every(({ row }) => ["SUCCEEDED", "DEAD_LETTERED"].includes(row.status))) {
        assertFinal(samples.map(({ row }) => row));
        break;
      }
      if (Date.now() > watchdog) throw new Error("retry demo watchdog expired");
      await sleep(50);
    }
    success = true;
  } finally {
    for (const child of children) if (!child.closed) child.process.kill(success ? "SIGTERM" : "SIGKILL");
    const watchdog = setTimeout(() => {
      for (const child of children) if (!child.closed) child.process.kill("SIGKILL");
    }, 5_000);
    try {
      await Promise.all(children.map((child) => child.done));
      if (success) {
        for (const child of children) assert.equal(child.process.exitCode, 0);
        // close drained all child logs; require the committed transitions
        // even if a 50ms database sample missed an intermediate state.
        for (const task of tasks) {
          for (const attempt of [1, 2, 3]) {
            const claim = `claimed step ${task.id} (fail_then_hash) at lease_version ${attempt} (attempt ${attempt})`;
            assert.equal(output.split(claim).length - 1, 1, `missing/duplicate claim ${attempt}`);
          }
          for (const attempt of [1, 2]) {
            assert(output.includes(`step ${task.id} failure recorded -> RETRY_WAIT at attempt_count ${attempt}, lease_version ${attempt}`));
            assert(output.includes(`step ${task.id} RETRY_WAIT -> READY at attempt_count ${attempt}, lease_version ${attempt}`));
          }
        }
        const final = (await readRows()).map(({ row }) => row);
        assertFinal(final);
        console.log(`[demo] PASS: retry-success SUCCEEDED and poison DEAD_LETTERED, both attempt 3 / v3; final rows ${JSON.stringify(final)}`);
      }
      console.log(`[demo] all child processes exited: ${children.map((child) => child.process.pid).join(", ")}`);
    } finally {
      clearTimeout(watchdog);
      await pool.end();
    }
  }
}

main().catch((error) => { console.error("[demo] FAILED", error); process.exitCode = 1; });
