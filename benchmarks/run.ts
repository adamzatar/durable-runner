import "../server/src/load-env.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import {
  benchPool, collectEnvironment, machineFitness, maintenanceDatabaseUrl, median, powerState, prepareBenchDatabase,
  repoRoot, round, sleep,
} from "./common.js";
import { runContention, type ContentionConfig } from "./contention.js";
import { runEventOverhead, type EventOverheadConfig } from "./event-overhead.js";
import { runIdempotency, type IdempotencyConfig } from "./idempotency.js";
import { runStaleGeneration, type StaleGenerationConfig } from "./stale-generation.js";
import { runThroughput, type ThroughputRunResult } from "./throughput.js";

// Usage:
//   npm run bench                         all suites, full size
//   npm run bench -- throughput stale     selected suites
//   npm run bench -- --quick              small smoke run, written to the OS temp dir
//   npm run bench -- --allow-low-power    measure anyway on battery / Low Power Mode
//   npm run bench -- --allow-high-load    measure anyway on an overloaded machine
//
// Suites: throughput, paced, contention, stale, idempotency, events.

const SUITES = ["throughput", "paced", "contention", "stale", "idempotency", "events"] as const;
type Suite = (typeof SUITES)[number];

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const allowLowPower = args.includes("--allow-low-power");
const allowHighLoad = args.includes("--allow-high-load");
const requested = args.filter((arg) => !arg.startsWith("--"));
for (const name of requested) {
  if (name !== "all" && !(SUITES as readonly string[]).includes(name)) throw new Error(`unknown suite ${name}`);
}
const selected: Suite[] = requested.length === 0 || requested.includes("all") ? [...SUITES] : (requested as Suite[]);

const config = quick
  ? {
      // Quick runs repeat too: the repetition path is part of what a smoke
      // run validates, and a single repetition cannot show cross-repetition
      // lifecycle leaks.
      throughput: { workerCounts: [1, 3], tasks: 2_000, repetitions: 3 },
      paced: { workers: 3, fallbackRatePerSec: 200, durationSeconds: 5, repetitions: 2 },
      contention: { processes: 2, claimersPerProcess: 4, backlogSteps: 5_000, churn: { hotSteps: 8, targetGrants: 5_000, leaseMs: 1, sweepers: 1 } },
      stale: { scenarios: 20 },
      idempotency: { logicalKeys: 200, concurrentExecutions: 4, claimLoops: 2, workerLoops: 2 },
      events: { tasks: 1_000, loops: 2, repetitions: 1 },
    }
  : {
      throughput: { workerCounts: [1, 3, 8], tasks: 50_000, repetitions: 3 },
      paced: { workers: 8, fallbackRatePerSec: 1_000, durationSeconds: 30, repetitions: 3 },
      contention: { processes: 4, claimersPerProcess: 16, backlogSteps: 100_000, churn: { hotSteps: 32, targetGrants: 100_000, leaseMs: 1, sweepers: 2 } },
      stale: { scenarios: 500 },
      idempotency: { logicalKeys: 5_000, concurrentExecutions: 8, claimLoops: 4, workerLoops: 4 },
      events: { tasks: 20_000, loops: 8, repetitions: 3 },
    } satisfies {
      throughput: { workerCounts: number[]; tasks: number; repetitions: number };
      paced: { workers: number; fallbackRatePerSec: number; durationSeconds: number; repetitions: number };
      contention: ContentionConfig;
      stale: StaleGenerationConfig;
      idempotency: IdempotencyConfig;
      events: EventOverheadConfig;
    };

const power = powerState();
if (!quick && !allowLowPower && (power.source !== "AC Power" || power.lowPowerMode === true)) {
  console.error(
    `[bench] refusing to measure: power source ${power.source ?? "unknown"}, Low Power Mode ${String(power.lowPowerMode)}. ` +
      "Both throttle the CPU and change every timing result. Plug in and disable Low Power Mode, or pass --allow-low-power " +
      "(recorded in the artifact).",
  );
  process.exit(2);
}
const fitness = machineFitness();
if (!quick && !allowHighLoad && (!fitness.loadOk || !fitness.memoryOk)) {
  console.error(
    `[bench] refusing to measure: 1-minute load ${fitness.loadAverage1m} on ${fitness.logicalCores} cores, ` +
      `memory free ${fitness.memoryFreePercent ?? "unknown"}%. An overloaded machine changes every timing result and has ` +
      "already cost one full invocation (churn ran ~33x slow and hit its watchdog). Free resources or pass " +
      "--allow-high-load (recorded in the artifact).",
  );
  process.exit(2);
}

