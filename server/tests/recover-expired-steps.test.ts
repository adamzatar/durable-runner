import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { recoverExpiredSteps, type RecoveredStep } from "../src/db/recover-expired-steps.js";
import { runRecoveryLoop } from "../src/coordinator/recovery-loop.js";
import type { StepStatus } from "../src/domain/step-status.js";

// Recovery is the runtime authorization for RUNNING -> READY. These tests
// check both directions of that authorization (expired leases are
// recovered; nothing else is) and the lease_version causality that later
// fencing depends on: recovery ends a generation without creating one.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let sweeperPool: Pool;
let sweeper: NodePgDatabase<Record<string, never>>;

const FIXTURE_PAYLOAD = { input: "recover-fixture", delayMs: 0 };

async function insertStep(opts: {
  status: StepStatus;
  workerId?: string | null;
  leaseVersion?: number;
  leaseOffsetMs?: number | null;
}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, current_worker_id, lease_version, lease_expires_at, task_type, payload)
     values ($1, $2::step_status, $3, $4,
             case when $5::int is null then null
                  else clock_timestamp() + ($5::int * interval '1 millisecond') end,
             'hash_after_delay', $6::jsonb)`,
    [id, opts.status, opts.workerId ?? null, opts.leaseVersion ?? 0, opts.leaseOffsetMs ?? null, JSON.stringify(FIXTURE_PAYLOAD)],
  );
  return id;
}

async function snapshot(id: string): Promise<Record<string, unknown>> {
  const result = await admin.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(s) as row from steps s where id = $1",
    [id],
  );
  return result.rows[0]!.row;
}

async function sqlBool(query: string, params: unknown[]): Promise<boolean> {
  const result = await admin.query<{ ok: boolean }>(query, params);
  return result.rows[0]!.ok;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function idsOf(steps: readonly RecoveredStep[]): string[] {
  return steps.map((step) => step.id).sort();
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  sweeperPool = new Pool({ connectionString, max: 1 });
  sweeper = drizzle(sweeperPool);
});

afterAll(async () => {
  await admin.end();
  await sweeperPool.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
});

describe("recoverExpiredSteps", () => {
  it("returns an expired RUNNING step to READY, clears ownership, and preserves lease_version and payload", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "recover-a", leaseVersion: 3, leaseOffsetMs: -1_000 });
    const before = await snapshot(id);

    const recovered = await recoverExpiredSteps(sweeper);

    expect(recovered).toEqual([{ id, leaseVersion: 3 }]);
    const after = await snapshot(id);
    expect(after.status).toBe("READY");
    expect(after.current_worker_id).toBeNull();
    expect(after.lease_expires_at).toBeNull();
    expect(after.lease_version).toBe(3);
    expect(after.payload).toEqual(FIXTURE_PAYLOAD);
    expect(after.result).toBeNull();
    expect(after.priority).toBe(before.priority);
    expect(after.available_at).toBe(before.available_at);
    expect(await sqlBool("select $1::timestamptz > $2::timestamptz as ok", [after.updated_at, before.updated_at])).toBe(
      true,
    );
  });

  it("leaves RUNNING steps with unexpired leases completely untouched, including ones about to expire", async () => {
    const farId = await insertStep({ status: "RUNNING", workerId: "recover-live", leaseVersion: 1, leaseOffsetMs: 30_000 });
    const nearId = await insertStep({ status: "RUNNING", workerId: "recover-live", leaseVersion: 1, leaseOffsetMs: 2_000 });
    const farBefore = await snapshot(farId);
    const nearBefore = await snapshot(nearId);

    expect(await recoverExpiredSteps(sweeper)).toEqual([]);

    expect(await snapshot(farId)).toEqual(farBefore);
    expect(await snapshot(nearId)).toEqual(nearBefore);
  });

  it("never touches non-RUNNING rows, even ones carrying a stale owner and an expired deadline", async () => {
    // The CHECK constraint only constrains RUNNING rows, so these
    // adversarial fixtures are storable. They prove the status predicate
    // is doing work, not just the deadline predicate.
    const statuses: StepStatus[] = ["PENDING", "READY", "RETRY_WAIT", "SUCCEEDED", "DEAD_LETTERED", "CANCELLED"];
    const ids = await Promise.all(
      statuses.map((status) => insertStep({ status, workerId: "ghost", leaseVersion: 2, leaseOffsetMs: -60_000 })),
    );
    const before = await Promise.all(ids.map(snapshot));

    expect(await recoverExpiredSteps(sweeper)).toEqual([]);

    expect(await Promise.all(ids.map(snapshot))).toEqual(before);
  });

  it("recovers exactly the expired rows out of a mixed set", async () => {
    const expiredA = await insertStep({ status: "RUNNING", workerId: "mix-1", leaseVersion: 1, leaseOffsetMs: -5 });
    const expiredB = await insertStep({ status: "RUNNING", workerId: "mix-2", leaseVersion: 7, leaseOffsetMs: -10_000 });
    const live = await insertStep({ status: "RUNNING", workerId: "mix-3", leaseVersion: 1, leaseOffsetMs: 10_000 });
    const ready = await insertStep({ status: "READY" });

    const recovered = await recoverExpiredSteps(sweeper);

    expect(idsOf(recovered)).toEqual([expiredA, expiredB].sort());
    expect(recovered.find((step) => step.id === expiredB)!.leaseVersion).toBe(7);
    expect((await snapshot(live)).status).toBe("RUNNING");
    expect((await snapshot(ready)).status).toBe("READY");

    // A second sweep has nothing left to do.
    expect(await recoverExpiredSteps(sweeper)).toEqual([]);
  });

  it("generation sequence: A claims v1, A's lease expires, recovery keeps v1, B claims v2", async () => {
    const id = await insertStep({ status: "READY" });
    const claimerA = new Pool({ connectionString, max: 1 });
    const claimerB = new Pool({ connectionString, max: 1 });

    try {
      const a = await claimNextStep(drizzle(claimerA), "worker-A", { leaseDurationMs: 300 });
      expect(a.claimed && a.step.id === id && a.step.leaseVersion).toBe(1);

      await waitUntil(
        () => sqlBool("select lease_expires_at <= clock_timestamp() as ok from steps where id = $1", [id]),
        3_000,
      );

      // Expired but not yet recovered: still RUNNING under A, and not
      // claimable. Expiry alone does not hand the step to anyone; recovery
      // is the only way back to READY.
      const tooEarly = await claimNextStep(drizzle(claimerB), "worker-B");
      expect(tooEarly.claimed).toBe(false);
      const stillA = await snapshot(id);
      expect(stillA.status).toBe("RUNNING");
      expect(stillA.current_worker_id).toBe("worker-A");

      expect(await recoverExpiredSteps(sweeper)).toEqual([{ id, leaseVersion: 1 }]);
      const recovered = await snapshot(id);
      expect(recovered.status).toBe("READY");
      expect(recovered.lease_version).toBe(1);

      const b = await claimNextStep(drizzle(claimerB), "worker-B");
      expect(b.claimed).toBe(true);
      if (!b.claimed) throw new Error("unreachable");
      expect(b.step.id).toBe(id);
      expect(b.step.leaseVersion).toBe(2);

      const owned = await snapshot(id);
      expect(owned.status).toBe("RUNNING");
      expect(owned.current_worker_id).toBe("worker-B");
      expect(owned.lease_version).toBe(2);
      expect(await sqlBool("select lease_expires_at > clock_timestamp() as ok from steps where id = $1", [id])).toBe(true);
    } finally {
      await claimerA.end();
      await claimerB.end();
    }
  });

  it("skips a locked expired row, recovers an unrelated row, then recovers the skipped row after release", async () => {
    // PostgreSQL establishes expiry. X sorts first so removing SKIP LOCKED
    // makes recovery wait on X before it can finish recovering Y.
    const x = await insertStep({ status: "RUNNING", workerId: "locked-x", leaseVersion: 3, leaseOffsetMs: -2_000 });
    const y = await insertStep({ status: "RUNNING", workerId: "unlocked-y", leaseVersion: 7, leaseOffsetMs: -1_000 });
    const beforeX = await snapshot(x);
    const beforeY = await snapshot(y);
    const locker = await admin.connect();
    const recoveryClient = await sweeperPool.connect();

    try {
      // Test-only watchdog: a broken blocking implementation fails quickly.
      // Success must return while the separate locker transaction is open.
      await recoveryClient.query("set statement_timeout = '2s'");
      await locker.query("begin");
      expect((await locker.query("select id from steps where id = $1 for update", [x])).rowCount).toBe(1);

      expect(await recoverExpiredSteps(drizzle(recoveryClient))).toEqual([{ id: y, leaseVersion: 7 }]);
      expect(await snapshot(x)).toEqual(beforeX);
      expect(await snapshot(y)).toMatchObject({
        status: "READY", current_worker_id: null, lease_expires_at: null,
        lease_version: 7, payload: beforeY.payload, result: beforeY.result,
      });

      await locker.query("commit");
      expect(await recoverExpiredSteps(drizzle(recoveryClient))).toEqual([{ id: x, leaseVersion: 3 }]);
      expect(await snapshot(x)).toMatchObject({
        status: "READY", current_worker_id: null, lease_expires_at: null,
        lease_version: 3, payload: beforeX.payload, result: beforeX.result,
      });
      expect((await snapshot(y)).lease_version).toBe(7);
    } finally {
      await locker.query("rollback");
      locker.release();
      await recoveryClient.query("reset statement_timeout");
      recoveryClient.release();
    }
  });

  it("recovers at most 100 rows per sweep and leaves the remainder for the next sweep", async () => {
    const inserted = await admin.query<{ id: string }>(
      `insert into steps (id, status, current_worker_id, lease_version, lease_expires_at, task_type, payload)
       select gen_random_uuid(), 'RUNNING', 'batch-owner', 4,
              statement_timestamp() - interval '1 second', 'hash_after_delay', $1::jsonb
       from generate_series(1, 101)
       returning id`,
      [JSON.stringify(FIXTURE_PAYLOAD)],
    );
    const ids = inserted.rows.map((row) => row.id).sort();

    const first = await recoverExpiredSteps(sweeper);
    expect(idsOf(first)).toEqual(ids.slice(0, 100));
    expect(first.every((step) => step.leaseVersion === 4)).toBe(true);
    expect((await snapshot(ids[100]!)).status).toBe("RUNNING");

    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id: ids[100]!, leaseVersion: 4 }]);
    expect(await recoverExpiredSteps(sweeper)).toEqual([]);
  });

  it("is safe to run from several sweepers at once: each expired step is recovered exactly once", async () => {
    const expiredIds = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        insertStep({ status: "RUNNING", workerId: `multi-${i}`, leaseVersion: i + 1, leaseOffsetMs: -1_000 }),
      ),
    );
    const sweeperPools = Array.from({ length: 4 }, () => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all(sweeperPools.map((pool) => pool.query("select 1")));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sweeps = sweeperPools.map(async (pool) => {
        await barrier;
        return recoverExpiredSteps(drizzle(pool));
      });
      release();
      const results = await Promise.all(sweeps);

      const allReturned = results.flat().map((step) => step.id);
      // Every expired step reported by exactly one sweeper, none twice.
      expect(allReturned.length).toBe(expiredIds.length);
      expect(new Set(allReturned).size).toBe(expiredIds.length);
      expect([...allReturned].sort()).toEqual([...expiredIds].sort());

      const rows = await admin.query<{ status: string; lease_version: number; current_worker_id: string | null }>(
        "select status, lease_version, current_worker_id from steps where id = any($1::uuid[])",
        [expiredIds],
      );
      for (const row of rows.rows) {
        expect(row.status).toBe("READY");
        expect(row.current_worker_id).toBeNull();
      }
      expect(rows.rows.map((row) => row.lease_version).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 30 }, (_, i) => i + 1),
      );
    } finally {
      await Promise.all(sweeperPools.map((pool) => pool.end()));
    }
  });
});

describe("runRecoveryLoop", () => {
  it("sweeps on an interval, recovering a lease that expires while it runs, and stops when aborted", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "loop-owner", leaseVersion: 1, leaseOffsetMs: 200 });
    const controller = new AbortController();
    const logs: string[] = [];
    const errors: unknown[] = [];

    const loop = runRecoveryLoop(sweeper, {
      intervalMs: 20,
      signal: controller.signal,
      log: (message) => logs.push(message),
      logError: (_message, error) => errors.push(error),
    });

    try {
      // The lease is live when the loop starts, so the first sweeps must
      // pass over it; "recovers only expired leases" itself is pinned down
      // by the tests above, this one checks the loop keeps sweeping.
      await waitUntil(async () => (await snapshot(id)).status === "READY", 3_000);
      expect(logs.filter((line) => line.includes(id))).toHaveLength(1);
    } finally {
      controller.abort();
      await loop;
    }
    expect(errors).toEqual([]);
  });
});
