import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep, type ClaimedStep } from "../src/db/claim-step.js";
import { completeStepSuccess } from "../src/db/complete-step.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { renewStepLease } from "../src/db/renew-step-lease.js";

// Every renewal assertion is made against durable row state read back
// from PostgreSQL, and every deadline comparison is made by PostgreSQL.
// Lease deadlines are placed explicitly with fixture UPDATEs relative to
// clock_timestamp(), rather than waited out, except in the one test that
// deliberately uses a real short claim-produced lease.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let workerPool: Pool;
let db: NodePgDatabase<Record<string, never>>;

async function insertReadyStep(): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, task_type, payload)
     values ($1, 'READY', 'hash_after_delay', '{"input":"renew-fixture","delayMs":0}'::jsonb)`,
    [id],
  );
  return id;
}

async function claimOnly(workerId: string, leaseDurationMs?: number): Promise<ClaimedStep> {
  const result = await claimNextStep(db, workerId, { leaseDurationMs });
  if (!result.claimed) throw new Error("fixture claim found no work");
  return result.step;
}

async function setLeaseOffset(id: string, offsetMs: number): Promise<void> {
  await admin.query(
    "update steps set lease_expires_at = clock_timestamp() + ($2::int * interval '1 millisecond') where id = $1",
    [id, offsetMs],
  );
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
});

describe("renewStepLease", () => {
  it("lets the owning generation push a live deadline forward without changing anything else", async () => {
    const id = await insertReadyStep();
    const step = await claimOnly("renew-owner");
    // Pull the deadline in close, so an advance is unambiguous.
    await setLeaseOffset(id, 2_000);
    const before = await snapshot(id);

    const result = await renewStepLease(db, { id, workerId: "renew-owner", leaseVersion: step.leaseVersion });

    expect(result.renewed).toBe(true);
    const after = await snapshot(id);
    expect(
      await sqlBool("select $1::timestamptz > $2::timestamptz as ok", [after.lease_expires_at, before.lease_expires_at]),
    ).toBe(true);
    // Full default duration, measured from the database clock at the write.
    expect(
      await sqlBool("select $1::timestamptz > clock_timestamp() + interval '25 seconds' as ok", [after.lease_expires_at]),
    ).toBe(true);

    // Only the deadline and updated_at moved.
    const { lease_expires_at: _a, updated_at: _b, ...restAfter } = after;
    const { lease_expires_at: _c, updated_at: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after.status).toBe("RUNNING");
    expect(after.current_worker_id).toBe("renew-owner");
    expect(after.lease_version).toBe(1);
  });

  it("never increments lease_version, however many times it renews", async () => {
    const id = await insertReadyStep();
    const step = await claimOnly("renew-repeat");

    let previousDeadline = (await snapshot(id)).lease_expires_at;
    for (let i = 0; i < 5; i += 1) {
      const result = await renewStepLease(db, { id, workerId: "renew-repeat", leaseVersion: step.leaseVersion });
      expect(result.renewed).toBe(true);
      const row = await snapshot(id);
      expect(row.lease_version).toBe(step.leaseVersion);
      expect(
        await sqlBool("select $1::timestamptz >= $2::timestamptz as ok", [row.lease_expires_at, previousDeadline]),
      ).toBe(true);
      previousDeadline = row.lease_expires_at;
    }
  });

  it("rejects a different worker and leaves the row untouched", async () => {
    const id = await insertReadyStep();
    const step = await claimOnly("renew-real-owner");
    const before = await snapshot(id);

    const result = await renewStepLease(db, { id, workerId: "renew-impostor", leaseVersion: step.leaseVersion });

    expect(result).toEqual({ renewed: false });
    expect(await snapshot(id)).toEqual(before);
  });

  it("rejects the right worker at an older or newer lease_version and leaves the row untouched", async () => {
    const id = await insertReadyStep();
    // Start from generation 3 so that both an older and a newer version
    // are plausible-looking values.
    await admin.query("update steps set lease_version = 2 where id = $1", [id]);
    const step = await claimOnly("renew-versioned");
    expect(step.leaseVersion).toBe(3);
    const before = await snapshot(id);

    for (const leaseVersion of [2, 4]) {
      const result = await renewStepLease(db, { id, workerId: "renew-versioned", leaseVersion });
      expect(result).toEqual({ renewed: false });
    }
    expect(await snapshot(id)).toEqual(before);
  });

  it("rejects a step that is not RUNNING: never-claimed READY, and SUCCEEDED", async () => {
    const readyId = await insertReadyStep();
    const readyBefore = await snapshot(readyId);
    expect(await renewStepLease(db, { id: readyId, workerId: "renew-ready", leaseVersion: 0 })).toEqual({
      renewed: false,
    });
    expect(await snapshot(readyId)).toEqual(readyBefore);

    // Same row, now taken through a real claim and completion.
    const step = await claimOnly("renew-done");
    expect(step.id).toBe(readyId);
    await completeStepSuccess(db, { id: step.id, workerId: "renew-done", leaseVersion: step.leaseVersion, result: {} });
    const doneBefore = await snapshot(step.id);

    const result = await renewStepLease(db, { id: step.id, workerId: "renew-done", leaseVersion: step.leaseVersion });

    expect(result).toEqual({ renewed: false });
    // In particular, renewal did not put a deadline back on a terminal row.
    expect(await snapshot(step.id)).toEqual(doneBefore);
    expect(doneBefore.lease_expires_at).toBeNull();
  });

  it("refuses to resurrect an expired lease that recovery has not yet swept", async () => {
    const id = await insertReadyStep();
    const step = await claimOnly("renew-expired");
    await setLeaseOffset(id, -1_000);
    const before = await snapshot(id);

    const result = await renewStepLease(db, { id, workerId: "renew-expired", leaseVersion: step.leaseVersion });

    expect(result).toEqual({ renewed: false });
    // Still RUNNING under the same owner — nothing swept it — but the
    // deadline did not move, so it is still expired and still recoverable.
    expect(await snapshot(id)).toEqual(before);
    expect(before.status).toBe("RUNNING");
    expect(await recoverExpiredSteps(db)).toEqual([{ id, leaseVersion: step.leaseVersion, status: "READY" }]);
  });

  it("with a real short claim-produced lease: renewable while live, not once the database clock passes it", async () => {
    const id = await insertReadyStep();
    const step = await claimOnly("renew-short", 400);
    expect(await sqlBool("select lease_expires_at > clock_timestamp() as ok from steps where id = $1", [id])).toBe(true);

    const live = await renewStepLease(db, { id, workerId: "renew-short", leaseVersion: step.leaseVersion, leaseDurationMs: 400 });
    expect(live.renewed).toBe(true);

    await waitUntil(
      () => sqlBool("select lease_expires_at <= clock_timestamp() as ok from steps where id = $1", [id]),
      3_000,
    );

    const late = await renewStepLease(db, { id, workerId: "renew-short", leaseVersion: step.leaseVersion, leaseDurationMs: 400 });
    expect(late).toEqual({ renewed: false });
    expect((await snapshot(id)).status).toBe("RUNNING");
  });
});
