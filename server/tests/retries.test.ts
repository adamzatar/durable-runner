import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { recordStepFailure } from "../src/db/record-step-failure.js";
import { promoteDueRetries } from "../src/db/promote-due-retries.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
const admin = new Pool({ connectionString, max: 4 });
const ownerPool = new Pool({ connectionString, max: 1 });
const otherPool = new Pool({ connectionString, max: 1 });
const owner = drizzle(ownerPool);
const other = drizzle(otherPool);
const fixtureIds: string[] = [];

beforeEach(async () => { await admin.query("delete from steps"); });
afterAll(async () => {
  try { await admin.query("delete from steps where id = any($1::uuid[])", [fixtureIds]); }
  finally { await Promise.all([admin.end(), ownerPool.end(), otherPool.end()]); }
});

async function insert(maxAttempts = 3, priorAttempts = 0, priorVersion = 0) {
  const id = randomUUID();
  fixtureIds.push(id);
  await admin.query(
    `insert into steps (id, status, task_type, payload, max_attempts, attempt_count, lease_version, priority)
     values ($1, 'READY', 'fail_then_hash', '{"input":"retry-fixture","failuresBeforeSuccess":99}', $2, $3, $4, 7)`,
    [id, maxAttempts, priorAttempts, priorVersion],
  );
  return id;
}

async function row(id: string) {
  const result = await admin.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(s) as row from steps s where id = $1", [id],
  );
  return result.rows[0]!.row;
}

async function claim(leaseDurationMs = 30_000) {
  const result = await claimNextStep(owner, "worker-a", { leaseDurationMs });
  expect(result.claimed).toBe(true);
  if (!result.claimed) throw new Error("claim failed");
  return result.step;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const watchdog = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > watchdog) throw new Error("test watchdog expired");
    await sleep(5);
  }
}

async function databaseReached(id: string, column: "available_at" | "lease_expires_at") {
  const result = await admin.query(`select ${column} <= clock_timestamp() as due from steps where id = $1`, [id]);
  return result.rows[0].due === true;
}

const failure = (step: { id: string; leaseVersion: number }, retryable = true) => recordStepFailure(owner, {
  id: step.id, workerId: "worker-a", leaseVersion: step.leaseVersion, retryable, error: "deterministic failure",
});

