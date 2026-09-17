import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CompletionConsistencyError, completeStepSuccess } from "../src/db/complete-step.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";
import { renewStepLease } from "../src/db/renew-step-lease.js";

// Owner writes (renewal, completion) racing the recovery sweep, each side
// on its own PostgreSQL connection so the statements genuinely overlap
// inside the database. These are logical actors in one Vitest process, not
// separate OS processes; what is under test is how PostgreSQL orders
// competing row writes, not process isolation.
//
// Deadlines are placed explicitly relative to clock_timestamp() rather than
// produced by sleeping, so which side is *allowed* to win is known in
// advance for every case except the deliberately spread-out one at the end.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const WORKER = "race-owner";
const VERSION = 1;

let admin: Pool;
let ownerPool: Pool;
let sweeperPool: Pool;
let ownerClient: PoolClient;
let sweeperClient: PoolClient;
let owner: NodePgDatabase<Record<string, never>>;
let sweeper: NodePgDatabase<Record<string, never>>;

async function insertRunning(leaseOffsetMs: number, input = "race-fixture"): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, current_worker_id, lease_version, lease_expires_at, task_type, payload)
     values ($1, 'RUNNING', $2, $3, clock_timestamp() + ($4::int * interval '1 millisecond'),
             'hash_after_delay', $5::jsonb)`,
    [id, WORKER, VERSION, leaseOffsetMs, JSON.stringify({ input, delayMs: 0 })],
  );
  return id;
}

interface Row {
  status: string;
  current_worker_id: string | null;
  lease_version: number;
  lease_expires_at: string | null;
  result: Record<string, unknown> | null;
  expired: boolean | null;
}

async function readRow(id: string): Promise<Row> {
  const result = await admin.query<Row>(
    `select status, current_worker_id, lease_version, lease_expires_at::text, result,
            lease_expires_at <= clock_timestamp() as expired
     from steps where id = $1`,
    [id],
  );
  return result.rows[0]!;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tryComplete(db: NodePgDatabase<Record<string, never>>, id: string, result: Record<string, unknown>) {
  try {
    await completeStepSuccess(db, { id, workerId: WORKER, leaseVersion: VERSION, result });
    return true;
  } catch (error) {
    if (error instanceof CompletionConsistencyError) return false;
    throw error;
  }
}

type LockHolder =
  // A transaction that modifies the row (without touching ownership or the
  // deadline) and holds it. When it commits, PostgreSQL re-reads the new
  // row version for anything that was waiting on it.
  | "modifies-row"
  // A transaction that only runs SELECT ... FOR UPDATE and holds it. When
  // it commits, nothing about the row changed, and PostgreSQL does not
  // re-evaluate a waiting single-statement UPDATE's WHERE clause. This is
  // the case that let an expired lease be renewed before renewal/completion
  // took the lock themselves.
  | "lock-only";

/**
 * Holds the owner's write in a row-lock wait, deterministically, and
 * releases it either after the lease has expired or while it is still
 * live:
 *
 * 1. The lease is live.
 * 2. A separate transaction takes the row lock (`holder` says how) and
 *    keeps its transaction open. This holder is synthetic — no application
 *    code holds a RUNNING row's lock like this — it exists to hold the
 *    owner's operation in a lock wait for as long as the test needs.
 * 3. The owner's write starts. The test confirms, via pg_stat_activity,
 *    that the owner's backend is waiting on a lock, and then confirms from
 *    the database clock that the lease is STILL live — so the owner's
 *    operation provably started, and blocked, before the deadline.
 * 4. Either the test waits until the database clock is past the deadline
 *    (`release: "after-expiry"`), or it waits `ms` and confirms the lease is
 *    still live (`release: { whileLiveAfterMs }`).
 * 5. The holder commits, releasing the lock.
 *
 * Returns whatever the owner's write reported.
 */
async function ownerWriteHeldBehindLock<T>(
  id: string,
  holder: LockHolder,
  release: "after-expiry" | { whileLiveAfterMs: number },
  write: (db: NodePgDatabase<Record<string, never>>) => Promise<T>,
): Promise<T> {
  const lockerPool = new Pool({ connectionString, max: 1 });
  const locker = await lockerPool.connect();
  const ownerPid = (await ownerClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

  try {
    await locker.query("begin");
    if (holder === "modifies-row") {
      await locker.query("update steps set updated_at = now() where id = $1", [id]);
    } else {
      const locked = await locker.query("select id from steps where id = $1 for update", [id]);
      expect(locked.rowCount).toBe(1);
    }

    const pending = write(owner);
    await waitUntil(
      async () => {
        const activity = await admin.query<{ wait_event_type: string | null }>(
          "select wait_event_type from pg_stat_activity where pid = $1",
          [ownerPid],
        );
        return activity.rows[0]?.wait_event_type === "Lock";
      },
      2_000,
      "owner write never waited on the row lock",
    );
    expect((await readRow(id)).expired).toBe(false);

    if (release === "after-expiry") {
      await waitUntil(async () => (await readRow(id)).expired === true, 3_000, "lease never expired");
    } else {
      await new Promise((resolve) => setTimeout(resolve, release.whileLiveAfterMs));
      expect((await readRow(id)).expired).toBe(false);
    }

    await locker.query("commit");
    return await pending;
  } finally {
    await locker.query("rollback").catch(() => undefined);
    locker.release();
    await lockerPool.end();
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString, max: 4 });
  ownerPool = new Pool({ connectionString, max: 1 });
  sweeperPool = new Pool({ connectionString, max: 1 });
  // Pinned clients, so each side is exactly one backend for the whole file
  // and the owner's PID is stable for the lock-wait checks.
  ownerClient = await ownerPool.connect();
  sweeperClient = await sweeperPool.connect();
  owner = drizzle(ownerClient);
  sweeper = drizzle(sweeperClient);
});

afterAll(async () => {
  ownerClient.release();
  sweeperClient.release();
  await ownerPool.end();
  await sweeperPool.end();
  await admin.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
});

const ROUNDS = 25;

describe("renewal vs recovery", () => {
  it("on an expired lease: renewal loses every time and the generation is never resurrected", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      // Expired by between 1ms and 25ms: right at the boundary, not an
      // hour ago.
      const id = await insertRunning(-(round + 1));

      const [renewal, recovered] = await Promise.all([
        renewStepLease(owner, { id, workerId: WORKER, leaseVersion: VERSION }),
        recoverExpiredSteps(sweeper),
      ]);

      expect(renewal).toEqual({ renewed: false });
      // The first sweep may skip the rejecting renewal's row lock. Once
      // both operations finish, the next sweep must recover any skipped row.
      expect([...recovered, ...(await recoverExpiredSteps(sweeper))]).toEqual([{ id, leaseVersion: VERSION }]);
      const row = await readRow(id);
      expect(row.status).toBe("READY");
      expect(row.current_worker_id).toBeNull();
      expect(row.lease_expires_at).toBeNull();
      expect(row.lease_version).toBe(VERSION);
    }
  });

  it("on a live lease: recovery never takes it, and renewal extends it", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await insertRunning(1_000);

      const [renewal, recovered] = await Promise.all([
        renewStepLease(owner, { id, workerId: WORKER, leaseVersion: VERSION }),
        recoverExpiredSteps(sweeper),
      ]);

      expect(renewal.renewed).toBe(true);
      expect(recovered).toEqual([]);
      const row = await readRow(id);
      expect(row.status).toBe("RUNNING");
      expect(row.current_worker_id).toBe(WORKER);
      expect(row.lease_version).toBe(VERSION);
      expect(row.expired).toBe(false);
    }
  });

  it("a renewal that starts while the lease is live but waits behind a row-MODIFYING lock holder past the deadline is rejected", async () => {
    const id = await insertRunning(500);

    const renewal = await ownerWriteHeldBehindLock(id, "modifies-row", "after-expiry", (db) =>
      renewStepLease(db, { id, workerId: WORKER, leaseVersion: VERSION }),
    );

    expect(renewal).toEqual({ renewed: false });
    const row = await readRow(id);
    expect(row.status).toBe("RUNNING");
    expect(row.expired).toBe(true);
    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id, leaseVersion: VERSION }]);
  });

  it("a renewal that starts while the lease is live but waits behind a LOCK-ONLY holder (SELECT ... FOR UPDATE) past the deadline is rejected", async () => {
    const id = await insertRunning(500);
    const deadlineBefore = (await readRow(id)).lease_expires_at;

    const renewal = await ownerWriteHeldBehindLock(id, "lock-only", "after-expiry", (db) =>
      renewStepLease(db, { id, workerId: WORKER, leaseVersion: VERSION }),
    );

    // Regression test for the hole found in Milestone 5: a single-statement
    // renewal evaluated "still live" before this wait and, because a
    // lock-only holder triggers no re-evaluation, extended the lease after
    // it had expired.
    expect(renewal).toEqual({ renewed: false });
    const row = await readRow(id);
    expect(row.status).toBe("RUNNING");
    expect(row.lease_version).toBe(VERSION);
    expect(row.lease_expires_at).toBe(deadlineBefore);
    expect(row.expired).toBe(true);
    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id, leaseVersion: VERSION }]);
  });

  it("control: a renewal held behind a lock-only holder that is released while the lease is still live succeeds", async () => {
    const id = await insertRunning(3_000);
    const deadlineBefore = (await readRow(id)).lease_expires_at;

    const renewal = await ownerWriteHeldBehindLock(id, "lock-only", { whileLiveAfterMs: 200 }, (db) =>
      renewStepLease(db, { id, workerId: WORKER, leaseVersion: VERSION }),
    );

    // Waiting is not itself grounds for rejection; the deadline is.
    expect(renewal.renewed).toBe(true);
    const row = await readRow(id);
    expect(row.status).toBe("RUNNING");
    expect(row.lease_version).toBe(VERSION);
    expect(row.lease_expires_at).not.toBe(deadlineBefore);
    expect(row.expired).toBe(false);
  });
});

describe("recovery behind row locks", () => {
  // Recovery skips rows held by either lock-only or modifying transactions.
  // A later sweep evaluates the committed state after the holder releases.
  it("a sweep skips a lock-only holder on an expired lease and recovers it on a later sweep after release", async () => {
    const id = await insertRunning(-1);
    const lockerPool = new Pool({ connectionString, max: 1 });
    const locker = await lockerPool.connect();
    try {
      await locker.query("begin");
      await locker.query("select id from steps where id = $1 for update", [id]);
      await sweeperClient.query("set statement_timeout = '2s'");
      expect(await recoverExpiredSteps(sweeper)).toEqual([]);
      expect((await readRow(id)).status).toBe("RUNNING");
      await locker.query("commit");

      expect(await recoverExpiredSteps(sweeper)).toEqual([{ id, leaseVersion: VERSION }]);
      expect((await readRow(id)).status).toBe("READY");
    } finally {
      await locker.query("rollback").catch(() => undefined);
      await sweeperClient.query("reset statement_timeout");
      locker.release();
      await lockerPool.end();
    }
  });

  it("a sweep skips an in-flight renewal; after commit, it leaves a still-live renewed deadline alone", async () => {
    // A synthetic owner running renewStepLease's two statements by hand, so
    // the test can hold the transaction open between the authorized UPDATE
    // and COMMIT (renewStepLease itself can't be paused there).
    const id = await insertRunning(400);
    const ownerTxPool = new Pool({ connectionString, max: 1 });
    const ownerTx = await ownerTxPool.connect();
    try {
      await ownerTx.query("begin");
      await ownerTx.query("select id from steps where id = $1 for update", [id]);
      const renewed = await ownerTx.query(
        `update steps set lease_expires_at = clock_timestamp() + interval '30 seconds'
         where id = $1 and status = 'RUNNING' and current_worker_id = $2 and lease_version = $3
           and lease_expires_at > clock_timestamp()
         returning id`,
        [id, WORKER, VERSION],
      );
      expect(renewed.rowCount).toBe(1);

      // Other sessions still see the committed old deadline, and by the
      // database clock it has now passed.
      await waitUntil(async () => (await readRow(id)).expired === true, 3_000, "old deadline never passed");
      await sweeperClient.query("set statement_timeout = '2s'");
      expect(await recoverExpiredSteps(sweeper)).toEqual([]);
      await ownerTx.query("commit");

      // This new sweep sees the committed renewal, whose deadline is still
      // live. A renewed deadline already expired at this check is recoverable.
      expect(await recoverExpiredSteps(sweeper)).toEqual([]);
      const row = await readRow(id);
      expect(row.status).toBe("RUNNING");
      expect(row.expired).toBe(false);
    } finally {
      await ownerTx.query("rollback").catch(() => undefined);
      await sweeperClient.query("reset statement_timeout");
      ownerTx.release();
      await ownerTxPool.end();
    }
  });
});

describe("completion vs recovery", () => {
  it("on an expired lease: completion is rejected whether it runs before, after, or alongside recovery", async () => {
    // Before recovery: no sweep has happened, and completion is still
    // rejected. The deadline, not the sweeper, ends the owner's authority.
    const first = await insertRunning(-1);
    expect(await tryComplete(owner, first, { hash: "late" })).toBe(false);
    const unswept = await readRow(first);
    expect(unswept.status).toBe("RUNNING");
    expect(unswept.result).toBeNull();
    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id: first, leaseVersion: VERSION }]);

    // After recovery.
    const second = await insertRunning(-1);
    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id: second, leaseVersion: VERSION }]);
    expect(await tryComplete(owner, second, { hash: "late" })).toBe(false);
    expect((await readRow(second)).status).toBe("READY");

    // Alongside.
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await insertRunning(-(round + 1));

      const [completed, recovered] = await Promise.all([
        tryComplete(owner, id, { hash: "late" }),
        recoverExpiredSteps(sweeper),
      ]);

      expect(completed).toBe(false);
      // Recovery may skip the rejecting completion's lock on this sweep.
      expect([...recovered, ...(await recoverExpiredSteps(sweeper))]).toEqual([{ id, leaseVersion: VERSION }]);
      const row = await readRow(id);
      expect(row.status).toBe("READY");
      expect(row.result).toBeNull();
      expect(row.lease_version).toBe(VERSION);
    }
  });

  it("on a live lease: completion wins every time and recovery never touches the row", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await insertRunning(1_000);

      const [completed, recovered] = await Promise.all([
        tryComplete(owner, id, { hash: `on-time-${round}` }),
        recoverExpiredSteps(sweeper),
      ]);

      expect(completed).toBe(true);
      expect(recovered).toEqual([]);
      const row = await readRow(id);
      expect(row.status).toBe("SUCCEEDED");
      expect(row.result).toEqual({ hash: `on-time-${round}` });
      expect(row.current_worker_id).toBeNull();
      expect(row.lease_expires_at).toBeNull();
      expect(row.lease_version).toBe(VERSION);
    }
  });

  it("a completion that starts while the lease is live but waits behind a row-MODIFYING lock holder past the deadline is rejected", async () => {
    const id = await insertRunning(500);

    const completed = await ownerWriteHeldBehindLock(id, "modifies-row", "after-expiry", (db) =>
      tryComplete(db, id, { hash: "late" }),
    );

    expect(completed).toBe(false);
    const row = await readRow(id);
    expect(row.status).toBe("RUNNING");
    expect(row.result).toBeNull();
    expect(row.expired).toBe(true);
  });

  it("a completion that starts while the lease is live but waits behind a LOCK-ONLY holder (SELECT ... FOR UPDATE) past the deadline is rejected", async () => {
    const id = await insertRunning(500);

    const completed = await ownerWriteHeldBehindLock(id, "lock-only", "after-expiry", (db) =>
      tryComplete(db, id, { hash: "late" }),
    );

    // Regression test for the same hole as the renewal case: without taking
    // the lock first, this committed SUCCEEDED for an expired generation.
    expect(completed).toBe(false);
    const row = await readRow(id);
    expect(row.status).toBe("RUNNING");
    expect(row.current_worker_id).toBe(WORKER);
    expect(row.lease_version).toBe(VERSION);
    expect(row.result).toBeNull();
    expect(row.expired).toBe(true);
    expect(await recoverExpiredSteps(sweeper)).toEqual([{ id, leaseVersion: VERSION }]);
    expect((await readRow(id)).result).toBeNull();
  });

  it("control: a completion held behind a lock-only holder that is released while the lease is still live succeeds", async () => {
    const id = await insertRunning(3_000);

    const completed = await ownerWriteHeldBehindLock(id, "lock-only", { whileLiveAfterMs: 200 }, (db) =>
      tryComplete(db, id, { hash: "in-time" }),
    );

    expect(completed).toBe(true);
    const row = await readRow(id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.result).toEqual({ hash: "in-time" });
    expect(row.lease_version).toBe(VERSION);
  });

  it("owner writes that wait while another transaction changes the row's ownership are rejected, even though the row's lease is live", async () => {
    // The lock holder replaces the ownership generation (different owner,
    // next version, fresh 30s deadline) and commits while the owner's write
    // waits. The deadline on the row after the wait is live, so only the
    // owner/version conditions in the authoritative UPDATE can reject.
    for (const operation of ["renewal", "completion"] as const) {
      const id = await insertRunning(3_000);
      const lockerPool = new Pool({ connectionString, max: 1 });
      const locker = await lockerPool.connect();
      const ownerPid = (await ownerClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      try {
        await locker.query("begin");
        await locker.query(
          `update steps set current_worker_id = 'someone-else', lease_version = lease_version + 1,
                            lease_expires_at = clock_timestamp() + interval '30 seconds'
           where id = $1`,
          [id],
        );
        const pending =
          operation === "renewal"
            ? renewStepLease(owner, { id, workerId: WORKER, leaseVersion: VERSION }).then((r) => r.renewed)
            : tryComplete(owner, id, { hash: "stale" });
        await waitUntil(
          async () =>
            (await admin.query("select wait_event_type from pg_stat_activity where pid = $1", [ownerPid])).rows[0]
              ?.wait_event_type === "Lock",
          2_000,
          "owner write never waited on the row lock",
        );
        await locker.query("commit");

        expect(await pending).toBe(false);
        const row = await readRow(id);
        expect(row.status).toBe("RUNNING");
        expect(row.current_worker_id).toBe("someone-else");
        expect(row.lease_version).toBe(VERSION + 1);
        expect(row.result).toBeNull();
        expect(row.expired).toBe(false);
      } finally {
        await locker.query("rollback").catch(() => undefined);
        locker.release();
        await lockerPool.end();
      }
    }
  });

  it("with each completion attempted close to its own deadline while sweeps run continuously, every row ends in exactly one legal outcome that matches what each side reported", async () => {
    const ROWS = 60;
    const LEAD_MS = 150;
    const SPACING_MS = 5;
    const completionPools = Array.from({ length: ROWS }, () => new Pool({ connectionString, max: 1 }));
    const extraSweeperPools = Array.from({ length: 2 }, () => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all([...completionPools, ...extraSweeperPools].map((pool) => pool.query("select 1")));

      // Deadlines are spaced approximately 5ms apart. clock_timestamp()
      // is evaluated per row, so there is no single frozen database instant.
      const inserted = await admin.query<{ id: string; i: number }>(
        `insert into steps (id, status, current_worker_id, lease_version, lease_expires_at, task_type, payload)
         select gen_random_uuid(), 'RUNNING', $1, $2,
                clock_timestamp() + ((${LEAD_MS} + g.i * ${SPACING_MS}) * interval '1 millisecond'),
                'hash_after_delay', jsonb_build_object('input', 'spread-' || g.i, 'delayMs', 0)
         from generate_series(0, $3::int - 1) as g(i)
         returning id, (payload->>'input')::text as i`,
        [WORKER, VERSION, ROWS],
      );
      const ids = new Array<string>(ROWS);
      for (const row of inserted.rows) {
        ids[Number(String(row.i).replace("spread-", ""))] = row.id;
      }

      // The local clock is used only to decide WHEN to send each
      // completion — aimed at its row's deadline, with a fixed jitter of
      // -4..+4ms so some land just before and some just after. Which of
      // those actually happened is decided by PostgreSQL and read back
      // from the rows, never inferred from these local times.
      const insertedAtLocal = Date.now();
      const completions = ids.map(async (id, i) => {
        const jitterMs = ((i * 7) % 9) - 4;
        const sendAt = insertedAtLocal + LEAD_MS + i * SPACING_MS + jitterMs;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, sendAt - Date.now())));
        return tryComplete(drizzle(completionPools[i]!), id, { hash: `spread-${i}` });
      });
      const sweepUntil = insertedAtLocal + LEAD_MS + ROWS * SPACING_MS + 50;
      const sweepers = [sweeper, ...extraSweeperPools.map((pool) => drizzle(pool))].map(async (db) => {
        const recovered: string[] = [];
        while (Date.now() < sweepUntil) {
          recovered.push(...(await recoverExpiredSteps(db)).map((step) => step.id));
        }
        return recovered;
      });

      const completedFlags = await Promise.all(completions);
      const recoveredIds = (await Promise.all(sweepers)).flat();
      // No row recovered twice, across three concurrent sweepers.
      expect(new Set(recoveredIds).size).toBe(recoveredIds.length);
      const recoveredSet = new Set(recoveredIds);

      let completedCount = 0;
      let recoveredCount = 0;
      let expiredUnsweptCount = 0;
      for (const [i, id] of ids.entries()) {
        const completed = completedFlags[i]!;
        const recovered = recoveredSet.has(id);
        const row = await readRow(id);

        // Never both: a completion that won means the lease was live when it
        // was checked, and the completed row is no longer RUNNING, so no
        // sweep could have matched it before or after.
        expect(completed && recovered).toBe(false);
        expect(row.lease_version).toBe(VERSION);

        if (completed) {
          completedCount += 1;
          expect(row.status).toBe("SUCCEEDED");
          expect(row.result).toEqual({ hash: `spread-${i}` });
          expect(row.current_worker_id).toBeNull();
          expect(row.lease_expires_at).toBeNull();
        } else if (recovered) {
          recoveredCount += 1;
          expect(row.status).toBe("READY");
          expect(row.result).toBeNull();
          expect(row.current_worker_id).toBeNull();
          expect(row.lease_expires_at).toBeNull();
        } else {
          // Legal third outcome: the completion checked the row after its
          // deadline, and no sweep has matched it yet. Expired, still
          // showing its old owner, but nobody can write to it except the
          // next sweep.
          expiredUnsweptCount += 1;
          expect(row.status).toBe("RUNNING");
          expect(row.current_worker_id).toBe(WORKER);
          expect(row.result).toBeNull();
          expect(row.expired).toBe(true);
        }
      }

      expect(completedCount + recoveredCount + expiredUnsweptCount).toBe(ROWS);

      // One more sweep picks up exactly the expired-unswept rows and leaves
      // every SUCCEEDED row alone.
      const finalSweep = await recoverExpiredSteps(sweeper);
      expect(finalSweep).toHaveLength(expiredUnsweptCount);
      const statuses = await admin.query<{ status: string; n: string }>(
        "select status, count(*) as n from steps where id = any($1::uuid[]) group by status",
        [ids],
      );
      const byStatus = Object.fromEntries(statuses.rows.map((row) => [row.status, Number(row.n)]));
      expect(byStatus).toEqual({
        ...(completedCount > 0 ? { SUCCEEDED: completedCount } : {}),
        ...(recoveredCount + expiredUnsweptCount > 0 ? { READY: recoveredCount + expiredUnsweptCount } : {}),
      });
    } finally {
      await Promise.all([...completionPools, ...extraSweeperPools].map((pool) => pool.end()));
    }
  }, 20_000);
});
