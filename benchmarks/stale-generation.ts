import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { claimNextStep } from "../server/src/db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../server/src/db/complete-step.js";
import { recordStepFailure } from "../server/src/db/record-step-failure.js";
import { recoverExpiredSteps } from "../server/src/db/recover-expired-steps.js";
import { renewStepLease } from "../server/src/db/renew-step-lease.js";
import { benchPool, resetBenchTables, round, sleep } from "./common.js";

// Deterministic ownership-failure scenarios against the production guarded
// operations and real PostgreSQL lease expiry. Nothing is simulated in
// memory: A's authority ends because the database clock passes its
// lease_expires_at, recovery is the production sweep, and B's generation
// comes from a real claim.
//
// A and B are logical actors in this one process, each with its own
// connection (its own PostgreSQL session). The stale worker is "stale"
// because it keeps using the (step id, worker id, lease_version) its claim
// returned after that generation has ended — which is exactly what a paused
// or partitioned worker process does when it resumes. `npm run
// demo:fencing` shows the same thing once with a real SIGSTOPped worker
// process; this benchmark repeats the protocol many times.
//
// Scenarios run one at a time: claimNextStep takes whichever READY row sorts
// first, so a single READY row at a time is what makes each claim land on
// the scenario's own step.
//
// Per scenario:
//   1. insert a READY step; A claims it (generation 1, 250 ms lease)
//   2. A renews once while live (must succeed)
//   3. wait until the DATABASE clock passes A's deadline
//   4. [expired, not yet recovered] A: renew, complete, report failure
//   5. production recovery sweep returns the step to READY
//   6. B claims generation 2 (B reuses A's worker id in half the scenarios,
//      leaving lease_version as the only term that can reject A)
//   7. [successor live] A: renew, complete, report failure
//   8. B completes (in half the scenarios A's stale completion is fired
//      concurrently with B's completion, on separate sessions)
//   9. [terminal] A: renew, complete, report failure
//  10. verify the final row and the exact event history

const A_LEASE_MS = 250;

export interface StaleGenerationConfig {
  scenarios: number;
}

type Phase = "expiredBeforeRecovery" | "successorLive" | "afterSuccessorCompleted";
type Operation = "renewal" | "completion" | "failureReport";

class Counters {
  attempts: Record<Phase, Record<Operation, number>> = {
    expiredBeforeRecovery: { renewal: 0, completion: 0, failureReport: 0 },
    successorLive: { renewal: 0, completion: 0, failureReport: 0 },
    afterSuccessorCompleted: { renewal: 0, completion: 0, failureReport: 0 },
  };
  staleWritesAccepted = 0;
  staleRejectionsWithRowChange = 0;
  liveRenewalsSucceeded = 0;
  recoveriesCompleted = 0;
  reassignmentsCompleted = 0;
  successorCompletions = 0;
  finalStateCorruption = 0;
  unexpectedFailures = 0;
  unexpectedSamples: string[] = [];

  unexpected(scenario: number, message: string) {
    this.unexpectedFailures += 1;
    if (this.unexpectedSamples.length < 10) this.unexpectedSamples.push(`scenario ${scenario}: ${message}`);
  }
}

interface StaleOwner {
  id: string;
  workerId: string;
  leaseVersion: number;
}

async function rowSnapshot(admin: Pool, id: string): Promise<string> {
  const result = await admin.query<{ row: string }>("select to_jsonb(s)::text as row from steps s where id = $1", [id]);
  return result.rows[0]!.row;
}

// Each stale operation is the production call with A's original generation.
// "Accepted" means the operation reported success; the row snapshot check
// separately catches any mutation, even one the call did not report.
async function staleAttempt(
  a: ReturnType<typeof drizzle>, stale: StaleOwner, operation: Operation, scenario: number, counters: Counters,
): Promise<void> {
  if (operation === "renewal") {
    const result = await renewStepLease(a, { ...stale, leaseDurationMs: 60_000 });
    if (result.renewed) counters.staleWritesAccepted += 1;
  } else if (operation === "completion") {
    try {
      await completeStepSuccess(a, { ...stale, result: { writer: "A-stale", scenario } });
      counters.staleWritesAccepted += 1;
    } catch (error) {
      if (!(error instanceof CompletionConsistencyError)) throw error;
    }
  } else {
    const result = await recordStepFailure(a, { ...stale, error: "stale failure report", retryable: true });
    if (result.recorded) counters.staleWritesAccepted += 1;
  }
}