describe("reported failure and retry policy", () => {
  it("counts claims only, waits until PostgreSQL says due, promotes, then claims a new generation/attempt", async () => {
    const id = await insert();
    expect(await row(id)).toMatchObject({ attempt_count: 0, lease_version: 0, last_error: null });
    const first = await claim();
    expect(first).toMatchObject({ id, attemptCount: 1, leaseVersion: 1 });
    const before = await row(id);
    const result = await failure(first);
    expect(result).toMatchObject({ recorded: true, status: "RETRY_WAIT", attemptCount: 1, leaseVersion: 1 });
    const waiting = await row(id);
    expect(waiting).toMatchObject({
      status: "RETRY_WAIT", attempt_count: 1, lease_version: 1, current_worker_id: null, lease_expires_at: null,
      last_error: "deterministic failure", payload: before.payload, priority: before.priority, result: before.result,
    });
    expect(await databaseReached(id, "available_at")).toBe(false);
    expect(await claimNextStep(other, "worker-b")).toEqual({ claimed: false });
    expect(await promoteDueRetries(other)).toEqual([]);
    expect(await row(id)).toEqual(waiting);
    await waitFor(() => databaseReached(id, "available_at"));
    expect(await promoteDueRetries(other)).toEqual([{ id, leaseVersion: 1, attemptCount: 1 }]);
    expect(await row(id)).toMatchObject({ ...waiting, status: "READY", updated_at: expect.any(String) });
    expect(await claim()).toMatchObject({ id, attemptCount: 2, leaseVersion: 2 });
  });

  it.each([[1, 500], [2, 1000], [3, 2000], [4, 4000], [5, 4000], [8, 4000]])(
    "attempt %i schedules exactly %i ms using one database scheduling instant", async (attempt, delay) => {
      // Different prior generation makes accidental use of lease_version
      // for the backoff distinguishable from the durable attempt count.
      const id = await insert(10, attempt - 1, 40);
      const result = await failure(await claim());
      expect(result.recorded).toBe(true);
      if (!result.recorded) throw new Error("failure rejected");
      expect(result.status).toBe("RETRY_WAIT");
      const timing = await admin.query(
        `select extract(epoch from ($1::timestamptz - $2::timestamptz)) * 1000 as delay_ms`,
        [result.availableAt, result.decidedAt],
      );
      expect(Number(timing.rows[0].delay_ms)).toBe(delay);
      expect(await row(id)).toMatchObject({ attempt_count: attempt, lease_version: 41 });
    },
  );

  it("max_attempts 3 permits exactly three attempts; final failure is terminal with no fourth claim", async () => {
    const id = await insert(3);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const step = await claim();
      expect(step).toMatchObject({ id, attemptCount: attempt, leaseVersion: attempt });
      const before = await row(id);
      expect(await failure(step)).toMatchObject({
        recorded: true, status: attempt < 3 ? "RETRY_WAIT" : "DEAD_LETTERED", attemptCount: attempt, leaseVersion: attempt,
      });
      if (attempt < 3) {
        await waitFor(() => databaseReached(id, "available_at"));
        expect(await promoteDueRetries(other)).toEqual([{ id, attemptCount: attempt, leaseVersion: attempt }]);
      } else {
        expect(await row(id)).toMatchObject({
          status: "DEAD_LETTERED", current_worker_id: null, lease_expires_at: null,
          attempt_count: 3, lease_version: 3, available_at: before.available_at, last_error: "deterministic failure",
        });
      }
    }
    const terminal = await row(id);
    expect(await promoteDueRetries(other)).toEqual([]);
    expect(await recoverExpiredSteps(other)).toEqual([]);
    expect(await claimNextStep(other, "worker-b")).toEqual({ claimed: false });
    expect(await row(id)).toEqual(terminal);
  });

  it("non-retryable invalid input dead-letters immediately without changing availability", async () => {
    const id = await insert();
    const step = await claim();
    const before = await row(id);
    expect(await failure(step, false)).toMatchObject({ recorded: true, status: "DEAD_LETTERED" });
    expect(await row(id)).toMatchObject({
      status: "DEAD_LETTERED", attempt_count: 1, lease_version: 1,
      available_at: before.available_at, current_worker_id: null, lease_expires_at: null,
    });
  });

  it("three crashed claims exhaust the total budget: final expiry dead-letters without a fourth attempt", async () => {
    const id = await insert(3);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await claim(100)).toMatchObject({ id, attemptCount: attempt, leaseVersion: attempt });
      const before = await row(id);
      await waitFor(() => databaseReached(id, "lease_expires_at"));
      const status = attempt < 3 ? "READY" : "DEAD_LETTERED";
      expect(await recoverExpiredSteps(other)).toEqual([{ id, leaseVersion: attempt, status }]);
      expect(await row(id)).toMatchObject({
        status, attempt_count: attempt, lease_version: attempt,
        current_worker_id: null, lease_expires_at: null, last_error: null,
        available_at: before.available_at, payload: before.payload, result: null,
      });
    }
    const terminal = await row(id);
    expect(await claimNextStep(other, "worker-b")).toEqual({ claimed: false });
    expect(await promoteDueRetries(other)).toEqual([]);
    expect(await row(id)).toEqual(terminal);
  });

  it("claim rejects even a manually inserted exhausted READY row", async () => {
    const id = await insert(3, 3, 12);
    const before = await row(id);
    expect(await claimNextStep(owner, "worker-a")).toEqual({ claimed: false });
    expect(await row(id)).toEqual(before);
  });

  it("concurrent claimers can consume the final available attempt only once", async () => {
    const id = await insert(3, 2, 12);
    const claims = await Promise.all([claimNextStep(owner, "worker-a"), claimNextStep(other, "worker-b")]);
    expect(claims.filter((result) => result.claimed)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "RUNNING", attempt_count: 3, lease_version: 13 });
    const winner = claims.find((result) => result.claimed)!;
    if (!winner.claimed) throw new Error("no winning claim");
    expect(await recordStepFailure(owner, {
      id, workerId: winner.step.workerId, leaseVersion: winner.step.leaseVersion, retryable: true, error: "last attempt",
    })).toMatchObject({ recorded: true, status: "DEAD_LETTERED" });
  });

  it.each(["wrong-worker", "wrong-version"])("rejects %s failure without writing", async (kind) => {
    const id = await insert();
    const step = await claim();
    const before = await row(id);
    expect(await recordStepFailure(other, {
      id, workerId: kind === "wrong-worker" ? "worker-b" : "worker-a",
      leaseVersion: kind === "wrong-version" ? step.leaseVersion + 1 : step.leaseVersion,
      retryable: true, error: "unauthorized",
    })).toEqual({ recorded: false });
    expect(await row(id)).toEqual(before);
  });

  it("rejects an expired owner before any recovery sweep", async () => {
    const id = await insert();
    const step = await claim(100);
    await waitFor(() => databaseReached(id, "lease_expires_at"));
    const before = await row(id);
    expect(await failure(step)).toEqual({ recorded: false });
    expect(await row(id)).toEqual(before);
  });

  it.each([true, false])("same-ID stale generation cannot choose retry/dead-letter after reclaim (retryable=%s)", async (retryable) => {
    const id = await insert();
    const stale = await claim(100);
    await waitFor(() => databaseReached(id, "lease_expires_at"));
    await recoverExpiredSteps(other);
    const current = await claimNextStep(other, "worker-a");
    expect(current.claimed).toBe(true);
    const before = await row(id);
    expect(before).toMatchObject({ status: "RUNNING", current_worker_id: "worker-a", attempt_count: 2, lease_version: 2 });
    expect(await databaseReached(id, "lease_expires_at")).toBe(false);
    expect(await failure(stale, retryable)).toEqual({ recorded: false });
    expect(await row(id)).toEqual(before);
    expect(await databaseReached(id, "lease_expires_at")).toBe(false);
    expect(await recordStepFailure(other, { id, workerId: "worker-a", leaseVersion: 2, retryable: true, error: "current" }))
      .toMatchObject({ recorded: true, status: "RETRY_WAIT" });
  });

  it("a failure starting live behind a lock-only holder is rejected after database-confirmed expiry", async () => {
    const id = await insert();
    const step = await claim(1_000);
    const holder = await admin.connect();
    const backend = await ownerPool.query("select pg_backend_pid() as pid");
    let pending: ReturnType<typeof failure> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from steps where id = $1 for update", [id]);
      const before = await row(id);
      pending = failure(step);
      await waitFor(async () => {
        const waiting = await admin.query("select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1", [backend.rows[0].pid]);
        return waiting.rows[0]?.waiting === true;
      });
      expect(await databaseReached(id, "lease_expires_at")).toBe(false);
      await waitFor(() => databaseReached(id, "lease_expires_at"));
      await holder.query("commit");
      expect(await pending).toEqual({ recorded: false });
      expect(await row(id)).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      if (pending) await pending;
    }
  });

  it("terminal failure cannot itself be reported again or promoted", async () => {
    const id = await insert(1);
    const step = await claim();
    expect(await failure(step)).toMatchObject({ recorded: true, status: "DEAD_LETTERED" });
    const before = await row(id);
    expect(await failure(step)).toEqual({ recorded: false });
    expect(await promoteDueRetries(other)).toEqual([]);
    expect(await row(id)).toEqual(before);
  });
});

