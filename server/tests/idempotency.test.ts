import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../src/db/complete-step.js";
import { applyIdempotentEffect, type EffectResult } from "../src/db/idempotent-effect.js";
import { recordStepFailure } from "../src/db/record-step-failure.js";
import { promoteDueRetries } from "../src/db/promote-due-retries.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { executeStep, stepEffectKey, type ExecutionContext } from "../src/worker/execute-step.js";
import { runWorkerLoop } from "../src/worker/worker-loop.js";

// The point of the milestone: a step can execute more than once, while the
// side effect it performs happens once. Fencing protects the step row;
// the idempotency key protects the effect. These tests use the real claim,
// recovery, completion and executor code paths against real PostgreSQL.
//
// Worker IDs are deliberately the SAME across generations here, so nothing
// passes because two workers had different names — lease_version is the
// term that distinguishes a stale generation from the current one.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const WORKER_ID = "worker-a";

let admin: Pool;

interface StepRow {
  status: string;
  current_worker_id: string | null;
  lease_version: number;
  attempt_count: number;
  result: EffectResult | null;
  expired: boolean | null;
}

async function readStep(id: string): Promise<StepRow> {
  const result = await admin.query<StepRow>(
    `select status, current_worker_id, lease_version, attempt_count, result,
            lease_expires_at <= clock_timestamp() as expired
     from steps where id = $1`,
    [id],
  );
  return result.rows[0]!;
}

// Whole-row snapshot with microsecond timestamps, for "nothing changed".
async function snapshotStep(id: string): Promise<unknown> {
  const result = await admin.query<{ row: unknown }>("select to_jsonb(s) as row from steps s where id = $1", [id]);
  return result.rows[0]!.row;
}

async function effectRows(key: string): Promise<Array<{ result: EffectResult; created_at: string }>> {
  const result = await admin.query<{ result: EffectResult; created_at: string }>(
    "select result, created_at::text from idempotent_effects where idempotency_key = $1",
    [key],
  );
  return result.rows;
}

async function insertEffectStep(id: string, delayAfterEffectMs: number): Promise<string> {
  await admin.query(
    `insert into steps (id, status, priority, task_type, payload)
     values ($1, 'READY', 0, 'idempotent_effect', $2::jsonb)`,
    [id, JSON.stringify({ value: "receipt-created", delayAfterEffectMs })],
  );
  return id;
}

function contextFor(db: NodePgDatabase<Record<string, never>>): ExecutionContext {
  return { applyEffect: (request) => applyIdempotentEffect(db, request) };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Occupies the event loop so no timer — including lease renewal — can fire.
// Stands in for a frozen or CPU-blocked worker process.
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy wait
  }
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
  await admin.query("delete from idempotent_effects");
});

describe("effect committed, completion lost, step re-executed", () => {
  it("re-executes through the real worker loop after a freeze, reusing the one effect and completing at the next generation", async () => {
    const id = randomUUID();
    const key = stepEffectKey(id);
    await insertEffectStep(id, 800);
    const pool = new Pool({ connectionString, max: 1 });
    const controller = new AbortController();
    const logs: string[] = [];
    const errors: Array<{ message: string; error: unknown }> = [];
    const loop = runWorkerLoop(drizzle(pool), WORKER_ID, {
      signal: controller.signal,
      pollIntervalMs: 50,
      leaseDurationMs: 400,
      leaseRenewalIntervalMs: 80,
      log: (message) => logs.push(message),
      logError: (message, error) => errors.push({ message, error }),
    });

    try {
      // The effect row appearing is the durable proof that the side effect
      // committed; nothing about the step has been written yet.
      await waitUntil(async () => (await effectRows(key)).length === 1, 5_000, "effect never committed");
      const applied = (await effectRows(key))[0]!;
      expect((await readStep(id)).status).toBe("RUNNING");

      // Freeze the worker past its lease while its executor is still in
      // delayAfterEffectMs: renewal cannot fire, so the lease lapses.
      blockEventLoop(900);

      // The completion this execution eventually attempts is rejected: it no
      // longer holds a live lease. The effect is already durable regardless.
      await waitUntil(
        async () => errors.some((entry) => entry.error instanceof CompletionConsistencyError),
        5_000,
        "expired execution never had its completion rejected",
      );
      const afterFreeze = await readStep(id);
      expect(afterFreeze).toMatchObject({
        status: "RUNNING",
        current_worker_id: WORKER_ID,
        lease_version: 1,
        attempt_count: 1,
        result: null,
        expired: true,
      });
      expect(await effectRows(key)).toEqual([applied]);

      // Recovery returns it to READY (budget remains), the same worker loop
      // claims it as a new generation, and executes the same logical task.
      expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 1, status: "READY" }]);
      await waitUntil(async () => (await readStep(id)).status === "SUCCEEDED", 10_000, "step never completed");

      const final = await readStep(id);
      expect(final).toMatchObject({
        status: "SUCCEEDED",
        current_worker_id: null,
        // Second ownership generation, second attempt against the budget.
        lease_version: 2,
        attempt_count: 2,
      });
      // The step's durable result is the effect applied by the FIRST
      // execution, including its identifier: the second execution reused it.
      expect(final.result).toEqual(applied.result);
      // Still exactly one effect, untouched — the second execution did not
      // apply anything, it read what was already there.
      expect(await effectRows(key)).toEqual([applied]);
      expect(logs.filter((line) => line.includes(`claimed step ${id}`))).toHaveLength(2);
    } finally {
      controller.abort();
      await loop;
      await pool.end();
    }
  }, 30_000);
});

