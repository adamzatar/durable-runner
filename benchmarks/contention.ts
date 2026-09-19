import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import type { Pool } from "pg";
import { recoverExpiredSteps } from "../server/src/db/recover-expired-steps.js";
import type { ClaimerRecord } from "./claimer.js";
import {
  benchDatabaseUrl, benchDb, benchPool, type Child, repoRoot, resetBenchTables, round, settleBenchTables,
  startTsChild, stderrSummary, stopChildren, waitFor,
} from "./common.js";

const claimerScript = `${repoRoot}benchmarks/claimer.ts`;

export interface ContentionConfig {
  processes: number;
  claimersPerProcess: number;
  // Phase A: this many fresh READY rows, each claimed once.
  backlogSteps: number;
  // Phase B: a few rows re-claimed over and over. Each claim's lease is
  // `leaseMs`; in-process sweepers call the production recoverExpiredSteps
  // in a tight loop, returning expired rows to READY so they can be claimed
  // again at the next generation.
  churn: { hotSteps: number; targetGrants: number; leaseMs: number; sweepers: number };
}

async function spawnClaimers(config: ContentionConfig, mode: "backlog" | "churn", leaseMs: number, dir: string) {
  const env = { ...process.env, DATABASE_URL: benchDatabaseUrl() };
  const children: Child[] = [];
  const outFiles: string[] = [];
  const ready: Promise<void>[] = [];
  for (let index = 1; index <= config.processes; index += 1) {
    const outFile = path.join(dir, `${mode}-claimer-${index}.json`);
    outFiles.push(outFile);
    const child = startTsChild(`${mode}-claimer-${index}`, claimerScript, [JSON.stringify({
      processIndex: index, claimers: config.claimersPerProcess, leaseMs, mode, outFile,
    })], { env, stderrFile: path.join(dir, `${mode}-claimer-${index}.stderr.log`), stdout: "pipe", stdin: "pipe" });
    children.push(child);
    ready.push(new Promise((resolve, reject) => {
      createInterface({ input: child.process.stdout! }).on("line", (line) => { if (line === "ready") resolve(); });
      child.closed.then(() => reject(new Error(`${child.name} exited before ready; see ${child.stderrFile}`)));
    }));
  }
  await Promise.all(ready);
  return { children, outFiles };
}

function go(children: Child[]) {
  for (const child of children) child.process.stdin!.write("go\n");
}

// Three independent sources must agree for every ownership generation:
//   1. what each claimer's claimNextStep call returned (client-side record),
//   2. the durable STEP_CLAIMED events (written in the claim transaction),
//   3. the final step rows (lease_version counts generations; a RUNNING row
//      names its current owner).
// A duplicate ownership grant is two claimers being told they own the same
// (step, lease_version). That is checked directly on (1), and (2)/(3) rule
// out a grant the client record could have missed or invented.
async function verifyOwnership(pool: Pool, records: ClaimerRecord[]) {
  const clientGrants = new Map<string, string[]>();
  const versionsByStep = new Map<string, number[]>();
  for (const record of records) {
    for (const [stepId, version] of record.grants) {
      const key = `${stepId}:${version}`;
      const owners = clientGrants.get(key) ?? [];
      owners.push(record.id);
      clientGrants.set(key, owners);
      const versions = versionsByStep.get(stepId) ?? [];
      versions.push(version);
      versionsByStep.set(stepId, versions);
    }
  }
  const duplicateGrants = [...clientGrants.entries()].filter(([, owners]) => owners.length > 1);

  const events = await pool.query<{ step_id: string; v: number; worker_id: string }>(
    "select step_id::text, (data->>'leaseVersion')::int as v, worker_id from step_events where event_type = 'STEP_CLAIMED'",
  );
  const eventOwners = new Map<string, string[]>();
  for (const event of events.rows) {
    const key = `${event.step_id}:${event.v}`;
    const owners = eventOwners.get(key) ?? [];
    owners.push(event.worker_id);
    eventOwners.set(key, owners);
  }
  const duplicateEvents = [...eventOwners.values()].filter((owners) => owners.length > 1).length;
  let grantsWithoutMatchingEvent = 0;
  for (const [key, owners] of clientGrants) {
    const eventOwner = eventOwners.get(key);
    if (!eventOwner || eventOwner.length !== 1 || owners.length !== 1 || eventOwner[0] !== owners[0]) grantsWithoutMatchingEvent += 1;
  }
  let eventsWithoutClientGrant = 0;
  for (const key of eventOwners.keys()) if (!clientGrants.has(key)) eventsWithoutClientGrant += 1;

  const rows = await pool.query<{ id: string; status: string; lease_version: number; current_worker_id: string | null }>(
    "select id::text, status::text, lease_version, current_worker_id from steps",
  );
  let rowsWithGenerationMismatch = 0;
  let runningRowsWithWrongOwner = 0;
  const generations: number[] = [];
  for (const row of rows.rows) {
    const versions = (versionsByStep.get(row.id) ?? []).sort((a, b) => a - b);
    generations.push(row.lease_version);
    // Every generation 1..lease_version granted to exactly one claimer, none
    // missing, none beyond what the row recorded.
    if (versions.length !== row.lease_version || versions.some((version, index) => version !== index + 1)) {
      rowsWithGenerationMismatch += 1;
    }
    if (row.status === "RUNNING") {
      const owner = clientGrants.get(`${row.id}:${row.lease_version}`);
      if (!owner || owner[0] !== row.current_worker_id) runningRowsWithWrongOwner += 1;
    }
  }

  return {
    clientObservedGrants: [...clientGrants.values()].reduce((sum, owners) => sum + owners.length, 0),
    distinctGenerationsGranted: clientGrants.size,
    duplicateOwnershipGrants: duplicateGrants.length,
    duplicateGrantSamples: duplicateGrants.slice(0, 5),
    durableClaimEvents: events.rowCount ?? 0,
    duplicateClaimEvents: duplicateEvents,
    clientGrantsWithoutMatchingEvent: grantsWithoutMatchingEvent,
    eventsWithoutClientGrant,
    stepRows: rows.rowCount ?? 0,
    rowsWithGenerationMismatch,
    runningRowsWithWrongOwner,
    generationsPerStep: {
      min: Math.min(...generations),
      max: Math.max(...generations),
      mean: round(generations.reduce((sum, value) => sum + value, 0) / generations.length, 1),
    },
  };
}

