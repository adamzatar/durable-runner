import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextStep } from "../src/db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../src/db/complete-step.js";
import { promoteDueRetries } from "../src/db/promote-due-retries.js";
import { recordStepFailure } from "../src/db/record-step-failure.js";
import { recoverExpiredSteps } from "../src/db/recover-expired-steps.js";

// Every durable lifecycle transition writes exactly one event, in the same
// transaction as the state change. These tests assert both directions: the
// event exists when the transition committed, and no event exists when a
// write was rejected or rolled back.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let ownerPool: Pool;
let owner: NodePgDatabase<Record<string, never>>;

interface EventRow {
  id: number;
  step_id: string;
  worker_id: string | null;
  event_type: string;
  data: Record<string, unknown>;
}

async function eventsFor(stepId: string): Promise<EventRow[]> {
  const result = await admin.query<EventRow>(
    `select id::int, step_id, worker_id, event_type, data from step_events
     where step_id = $1 order by xid, id`,
    [stepId],
  );
  return result.rows;
}

async function eventTypesFor(stepId: string): Promise<string[]> {
  return (await eventsFor(stepId)).map((row) => row.event_type);
}

async function countAllEvents(): Promise<number> {
  const result = await admin.query<{ n: string }>("select count(*) as n from step_events");
  return Number(result.rows[0]!.n);
}