describe("stale generation after reclaim", () => {
  it.each(["completion", "retry", "dead-letter"])("same-ID post-effect stale %s is fenced while v2 is live", async (operation) => {
    const id = randomUUID();
    const key = stepEffectKey(id);
    await insertEffectStep(id, 0);
    // Two independent connections, one application-level worker ID: A and B
    // are different process lifetimes using the same name.
    const poolA = new Pool({ connectionString, max: 1 });
    const poolB = new Pool({ connectionString, max: 1 });
    const dbA = drizzle(poolA);
    const dbB = drizzle(poolB);

    try {
      // A claims v1 and runs the task: the effect commits.
      const claimA = await claimNextStep(dbA, WORKER_ID, { leaseDurationMs: 250 });
      expect(claimA.claimed).toBe(true);
      if (!claimA.claimed) throw new Error("A failed to claim");
      expect(claimA.step).toMatchObject({ leaseVersion: 1, attemptCount: 1 });
      const resultA = (await executeStep(claimA.step, contextFor(dbA))) as EffectResult;
      const applied = (await effectRows(key))[0]!;
      expect(applied.result).toEqual(resultA);

      // A never completes. Its lease lapses by the database clock and the
      // sweep hands the step back.
      await waitUntil(
        async () => (await readStep(id)).expired === true,
        5_000,
        "A's lease never expired",
      );
      expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 1, status: "READY" }]);

      // B claims v2 under the SAME worker ID and executes the same task.
      const claimB = await claimNextStep(dbB, WORKER_ID);
      expect(claimB.claimed).toBe(true);
      if (!claimB.claimed) throw new Error("B failed to claim");
      expect(claimB.step).toMatchObject({ leaseVersion: 2, attemptCount: 2 });
      const resultB = (await executeStep(claimB.step, contextFor(dbB))) as EffectResult;

      // B's execution reused A's effect: identical result, one row, same
      // created_at. B did not perform a second effect.
      expect(resultB).toEqual(resultA);
      expect(await effectRows(key)).toEqual([applied]);

      const liveV2 = await snapshotStep(id);
      expect(await readStep(id)).toMatchObject({
        status: "RUNNING", current_worker_id: WORKER_ID, expired: false,
        lease_version: 2, attempt_count: 2,
      });

      // A resumes. Its re-request finds the effect already applied...
      const reRequest = await applyIdempotentEffect(dbA, {
        idempotencyKey: key,
        effectType: "demo_receipt",
        request: { stepId: id, value: "receipt-created" },
      });
      expect(reRequest.applied).toBe(false);
      expect(reRequest.result).toEqual(applied.result);
      expect(await effectRows(key)).toEqual([applied]);

      // Every authorization term except generation matches: same ID, live
      // RUNNING successor. This cannot pass just because v2 is terminal.
      if (operation === "completion") {
        await expect(completeStepSuccess(dbA, {
          id, workerId: WORKER_ID, leaseVersion: 1, result: resultA,
        })).rejects.toBeInstanceOf(CompletionConsistencyError);
      } else {
        expect(await recordStepFailure(dbA, {
          id, workerId: WORKER_ID, leaseVersion: 1,
          error: "stale post-effect error", retryable: operation === "retry",
        })).toEqual({ recorded: false });
      }
      expect(await snapshotStep(id)).toEqual(liveV2);
      expect(await effectRows(key)).toEqual([applied]);
      await completeStepSuccess(dbB, {
        id, workerId: WORKER_ID, leaseVersion: 2, result: resultB,
      });
      expect(await readStep(id)).toMatchObject({
        status: "SUCCEEDED", lease_version: 2, attempt_count: 2, result: resultA,
      });
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }, 30_000);

  it("a re-execution after recovery produces the same step result as the execution that applied the effect", async () => {
    const id = randomUUID();
    const key = stepEffectKey(id);
    await insertEffectStep(id, 0);
    const pool = new Pool({ connectionString, max: 1 });
    const db = drizzle(pool);

    try {
      const first = await claimNextStep(db, WORKER_ID, { leaseDurationMs: 200 });
      if (!first.claimed) throw new Error("first claim failed");
      const firstResult = await executeStep(first.step, contextFor(db));

      await waitUntil(async () => (await readStep(id)).expired === true, 5_000, "lease never expired");
      await recoverExpiredSteps(drizzle(admin));

      const second = await claimNextStep(db, WORKER_ID);
      if (!second.claimed) throw new Error("second claim failed");
      const secondResult = await executeStep(second.step, contextFor(db));

      // Same payload, same key, same stored effect: the executions are
      // interchangeable from the step's point of view, which is what makes
      // re-execution safe.
      expect(secondResult).toEqual(firstResult);
      expect(await effectRows(key)).toHaveLength(1);
      expect(second.step.attemptCount).toBe(2);
      expect(second.step.leaseVersion).toBe(2);
    } finally {
      await pool.end();
    }
  }, 20_000);
});