async function staleRound(
  admin: Pool, a: ReturnType<typeof drizzle>, stale: StaleOwner, phase: Phase, scenario: number, counters: Counters,
) {
  for (const operation of ["renewal", "completion", "failureReport"] as const) {
    const before = await rowSnapshot(admin, stale.id);
    counters.attempts[phase][operation] += 1;
    await staleAttempt(a, stale, operation, scenario, counters);
    if ((await rowSnapshot(admin, stale.id)) !== before) counters.staleRejectionsWithRowChange += 1;
  }
}

async function waitForDatabaseExpiry(admin: Pool, id: string) {
  const watchdog = Date.now() + 5_000;
  for (;;) {
    const result = await admin.query<{ expired: boolean }>(
      "select lease_expires_at <= clock_timestamp() as expired from steps where id = $1", [id],
    );
    if (result.rows[0]!.expired) return;
    if (Date.now() > watchdog) throw new Error("lease did not expire on the database clock within 5s");
    await sleep(5);
  }
}

async function runScenario(
  scenario: number, admin: Pool, a: ReturnType<typeof drizzle>, b: ReturnType<typeof drizzle>,
  sweeper: ReturnType<typeof drizzle>, counters: Counters,
) {
  const sameWorkerId = scenario % 2 === 1;
  const race = Math.floor(scenario / 2) % 2 === 1;
  const workerA = `stale-a-${scenario}`;
  const workerB = sameWorkerId ? workerA : `stale-b-${scenario}`;
  const id = randomUUID();
  await admin.query(
    `insert into steps (id, status, priority, available_at, task_type, payload)
     values ($1, 'READY', 0, clock_timestamp() - interval '1 second', 'fail_then_hash',
             jsonb_build_object('input', 'stale-' || $2::text, 'failuresBeforeSuccess', 0))`,
    [id, scenario],
  );

  const first = await claimNextStep(a, workerA, { leaseDurationMs: A_LEASE_MS });
  if (!first.claimed || first.step.id !== id || first.step.leaseVersion !== 1) {
    counters.unexpected(scenario, `A's claim did not return generation 1 of the scenario step: ${JSON.stringify(first)}`);
    return;
  }
  const stale: StaleOwner = { id, workerId: workerA, leaseVersion: 1 };

  const live = await renewStepLease(a, { ...stale, leaseDurationMs: A_LEASE_MS });
  if (live.renewed) counters.liveRenewalsSucceeded += 1;
  else counters.unexpected(scenario, "A's renewal while live was rejected");

  await waitForDatabaseExpiry(admin, id);
  await staleRound(admin, a, stale, "expiredBeforeRecovery", scenario, counters);

  const recovered = await recoverExpiredSteps(sweeper);
  if (recovered.some((step) => step.id === id && step.leaseVersion === 1 && step.status === "READY")) {
    counters.recoveriesCompleted += 1;
  } else {
    counters.unexpected(scenario, `recovery did not return the step to READY: ${JSON.stringify(recovered)}`);
    return;
  }

  const second = await claimNextStep(b, workerB, { leaseDurationMs: 60_000 });
  if (!second.claimed || second.step.id !== id || second.step.leaseVersion !== 2) {
    counters.unexpected(scenario, `B's claim did not return generation 2: ${JSON.stringify(second)}`);
    return;
  }
  counters.reassignmentsCompleted += 1;

  await staleRound(admin, a, stale, "successorLive", scenario, counters);

  const successorResult = { writer: "B", scenario };
  if (race) {
    counters.attempts.successorLive.completion += 1;
    const [staleOutcome, successorOutcome] = await Promise.allSettled([
      completeStepSuccess(a, { ...stale, result: { writer: "A-stale", scenario } }),
      completeStepSuccess(b, { id, workerId: workerB, leaseVersion: 2, result: successorResult }),
    ]);
    if (staleOutcome.status === "fulfilled") counters.staleWritesAccepted += 1;
    else if (!(staleOutcome.reason instanceof CompletionConsistencyError)) throw staleOutcome.reason;
    if (successorOutcome.status === "fulfilled") counters.successorCompletions += 1;
    else counters.unexpected(scenario, `B's completion failed in the race: ${String(successorOutcome.reason)}`);
  } else {
    await completeStepSuccess(b, { id, workerId: workerB, leaseVersion: 2, result: successorResult });
    counters.successorCompletions += 1;
  }

  await staleRound(admin, a, stale, "afterSuccessorCompleted", scenario, counters);

  const final = await admin.query<{
    status: string; lease_version: number; attempt_count: number; current_worker_id: string | null;
    lease_expires_at: string | null; result: unknown; last_error: string | null;
  }>("select status::text, lease_version, attempt_count, current_worker_id, lease_expires_at, result, last_error from steps where id = $1", [id]);
  const row = final.rows[0]!;
  const events = await admin.query<{ event_type: string; worker_id: string | null; v: number }>(
    `select event_type, worker_id, (data->>'leaseVersion')::int as v from step_events
     where step_id = $1 order by xid, id`, [id],
  );
  const history = events.rows.map((event) => `${event.event_type}:${event.worker_id}:v${event.v}`).join(" ");
  const expectedHistory =
    `STEP_CLAIMED:${workerA}:v1 LEASE_RECOVERED:${workerA}:v1 STEP_CLAIMED:${workerB}:v2 STEP_SUCCEEDED:${workerB}:v2`;
  const rowOk =
    row.status === "SUCCEEDED" && row.lease_version === 2 && row.attempt_count === 2 && row.current_worker_id === null &&
    row.lease_expires_at === null && row.last_error === null && JSON.stringify(row.result) === JSON.stringify(successorResult);
  if (!rowOk || history !== expectedHistory) {
    counters.finalStateCorruption += 1;
    if (counters.unexpectedSamples.length < 10) {
      counters.unexpectedSamples.push(`scenario ${scenario}: final row ${JSON.stringify(row)} history ${history}`);
    }
  }
}