function log(message: string) {
  console.log(`[bench ${new Date().toISOString()}] ${message}`);
}

function summarizeThroughput(runs: ThroughputRunResult[]) {
  const byWorkers = new Map<number, ThroughputRunResult[]>();
  for (const run of runs) byWorkers.set(run.config.workers, [...(byWorkers.get(run.config.workers) ?? []), run]);
  return [...byWorkers.entries()].map(([workers, group]) => {
    const rates = group.map((run) => run.tasksPerSecond);
    const medianRate = median(rates);
    return {
      workers,
      runs: group.length,
      tasksPerSecond: { median: medianRate, min: Math.min(...rates), max: Math.max(...rates),
        spreadPercentOfMedian: round(((Math.max(...rates) - Math.min(...rates)) / medianRate) * 100, 1) },
      endToEndP50MsMedian: median(group.map((run) => run.latencyMs.endToEnd.p50)),
      endToEndP95MsMedian: median(group.map((run) => run.latencyMs.endToEnd.p95)),
      endToEndP99MsMedian: median(group.map((run) => run.latencyMs.endToEnd.p99)),
      claimToCompletionP50MsMedian: median(group.map((run) => run.latencyMs.claimToCompletion.p50)),
      claimToCompletionP95MsMedian: median(group.map((run) => run.latencyMs.claimToCompletion.p95)),
      claimToCompletionP99MsMedian: median(group.map((run) => run.latencyMs.claimToCompletion.p99)),
      allTasksSucceeded: group.every((run) => run.succeeded === run.tasks && run.failed === 0),
    };
  });
}

function throughputRows(runs: ThroughputRunResult[]): string[] {
  return runs.map((run, index) =>
    `| ${index + 1} | ${run.config.workers} | ${run.tasks} | ${run.succeeded} | ${run.failed} | ${run.wallSeconds} | ` +
    `${run.tasksPerSecond} | ${run.firstClaimDelayMs} | ${run.latencyMs.endToEnd.p50} / ${run.latencyMs.endToEnd.p95} / ${run.latencyMs.endToEnd.p99} | ` +
    `${run.latencyMs.claimToCompletion.p50} / ${run.latencyMs.claimToCompletion.p95} / ${run.latencyMs.claimToCompletion.p99} | ` +
    `${run.eventsPerTask} | ${run.wal.bytesPerTask} | ${run.reclaimedTasks} | ${run.processes.stderrLines} |`);
}