function summarizeRecords(records: ClaimerRecord[]) {
  return {
    claimers: records.length,
    attemptedClaims: records.reduce((sum, record) => sum + record.attempts, 0),
    successfulClaims: records.reduce((sum, record) => sum + record.grants.length, 0),
    emptyClaims: records.reduce((sum, record) => sum + record.empty, 0),
    claimConsistencyErrors: records.reduce((sum, record) => sum + record.consistencyErrors, 0),
    otherErrors: records.reduce((sum, record) => sum + record.otherErrors, 0),
    otherErrorSamples: records.flatMap((record) => record.otherErrorSamples).slice(0, 5),
    claimersWithAtLeastOneGrant: records.filter((record) => record.grants.length > 0).length,
    minGrantsPerClaimer: Math.min(...records.map((record) => record.grants.length)),
    maxGrantsPerClaimer: Math.max(...records.map((record) => record.grants.length)),
  };
}

async function claimEventSpan(pool: Pool) {
  const result = await pool.query<{ seconds: number }>(
    `select extract(epoch from (max(created_at) - min(created_at)))::float8 as seconds
     from step_events where event_type = 'STEP_CLAIMED'`,
  );
  return result.rows[0]!.seconds;
}

function readRecords(outFiles: string[]): ClaimerRecord[] {
  return outFiles.flatMap((file) => JSON.parse(readFileSync(file, "utf8")) as ClaimerRecord[]);
}

async function insertSteps(pool: Pool, count: number, maxAttempts: number) {
  await pool.query(
    `insert into steps (id, status, priority, available_at, max_attempts, task_type, payload)
     select gen_random_uuid(), 'READY', 0, clock_timestamp() - interval '1 second', $2, 'fail_then_hash',
            jsonb_build_object('input', 'contention-' || g, 'failuresBeforeSuccess', 0)
     from generate_series(1, $1::int) g`,
    [count, maxAttempts],
  );
  await settleBenchTables(pool);
  // Fail fast on a short fixture rather than measuring whatever is left.
  const check = await pool.query<{ n: number }>("select count(*)::int as n from steps");
  if (check.rows[0]!.n !== count) {
    throw new Error(`fixture should hold exactly ${count} steps, found ${check.rows[0]!.n}: the benchmark database was modified by something else`);
  }
}

