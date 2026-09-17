import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../src/db/complete-step.js";

// Shares the "this file owns the steps table for its run" convention from
// claim-step.test.ts. Kept as its own file/fixtures rather than importing
// from there, matching this codebase's preference for a little duplication
// over a shared test-fixture abstraction (see CLAUDE.md).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let claimerPool: Pool;
let db: NodePgDatabase<Record<string, never>>;

async function insertReadyStep(opts: { priority?: number } = {}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, priority, task_type, payload)
     values ($1, 'READY', $2, 'hash_after_delay', $3::jsonb)`,
    [id, opts.priority ?? 0, JSON.stringify({ input: "complete-step-fixture", delayMs: 0 })],
  );
  return id;
}

interface StepRow {
  id: string;
  status: string;
  result: { hash: string } | null;
  current_worker_id: string | null;
  lease_expires_at: Date | null;
  lease_version: number;
  updated_at: Date;
}

async function readStep(id: string): Promise<StepRow> {
  const result = await admin.query<StepRow>(
    `select id, status, result, current_worker_id, lease_expires_at, lease_version, updated_at
     from steps where id = $1`,
    [id],
  );
  return result.rows[0]!;
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  claimerPool = new Pool({ connectionString, max: 1 });
  db = drizzle(claimerPool);
});

afterAll(async () => {
  await admin.end();
  await claimerPool.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
});

describe("completeStepSuccess", () => {
  it("persists SUCCEEDED, the result, and the intended terminal ownership fields", async () => {
    const id = await insertReadyStep();
    const claim = await claimNextStep(db, "worker-complete-1");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await completeStepSuccess(db, {
      id,
      workerId: claim.step.workerId,
      leaseVersion: claim.step.leaseVersion,
      result: { hash: "deadbeef" },
    });

    const row = await readStep(id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.result).toEqual({ hash: "deadbeef" });
    // Terminal ownership shape: no active owner or deadline, but the
    // ownership generation the step went through is preserved, not reset.
    expect(row.current_worker_id).toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.lease_version).toBe(claim.step.leaseVersion);
    expect(row.lease_version).toBeGreaterThan(0);
  });

  it("rejects completion from the wrong worker and leaves the row untouched", async () => {
    const id = await insertReadyStep();
    const claim = await claimNextStep(db, "worker-complete-2");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(
      completeStepSuccess(db, {
        id,
        workerId: "some-impostor-worker",
        leaseVersion: claim.step.leaseVersion,
        result: { hash: "should-not-be-written" },
      }),
    ).rejects.toThrow(CompletionConsistencyError);

    const row = await readStep(id);
    expect(row.status).toBe("RUNNING");
    expect(row.current_worker_id).toBe(claim.step.workerId);
    expect(row.lease_version).toBe(claim.step.leaseVersion);
    expect(row.result).toBeNull();
  });

  it("rejects completion at a stale lease_version and leaves the row untouched", async () => {
    const id = await insertReadyStep();
    const claim = await claimNextStep(db, "worker-complete-3");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(
      completeStepSuccess(db, {
        id,
        workerId: claim.step.workerId,
        leaseVersion: claim.step.leaseVersion - 1,
        result: { hash: "should-not-be-written" },
      }),
    ).rejects.toThrow(CompletionConsistencyError);

    const row = await readStep(id);
    expect(row.status).toBe("RUNNING");
    expect(row.lease_version).toBe(claim.step.leaseVersion);
    expect(row.result).toBeNull();
  });

  it("rejects completion by the rightful owner and generation once the lease has expired, before any recovery runs", async () => {
    const id = await insertReadyStep();
    const claim = await claimNextStep(db, "worker-complete-late");
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");
    // Same owner, same lease_version, nothing swept — only the deadline
    // has passed.
    await admin.query("update steps set lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = $1", [
      id,
    ]);

    await expect(
      completeStepSuccess(db, {
        id,
        workerId: claim.step.workerId,
        leaseVersion: claim.step.leaseVersion,
        result: { hash: "should-not-be-written" },
      }),
    ).rejects.toThrow(CompletionConsistencyError);

    const row = await readStep(id);
    expect(row.status).toBe("RUNNING");
    expect(row.current_worker_id).toBe(claim.step.workerId);
    expect(row.lease_version).toBe(claim.step.leaseVersion);
    expect(row.result).toBeNull();
  });

  it("rejects completion of a step that is not RUNNING", async () => {
    const id = await insertReadyStep();

    await expect(
      completeStepSuccess(db, {
        id,
        workerId: "worker-never-claimed",
        leaseVersion: 1,
        result: { hash: "should-not-be-written" },
      }),
    ).rejects.toThrow(CompletionConsistencyError);

    const row = await readStep(id);
    expect(row.status).toBe("READY");
  });
});
