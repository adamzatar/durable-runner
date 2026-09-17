import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../src/db/complete-step.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { renewStepLease } from "../src/db/renew-step-lease.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// Independent connections model separate worker lifetimes even when their
// application-level worker IDs match. No synthetic owner/version replacement.
const admin = new Pool({ connectionString, max: 1 });
const oldPool = new Pool({ connectionString, max: 1 });
const newPool = new Pool({ connectionString, max: 1 });
const oldOwner = drizzle(oldPool);
const newOwner = drizzle(newPool);
let fixtureId: string;

beforeEach(async () => {
  await admin.query("delete from steps");
  fixtureId = randomUUID();
  await admin.query(
    `insert into steps (id, status, priority, available_at, task_type, payload)
     values ($1, 'READY', 7, clock_timestamp() - interval '1 second',
             'hash_after_delay', '{"input":"fencing-fixture","delayMs":0}')`,
    [fixtureId],
  );
});

afterEach(async () => {
  await admin.query("delete from steps where id = $1", [fixtureId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), oldPool.end(), newPool.end()]);
});

// JSON timestamps retain PostgreSQL's microseconds, unlike JS Date parsing.
// Comparing the entire row checks payload, result, scheduling and updated_at
// as well as every ownership field: rejection must perform no durable write.
async function readRow() {
  const result = await admin.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(s) as row from steps s where id = $1", [fixtureId],
  );
  return result.rows[0]!.row;
}

async function reclaim(newWorkerId: string) {
  expect(await readRow()).toMatchObject({ status: "READY", lease_version: 0 });
  const first = await claimNextStep(oldOwner, "worker-a", { leaseDurationMs: 100 });
  expect(first.claimed).toBe(true);
  if (!first.claimed) throw new Error("first claim failed");
  expect(first.step).toMatchObject({ id: fixtureId, workerId: "worker-a", leaseVersion: 1 });

  // Process time is only a watchdog. PostgreSQL alone establishes expiry.
  const watchdog = Date.now() + 5_000;
  for (;;) {
    const expiry = await admin.query<{ expired: boolean }>(
      "select lease_expires_at <= clock_timestamp() as expired from steps where id = $1", [fixtureId],
    );
    if (expiry.rows[0]!.expired) break;
    if (Date.now() > watchdog) throw new Error("database lease did not expire within watchdog");
    await sleep(10);
  }

  expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id: fixtureId, leaseVersion: 1 }]);
  expect(await readRow()).toMatchObject({
    status: "READY", current_worker_id: null, lease_expires_at: null, lease_version: 1,
  });

  const second = await claimNextStep(newOwner, newWorkerId);
  expect(second.claimed).toBe(true);
  if (!second.claimed) throw new Error("second claim failed");
  expect(second.step).toMatchObject({ id: fixtureId, workerId: newWorkerId, leaseVersion: 2 });
  return first.step;
}

async function assertLiveV2(newWorkerId: string) {
  const result = await admin.query(
    `select status, current_worker_id, lease_version,
            lease_expires_at > clock_timestamp() as live
     from steps where id = $1`, [fixtureId],
  );
  expect(result.rows[0]).toEqual({
    status: "RUNNING", current_worker_id: newWorkerId, lease_version: 2, live: true,
  });
}

async function finishCurrentOwner(newWorkerId: string) {
  const before = await readRow();
  expect(await renewStepLease(newOwner, {
    id: fixtureId, workerId: newWorkerId, leaseVersion: 2, leaseDurationMs: 60_000,
  })).toMatchObject({ renewed: true });
  const extension = await admin.query(
    "select lease_expires_at > $2::timestamptz as extended from steps where id = $1",
    [fixtureId, before.lease_expires_at],
  );
  expect(extension.rows[0].extended).toBe(true);
  expect(await readRow()).toMatchObject({ status: "RUNNING", current_worker_id: newWorkerId, lease_version: 2 });
  await completeStepSuccess(newOwner, {
    id: fixtureId, workerId: newWorkerId, leaseVersion: 2, result: { hash: "current-generation-result" },
  });
  expect(await readRow()).toMatchObject({
    status: "SUCCEEDED", lease_version: 2, current_worker_id: null, lease_expires_at: null,
    result: { hash: "current-generation-result" },
    payload: before.payload, priority: before.priority, available_at: before.available_at,
  });
}

describe("ownership generation fencing after real expiry/recovery/reclaim", () => {
  for (const [label, newWorkerId] of [["different-ID", "worker-b"], ["same-ID", "worker-a"]] as const) {
    it(`${label} stale completion rejects v1 while v2 is RUNNING with a live lease`, async () => {
      const stale = await reclaim(newWorkerId);
      const before = await readRow();
      await assertLiveV2(newWorkerId);
      await expect(completeStepSuccess(oldOwner, {
        id: stale.id, workerId: stale.workerId, leaseVersion: stale.leaseVersion,
        result: { hash: "stale-generation-result" },
      })).rejects.toBeInstanceOf(CompletionConsistencyError);
      expect(await readRow()).toEqual(before);
      // Checking liveness after rejection rules out deadline expiry as the
      // reason. For same-ID, version is the only false authorization term.
      await assertLiveV2(newWorkerId);
      await finishCurrentOwner(newWorkerId);
    });

    it(`${label} stale renewal cannot extend v2's live deadline`, async () => {
      const stale = await reclaim(newWorkerId);
      const before = await readRow();
      await assertLiveV2(newWorkerId);
      expect(await renewStepLease(oldOwner, {
        id: stale.id, workerId: stale.workerId, leaseVersion: stale.leaseVersion, leaseDurationMs: 120_000,
      })).toEqual({ renewed: false });
      expect(await readRow()).toEqual(before);
      await assertLiveV2(newWorkerId);
      await finishCurrentOwner(newWorkerId);
    });
  }
});
