import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import {
  assertChildrenAlive, benchDatabaseUrl, benchPool, type Child, repoRoot, resetBenchTables, round, settleBenchTables,
  sleep, startTsChild, stderrSummary, stopChildren, waitFor, walDelta, walPosition,
} from "./common.js";

// Unmodified runtime entrypoints: each worker is its own OS process with its
// own connection pool, heartbeat loop and lease renewal, and the coordinator
// runs the normal 1s recovery/retry-promotion sweep throughout. Every claim
// and completion writes its durable step_events row in the same transaction,
// exactly as in normal operation. Nothing here switches events off.
const workerScript = `${repoRoot}server/src/worker/worker.ts`;
const coordinatorScript = `${repoRoot}server/src/coordinator/coordinator.ts`;

// fail_then_hash with failuresBeforeSuccess 0 succeeds on its first attempt
// and is synchronous (one SHA-256 of a short string). hash_after_delay with
// delayMs 0 is not used because it still awaits setTimeout(0), which Node
// clamps to 1 ms — an incidental delay the benchmark would then be measuring.
const TASK_TYPE = "fail_then_hash";

export type Arrival = { kind: "backlog" } | { kind: "paced"; ratePerSec: number };

export interface ThroughputRunConfig {
  workers: number;
  tasks: number;
  arrival: Arrival;
}

// Backlog mode: the fixture is inserted with available_at = T, an instant
// chosen this far in the future, so insertion, VACUUM ANALYZE and CHECKPOINT
// all finish before any row is claimable. T is therefore both the durable
// eligibility instant of every task and the start of the timed window.
const BACKLOG_ELIGIBILITY_MARGIN_MS = 8_000;

// Paced mode inserts a batch this often.
const PACED_BATCH_INTERVAL_MS = 10;

async function insertBacklog(pool: Pool, tasks: number): Promise<string> {
  const eligibleAt = await pool.query<{ t: string }>(
    "select (clock_timestamp() + $1::int * interval '1 millisecond')::text as t",
    [BACKLOG_ELIGIBILITY_MARGIN_MS],
  );
  const t = eligibleAt.rows[0]!.t;
  await pool.query(
    `insert into steps (id, status, priority, available_at, max_attempts, task_type, payload)
     select gen_random_uuid(), 'READY', 0, $2::timestamptz, 3, $3,
            jsonb_build_object('input', 'bench-' || g, 'failuresBeforeSuccess', 0)
     from generate_series(1, $1::int) g`,
    [tasks, t, TASK_TYPE],
  );
  await settleBenchTables(pool);
  await assertFixtureSize(pool, tasks);
  const check = await pool.query<{ before: boolean }>("select clock_timestamp() < $1::timestamptz as before", [t]);
  if (!check.rows[0]!.before) {
    throw new Error("fixture preparation overran the eligibility instant; results would include preparation time");
  }
  return t;
}

// The fixture must be exactly the requested size before any timing starts.
// A short count here means something outside this run touched the benchmark
// tables (e.g. a second harness invocation truncating them); failing fast
// keeps a destroyed fixture from ever being measured as 0/0.
async function assertFixtureSize(pool: Pool, expected: number): Promise<void> {
  const count = await pool.query<{ n: number }>("select count(*)::int as n from steps");
  if (count.rows[0]!.n !== expected) {
    throw new Error(`fixture should hold exactly ${expected} steps, found ${count.rows[0]!.n}: the benchmark database was modified by something else`);
  }
}

// Open-loop arrivals: rows are inserted on a fixed schedule regardless of how
// far behind the workers are. available_at defaults to now(), the inserting
// transaction's start, which is the task's durable eligibility instant; the
// row becomes visible at that transaction's commit, normally well under a
// millisecond later on this local setup.
async function insertPaced(pool: Pool, tasks: number, ratePerSec: number): Promise<void> {
  const start = performance.now();
  let inserted = 0;
  while (inserted < tasks) {
    const due = Math.min(tasks, Math.floor(((performance.now() - start) / 1000) * ratePerSec));
    if (due > inserted) {
      await pool.query(
        `insert into steps (id, status, priority, max_attempts, task_type, payload)
         select gen_random_uuid(), 'READY', 0, 3, $3,
                jsonb_build_object('input', 'bench-' || g, 'failuresBeforeSuccess', 0)
         from generate_series($1::int, $2::int) g`,
        [inserted + 1, due, TASK_TYPE],
      );
      inserted = due;
    }
    await sleep(PACED_BATCH_INTERVAL_MS);
  }
  // Rows are not deleted as workers drain them, so the full fixture must
  // still be present once insertion finishes.
  await assertFixtureSize(pool, tasks);
}