describe("retry promotion concurrency", () => {
  async function dueRows(count: number) {
    const result = await admin.query<{ id: string }>(
      `insert into steps (status, task_type, payload, attempt_count, lease_version, last_error, available_at)
       select 'RETRY_WAIT', 'fail_then_hash', '{"input":"promotion","failuresBeforeSuccess":1}', 1, 7, 'keep me',
              clock_timestamp() - interval '1 second' from generate_series(1, $1) returning id`, [count],
    );
    const ids = result.rows.map((r) => r.id);
    fixtureIds.push(...ids);
    return ids;
  }

  it("skips a locked due row, promotes others, and revisits it on a later sweep", async () => {
    const [x, y] = await dueRows(2);
    const holder = await admin.connect();
    const before = await row(x!);
    try {
      await holder.query("begin");
      await holder.query("select id from steps where id = $1 for update", [x]);
      await otherPool.query("set statement_timeout = '1500ms'");
      expect(await promoteDueRetries(other)).toEqual([{ id: y, leaseVersion: 7, attemptCount: 1 }]);
      expect(await row(x!)).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      await otherPool.query("reset statement_timeout");
    }
    expect(await promoteDueRetries(other)).toEqual([{ id: x, leaseVersion: 7, attemptCount: 1 }]);
    expect(await row(x!)).toMatchObject({ ...before, status: "READY", updated_at: expect.any(String) });
  });

  it("bounds a sweep at 100 rows and concurrent promoters never duplicate a promotion", async () => {
    await dueRows(201);
    const [first, second] = await Promise.all([promoteDueRetries(owner), promoteDueRetries(other)]);
    expect(first.length).toBeLessThanOrEqual(100);
    expect(second.length).toBeLessThanOrEqual(100);
    const remainder = await promoteDueRetries(other);
    const all = [...first, ...second, ...remainder];
    expect(all).toHaveLength(201);
    expect(new Set(all.map((r) => r.id)).size).toBe(201);
    expect(all.every((r) => r.attemptCount === 1 && r.leaseVersion === 7)).toBe(true);
  });
});
