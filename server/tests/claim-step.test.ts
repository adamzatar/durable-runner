import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  STEP_LEASE_DURATION_MS,
  claimNextStep,
  type ClaimedStep,
} from "../src/db/claim-step.js";
import type { StepStatus } from "../src/domain/step-status.js";

// This file owns the `steps` table for the duration of the run: it deletes
// every row before each test so results never depend on what a previous
// run (or the Phase 0 spike) left behind in the development database.
// Assertions still reference explicitly inserted IDs rather than global
// counts. If another test file ever starts writing to `steps`, these tests
// need `fileParallelism: false` — today this is the only one.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Used only for fixtures and verification, never for claiming.
let admin: Pool;

interface Claimer {
  workerId: string;
  db: NodePgDatabase<Record<string, never>>;
  pool: Pool;
}

// Each claimer gets its own pool capped at one connection, so a claimer is
// exactly one PostgreSQL backend and two claimers can never accidentally
// share a connection (which would serialize them and make a concurrency
// test prove nothing). The connection is opened before the test body runs
// so that connection setup is not what interleaves.
//
// These are independent connections, not independent OS processes: all
// claimers here are logical claimers inside the single Vitest process. The
// contention being tested is real contention inside PostgreSQL between
// concurrent transactions; it is not a test of process isolation.
async function createClaimer(workerId: string): Promise<Claimer> {
  const pool = new Pool({ connectionString, max: 1 });
  await pool.query("select 1");
  return { workerId, db: drizzle(pool), pool };
}

async function insertStep(opts: {
  id?: string;
  status?: StepStatus;
  priority?: number;
  availableOffsetMs?: number;
  leaseVersion?: number;
  currentWorkerId?: string | null;
  leaseExpiresOffsetMs?: number | null;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await admin.query(
    `insert into steps (id, status, priority, available_at, lease_version, current_worker_id, lease_expires_at)
     values (
       $1,
       $2::step_status,
       $3,
       now() + ($4::int * interval '1 millisecond'),
       $5,
       $6,
       case when $7::int is null then null
            else now() + ($7::int * interval '1 millisecond') end
     )`,
    [
      id,
      opts.status ?? "READY",
      opts.priority ?? 0,
      opts.availableOffsetMs ?? -1_000,
      opts.leaseVersion ?? 0,
      opts.currentWorkerId ?? null,
      opts.leaseExpiresOffsetMs ?? null,
    ],
  );
  return id;
}

interface StepRow {
  id: string;
  status: StepStatus;
  priority: number;
  lease_version: number;
  current_worker_id: string | null;
  lease_expires_at: Date | null;
}

async function readSteps(ids: readonly string[]): Promise<StepRow[]> {
  const result = await admin.query<StepRow>(
    `select id, status, priority, lease_version, current_worker_id, lease_expires_at
     from steps where id = any($1::uuid[]) order by id`,
    [[...ids]],
  );
  return result.rows;
}

// Turns "the claim blocked" into an explicit failure instead of a hung
// test. Only used where a wrong implementation would block forever.
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function claimedStepsOf(
  outcomes: ReadonlyArray<{ workerId: string; result: Awaited<ReturnType<typeof claimNextStep>> }>,
): Array<{ workerId: string; step: ClaimedStep }> {
  return outcomes.flatMap((outcome) =>
    outcome.result.claimed ? [{ workerId: outcome.workerId, step: outcome.result.step }] : [],
  );
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
});