const THROUGHPUT_HEADER = [
  "| # | workers | tasks | succeeded | failed | wall s | tasks/s | first claim ms | e2e p50/p95/p99 ms | claim→done p50/p95/p99 ms | events/task | WAL B/task | reclaimed | stderr lines |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

function renderMarkdown(artifact: Record<string, any>): string {
  const lines: string[] = [];
  const env = artifact.environment;
  lines.push(`# Benchmark results ${artifact.runId}`, "");
  lines.push(`Generated by \`npm run bench\`${artifact.quick ? " (quick smoke run — not a measurement)" : ""}.`, "");
  lines.push("## Environment", "");
  lines.push(`- git: ${env.git.commit} (${env.git.subject}); runtime source unmodified: ${env.git.runtimeSourceUnmodified}`);
  lines.push(`- Node ${env.node}; ${env.os.platform} ${env.os.productVersion ?? ""} (${env.os.release}, ${env.os.arch})`);
  lines.push(`- CPU ${env.cpu.model}, ${env.cpu.logicalCores} logical cores (${env.cpu.performanceCores} performance + ${env.cpu.efficiencyCores} efficiency); ${env.memoryGiB} GiB RAM`);
  lines.push(`- power: ${env.power.source}; Low Power Mode: ${env.power.lowPowerMode}`);
  lines.push(`- machine load at start: 1-minute load ${env.fitness.loadAverage1m} on ${env.fitness.logicalCores} cores, memory free ${env.fitness.memoryFreePercent ?? "unknown"}%`);
  lines.push(`- PostgreSQL ${env.postgres.serverVersion}, ${env.postgres.location}; ${Object.entries(env.postgres.settings).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  const s = artifact.suites;
  if (s.throughput) {
    lines.push("## Throughput (backlog drain)", "", ...THROUGHPUT_HEADER, ...throughputRows(s.throughput.runs), "");
    lines.push("| workers | runs | median tasks/s | min | max | spread % | median e2e p50/p95/p99 ms | median claim→done p50/p95/p99 ms | all succeeded |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const row of s.throughput.summary) {
      lines.push(`| ${row.workers} | ${row.runs} | ${row.tasksPerSecond.median} | ${row.tasksPerSecond.min} | ${row.tasksPerSecond.max} | ` +
        `${row.tasksPerSecond.spreadPercentOfMedian} | ${row.endToEndP50MsMedian} / ${row.endToEndP95MsMedian} / ${row.endToEndP99MsMedian} | ` +
        `${row.claimToCompletionP50MsMedian} / ${row.claimToCompletionP95MsMedian} / ${row.claimToCompletionP99MsMedian} | ${row.allTasksSucceeded} |`);
    }
    lines.push("");
  }
  if (s.paced) {
    lines.push(`## Paced arrivals (${s.paced.ratePerSec} tasks/s, ${s.paced.config.workers} workers)`, "", `Rate: ${s.paced.rateRule}.`, "", ...THROUGHPUT_HEADER, ...throughputRows(s.paced.runs), "");
  }
  if (s.contention) {
    for (const phase of ["backlog", "churn"] as const) {
      const p = s.contention[phase];
      lines.push(`## Claim contention — ${phase}`, "", `${p.description}.`, "");
      lines.push("| claimers | attempted | successful | empty | duplicate grants | consistency errors | other errors | durable claim events | grants w/o matching event | events w/o client grant | row generation mismatches | first→last claim s | claims/s |");
      lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
      lines.push(`| ${p.claimers} | ${p.attemptedClaims} | ${p.successfulClaims} | ${p.emptyClaims} | ${p.ownership.duplicateOwnershipGrants} | ` +
        `${p.claimConsistencyErrors} | ${p.otherErrors} | ${p.ownership.durableClaimEvents} | ${p.ownership.clientGrantsWithoutMatchingEvent} | ` +
        `${p.ownership.eventsWithoutClientGrant} | ${p.ownership.rowsWithGenerationMismatch} | ${p.wallSecondsFirstToLastClaimEvent} | ${p.successfulClaimsPerSecond} |`);
      lines.push("");
    }
  }
  if (s.stale) {
    const r = s.stale;
    lines.push("## Stale-generation scenarios", "");
    lines.push("| scenarios | recoveries | reassignments | stale renewals | stale completions | stale failure reports | stale writes accepted | rejections that changed the row | final-state corruption | unexpected failures |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    lines.push(`| ${r.scenariosAttempted} | ${r.recoveriesCompleted} | ${r.reassignmentsCompleted} | ${r.staleRenewalAttempts} | ${r.staleCompletionAttempts} | ` +
      `${r.staleFailureReportAttempts} | ${r.staleWritesAccepted} | ${r.staleRejectionsThatChangedTheRow} | ${r.scenariosWithFinalStateCorruption} | ${r.unexpectedFailures} |`);
    lines.push("");
  }
  if (s.idempotency) {
    const r = s.idempotency;
    lines.push("## Idempotency stress", "");
    lines.push("| logical keys | executions | applied (inserted) | reused stored effect | durable effect rows | duplicate logical effects | conflicting requests rejected | effects created on re-execution | final succeeded | results matching stored effect |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    lines.push(`| ${r.logicalEffectsRequested} | ${r.executionsTotal} | ${r.phase1.appliedTrue} | ${r.phase1.appliedFalseReturnedStored + r.phase4.workerLoopExecutions} | ` +
      `${r.durableEffectRows} | ${r.duplicateLogicalEffects} | ${r.phase3.conflictingKeyRejections} / ${r.phase3.conflictingRequestAttempts} | ` +
      `${r.phase4.effectsCreated} | ${r.finalSucceededSteps} | ${r.stepResultsMatchingStoredEffect} |`);
    lines.push("");
  }
  if (s.eventOverhead) {
    const r = s.eventOverhead;
    lines.push("## Event write overhead (benchmark-only comparison)", "");
    lines.push("| trial | variant | completed | event rows | seconds | tasks/s |", "|---|---|---|---|---|---|");
    r.trials.forEach((t: any, index: number) => lines.push(`| ${index + 1} | ${t.variant} | ${t.completed} | ${t.eventRows} | ${t.seconds} | ${t.tasksPerSecond} |`));
    lines.push("", `Median tasks/s: events ${r.medianTasksPerSecond.events}, no-events (benchmark-only copy) ${r.medianTasksPerSecond.noEventsBenchmarkOnly}; ratio ${r.eventsThroughputRelativeToNoEvents}.`, "");
  }
  return lines.join("\n");
}

async function main() {
  // Exclusive use of the benchmark database for the whole invocation: every
  // suite truncates the tables between runs, so two harnesses sharing it
  // would silently destroy each other's fixtures (the failure mode behind
  // the invalid 19:46 UTC invocation). A session-level advisory lock on a
  // connection held checked out (so the pool never idles it out) until exit;
  // PostgreSQL drops it if this process dies. Taken on the maintenance
  // database BEFORE prepareBenchDatabase, so a concurrent invocation cannot
  // race database creation/migration either; advisory locks are
  // cluster-wide, so the database the lock connection uses does not matter.
  const lockPool = new Pool({ connectionString: maintenanceDatabaseUrl(), max: 1 });
  const lockClient = await lockPool.connect();
  const lock = await lockClient.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('durable-runner-bench')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("[bench] another benchmark run holds the benchmark database; refusing to run concurrently with it");
    process.exit(3);
  }
  log(`preparing benchmark database (suites: ${selected.join(", ")}${quick ? ", quick" : ""})`);
  await prepareBenchDatabase();
  const pool = benchPool(1);
  const environment = await collectEnvironment(pool);
  await pool.end();
  const logDir = mkdtempSync(path.join(os.tmpdir(), "durable-runner-bench-"));
  const suites: Record<string, unknown> = {};

  if (selected.includes("throughput")) {
    const { workerCounts, tasks, repetitions } = config.throughput;
    const runs: ThroughputRunResult[] = [];
    // Interleaved (1,3,8,1,3,8,...) rather than grouped, so slow drift in the
    // machine's state (thermal, background load) spreads across worker counts
    // instead of landing on one of them.
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const workers of workerCounts) {
        log(`throughput: ${workers} worker(s), ${tasks} tasks, repetition ${repetition}/${repetitions}`);
        const runDir = mkdtempSync(path.join(logDir, `throughput-${workers}w-`));
        const result = await runThroughput({ workers, tasks, arrival: { kind: "backlog" } }, runDir);
        log(`  ${result.tasksPerSecond} tasks/s, wall ${result.wallSeconds}s, succeeded ${result.succeeded}/${result.tasks}, ` +
          `e2e p50 ${result.latencyMs.endToEnd.p50}ms, claim→done p50 ${result.latencyMs.claimToCompletion.p50}ms`);
        runs.push(result);
        await sleep(3_000);
      }
    }
    suites.throughput = { config: config.throughput, runOrder: "interleaved by repetition", runs, summary: summarizeThroughput(runs) };
  }

  if (selected.includes("paced")) {
    const { workers, fallbackRatePerSec, durationSeconds, repetitions } = config.paced;
    // The rate is derived, not hand-picked: half of what the same number of
    // workers sustained on a backlog, so the system is loaded but not
    // saturated and latency reflects the runtime rather than an ever-growing
    // queue. Falls back to the configured rate if throughput did not run.
    const throughput = suites.throughput as { summary: ReturnType<typeof summarizeThroughput> } | undefined;
    const capacity = throughput?.summary.find((row) => row.workers === workers)?.tasksPerSecond.median;
    const ratePerSec = capacity ? Math.max(100, Math.floor((capacity * 0.5) / 100) * 100) : fallbackRatePerSec;
    const rateRule = capacity
      ? `50% of the ${workers}-worker median backlog throughput (${capacity} tasks/s) in this invocation, rounded down to a multiple of 100`
      : "configured fallback rate (throughput suite not run in this invocation)";
    const tasks = ratePerSec * durationSeconds;
    const runs: ThroughputRunResult[] = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      log(`paced: ${workers} workers, ${ratePerSec} tasks/s, ${tasks} tasks, repetition ${repetition}/${repetitions}`);
      const runDir = mkdtempSync(path.join(logDir, "paced-"));
      const result = await runThroughput({ workers, tasks, arrival: { kind: "paced", ratePerSec } }, runDir);
      log(`  e2e p50/p95/p99 ${result.latencyMs.endToEnd.p50}/${result.latencyMs.endToEnd.p95}/${result.latencyMs.endToEnd.p99}ms`);
      runs.push(result);
      await sleep(3_000);
    }
    suites.paced = { config: config.paced, ratePerSec, rateRule, tasksPerRun: tasks, runs, summary: summarizeThroughput(runs) };
  }

  if (selected.includes("contention")) {
    log(`contention: ${config.contention.processes} processes x ${config.contention.claimersPerProcess} claimers`);
    const result = await runContention(config.contention, mkdtempSync(path.join(logDir, "contention-")));
    log(`  backlog: ${result.backlog.successfulClaims} grants, ${result.backlog.ownership.duplicateOwnershipGrants} duplicates; ` +
      `churn: ${result.churn.successfulClaims} grants, ${result.churn.ownership.duplicateOwnershipGrants} duplicates`);
    suites.contention = result;
  }

  if (selected.includes("stale")) {
    log(`stale generation: ${config.stale.scenarios} scenarios`);
    const result = await runStaleGeneration(config.stale);
    log(`  ${result.staleAttemptsTotal} stale attempts, ${result.staleWritesAccepted} accepted, ${result.unexpectedFailures} unexpected`);
    suites.stale = result;
  }

  if (selected.includes("idempotency")) {
    log(`idempotency: ${config.idempotency.logicalKeys} keys x ${config.idempotency.concurrentExecutions} concurrent executions`);
    const result = await runIdempotency(config.idempotency);
    log(`  ${result.executionsTotal} executions, ${result.durableEffectRows} effect rows, ${result.duplicateLogicalEffects} duplicate logical effects`);
    suites.idempotency = result;
  }

  if (selected.includes("events")) {
    log(`event overhead: ${config.events.tasks} tasks x ${config.events.loops} loops, ${config.events.repetitions} alternating repetitions`);
    const result = await runEventOverhead(config.events);
    log(`  median tasks/s with events ${result.medianTasksPerSecond.events}, without (benchmark-only) ${result.medianTasksPerSecond.noEventsBenchmarkOnly}`);
    suites.eventOverhead = result;
  }

  const stamp = environment.timestamp.replace(/[:.]/g, "-");
  const runId = `${stamp}_${(environment.git.commit ?? "unknown").slice(0, 7)}${quick ? "_quick" : ""}`;
  const artifact = {
    runId,
    quick,
    allowLowPowerOverride: allowLowPower,
    allowHighLoadOverride: allowHighLoad,
    selectedSuites: selected,
    environment,
    powerAtEnd: powerState(),
    loadAverageAtEnd: os.loadavg().map((value) => round(value, 2)),
    suites,
  };
  const outDir = quick ? logDir : path.join(repoRoot, "benchmarks", "results");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${runId}.json`);
  const markdown = renderMarkdown(artifact);
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(jsonPath.replace(/\.json$/, ".md"), `${markdown.trimEnd()}\n`);
  console.log(`\n${markdown}\n`);
  log(`wrote ${jsonPath} (+ .md)`);
  lockClient.release();
  await lockPool.end();
}

main().catch((error) => {
  console.error("[bench] failed:", error);
  process.exit(1);
});