type Percentiles = { p50: number; p95: number; p99: number; max: number };

function percentiles(values: number[] | null, max: number | null): Percentiles {
  const [p50, p95, p99] = (values ?? [NaN, NaN, NaN]).map((value) => round(Number(value), 2));
  return { p50: p50!, p95: p95!, p99: p99!, max: round(Number(max), 2) };
}

async function tableStats(pool: Pool) {
  const result = await pool.query<{ relname: string; autovacuum_count: string; autoanalyze_count: string; n_dead_tup: string }>(
    `select relname, autovacuum_count::text, autoanalyze_count::text, n_dead_tup::text
     from pg_stat_user_tables where relname in ('steps', 'step_events')`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.relname, {
    autovacuumCount: Number(row.autovacuum_count),
    autoanalyzeCount: Number(row.autoanalyze_count),
    deadTuples: Number(row.n_dead_tup),
  }]));
}

async function measure(pool: Pool) {
  // Definitions (all instants are PostgreSQL clock_timestamp() values written
  // by the runtime itself; no process clock is involved):
  //   eligible_at  = steps.available_at
  //   first claim  = created_at of the step's first STEP_CLAIMED event
  //                  (inside the claim transaction, after the ownership UPDATE)
  //   terminal     = created_at of its STEP_SUCCEEDED / STEP_DEAD_LETTERED
  //                  event (inside the completing transaction, after the
  //                  guarded UPDATE; the COMMIT follows)
  //   end-to-end   = terminal - eligible_at
  //   queue wait   = first claim - eligible_at
  //   service      = terminal - last claim (claim-to-completion of the
  //                  generation that finished the task)
  const summary = await pool.query(`
    with claims as (
      select step_id, min(created_at) as first_claim_at, max(created_at) as last_claim_at, count(*)::int as claims
      from step_events where event_type = 'STEP_CLAIMED' group by step_id
    ), terminal as (
      select step_id, max(created_at) as terminal_at, count(*)::int as terminal_events
      from step_events where event_type in ('STEP_SUCCEEDED', 'STEP_DEAD_LETTERED') group by step_id
    ), per_step as (
      select s.status, s.available_at, s.lease_version, c.first_claim_at, c.last_claim_at, c.claims,
             t.terminal_at, t.terminal_events,
             s.result->>'hash' = encode(sha256(convert_to(s.payload->>'input', 'UTF8')), 'hex') as result_ok
      from steps s
      left join claims c on c.step_id = s.id
      left join terminal t on t.step_id = s.id
    )
    select
      count(*)::int as tasks,
      count(*) filter (where status = 'SUCCEEDED')::int as succeeded,
      count(*) filter (where status = 'SUCCEEDED' and result_ok)::int as results_verified,
      count(*) filter (where lease_version <> 1)::int as reclaimed_tasks,
      count(*) filter (where claims is distinct from 1)::int as tasks_not_claimed_exactly_once,
      count(*) filter (where terminal_events is distinct from 1)::int as tasks_without_one_terminal_event,
      min(available_at)::text as first_eligible_at,
      max(available_at)::text as last_eligible_at,
      max(terminal_at)::text as last_terminal_at,
      extract(epoch from (max(terminal_at) - min(available_at)))::float8 as wall_seconds,
      extract(epoch from (max(available_at) - min(available_at)))::float8 as arrival_span_seconds,
      (extract(epoch from (min(first_claim_at) - min(available_at))) * 1000)::float8 as first_claim_delay_ms,
      extract(epoch from (max(terminal_at) - min(first_claim_at)))::float8 as active_seconds,
      percentile_cont(array[0.5, 0.95, 0.99]) within group (order by (extract(epoch from (terminal_at - available_at)) * 1000)::float8) as e2e_ms,
      max(extract(epoch from (terminal_at - available_at)) * 1000)::float8 as e2e_max_ms,
      percentile_cont(array[0.5, 0.95, 0.99]) within group (order by (extract(epoch from (first_claim_at - available_at)) * 1000)::float8) as queue_ms,
      max(extract(epoch from (first_claim_at - available_at)) * 1000)::float8 as queue_max_ms,
      percentile_cont(array[0.5, 0.95, 0.99]) within group (order by (extract(epoch from (terminal_at - last_claim_at)) * 1000)::float8) as service_ms,
      max(extract(epoch from (terminal_at - last_claim_at)) * 1000)::float8 as service_max_ms
    from per_step
  `);
  const row = summary.rows[0];

  const statuses = await pool.query<{ status: string; n: number }>("select status::text, count(*)::int as n from steps group by 1 order by 1");
  const events = await pool.query<{ event_type: string; n: number }>("select event_type, count(*)::int as n from step_events group by 1 order by 1");
  const perWorker = await pool.query<{ worker_id: string; n: number }>(
    "select worker_id, count(*)::int as n from step_events where event_type = 'STEP_SUCCEEDED' group by 1 order by 1",
  );
  const timeline = await pool.query<{ second: number; n: number }>(
    `select floor(extract(epoch from (created_at - $1::timestamptz)))::int as second, count(*)::int as n
     from step_events where event_type in ('STEP_SUCCEEDED', 'STEP_DEAD_LETTERED') group by 1 order by 1`,
    [row.first_eligible_at],
  );
  const sizes = await pool.query<{ steps: string; step_events: string }>(
    "select pg_total_relation_size('steps')::text as steps, pg_total_relation_size('step_events')::text as step_events",
  );

  const failed = row.tasks - row.succeeded;
  return {
    tasks: row.tasks as number,
    succeeded: row.succeeded as number,
    failed,
    statusCounts: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    resultsVerifiedBySha256InSql: row.results_verified as number,
    reclaimedTasks: row.reclaimed_tasks as number,
    tasksNotClaimedExactlyOnce: row.tasks_not_claimed_exactly_once as number,
    tasksWithoutExactlyOneTerminalEvent: row.tasks_without_one_terminal_event as number,
    firstEligibleAt: row.first_eligible_at as string,
    lastTerminalAt: row.last_terminal_at as string,
    wallSeconds: round(row.wall_seconds, 3),
    arrivalSpanSeconds: round(row.arrival_span_seconds, 3),
    tasksPerSecond: round(row.succeeded / row.wall_seconds, 1),
    firstClaimDelayMs: round(row.first_claim_delay_ms, 1),
    activeSeconds: round(row.active_seconds, 3),
    tasksPerActiveSecond: round(row.succeeded / row.active_seconds, 1),
    latencyMs: {
      endToEnd: percentiles(row.e2e_ms, row.e2e_max_ms),
      queueWait: percentiles(row.queue_ms, row.queue_max_ms),
      claimToCompletion: percentiles(row.service_ms, row.service_max_ms),
    },
    eventCounts: Object.fromEntries(events.rows.map((r) => [r.event_type, r.n])),
    eventsPerTask: round(events.rows.reduce((sum, r) => sum + r.n, 0) / row.tasks, 3),
    completionsPerWorker: Object.fromEntries(perWorker.rows.map((r) => [r.worker_id, r.n])),
    completionsPerSecond: (() => {
      const buckets = new Array<number>((timeline.rows.at(-1)?.second ?? -1) + 1).fill(0);
      for (const r of timeline.rows) buckets[r.second] = r.n;
      return buckets;
    })(),
    tableBytesAfterRun: { steps: Number(sizes.rows[0]!.steps), stepEvents: Number(sizes.rows[0]!.step_events) },
  };
}

