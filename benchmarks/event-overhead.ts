import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { claimNextStep } from "../server/src/db/claim-step.js";
import { completeStepSuccess } from "../server/src/db/complete-step.js";
import { parseStepStatus } from "../server/src/domain/step-status.js";
import { transitionStepStatus } from "../server/src/domain/step-transitions.js";
import { benchPool, median, resetBenchTables, round, settleBenchTables } from "./common.js";

// What does the durable event write cost on the claim/complete path?
//
// Variant "events" calls the production claimNextStep / completeStepSuccess.
// Variant "no-events" calls the two BENCHMARK-ONLY copies below, which are
// those functions with the step_events INSERT removed and nothing else
// changed: same transaction boundaries, same lock-then-authorize statements,
// same predicates. The runtime has no such mode. No reported throughput,
// latency or correctness number comes from the no-events variant; it exists
// only to size the difference.
//
// Both variants run in this process with the same number of concurrent
// loops, each on its own session, doing claim -> SHA-256 -> complete. Worker
// processes, polling, heartbeats and the coordinator are deliberately absent,
// so the difference is concentrated on the database path; in the full
// system the relative cost is diluted by that other work.

type Db = NodePgDatabase<Record<string, unknown>>;

async function claimWithoutEvent(db: Db, workerId: string, leaseDurationMs: number) {
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string; status: string }>(sql`
      select id, status
      from steps
      where status = 'READY'
        and available_at <= now()
        and attempt_count < max_attempts
      order by priority desc, available_at asc, id asc
      limit 1
      for update skip locked
    `);
    const candidate = candidates.rows[0];
    if (!candidate) return undefined;
    transitionStepStatus(parseStepStatus(candidate.status), "RUNNING");
    const claimed = await tx.execute<{ id: string; lease_version: number; payload: { input: string } }>(sql`
      update steps
      set status = 'RUNNING',
          current_worker_id = ${workerId},
          lease_version = lease_version + 1,
          attempt_count = attempt_count + 1,
          lease_expires_at = clock_timestamp() + (${leaseDurationMs}::int * interval '1 millisecond'),
          updated_at = now()
      where id = ${candidate.id}
        and status = 'READY'
        and attempt_count < max_attempts
      returning id, status, current_worker_id, lease_version, attempt_count, lease_expires_at, priority, available_at, task_type, payload
    `);
    if (claimed.rows.length !== 1) throw new Error("benchmark claim copy updated an unexpected number of rows");
    return claimed.rows[0]!;
  });
}

