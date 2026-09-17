import "../load-env.js";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

// Real workers, ordinary executor, production lease/heartbeat/sweep timings.
// A starts first so its v1 claim is deterministic. B starts after READY v1
// has been sampled, so polling cannot miss that intermediate state.
// Logs provide execution evidence, not task coordination; all shared task
// state and every expiry decision come from PostgreSQL. No worker IPC.
// This different-ID, terminal-row demo proves a real old execution resumes
// and loses. The same-ID tests isolate lease_version as the rejecting term
// while v2 is still RUNNING with a live lease.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 5_000 });
const workerScript = fileURLToPath(new URL("./worker.ts", import.meta.url));
const coordinatorScript = fileURLToPath(new URL("../coordinator/coordinator.ts", import.meta.url));
const execFileAsync = promisify(execFile);

interface Child {
  process: ChildProcess;
  output: string;
  exited: boolean;
  done: Promise<void>;
  error?: Error;
}
const children: Child[] = [];
let interrupted = false;
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

function startChild(script: string, args: string[] = []): Child {
  // No tsx launcher: this exact child PID runs the worker/coordinator.
  const processHandle = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child: Child = { process: processHandle, output: "", exited: false, done: Promise.resolve() };
  child.done = new Promise((resolve) => {
    processHandle.once("error", (error) => { child.error = error; });
    // close follows exit and draining stdout/stderr, so the final checks
    // include every completion/rejection log, including during shutdown.
    processHandle.once("close", () => { child.exited = true; resolve(); });
  });
  for (const stream of [processHandle.stdout!, processHandle.stderr!]) {
    stream.on("data", (data: Buffer) => {
      child.output += data.toString();
      process.stdout.write(data);
    });
  }
  children.push(child);
  return child;
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 15_000) {
  // Process clock is only a watchdog/poll scheduler, never lease authority.
  const watchdog = Date.now() + timeoutMs;
  for (;;) {
    if (interrupted) throw new Error("demo interrupted");
    for (const child of children) {
      if (child.error) throw child.error;
      if (child.exited) throw new Error(`child ${child.process.pid} exited unexpectedly`);
    }
    if (await check()) return;
    if (Date.now() >= watchdog) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

interface StepRow extends Record<string, unknown> {
  id: string;
  status: string;
  current_worker_id: string | null;
  lease_version: number;
  lease_expires_at: string | null;
  result: { hash: string } | null;
}
interface Sample {
  row: StepRow;
  observed_at: string;
  original_deadline_passed: boolean | null;
}
const id = randomUUID();
let originalDeadline: string | null = null;

async function sample(): Promise<Sample> {
  const result = await pool.query<Sample>(
    `select to_jsonb(s) as row, db_clock.observed_at::text,
            db_clock.observed_at >= $2::timestamptz as original_deadline_passed
     from steps s cross join (select clock_timestamp() as observed_at) db_clock
     where s.id = $1`, [id, originalDeadline],
  );
  const state = result.rows[0]!;
  assert(state, "demo step disappeared");
  if (originalDeadline && (state.row.status !== "RUNNING" || state.row.lease_version !== 1)) {
    assert.equal(state.original_deadline_passed, true, "sampled recovery/reclaim before original expiry");
  }
  return state;
}

async function heartbeat(workerId: string): Promise<string> {
  const result = await pool.query<{ heartbeat: string }>(
    "select last_heartbeat_at::text as heartbeat from workers where id = $1", [workerId],
  );
  assert(result.rows[0], `missing heartbeat for ${workerId}`);
  return result.rows[0].heartbeat;
}

function signal(child: Child, name: NodeJS.Signals) {
  assert(child.process.kill(name), `could not send ${name} to PID ${child.process.pid}`);
}

async function stopChildren(success: boolean) {
  for (const child of children) {
    if (child.exited) continue;
    // On failure SIGKILL also terminates a still-SIGSTOPped A. On success
    // A has resumed and finished its rejected completion, so all are idle.
    child.process.kill(success ? "SIGTERM" : "SIGKILL");
  }
  const watchdog = setTimeout(() => {
    for (const child of children) if (!child.exited) child.process.kill("SIGKILL");
  }, 5_000);
  try {
    await Promise.all(children.map((child) => child.done));
  } finally {
    clearTimeout(watchdog);
  }
  if (success) {
    for (const child of children) {
      assert.equal(child.process.exitCode, 0, `child ${child.process.pid} did not shut down cleanly`);
    }
  }
  console.log(`[demo] all child processes exited: ${children.map((child) => child.process.pid).join(", ")}`);
}

async function main() {
  let success = false;
  let ownerA: Child | undefined;
  let completedV2: StepRow | undefined;
  try {
    const pending = await pool.query(
      "select id from steps where status not in ('SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED') limit 1",
    );
    assert.equal(pending.rowCount, 0, "refusing to run with unrelated non-terminal steps");
    startChild(coordinatorScript);
    ownerA = startChild(workerScript, ["worker-a"]);
    const a = ownerA;
    await waitFor("A registered with its actual child PID", async () =>
      a.output.includes(`[worker-a] registered, pid ${a.process.pid}`));

    const payload = { input: "fencing-demo", delayMs: 12_000 };
    await pool.query(
      `insert into steps (id, status, task_type, payload)
       values ($1, 'READY', 'hash_after_delay', $2::jsonb)`, [id, JSON.stringify(payload)],
    );
    await waitFor("A's original executor started at v1", async () =>
      a.output.includes(`execution started for step ${id} at lease_version 1`));
    signal(a, "SIGSTOP");
    await waitFor("OS reports A stopped", async () => {
      const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(a.process.pid)]);
      return stdout.trim().startsWith("T");
    });
    console.log(`[demo] SIGSTOP confirmed by OS for worker-a PID ${a.process.pid}; original executor is pending`);

    // Fail promptly if orchestration stopped A inside a step transaction.
    // Otherwise its retained lock could defer recovery forever. This is
    // just a lock-only probe; it makes no task/lease changes.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from steps where id = $1 for update nowait", [id]);
    } finally {
      try {
        await client.query("rollback");
      } finally {
        client.release();
      }
    }
    const stopped = await sample();
    assert.equal(stopped.row.status, "RUNNING");
    assert.equal(stopped.row.current_worker_id, "worker-a");
    assert.equal(stopped.row.lease_version, 1);
    assert(stopped.row.lease_expires_at);
    originalDeadline = stopped.row.lease_expires_at;
    // Allow an already-sent heartbeat to settle before taking the baseline.
    await sleep(1_000);
    const baselineHeartbeat = await heartbeat("worker-a");
    const beforeExpiry = await sample();
    assert.equal(beforeExpiry.original_deadline_passed, false);
    assert.deepEqual(beforeExpiry.row, stopped.row);
    console.log(`[demo] sampled RUNNING worker-a v1 at ${beforeExpiry.observed_at}, deadline ${originalDeadline}`);

    await waitFor("PostgreSQL confirms v1 expiry", async () => {
      const state = await sample();
      if (state.row.status === "RUNNING") {
        assert.deepEqual(state.row, stopped.row, "stopped A unexpectedly renewed or changed its step");
      }
      return state.original_deadline_passed === true;
    }, 45_000);
    console.log("[demo] PostgreSQL confirms the original lease deadline has passed");
    await waitFor("coordinator recovered READY v1", async () => {
      const state = await sample();
      if (state.row.status === "RUNNING") {
        assert.deepEqual(state.row, stopped.row, "stopped A unexpectedly renewed or changed its step");
        return false;
      }
      assert.equal(state.row.status, "READY");
      assert.equal(state.row.lease_version, 1);
      assert.equal(state.row.current_worker_id, null);
      assert.equal(state.row.lease_expires_at, null);
      console.log(`[demo] sampled READY v1 after expiry at ${state.observed_at}`);
      return true;
    });
    assert.equal(await heartbeat("worker-a"), baselineHeartbeat);

    const b = startChild(workerScript, ["worker-b"]);
    await waitFor("B claimed RUNNING v2", async () => {
      const state = await sample();
      if (state.row.status === "READY") return false;
      assert.equal(state.row.status, "RUNNING");
      assert.equal(state.row.current_worker_id, "worker-b");
      assert.equal(state.row.lease_version, 2);
      return true;
    });
    console.log("[demo] sampled worker-b RUNNING v2; worker-a remains stopped");
    const bHeartbeat = await heartbeat("worker-b");
    await waitFor("B completed v2", async () => (await sample()).row.status === "SUCCEEDED", 25_000);
    await waitFor("B logged its v2 completion", async () => b.output.includes(`completed step ${id} at lease_version 2:`));
    completedV2 = (await sample()).row;
    assert.equal(completedV2.lease_version, 2);
    assert.equal(completedV2.current_worker_id, null);
    assert.equal(completedV2.lease_expires_at, null);
    assert.deepEqual(completedV2.payload, payload);
    assert.deepEqual(completedV2.result, { hash: createHash("sha256").update(payload.input).digest("hex") });
    assert.notEqual(await heartbeat("worker-b"), bHeartbeat, "live B's heartbeat did not advance");
    assert.equal(await heartbeat("worker-a"), baselineHeartbeat, "stopped A's heartbeat advanced");
    console.log("[demo] B completed v2; A's heartbeat stayed unchanged after the post-stop baseline");

    signal(a, "SIGCONT");
    console.log(`[demo] SIGCONT sent to the same worker-a PID ${a.process.pid}`);
    await waitFor("A's original v1 execution attempted completion and was rejected", async () => {
      assert(!a.output.includes(`completed step ${id} at lease_version 1:`), "stale v1 completion was accepted");
      return a.output.includes(`step ${id} completion rejected at lease_version 1`);
    }, 20_000);
    assert.deepEqual((await sample()).row, completedV2, "stale execution mutated v2's terminal row");
    success = true;
  } finally {
    try {
      await stopChildren(success);
      if (success) {
        assert(ownerA && completedV2);
        assert(!ownerA.output.includes(`completed step ${id} at lease_version 1:`), "stale completion accepted during shutdown");
        assert.deepEqual((await sample()).row, completedV2);
        console.log(`[demo] PASS: original v1 execution resumed and completion was rejected; final row ${JSON.stringify(completedV2)}`);
      }
    } finally {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error("[demo] FAILED", error);
  process.exitCode = 1;
});