// A run is only allowed into the results if it measured exactly the
// requested fixture and every reported number is finite. Without this, a
// fixture destroyed mid-run (e.g. by a second harness invocation truncating
// the tables) surfaces as a silent 0/0 with NaN rates and percentiles.
// Task failures are NOT asserted away: a run with dead-lettered tasks is a
// real result and is reported, not hidden.
function assertRunMeasurable(metrics: Awaited<ReturnType<typeof measure>>, expectedTasks: number): void {
  if (metrics.tasks !== expectedTasks) {
    throw new Error(`expected ${expectedTasks} tasks after the run, found ${metrics.tasks}: the benchmark database was modified by something else`);
  }
  const headline: Record<string, number> = {
    wallSeconds: metrics.wallSeconds,
    tasksPerSecond: metrics.tasksPerSecond,
    firstClaimDelayMs: metrics.firstClaimDelayMs,
    eventsPerTask: metrics.eventsPerTask,
  };
  for (const [name, percentilesOf] of Object.entries(metrics.latencyMs)) {
    for (const [key, value] of Object.entries(percentilesOf)) headline[`${name}.${key}`] = value;
  }
  for (const [name, value] of Object.entries(headline)) {
    if (!Number.isFinite(value)) {
      throw new Error(`run produced a non-finite ${name} (${value}) from ${metrics.tasks} tasks; refusing to record it`);
    }
  }
  if (metrics.wallSeconds <= 0) {
    throw new Error(`run measured a non-positive wall time (${metrics.wallSeconds}s); refusing to record it`);
  }
}