export async function runStaleGeneration(config: StaleGenerationConfig) {
  const admin = benchPool(1);
  const aPool = benchPool(1);
  const bPool = benchPool(1);
  const sweeperPool = benchPool(1);
  const counters = new Counters();
  try {
    await resetBenchTables(admin);
    const a = drizzle(aPool);
    const b = drizzle(bPool);
    const sweeper = drizzle(sweeperPool);
    const start = performance.now();
    for (let scenario = 0; scenario < config.scenarios; scenario += 1) {
      try {
        await runScenario(scenario, admin, a, b, sweeper, counters);
      } catch (error) {
        counters.unexpected(scenario, `threw ${String(error)}`);
      }
    }
    const seconds = (performance.now() - start) / 1000;
    const staleAttempts = Object.values(counters.attempts)
      .flatMap((byOperation) => Object.values(byOperation))
      .reduce((sum, value) => sum + value, 0);
    const byOperation = (operation: Operation) =>
      Object.values(counters.attempts).reduce((sum, phase) => sum + phase[operation], 0);
    return {
      config: { ...config, aLeaseMs: A_LEASE_MS, variants: "worker-id reuse on odd scenarios; concurrent stale/successor completion on every other pair" },
      scenariosAttempted: config.scenarios,
      recoveriesCompleted: counters.recoveriesCompleted,
      reassignmentsCompleted: counters.reassignmentsCompleted,
      successorCompletions: counters.successorCompletions,
      liveRenewalsSucceeded: counters.liveRenewalsSucceeded,
      staleAttemptsTotal: staleAttempts,
      staleRenewalAttempts: byOperation("renewal"),
      staleCompletionAttempts: byOperation("completion"),
      staleFailureReportAttempts: byOperation("failureReport"),
      staleAttemptsByPhase: counters.attempts,
      staleWritesAccepted: counters.staleWritesAccepted,
      staleRejectionsThatChangedTheRow: counters.staleRejectionsWithRowChange,
      // Final row and exact event history per scenario (see runScenario).
      scenariosWithFinalStateCorruption: counters.finalStateCorruption,
      unexpectedFailures: counters.unexpectedFailures,
      unexpectedSamples: counters.unexpectedSamples,
      wallSeconds: round(seconds, 2),
    };
  } finally {
    await Promise.all([admin.end(), aPool.end(), bPool.end(), sweeperPool.end()]);
  }
}