async function runBacklogPhase(config: ContentionConfig, pool: Pool, dir: string) {
  await resetBenchTables(pool);
  await insertSteps(pool, config.backlogSteps, 3);
  // Leases far longer than the phase, so every row is claimed exactly once
  // and nothing expires: this phase isolates concurrent first claims.
  const { children, outFiles } = await spawnClaimers(config, "backlog", 600_000, dir);
  try {
    const start = performance.now();
    go(children);
    await Promise.all(children.map((child) => child.closed));
    const harnessSeconds = (performance.now() - start) / 1000;
    const records = readRecords(outFiles);
    const summary = summarizeRecords(records);
    const dbSeconds = await claimEventSpan(pool);
    // Leases outlast the phase and claimers stop only once no READY row
    // remains, so exactly one successful claim per fixture row is
    // deterministic. Anything else means the phase did not run as configured.
    if (summary.successfulClaims !== config.backlogSteps) {
      throw new Error(`backlog phase granted ${summary.successfulClaims} claims for ${config.backlogSteps} fixture rows`);
    }
    if (!Number.isFinite(dbSeconds) || dbSeconds <= 0) {
      throw new Error(`backlog phase produced a non-positive claim-event span (${dbSeconds}s) from ${summary.successfulClaims} claims`);
    }
    return {
      description: "fresh backlog: every READY row claimed once by concurrent independent sessions",
      steps: config.backlogSteps,
      leaseMs: 600_000,
      ...summary,
      wallSecondsHarness: round(harnessSeconds, 3),
      wallSecondsFirstToLastClaimEvent: round(dbSeconds, 3),
      successfulClaimsPerSecond: round(summary.successfulClaims / dbSeconds, 0),
      ownership: await verifyOwnership(pool, records),
      processes: {
        exitCodes: Object.fromEntries(children.map((child) => [child.name, child.exitCode])),
        stderrLines: stderrSummary(children).lines,
      },
    };
  } finally {
    await stopChildren(children);
  }
}

async function runChurnPhase(config: ContentionConfig, pool: Pool, dir: string) {
  const { hotSteps, targetGrants, leaseMs, sweepers } = config.churn;
  await resetBenchTables(pool);
  // Attempt budget large enough never to dead-letter within the phase: this
  // phase is about ownership, not the retry budget.
  await insertSteps(pool, hotSteps, 10_000_000);
  const { children, outFiles } = await spawnClaimers(config, "churn", leaseMs, dir);
  const stop = { value: false };
  const sweeperStats = Array.from({ length: sweepers }, () => ({ sweeps: 0, recovered: 0, errors: 0 }));
  const sweeperLoops = sweeperStats.map(async (stats) => {
    const { pool: sweeperPool, db } = benchDb(1);
    try {
      while (!stop.value) {
        try {
          const recovered = await recoverExpiredSteps(db);
          stats.sweeps += 1;
          stats.recovered += recovered.length;
        } catch {
          stats.errors += 1;
        }
      }
    } finally {
      await sweeperPool.end();
    }
  });
  try {
    const start = performance.now();
    go(children);
    await waitFor(`${targetGrants} grants`, async () => {
      const result = await pool.query<{ total: number }>("select coalesce(sum(lease_version), 0)::int as total from steps");
      return result.rows[0]!.total >= targetGrants;
    }, 600_000, 100);
    await stopChildren(children);
    stop.value = true;
    await Promise.all(sweeperLoops);
    const harnessSeconds = (performance.now() - start) / 1000;
    const records = readRecords(outFiles);
    const summary = summarizeRecords(records);
    const dbSeconds = await claimEventSpan(pool);
    // The phase ran until the database recorded targetGrants ownership
    // generations; the client records must account for at least that many.
    if (summary.successfulClaims < targetGrants) {
      throw new Error(`churn phase recorded only ${summary.successfulClaims} client-observed grants for a target of ${targetGrants}`);
    }
    if (!Number.isFinite(dbSeconds) || dbSeconds <= 0) {
      throw new Error(`churn phase produced a non-positive claim-event span (${dbSeconds}s) from ${summary.successfulClaims} claims`);
    }
    const recoveries = await pool.query<{ n: number }>("select count(*)::int as n from step_events where event_type = 'LEASE_RECOVERED'");
    return {
      description: "hot-row churn: many sessions repeatedly re-claiming a few rows across successive ownership generations",
      hotSteps,
      leaseMs,
      sweepers,
      ...summary,
      recoverySweeps: sweeperStats.reduce((sum, stats) => sum + stats.sweeps, 0),
      recoveredBySweepers: sweeperStats.reduce((sum, stats) => sum + stats.recovered, 0),
      sweeperErrors: sweeperStats.reduce((sum, stats) => sum + stats.errors, 0),
      durableLeaseRecoveredEvents: recoveries.rows[0]!.n,
      wallSecondsHarness: round(harnessSeconds, 3),
      wallSecondsFirstToLastClaimEvent: round(dbSeconds, 3),
      successfulClaimsPerSecond: round(summary.successfulClaims / dbSeconds, 0),
      ownership: await verifyOwnership(pool, records),
      processes: {
        exitCodes: Object.fromEntries(children.map((child) => [child.name, child.exitCode])),
        stderrLines: stderrSummary(children).lines,
      },
    };
  } finally {
    stop.value = true;
    await stopChildren(children);
    await Promise.all(sweeperLoops);
  }
}

export async function runContention(config: ContentionConfig, dir: string) {
  const pool = benchPool(1);
  try {
    const backlog = await runBacklogPhase(config, pool, dir);
    const churn = await runChurnPhase(config, pool, dir);
    return { config, backlog, churn };
  } finally {
    await pool.end();
  }
}