describe("claimNextStep", () => {
  describe("concurrent claiming", () => {
    it("gives each available step to exactly one of many simultaneous claimers", async () => {
      const stepIds = [
        await insertStep({ priority: 3 }),
        await insertStep({ priority: 2 }),
        await insertStep({ priority: 1 }),
      ];
      const claimerCount = 12;

      const claimers = await Promise.all(
        Array.from({ length: claimerCount }, (_, i) => createClaimer(`worker-${i}`)),
      );

      try {
        // Hold every claimer at a barrier, then release them together, so
        // the claim transactions overlap inside PostgreSQL rather than
        // being spread out by pool warm-up.
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });

        const attempts = claimers.map(async (claimer) => {
          await barrier;
          return {
            workerId: claimer.workerId,
            result: await claimNextStep(claimer.db, claimer.workerId),
          };
        });
        release();
        const outcomes = await Promise.all(attempts);

        const successes = claimedStepsOf(outcomes);

        // Exactly as many claims as there were rows. This is deterministic
        // rather than probabilistic: a claimer only reports "no work" when
        // every eligible row is locked, and a row is only locked by a
        // claimer that goes on to claim it. With 12 claimers and 3 rows,
        // no row can be left behind.
        expect(successes).toHaveLength(stepIds.length);
        expect(outcomes.length - successes.length).toBe(claimerCount - stepIds.length);

        // No step handed out twice. This is the assertion a naive
        // read-then-update implementation fails.
        const claimedIds = successes.map((success) => success.step.id);
        expect(new Set(claimedIds).size).toBe(stepIds.length);
        expect([...claimedIds].sort()).toEqual([...stepIds].sort());

        // No claimer won twice either.
        const winners = successes.map((success) => success.workerId);
        expect(new Set(winners).size).toBe(stepIds.length);

        // The durable rows agree with what the claimers were told.
        const rows = await readSteps(stepIds);
        expect(rows).toHaveLength(stepIds.length);
        for (const row of rows) {
          expect(row.status).toBe("RUNNING");
          expect(row.lease_version).toBe(1);
          expect(row.current_worker_id).not.toBeNull();
          expect(row.lease_expires_at).not.toBeNull();

          const reportedBy = successes.filter((success) => success.step.id === row.id);
          expect(reportedBy).toHaveLength(1);
          const claim = reportedBy[0]!;
          expect(row.current_worker_id).toBe(claim.workerId);
          expect(row.lease_version).toBe(claim.step.leaseVersion);
        }

        // Every owning worker is distinct: one owner per row, no row with
        // a contested owner.
        expect(new Set(rows.map((row) => row.current_worker_id)).size).toBe(stepIds.length);
      } finally {
        await Promise.all(claimers.map((claimer) => claimer.pool.end()));
      }
    }, 30_000);

    it("hands the same step to only one claimer even when far more claimers than work exists", async () => {
      const onlyStep = await insertStep({ priority: 5 });
      const claimers = await Promise.all(
        Array.from({ length: 16 }, (_, i) => createClaimer(`contender-${i}`)),
      );

      try {
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const attempts = claimers.map(async (claimer) => {
          await barrier;
          return {
            workerId: claimer.workerId,
            result: await claimNextStep(claimer.db, claimer.workerId),
          };
        });
        release();
        const outcomes = await Promise.all(attempts);

        const successes = claimedStepsOf(outcomes);
        expect(successes).toHaveLength(1);
        expect(successes[0]!.step.id).toBe(onlyStep);

        // The 15 losers are told there is no work. They are not given
        // duplicate ownership, and they are not given an error.
        const rows = await readSteps([onlyStep]);
        expect(rows[0]!.status).toBe("RUNNING");
        expect(rows[0]!.current_worker_id).toBe(successes[0]!.workerId);
        expect(rows[0]!.lease_version).toBe(1);
      } finally {
        await Promise.all(claimers.map((claimer) => claimer.pool.end()));
      }
    }, 30_000);
  });

  describe("SKIP LOCKED", () => {
    it("steps over a row another open transaction holds locked and claims the next eligible one instead", async () => {
      // Deliberately makes the locked row the one the claimer would
      // otherwise prefer, so claiming the other row can only be explained
      // by the lock being skipped.
      const lockedStepId = await insertStep({ priority: 10 });
      const otherStepId = await insertStep({ priority: 1 });

      const lockerPool = new Pool({ connectionString, max: 1 });
      const locker = await lockerPool.connect();
      const claimer = await createClaimer("worker-skip-locked");

      try {
        await locker.query("begin");
        const locked = await locker.query("select id from steps where id = $1 for update", [
          lockedStepId,
        ]);
        expect(locked.rows).toHaveLength(1);
        // The lock is definitively held now — this is awaited, so no
        // sleep or timing guess is involved anywhere in this test.

        const result = await withTimeout(
          claimNextStep(claimer.db, claimer.workerId),
          2_000,
          "claim blocked on a row locked by another transaction — SKIP LOCKED is not in effect",
        );

        expect(result.claimed).toBe(true);
        if (!result.claimed) throw new Error("unreachable");
        expect(result.step.id).toBe(otherStepId);

        // The skipped row was left completely untouched — skipped, not
        // claimed-and-rolled-back.
        const [lockedRow] = await readSteps([lockedStepId]);
        expect(lockedRow!.status).toBe("READY");
        expect(lockedRow!.lease_version).toBe(0);
        expect(lockedRow!.current_worker_id).toBeNull();
      } finally {
        await locker.query("rollback").catch(() => undefined);
        locker.release();
        await lockerPool.end();
        await claimer.pool.end();
      }

      // Releasing the lock makes that row claimable again, which shows the
      // row was skipped because of the lock and not because it was
      // ineligible.
      const after = await createClaimer("worker-after-release");
      try {
        const result = await claimNextStep(after.db, after.workerId);
        expect(result.claimed).toBe(true);
        if (!result.claimed) throw new Error("unreachable");
        expect(result.step.id).toBe(lockedStepId);
        expect(result.step.leaseVersion).toBe(1);
      } finally {
        await after.pool.end();
      }
    }, 15_000);

    it("reports no work when every eligible row is locked, rather than waiting", async () => {
      const onlyStepId = await insertStep({ priority: 7 });

      const lockerPool = new Pool({ connectionString, max: 1 });
      const locker = await lockerPool.connect();
      const claimer = await createClaimer("worker-all-locked");

      try {
        await locker.query("begin");
        await locker.query("select id from steps where id = $1 for update", [onlyStepId]);

        const result = await withTimeout(
          claimNextStep(claimer.db, claimer.workerId),
          2_000,
          "claim blocked instead of reporting no work",
        );
        expect(result.claimed).toBe(false);
      } finally {
        await locker.query("rollback").catch(() => undefined);
        locker.release();
        await lockerPool.end();
        await claimer.pool.end();
      }
    }, 15_000);
  });

  describe("eligibility", () => {
    let claimer: Claimer;

    beforeEach(async () => {
      claimer = await createClaimer("worker-eligibility");
    });

    afterEach(async () => {
      await claimer.pool.end();
    });

    it("returns no work when the table is empty", async () => {
      const result = await claimNextStep(claimer.db, claimer.workerId);
      expect(result.claimed).toBe(false);
    });

    it("does not claim steps in any non-READY status", async () => {
      const ids = [
        await insertStep({ status: "PENDING" }),
        await insertStep({ status: "RETRY_WAIT" }),
        await insertStep({ status: "SUCCEEDED" }),
        await insertStep({ status: "DEAD_LETTERED" }),
        await insertStep({ status: "CANCELLED" }),
        await insertStep({
          status: "RUNNING",
          leaseVersion: 2,
          currentWorkerId: "someone-else",
          leaseExpiresOffsetMs: 30_000,
        }),
      ];

      const result = await claimNextStep(claimer.db, claimer.workerId);
      expect(result.claimed).toBe(false);

      // Nothing was mutated on the way past.
      const rows = await readSteps(ids);
      expect(rows.map((row) => row.status).sort()).toEqual(
        ["CANCELLED", "DEAD_LETTERED", "PENDING", "RETRY_WAIT", "RUNNING", "SUCCEEDED"].sort(),
      );
      for (const row of rows) {
        if (row.status !== "RUNNING") {
          expect(row.current_worker_id).toBeNull();
          expect(row.lease_version).toBe(0);
        } else {
          expect(row.current_worker_id).toBe("someone-else");
          expect(row.lease_version).toBe(2);
        }
      }
    });

    it("does not claim a step whose available_at is still in the future", async () => {
      const futureId = await insertStep({ priority: 100, availableOffsetMs: 60 * 60 * 1_000 });

      const empty = await claimNextStep(claimer.db, claimer.workerId);
      expect(empty.claimed).toBe(false);

      // A step that is already available is claimed even though the future
      // one outranks it on priority.
      const availableId = await insertStep({ priority: 1, availableOffsetMs: -1_000 });
      const result = await claimNextStep(claimer.db, claimer.workerId);
      expect(result.claimed).toBe(true);
      if (!result.claimed) throw new Error("unreachable");
      expect(result.step.id).toBe(availableId);

      const [futureRow] = await readSteps([futureId]);
      expect(futureRow!.status).toBe("READY");
    });

    it("does not claim a step that is already RUNNING under another worker", async () => {
      const id = await insertStep({ priority: 4 });

      const first = await claimNextStep(claimer.db, claimer.workerId);
      expect(first.claimed).toBe(true);

      const second = await claimNextStep(claimer.db, "worker-second");
      expect(second.claimed).toBe(false);

      const [row] = await readSteps([id]);
      expect(row!.current_worker_id).toBe(claimer.workerId);
      expect(row!.lease_version).toBe(1);
    });
  });

  describe("claim ordering", () => {
    let claimer: Claimer;

    beforeEach(async () => {
      claimer = await createClaimer("worker-ordering");
    });

    afterEach(async () => {
      await claimer.pool.end();
    });

    it("claims by priority descending, then oldest available_at, when uncontended", async () => {
      const lowPriority = await insertStep({ priority: 1, availableOffsetMs: -60_000 });
      const midNewer = await insertStep({ priority: 5, availableOffsetMs: -10_000 });
      const midOlder = await insertStep({ priority: 5, availableOffsetMs: -30_000 });
      const highPriority = await insertStep({ priority: 10, availableOffsetMs: -1_000 });

      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await claimNextStep(claimer.db, `${claimer.workerId}-${i}`);
        expect(result.claimed).toBe(true);
        if (!result.claimed) throw new Error("unreachable");
        order.push(result.step.id);
      }

      // Highest priority wins outright even though it became available
      // most recently; within the tied priority band the older
      // availability goes first.
      expect(order).toEqual([highPriority, midOlder, midNewer, lowPriority]);

      const exhausted = await claimNextStep(claimer.db, claimer.workerId);
      expect(exhausted.claimed).toBe(false);
    });

    it("breaks an exact priority and available_at tie by ascending id", async () => {
      const first = randomUUID();
      const second = randomUUID();
      // One statement, so now() is identical for both rows and the tie is
      // genuinely exact rather than microseconds apart.
      await admin.query(
        `insert into steps (id, status, priority, available_at)
         values ($1, 'READY', 0, now() - interval '1 second'),
                ($2, 'READY', 0, now() - interval '1 second')`,
        [first, second],
      );

      const order: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const result = await claimNextStep(claimer.db, `${claimer.workerId}-tie-${i}`);
        expect(result.claimed).toBe(true);
        if (!result.claimed) throw new Error("unreachable");
        order.push(result.step.id);
      }

      expect(order).toEqual([first, second].sort());
    });
  });

  describe("ownership metadata", () => {
    let claimer: Claimer;

    beforeEach(async () => {
      claimer = await createClaimer("worker-ownership");
    });

    afterEach(async () => {
      await claimer.pool.end();
    });

    it("records status, owner, lease version, and lease deadline in one committed write", async () => {
      const id = await insertStep({ priority: 2 });

      const result = await claimNextStep(claimer.db, claimer.workerId);
      expect(result.claimed).toBe(true);
      if (!result.claimed) throw new Error("unreachable");
      expect(result.step.id).toBe(id);
      expect(result.step.status).toBe("RUNNING");
      expect(result.step.workerId).toBe(claimer.workerId);

      const [row] = await readSteps([id]);
      expect(row!.status).toBe("RUNNING");
      expect(row!.current_worker_id).toBe(claimer.workerId);

      // The lease window is checked in SQL, against the database clock
      // that wrote it, so the assertion does not depend on this process's
      // clock agreeing with PostgreSQL's.
      const timing = await admin.query<{ in_window: boolean; bumped: boolean }>(
        `select lease_expires_at > now() as in_window,
                updated_at > created_at as bumped
         from steps where id = $1`,
        [id],
      );
      expect(timing.rows[0]!.in_window).toBe(true);
      expect(timing.rows[0]!.bumped).toBe(true);

      const bound = await admin.query<{ within_duration: boolean }>(
        `select lease_expires_at <= now() + ($2::int * interval '1 millisecond') as within_duration
         from steps where id = $1`,
        [id, STEP_LEASE_DURATION_MS],
      );
      expect(bound.rows[0]!.within_duration).toBe(true);
    });

    it("measures the lease from the ownership write, not from transaction start", async () => {
      const id = await insertStep({ priority: 1 });

      const result = await claimNextStep(claimer.db, claimer.workerId);
      expect(result.claimed).toBe(true);

      // updated_at is written from now(), which PostgreSQL fixes at BEGIN.
      // The deadline is written in the same UPDATE, but from
      // clock_timestamp(). At least the BEGIN and SELECT round trips have
      // passed by the time the UPDATE runs, so a lease measured from the
      // write must end strictly later than transaction start + duration.
      // A deadline computed from now() would be exactly equal and fail.
      // This is a strict inequality on the database's own timestamps: it
      // does not depend on how long anything took, only on which clock
      // was read.
      const anchor = await admin.query<{ measured_after_begin: boolean }>(
        `select lease_expires_at > updated_at + ($2::int * interval '1 millisecond') as measured_after_begin
         from steps where id = $1`,
        [id, STEP_LEASE_DURATION_MS],
      );
      expect(anchor.rows[0]!.measured_after_begin).toBe(true);
    });

    it("starts lease_version at 0 and increments it per ownership generation", async () => {
      const fresh = await insertStep({ priority: 9 });
      const previouslyOwned = await insertStep({ priority: 8, leaseVersion: 3 });

      const firstClaim = await claimNextStep(claimer.db, claimer.workerId);
      expect(firstClaim.claimed).toBe(true);
      if (!firstClaim.claimed) throw new Error("unreachable");
      expect(firstClaim.step.id).toBe(fresh);
      // Never claimed before: 0 -> 1. lease_version 0 therefore never
      // corresponds to a real ownership generation.
      expect(firstClaim.step.leaseVersion).toBe(1);

      const secondClaim = await claimNextStep(claimer.db, "worker-ownership-2");
      expect(secondClaim.claimed).toBe(true);
      if (!secondClaim.claimed) throw new Error("unreachable");
      expect(secondClaim.step.id).toBe(previouslyOwned);
      // Incremented, not reset — a reclaim must produce a version no
      // earlier owner can still be holding.
      expect(secondClaim.step.leaseVersion).toBe(4);

      const rows = await readSteps([fresh, previouslyOwned]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // The version handed to the claimer is the version that is durable;
      // a later fencing check has to be able to trust this.
      expect(byId.get(fresh)!.lease_version).toBe(1);
      expect(byId.get(previouslyOwned)!.lease_version).toBe(4);
    });

    it("rejects an empty workerId rather than recording an unidentifiable owner", async () => {
      await insertStep({});
      await expect(claimNextStep(claimer.db, "   ")).rejects.toThrow(/non-empty workerId/);
    });
  });

  describe("database-enforced ownership invariant", () => {
    it("refuses to store a RUNNING step with no owner, deadline, or ownership generation", async () => {
      await expect(
        admin.query(`insert into steps (id, status) values ($1, 'RUNNING')`, [randomUUID()]),
      ).rejects.toThrow(/steps_running_requires_owner/);
    });
  });
});