describe("step identity and retry policy around effects", () => {
  it("different steps with identical payloads cannot share an effect", async () => {
    const db = drizzle(admin);
    const ids = [randomUUID(), randomUUID()];
    const results: unknown[] = [];
    for (const id of ids) {
      await insertEffectStep(id, 0);
      const claim = await claimNextStep(db, WORKER_ID);
      if (!claim.claimed) throw new Error("claim failed");
      results.push(await executeStep(claim.step, contextFor(db)));
      expect(await effectRows(stepEffectKey(id))).toHaveLength(1);
    }
    expect(results[0]).not.toEqual(results[1]);
    expect((await admin.query("select count(*)::int as n from idempotent_effects")).rows[0].n).toBe(2);
  });

  it("post-effect reported failures still consume exactly three attempts then dead-letter", async () => {
    const db = drizzle(admin);
    const id = randomUUID();
    await insertEffectStep(id, 0);
    let original: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await claimNextStep(db, WORKER_ID);
      if (!claim.claimed) throw new Error("claim failed");
      expect(claim.step).toMatchObject({ id, attemptCount: attempt, leaseVersion: attempt });
      // Models a valid executor whose effect commits and then throws.
      const result = await executeStep(claim.step, contextFor(db));
      if (attempt === 1) original = result;
      expect(result).toEqual(original);
      expect(await recordStepFailure(db, {
        id, workerId: WORKER_ID, leaseVersion: attempt, error: "failure after effect", retryable: true,
      })).toMatchObject({ recorded: true, status: attempt < 3 ? "RETRY_WAIT" : "DEAD_LETTERED",
        attemptCount: attempt, leaseVersion: attempt });
      if (attempt < 3) {
        await waitUntil(async () => (await admin.query(
          "select available_at <= clock_timestamp() as due from steps where id = $1", [id],
        )).rows[0].due, 5_000, "retry never due");
        expect(await promoteDueRetries(db)).toEqual([{ id, leaseVersion: attempt, attemptCount: attempt }]);
      }
    }
    expect(await effectRows(stepEffectKey(id))).toHaveLength(1);
    expect(await readStep(id)).toMatchObject({ status: "DEAD_LETTERED", attempt_count: 3, lease_version: 3, result: null });
    expect(await promoteDueRetries(db)).toEqual([]);
    expect(await recoverExpiredSteps(db)).toEqual([]);
    expect(await claimNextStep(db, WORKER_ID)).toEqual({ claimed: false });
  });

  it("an effect on the last crashed attempt remains durable even when recovery dead-letters", async () => {
    const db = drizzle(admin);
    const id = randomUUID();
    await insertEffectStep(id, 0);
    await admin.query("update steps set max_attempts = 1 where id = $1", [id]);
    const claim = await claimNextStep(db, WORKER_ID, { leaseDurationMs: 150 });
    if (!claim.claimed) throw new Error("claim failed");
    const result = await executeStep(claim.step, contextFor(db));
    await waitUntil(async () => (await readStep(id)).expired === true, 5_000, "lease never expired");
    expect(await recoverExpiredSteps(db)).toEqual([{ id, leaseVersion: 1, status: "DEAD_LETTERED" }]);
    expect(await claimNextStep(db, WORKER_ID)).toEqual({ claimed: false });
    expect(await effectRows(stepEffectKey(id))).toMatchObject([{ result }]);
    expect(await readStep(id)).toMatchObject({ status: "DEAD_LETTERED", attempt_count: 1, result: null });
  });

  it.each([
    ["idempotent_effect", { value: "", delayAfterEffectMs: 0 }],
    ["idempotent_effect", { idempotencyKey: "caller-key", value: "v", delayAfterEffectMs: 0 }],
    ["unsupported", { value: "v", delayAfterEffectMs: 0 }],
  ])("invalid %s input dead-letters on the first attempt without an effect", async (taskType, payload) => {
    const id = randomUUID();
    await admin.query("insert into steps (id, status, task_type, payload) values ($1, 'READY', $2, $3)",
      [id, taskType, JSON.stringify(payload)]);
    const controller = new AbortController();
    const loop = runWorkerLoop(drizzle(admin), WORKER_ID, {
      signal: controller.signal, pollIntervalMs: 10, log: () => {}, logError: () => {},
    });
    try {
      await waitUntil(async () => (await readStep(id)).status === "DEAD_LETTERED", 5_000, "invalid task not rejected");
      expect(await readStep(id)).toMatchObject({ attempt_count: 1, lease_version: 1, result: null });
      expect((await admin.query("select count(*)::int as n from idempotent_effects")).rows[0].n).toBe(0);
    } finally {
      controller.abort();
      await loop;
    }
  });
});