async function completeWithoutEvent(db: Db, params: { id: string; workerId: string; leaseVersion: number; result: Record<string, unknown> }) {
  transitionStepStatus("RUNNING", "SUCCEEDED");
  const updatedCount = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from steps where id = ${params.id} for update`);
    if (locked.rows.length === 0) return 0;
    const updated = await tx.execute(sql`
      update steps
      set status = 'SUCCEEDED',
          result = ${JSON.stringify(params.result)}::jsonb,
          current_worker_id = null,
          lease_expires_at = null,
          updated_at = now()
      where id = ${params.id}
        and status = 'RUNNING'
        and current_worker_id = ${params.workerId}
        and lease_version = ${params.leaseVersion}
        and lease_expires_at > clock_timestamp()
      returning id, lease_version, attempt_count
    `);
    return updated.rows.length;
  });
  if (updatedCount !== 1) throw new Error("benchmark completion copy updated an unexpected number of rows");
}

type Variant = "events" | "no-events";

export interface EventOverheadConfig {
  tasks: number;
  loops: number;
  repetitions: number;
}

const LEASE_MS = 30_000;

async function loop(variant: Variant, db: Db, workerId: string): Promise<number> {
  let completed = 0;
  for (;;) {
    if (variant === "events") {
      const claim = await claimNextStep(db, workerId, { leaseDurationMs: LEASE_MS });
      if (!claim.claimed) return completed;
      const input = (claim.step.payload as { input: string }).input;
      await completeStepSuccess(db, {
        id: claim.step.id, workerId, leaseVersion: claim.step.leaseVersion,
        result: { hash: createHash("sha256").update(input).digest("hex") },
      });
    } else {
      const claim = await claimWithoutEvent(db, workerId, LEASE_MS);
      if (!claim) return completed;
      await completeWithoutEvent(db, {
        id: claim.id, workerId, leaseVersion: claim.lease_version,
        result: { hash: createHash("sha256").update(claim.payload.input).digest("hex") },
      });
    }
    completed += 1;
  }
}

async function trial(variant: Variant, config: EventOverheadConfig, admin: Pool) {
  await resetBenchTables(admin);
  await admin.query(
    `insert into steps (id, status, priority, available_at, max_attempts, task_type, payload)
     select gen_random_uuid(), 'READY', 0, clock_timestamp() - interval '1 second', 3, 'fail_then_hash',
            jsonb_build_object('input', 'overhead-' || g, 'failuresBeforeSuccess', 0)
     from generate_series(1, $1::int) g`,
    [config.tasks],
  );
  await settleBenchTables(admin);
  {
    // Fail fast on a short fixture rather than timing whatever is left.
    const count = await admin.query<{ n: number }>("select count(*)::int as n from steps");
    if (count.rows[0]!.n !== config.tasks) {
      throw new Error(`fixture should hold exactly ${config.tasks} steps, found ${count.rows[0]!.n}: the benchmark database was modified by something else`);
    }
  }
  const pools = Array.from({ length: config.loops }, () => benchPool(1));
  try {
    await Promise.all(pools.map((pool) => pool.query("select 1")));
    const start = performance.now();
    const completed = await Promise.all(pools.map((pool, index) => loop(variant, drizzle(pool), `overhead-${index + 1}`)));
    const seconds = (performance.now() - start) / 1000;
    const check = await admin.query<{ succeeded: number; events: number }>(
      "select (select count(*)::int from steps where status = 'SUCCEEDED') as succeeded, (select count(*)::int from step_events) as events",
    );
    const total = completed.reduce((sum, value) => sum + value, 0);
    // Loops run until no row is claimable and every claim is completed, so a
    // trial always finishes exactly the fixture. The event row count is
    // fixed per variant: 2 per task with events, 0 in the benchmark-only
    // copy. Any deviation means the trial did not run as configured.
    if (total !== config.tasks || check.rows[0]!.succeeded !== config.tasks) {
      throw new Error(`${variant} trial completed ${total} (${check.rows[0]!.succeeded} SUCCEEDED rows) for ${config.tasks} fixture rows`);
    }
    const expectedEvents = variant === "events" ? 2 * config.tasks : 0;
    if (check.rows[0]!.events !== expectedEvents) {
      throw new Error(`${variant} trial left ${check.rows[0]!.events} event rows, expected ${expectedEvents}`);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`${variant} trial measured a non-positive duration (${seconds}s)`);
    }
    return {
      variant,
      completed: total,
      succeededRows: check.rows[0]!.succeeded,
      eventRows: check.rows[0]!.events,
      seconds: round(seconds, 3),
      tasksPerSecond: round(total / seconds, 1),
    };
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}

export async function runEventOverhead(config: EventOverheadConfig) {
  const admin = benchPool(1);
  try {
    // One small trial per variant first, so JIT/connection/cache warm-up in
    // this process does not land only on whichever variant runs first.
    // Recorded in the artifact, excluded from the medians.
    const warmup = [];
    for (const variant of ["events", "no-events"] as const) {
      warmup.push(await trial(variant, { ...config, tasks: Math.min(config.tasks, 2_000) }, admin));
    }
    const trials = [];
    // Alternating order, so drift in machine state affects both variants.
    for (let repetition = 0; repetition < config.repetitions; repetition += 1) {
      for (const variant of ["events", "no-events"] as const) trials.push(await trial(variant, config, admin));
    }
    const withEvents = median(trials.filter((t) => t.variant === "events").map((t) => t.tasksPerSecond));
    const withoutEvents = median(trials.filter((t) => t.variant === "no-events").map((t) => t.tasksPerSecond));
    return {
      config,
      warmupExcludedFromMedians: warmup,
      trials,
      medianTasksPerSecond: { events: withEvents, noEventsBenchmarkOnly: withoutEvents },
      eventsThroughputRelativeToNoEvents: round(withEvents / withoutEvents, 3),
    };
  } finally {
    await admin.end();
  }
}
