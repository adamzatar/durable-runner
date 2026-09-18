import "../load-env.js";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

// Milestone 8: the side effect happens once, the step executes twice.
//
// Real worker processes, the ordinary executor, production lease/heartbeat/
// sweep timings. A claims v1 and commits its effect, then is SIGSTOPped
// while still inside delayAfterEffectMs — so the effect is durable and the
// step completion is not. Its lease expires, the coordinator recovers the
// step, B claims v2, re-executes the same logical task, is handed A's
// stored effect result instead of applying a second effect, and completes.
// A is then resumed and its stale v1 completion is rejected by fencing.
//
// The SIGSTOP trigger is the effect row appearing in PostgreSQL, not a log
// line: the durable effect is the thing the orchestration must wait for.
// Logs are evidence of what each process did; all shared state and every
// expiry decision come from the database. No worker IPC.
//
// Each run uses a fresh idempotency key, so a rerun genuinely applies a new
// effect rather than quietly reusing the previous run's row.
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
  // No tsx launcher: this exact child PID runs the worker/coordinator, so
  // SIGSTOP/SIGCONT reach the process that holds the lease.
  const processHandle = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child: Child = { process: processHandle, output: "", exited: false, done: Promise.resolve() };
  child.done = new Promise((resolve) => {
    processHandle.once("error", (error) => { child.error = error; });
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
  attempt_count: number;
  lease_expires_at: string | null;
  result: { effectId: string; value: string } | null;
}
interface Sample {
  row: StepRow;
  observed_at: string;
  original_deadline_passed: boolean | null;
}
interface EffectRow {
  idempotency_key: string;
  effect_type: string;
  request: { value: string };
  result: { effectId: string; value: string };
  created_at: string;
}

const id = randomUUID();
const idempotencyKey = `idempotency-demo-${randomUUID()}`;
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

// Every effect stored under this run's key. The demo asserts on the whole
// set, so a second effect row would fail rather than go unnoticed.
async function effects(): Promise<EffectRow[]> {
  const result = await pool.query<EffectRow>(
    `select idempotency_key, effect_type, request, result, created_at::text
     from idempotent_effects where idempotency_key = $1`, [idempotencyKey],
  );
  return result.rows;
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
    // On failure SIGKILL also terminates a still-SIGSTOPped A. On success A
    // has resumed and finished its rejected completion, so all are idle.
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
  let applied: EffectRow | undefined;
  try {
    const pending = await pool.query(
      "select id from steps where status not in ('SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED') limit 1",
    );
    assert.equal(pending.rowCount, 0, "refusing to run with unrelated non-terminal steps");
    assert.equal((await effects()).length, 0, "this run's idempotency key is already in use");

    startChild(coordinatorScript);
    ownerA = startChild(workerScript, ["worker-a"]);
    const a = ownerA;
    await waitFor("A registered with its actual child PID", async () =>
      a.output.includes(`[worker-a] registered, pid ${a.process.pid}`));

    // delayAfterEffectMs holds the execution open after its effect commits,
    // which is the window this demo needs to stop A inside.
    const payload = { idempotencyKey, value: "receipt-created", delayAfterEffectMs: 25_000 };
    await pool.query(
      `insert into steps (id, status, task_type, payload)
       values ($1, 'READY', 'idempotent_effect', $2::jsonb)`, [id, JSON.stringify(payload)],
    );
    await waitFor("A's original executor started at v1", async () =>
      a.output.includes(`execution started for step ${id} at lease_version 1`));

    // The durable signal: A's effect has committed. The step has no result
    // and no completion yet — exactly the state a crash must be safe in.
    await waitFor("A's effect committed", async () => (await effects()).length === 1);
    applied = (await effects())[0]!;
    assert.equal(applied.effect_type, "demo_receipt");
    assert.deepEqual(applied.request, { value: "receipt-created" });
    console.log(`[demo] effect ${applied.result.effectId} committed by A at ${applied.created_at}, step not completed`);

    signal(a, "SIGSTOP");
    await waitFor("OS reports A stopped", async () => {
      const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(a.process.pid)]);
      return stdout.trim().startsWith("T");
    });
    console.log(`[demo] SIGSTOP confirmed by OS for worker-a PID ${a.process.pid}; its execution is pending`);

    // Fail promptly if orchestration stopped A inside a step transaction,
    // whose retained lock could defer recovery. Lock-only probe; it makes no
    // task/lease changes.
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
    assert.equal(stopped.row.attempt_count, 1);
    assert.equal(stopped.row.result, null, "step has a result before any completion");
    assert(stopped.row.lease_expires_at);
    originalDeadline = stopped.row.lease_expires_at;
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
      assert.equal(state.row.attempt_count, 1);
      assert.equal(state.row.current_worker_id, null);
      console.log(`[demo] sampled READY v1 after expiry at ${state.observed_at}`);
      return true;
    });
    assert.equal(await heartbeat("worker-a"), baselineHeartbeat);
    assert.deepEqual(await effects(), [applied], "effect changed while A was stopped");

    const b = startChild(workerScript, ["worker-b"]);
    await waitFor("B claimed RUNNING v2", async () => {
      const state = await sample();
      if (state.row.status === "READY") return false;
      assert.equal(state.row.status, "RUNNING");
      assert.equal(state.row.current_worker_id, "worker-b");
      assert.equal(state.row.lease_version, 2);
      // Second ownership generation AND second attempt against the budget.
      assert.equal(state.row.attempt_count, 2);
      return true;
    });
    console.log("[demo] sampled worker-b RUNNING v2; worker-a remains stopped");

    await waitFor("B completed v2", async () => (await sample()).row.status === "SUCCEEDED", 40_000);
    await waitFor("B logged its v2 completion", async () => b.output.includes(`completed step ${id} at lease_version 2:`));
    completedV2 = (await sample()).row;
    assert.equal(completedV2.lease_version, 2);
    assert.equal(completedV2.attempt_count, 2);
    assert.equal(completedV2.current_worker_id, null);
    assert.deepEqual(completedV2.payload, payload);
    // B's step result IS A's effect result: B re-executed the task and was
    // handed the stored effect instead of applying a second one.
    assert.deepEqual(completedV2.result, applied.result);
    assert.deepEqual(await effects(), [applied], "B applied a second effect");
    console.log(
      `[demo] B completed v2 reusing effect ${applied.result.effectId}; still exactly one effect row for this key`,
    );

    signal(a, "SIGCONT");
    console.log(`[demo] SIGCONT sent to the same worker-a PID ${a.process.pid}`);
    await waitFor("A's original v1 execution attempted completion and was rejected", async () => {
      assert(!a.output.includes(`completed step ${id} at lease_version 1:`), "stale v1 completion was accepted");
      return a.output.includes(`step ${id} completion rejected at lease_version 1`);
    }, 40_000);
    assert.deepEqual((await sample()).row, completedV2, "stale execution mutated v2's terminal row");
    assert.deepEqual(await effects(), [applied], "stale execution produced a second effect");
    success = true;
  } finally {
    try {
      await stopChildren(success);
      if (success) {
        assert(ownerA && completedV2 && applied);
        assert(!ownerA.output.includes(`completed step ${id} at lease_version 1:`), "stale completion accepted during shutdown");
        assert.deepEqual((await sample()).row, completedV2);
        const finalEffects = await effects();
        assert.deepEqual(finalEffects, [applied]);
        console.log(
          `[demo] PASS: 2 executions (v1 by worker-a, v2 by worker-b), ${finalEffects.length} durable effect ` +
            `(${applied.result.effectId}, created ${applied.created_at}), step SUCCEEDED at lease_version ` +
            `${completedV2.lease_version} attempt_count ${completedV2.attempt_count} with the stored effect result. ` +
            `A's resumed v1 completion was rejected. At-least-once execution, one logical side effect — not exactly-once.`,
        );
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