export type ThroughputRunResult = Awaited<ReturnType<typeof runThroughput>>;

export async function runThroughput(config: ThroughputRunConfig, logDir: string) {
  const pool = benchPool(2);
  const children: Child[] = [];
  try {
    await resetBenchTables(pool);
    const env = { ...process.env, DATABASE_URL: benchDatabaseUrl() };
    children.push(startTsChild("coordinator", coordinatorScript, [], {
      env, stderrFile: path.join(logDir, "coordinator.stderr.log"),
    }));
    const workerIds = Array.from({ length: config.workers }, (_, index) => `bench-worker-${index + 1}`);
    for (const id of workerIds) {
      children.push(startTsChild(id, workerScript, [id], { env, stderrFile: path.join(logDir, `${id}.stderr.log`) }));
    }
    // Warm: every worker process has loaded, connected and registered (its
    // loop starts polling immediately after registration). Timing starts
    // later, at the first task's eligibility instant.
    await waitFor("all workers registered", async () => {
      assertChildrenAlive(children);
      const result = await pool.query<{ n: number }>("select count(*)::int as n from workers where id = any($1)", [workerIds]);
      return result.rows[0]!.n === config.workers;
    }, 60_000);

    const loadAverageBefore = os.loadavg().map((value) => round(value, 2));
    let walStart: Awaited<ReturnType<typeof walPosition>>;
    let statsBefore: Awaited<ReturnType<typeof tableStats>>;
    if (config.arrival.kind === "backlog") {
      await insertBacklog(pool, config.tasks);
      walStart = await walPosition(pool);
      statsBefore = await tableStats(pool);
    } else {
      await settleBenchTables(pool);
      walStart = await walPosition(pool);
      statsBefore = await tableStats(pool);
      await insertPaced(pool, config.tasks, config.arrival.ratePerSec);
    }

    const watchdogMs = 120_000 + config.tasks * 20;
    await waitFor("every task terminal", async () => {
      assertChildrenAlive(children);
      // Cheap check first: READY and RUNNING are served by the runtime's
      // partial indexes. Only once both are empty does the harness pay for
      // the full scan that also covers RETRY_WAIT/PENDING, so the completion
      // poll adds as little load as possible to the database under test.
      const busy = await pool.query<{ busy: boolean }>(
        `select exists (select 1 from steps where status = 'READY')
             or exists (select 1 from steps where status = 'RUNNING') as busy`,
      );
      if (busy.rows[0]!.busy) return false;
      const result = await pool.query<{ open: number }>(
        "select count(*)::int as open from steps where status not in ('SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED')",
      );
      return result.rows[0]!.open === 0;
    }, watchdogMs, 250);

    const wal = await walDelta(pool, walStart);
    const statsAfter = await tableStats(pool);
    const loadAverageAfter = os.loadavg().map((value) => round(value, 2));
    await stopChildren(children);
    const metrics = await measure(pool);
    assertRunMeasurable(metrics, config.tasks);
    const stderr = stderrSummary(children);

    return {
      config,
      ...metrics,
      wal: { ...wal, bytesPerTask: round(wal.walBytes / metrics.tasks, 0) },
      autovacuumDuringRun: Object.fromEntries(Object.keys(statsAfter).map((table) => [table, {
        autovacuumRuns: statsAfter[table]!.autovacuumCount - (statsBefore[table]?.autovacuumCount ?? 0),
        autoanalyzeRuns: statsAfter[table]!.autoanalyzeCount - (statsBefore[table]?.autoanalyzeCount ?? 0),
        deadTuplesAtEnd: statsAfter[table]!.deadTuples,
      }])),
      loadAverage: { before: loadAverageBefore, after: loadAverageAfter },
      processes: {
        exitCodes: Object.fromEntries(children.map((child) => [child.name, child.exitCode])),
        stderrLines: stderr.lines,
        stderrSample: stderr.sample,
      },
    };
  } finally {
    await stopChildren(children);
    await pool.end();
  }
}