async function insertStep(opts: { status?: string; workerId?: string | null; leaseVersion?: number; attemptCount?: number; maxAttempts?: number; leaseOffsetMs?: number | null; availableOffsetMs?: number } = {}): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, current_worker_id, lease_version, attempt_count, max_attempts,
                        available_at, lease_expires_at, task_type, payload)
     values ($1, $2::step_status, $3, $4, $5, $6,
             clock_timestamp() + ($7::int * interval '1 millisecond'),
             case when $8::int is null then null else clock_timestamp() + ($8::int * interval '1 millisecond') end,
             'hash_after_delay', '{"input":"event-fixture","delayMs":0}'::jsonb)`,
    [
      id,
      opts.status ?? "READY",
      opts.workerId ?? null,
      opts.leaseVersion ?? 0,
      opts.attemptCount ?? 0,
      opts.maxAttempts ?? 3,
      opts.availableOffsetMs ?? -1_000,
      opts.leaseOffsetMs ?? null,
    ],
  );
  return id;
}

async function stepRow(id: string): Promise<Record<string, unknown>> {
  const result = await admin.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(s) as row from steps s where id = $1",
    [id],
  );
  return result.rows[0]!.row;
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  ownerPool = new Pool({ connectionString, max: 1 });
  owner = drizzle(ownerPool);
});

afterAll(async () => {
  await admin.end();
  await ownerPool.end();
});

beforeEach(async () => {
  await admin.query("delete from steps");
  await admin.query("delete from step_events");
});

describe("one event per committed transition", () => {
  it("records STEP_CLAIMED with the claimant, generation and attempt", async () => {
    const id = await insertStep();

    const claim = await claimNextStep(owner, "worker-a");
    expect(claim.claimed).toBe(true);

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      step_id: id,
      worker_id: "worker-a",
      event_type: "STEP_CLAIMED",
      data: { leaseVersion: 1, attemptCount: 1 },
    });
  });

  it("records STEP_SUCCEEDED on completion", async () => {
    const id = await insertStep();
    const claim = await claimNextStep(owner, "worker-a");
    if (!claim.claimed) throw new Error("claim failed");

    await completeStepSuccess(owner, {
      id,
      workerId: "worker-a",
      leaseVersion: claim.step.leaseVersion,
      result: { hash: "abc" },
    });

    const events = await eventsFor(id);
    expect(events.map((row) => row.event_type)).toEqual(["STEP_CLAIMED", "STEP_SUCCEEDED"]);
    expect(events[1]).toMatchObject({
      worker_id: "worker-a",
      data: { leaseVersion: 1, attemptCount: 1 },
    });
    // The result itself stays on the step row; the event records the
    // generation and attempt it happened at, not a copy of the output.
    expect(events[1]!.data).not.toHaveProperty("result");
  });

  it("records STEP_RETRY_SCHEDULED with the backoff deadline and a bounded error excerpt", async () => {
    const id = await insertStep();
    const claim = await claimNextStep(owner, "worker-a");
    if (!claim.claimed) throw new Error("claim failed");

    const failure = await recordStepFailure(owner, {
      id,
      workerId: "worker-a",
      leaseVersion: claim.step.leaseVersion,
      error: "boom".repeat(200),
      retryable: true,
    });
    expect(failure.recorded).toBe(true);

    const events = await eventsFor(id);
    expect(events.map((row) => row.event_type)).toEqual(["STEP_CLAIMED", "STEP_RETRY_SCHEDULED"]);
    const data = events[1]!.data as { availableAt: string; error: string; attemptCount: number };
    expect(data.attemptCount).toBe(1);
    expect(failure.recorded && data.availableAt).toBe(failure.recorded && failure.availableAt);
    // Truncated: append-only history never gets pruned, and the full text
    // remains on steps.last_error.
    expect(data.error.length).toBeLessThanOrEqual(200);
    const row = await stepRow(id);
    expect(String(row.last_error).length).toBeGreaterThan(200);
  });

  it("records STEP_DEAD_LETTERED when the budget is exhausted, and when input is non-retryable", async () => {
    const exhausted = await insertStep({ maxAttempts: 1 });
    const claimA = await claimNextStep(owner, "worker-a");
    if (!claimA.claimed) throw new Error("claim failed");
    await recordStepFailure(owner, {
      id: exhausted,
      workerId: "worker-a",
      leaseVersion: claimA.step.leaseVersion,
      error: "last attempt failed",
      retryable: true,
    });

    expect(await eventTypesFor(exhausted)).toEqual(["STEP_CLAIMED", "STEP_DEAD_LETTERED"]);
    expect((await eventsFor(exhausted))[1]!.data).toMatchObject({
      leaseVersion: 1,
      attemptCount: 1,
      reason: "attempt_budget_exhausted",
    });

    const poison = await insertStep();
    const claimB = await claimNextStep(owner, "worker-b");
    if (!claimB.claimed) throw new Error("claim failed");
    await recordStepFailure(owner, {
      id: poison,
      workerId: "worker-b",
      leaseVersion: claimB.step.leaseVersion,
      error: "invalid payload",
      retryable: false,
    });

    expect((await eventsFor(poison))[1]).toMatchObject({
      event_type: "STEP_DEAD_LETTERED",
      data: { reason: "non_retryable_failure" },
    });
  });

  it("records LEASE_RECOVERED naming the owner that lost authority, not the cleared NULL", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "worker-a", leaseVersion: 4, attemptCount: 1, leaseOffsetMs: -1_000 });

    expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 4, status: "READY" }]);

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      worker_id: "worker-a",
      event_type: "LEASE_RECOVERED",
      data: { leaseVersion: 4, attemptCount: 1, previousWorkerId: "worker-a" },
    });
    // The step itself no longer has an owner; only the event remembers it.
    expect((await stepRow(id)).current_worker_id).toBeNull();
  });

  it("records STEP_DEAD_LETTERED when recovery finds an expired step with no budget left", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "worker-a", leaseVersion: 3, attemptCount: 3, maxAttempts: 3, leaseOffsetMs: -1_000 });

    expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 3, status: "DEAD_LETTERED" }]);

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      worker_id: "worker-a",
      event_type: "STEP_DEAD_LETTERED",
      data: { previousWorkerId: "worker-a", reason: "lease_expired_attempt_budget_exhausted" },
    });
  });

  it("records RETRY_READY on promotion, with no owner", async () => {
    const id = await insertStep({ status: "RETRY_WAIT", leaseVersion: 2, attemptCount: 2, availableOffsetMs: -10 });

    expect(await promoteDueRetries(drizzle(admin))).toEqual([{ id, leaseVersion: 2, attemptCount: 2 }]);

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      worker_id: null,
      event_type: "RETRY_READY",
      data: { leaseVersion: 2, attemptCount: 2 },
    });
  });

  it("builds a readable history across recovery and retry cycles", async () => {
    // Crash path: claimed, lease expired, recovered, claimed again, done.
    const crashed = await insertStep();
    const first = await claimNextStep(owner, "worker-a", { leaseDurationMs: 100 });
    if (!first.claimed) throw new Error("claim failed");
    await admin.query("update steps set lease_expires_at = clock_timestamp() - interval '1 ms' where id = $1", [crashed]);
    await recoverExpiredSteps(drizzle(admin));
    const second = await claimNextStep(owner, "worker-b");
    if (!second.claimed) throw new Error("reclaim failed");
    await completeStepSuccess(owner, { id: crashed, workerId: "worker-b", leaseVersion: 2, result: { hash: "x" } });

    expect(await eventTypesFor(crashed)).toEqual([
      "STEP_CLAIMED",
      "LEASE_RECOVERED",
      "STEP_CLAIMED",
      "STEP_SUCCEEDED",
    ]);
    const crashedEvents = await eventsFor(crashed);
    expect(crashedEvents.map((row) => (row.data as { leaseVersion: number }).leaseVersion)).toEqual([1, 1, 2, 2]);

    // Retry path: claimed, failed, promoted, claimed again, done.
    const retried = await insertStep();
    const attempt1 = await claimNextStep(owner, "worker-a");
    if (!attempt1.claimed) throw new Error("claim failed");
    await recordStepFailure(owner, {
      id: retried,
      workerId: "worker-a",
      leaseVersion: attempt1.step.leaseVersion,
      error: "transient",
      retryable: true,
    });
    await admin.query("update steps set available_at = clock_timestamp() - interval '1 ms' where id = $1", [retried]);
    await promoteDueRetries(drizzle(admin));
    const attempt2 = await claimNextStep(owner, "worker-a");
    if (!attempt2.claimed) throw new Error("reclaim failed");
    await completeStepSuccess(owner, { id: retried, workerId: "worker-a", leaseVersion: 2, result: { hash: "y" } });

    expect(await eventTypesFor(retried)).toEqual([
      "STEP_CLAIMED",
      "STEP_RETRY_SCHEDULED",
      "RETRY_READY",
      "STEP_CLAIMED",
      "STEP_SUCCEEDED",
    ]);
    expect((await eventsFor(retried)).map((row) => (row.data as { attemptCount: number }).attemptCount)).toEqual([
      1, 1, 1, 2, 2,
    ]);
  });
});

describe("rejected writes record nothing", () => {
  it("a stale completion rejected by fencing writes no success event", async () => {
    const id = await insertStep();
    const stale = await claimNextStep(owner, "worker-a", { leaseDurationMs: 100 });
    if (!stale.claimed) throw new Error("claim failed");
    await admin.query("update steps set lease_expires_at = clock_timestamp() - interval '1 ms' where id = $1", [id]);
    await recoverExpiredSteps(drizzle(admin));
    const current = await claimNextStep(owner, "worker-b");
    if (!current.claimed) throw new Error("reclaim failed");
    const before = await eventsFor(id);

    await expect(
      completeStepSuccess(owner, { id, workerId: "worker-a", leaseVersion: stale.step.leaseVersion, result: { hash: "stale" } }),
    ).rejects.toBeInstanceOf(CompletionConsistencyError);

    expect(await eventsFor(id)).toEqual(before);
    expect(await eventTypesFor(id)).not.toContain("STEP_SUCCEEDED");
  });

  it("a rejected failure report writes no retry or dead-letter event", async () => {
    const id = await insertStep();
    const stale = await claimNextStep(owner, "worker-a", { leaseDurationMs: 100 });
    if (!stale.claimed) throw new Error("claim failed");
    await admin.query("update steps set lease_expires_at = clock_timestamp() - interval '1 ms' where id = $1", [id]);
    const before = await eventsFor(id);

    // Expired owner: the failure report is rejected before any sweep runs.
    const rejected = await recordStepFailure(owner, {
      id,
      workerId: "worker-a",
      leaseVersion: stale.step.leaseVersion,
      error: "too late",
      retryable: true,
    });

    expect(rejected).toEqual({ recorded: false });
    expect(await eventsFor(id)).toEqual(before);
  });

  it("a sweep that skips a locked expired row writes no event until the row is actually recovered", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "worker-a", leaseVersion: 1, attemptCount: 1, leaseOffsetMs: -1_000 });
    const lockerPool = new Pool({ connectionString, max: 1 });
    const locker = await lockerPool.connect();

    try {
      await locker.query("begin");
      await locker.query("select id from steps where id = $1 for update", [id]);

      // Skipped, not waited on: nothing recovered, nothing recorded.
      expect(await recoverExpiredSteps(drizzle(admin))).toEqual([]);
      expect(await eventsFor(id)).toEqual([]);

      await locker.query("commit");
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
      await lockerPool.end();
    }

    // The later sweep that actually recovers it writes the one event.
    expect(await recoverExpiredSteps(drizzle(admin))).toEqual([{ id, leaseVersion: 1, status: "READY" }]);
    expect(await eventTypesFor(id)).toEqual(["LEASE_RECOVERED"]);
  });
});

describe("event write failure rolls back the transition", () => {
  // Failure is injected at the database boundary with a trigger created and
  // dropped by the test: deterministic, and it needs no permanent hook in
  // production code. The claim, completion and failure paths all write their
  // event inside the same transaction as their state change via the same
  // helper, so proving two of them covers that shared pattern.
  // Drizzle wraps driver errors ("Failed query: ..."), so the injected
  // message is on the cause chain rather than the top-level message.
  async function expectInjectedFailure(work: Promise<unknown>): Promise<void> {
    const error = await work.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      chain.push(current.message);
    }
    expect(chain.join(" | ")).toMatch(/injected event insert failure/);
  }

  async function withFailingEventInserts(body: () => Promise<void>): Promise<void> {
    await admin.query(`
      create or replace function durable_runner_fail_event_insert() returns trigger as $$
      begin raise exception 'injected event insert failure'; end;
      $$ language plpgsql`);
    await admin.query(`
      create trigger durable_runner_fail_event_insert
      before insert on step_events for each row
      execute function durable_runner_fail_event_insert()`);
    try {
      await body();
    } finally {
      await admin.query("drop trigger if exists durable_runner_fail_event_insert on step_events");
      await admin.query("drop function if exists durable_runner_fail_event_insert()");
    }
  }

  it("a claim whose event insert fails leaves the step READY and unclaimed", async () => {
    const id = await insertStep();
    const before = await stepRow(id);

    await withFailingEventInserts(async () => {
      await expectInjectedFailure(claimNextStep(owner, "worker-a"));
    });

    // No half-claim: no ownership, no consumed attempt, no lease.
    expect(await stepRow(id)).toEqual(before);
    expect(await countAllEvents()).toBe(0);

    // And the step is still claimable once events work again.
    const retry = await claimNextStep(owner, "worker-a");
    expect(retry.claimed).toBe(true);
    expect(await eventTypesFor(id)).toEqual(["STEP_CLAIMED"]);
  });

  it("a completion whose event insert fails leaves the step RUNNING with its lease intact", async () => {
    const id = await insertStep();
    const claim = await claimNextStep(owner, "worker-a");
    if (!claim.claimed) throw new Error("claim failed");
    const before = await stepRow(id);

    await withFailingEventInserts(async () => {
      await expectInjectedFailure(
        completeStepSuccess(owner, { id, workerId: "worker-a", leaseVersion: claim.step.leaseVersion, result: { hash: "lost" } }),
      );
    });

    expect(await stepRow(id)).toEqual(before);
    expect(await eventTypesFor(id)).toEqual(["STEP_CLAIMED"]);

    // The owner still holds a live lease and can complete for real.
    await completeStepSuccess(owner, { id, workerId: "worker-a", leaseVersion: claim.step.leaseVersion, result: { hash: "ok" } });
    expect(await eventTypesFor(id)).toEqual(["STEP_CLAIMED", "STEP_SUCCEEDED"]);
  });

  it("a failure report whose event insert fails leaves the step RUNNING", async () => {
    const id = await insertStep();
    const claim = await claimNextStep(owner, "worker-a");
    if (!claim.claimed) throw new Error("claim failed");
    const before = await stepRow(id);

    await withFailingEventInserts(async () => {
      await expectInjectedFailure(
        recordStepFailure(owner, { id, workerId: "worker-a", leaseVersion: claim.step.leaseVersion, error: "boom", retryable: true }),
      );
    });

    expect(await stepRow(id)).toEqual(before);
    expect(await eventTypesFor(id)).toEqual(["STEP_CLAIMED"]);
  });

  it("a recovery sweep whose event insert fails recovers nothing", async () => {
    const id = await insertStep({ status: "RUNNING", workerId: "worker-a", leaseVersion: 1, attemptCount: 1, leaseOffsetMs: -1_000 });
    const before = await stepRow(id);

    await withFailingEventInserts(async () => {
      await expectInjectedFailure(recoverExpiredSteps(drizzle(admin)));
    });

    expect(await stepRow(id)).toEqual(before);
    expect(await countAllEvents()).toBe(0);
  });
});

describe("concurrent writers", () => {
  it("many claimers racing for few steps produce exactly one claim event per successful claim", async () => {
    const stepIds = [await insertStep({ availableOffsetMs: -3_000 }), await insertStep({ availableOffsetMs: -2_000 }), await insertStep({ availableOffsetMs: -1_000 })];
    const pools = Array.from({ length: 12 }, () => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all(pools.map((pool) => pool.query("select 1")));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempts = pools.map(async (pool, i) => {
        await barrier;
        return claimNextStep(drizzle(pool), `racer-${i}`);
      });
      release();
      const results = await Promise.all(attempts);

      const claimed = results.filter((result) => result.claimed);
      expect(claimed).toHaveLength(stepIds.length);

      const events = await admin.query<{ step_id: string; worker_id: string; n: string }>(
        `select step_id, worker_id, count(*) as n from step_events
         where event_type = 'STEP_CLAIMED' group by step_id, worker_id`,
      );
      // One event per successful claim, attributed to the winner; the
      // claimers that found nothing wrote nothing.
      expect(events.rows).toHaveLength(stepIds.length);
      expect(events.rows.every((row) => row.n === "1")).toBe(true);
      expect(new Set(events.rows.map((row) => row.step_id))).toEqual(new Set(stepIds));
      expect(await countAllEvents()).toBe(stepIds.length);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);

  it("concurrent recovery sweepers record exactly one recovery event per step", async () => {
    const stepIds = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        insertStep({ status: "RUNNING", workerId: `owner-${i}`, leaseVersion: 1, attemptCount: 1, leaseOffsetMs: -1_000 }),
      ),
    );
    const pools = Array.from({ length: 4 }, () => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all(pools.map((pool) => pool.query("select 1")));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sweeps = pools.map(async (pool) => {
        await barrier;
        return recoverExpiredSteps(drizzle(pool));
      });
      release();
      const recovered = (await Promise.all(sweeps)).flat();

      // Each step recovered once in total, by exactly one sweeper.
      expect(recovered).toHaveLength(stepIds.length);
      expect(new Set(recovered.map((step) => step.id)).size).toBe(stepIds.length);

      const perStep = await admin.query<{ step_id: string; n: string }>(
        `select step_id, count(*) as n from step_events where event_type = 'LEASE_RECOVERED' group by step_id`,
      );
      expect(perStep.rows).toHaveLength(stepIds.length);
      expect(perStep.rows.every((row) => row.n === "1")).toBe(true);
      expect(await countAllEvents()).toBe(stepIds.length);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);

  it("concurrent retry promoters record exactly one promotion event per step", async () => {
    const stepIds = await Promise.all(
      Array.from({ length: 25 }, () =>
        insertStep({ status: "RETRY_WAIT", leaseVersion: 1, attemptCount: 1, availableOffsetMs: -1_000 }),
      ),
    );
    const pools = Array.from({ length: 4 }, () => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all(pools.map((pool) => pool.query("select 1")));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sweeps = pools.map(async (pool) => {
        await barrier;
        return promoteDueRetries(drizzle(pool));
      });
      release();
      const promoted = (await Promise.all(sweeps)).flat();

      expect(promoted).toHaveLength(stepIds.length);
      const perStep = await admin.query<{ step_id: string; n: string }>(
        `select step_id, count(*) as n from step_events where event_type = 'RETRY_READY' group by step_id`,
      );
      expect(perStep.rows).toHaveLength(stepIds.length);
      expect(perStep.rows.every((row) => row.n === "1")).toBe(true);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);

  it("history stays consistent with final state under a claim/recover/reclaim race", async () => {
    const id = await insertStep();
    const first = await claimNextStep(owner, "worker-a", { leaseDurationMs: 60 });
    if (!first.claimed) throw new Error("claim failed");

    // Let the lease expire by the database clock, then race a sweeper and a
    // second claimer against each other.
    await sleep(120);
    const sweeperPool = new Pool({ connectionString, max: 1 });
    const claimerPool = new Pool({ connectionString, max: 1 });
    try {
      await Promise.all([sweeperPool.query("select 1"), claimerPool.query("select 1")]);
      await Promise.all([
        recoverExpiredSteps(drizzle(sweeperPool)),
        claimNextStep(drizzle(claimerPool), "worker-b"),
      ]);

      const row = await stepRow(id);
      const types = await eventTypesFor(id);
      // Whatever the interleaving, the history explains the row: the number
      // of claim events equals the attempts consumed, and the last event
      // agrees with the current status.
      expect(types.filter((type) => type === "STEP_CLAIMED")).toHaveLength(Number(row.attempt_count));
      const last = types[types.length - 1];
      if (row.status === "RUNNING") expect(last).toBe("STEP_CLAIMED");
      if (row.status === "READY") expect(last).toBe("LEASE_RECOVERED");
    } finally {
      await sweeperPool.end();
      await claimerPool.end();
    }
  }, 20_000);
});
