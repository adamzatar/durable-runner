import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { claimNextStep } from "../server/src/db/claim-step.js";
import {
  applyIdempotentEffect, DEMO_EFFECT_TYPE, IdempotencyConflictError,
} from "../server/src/db/idempotent-effect.js";
import { recoverExpiredSteps } from "../server/src/db/recover-expired-steps.js";
import { executeStep, stepEffectKey } from "../server/src/worker/execute-step.js";
import { runWorkerLoop } from "../server/src/worker/worker-loop.js";
import { benchPool, resetBenchTables, round, settleBenchTables, waitFor } from "./common.js";

// Repeated and concurrent execution of idempotent_effect steps against
// stable, step-derived idempotency keys (step:<uuid>:demo_receipt), using the
// production executor, effect store, claim, recovery and worker loop.
//
// Phase 1 — duplicate concurrent execution, then loss of ownership:
//   each step is claimed (generation 1, short lease) and the production
//   executor is invoked `concurrentExecutions` times at once for it, each
//   invocation on its own PostgreSQL session, so the first application of
//   every key is a real insert race. The claimant then abandons the step
//   without completing it: the effect is durable, the step outcome is not.
//   This is the window idempotency exists for. The concurrency is injected
//   by the harness; in normal operation overlapping executions come from a
//   stale owner still running after its lease was recovered and reclaimed.
// Phase 2 — the leases expire on the database clock; the production
//   recovery sweep returns every step to READY.
// Phase 3 — conflicting reuse: each key is presented once with a different
//   request, which must be rejected without touching the stored effect.
// Phase 4 — re-execution by unmodified worker loops (logical loops in this
//   process, each with its own pool): generation 2 runs the executor again,
//   receives the stored effect, and completes the step.
//
// This demonstrates at most one durable effect per logical key under
// at-least-once execution. It does not make execution exactly-once: the
// executor demonstrably runs many times per step.

const GEN1_LEASE_MS = 200;

export interface IdempotencyConfig {
  logicalKeys: number;
  concurrentExecutions: number;
  claimLoops: number;
  workerLoops: number;
}

type Observation = { applied: boolean; effectId: string };

async function effectFingerprint(admin: Pool): Promise<string> {
  const result = await admin.query<{ fingerprint: string | null }>(
    `select md5(string_agg(idempotency_key || effect_type || request::text || result::text || created_at::text, '|'
                           order by idempotency_key)) as fingerprint
     from idempotent_effects`,
  );
  return result.rows[0]!.fingerprint ?? "";
}

export async function runIdempotency(config: IdempotencyConfig) {
  const admin = benchPool(1);
  const pools: Pool[] = [admin];
  const newPool = () => { const pool = benchPool(1); pools.push(pool); return pool; };
  try {
    await resetBenchTables(admin);
    await admin.query(
      `insert into steps (id, status, priority, available_at, max_attempts, task_type, payload)
       select gen_random_uuid(), 'READY', 0, clock_timestamp() - interval '1 second', 3, 'idempotent_effect',
              jsonb_build_object('value', 'idem-' || g, 'delayAfterEffectMs', 0)
       from generate_series(1, $1::int) g`,
      [config.logicalKeys],
    );
    await settleBenchTables(admin);
    {
      // Fail fast on a short fixture rather than stressing whatever is left.
      const count = await admin.query<{ n: number }>("select count(*)::int as n from steps");
      if (count.rows[0]!.n !== config.logicalKeys) {
        throw new Error(`fixture should hold exactly ${config.logicalKeys} steps, found ${count.rows[0]!.n}: the benchmark database was modified by something else`);
      }
    }
    const start = performance.now();

    // --- phase 1 ---------------------------------------------------------
    const observations = new Map<string, Observation[]>();
    let phase1Executions = 0;
    let phase1ExecutorErrors = 0;
    let phase1Claims = 0;
    const errorSamples: string[] = [];
    const claimLoops = Array.from({ length: config.claimLoops }, async (_, loopIndex) => {
      const claimDb = drizzle(newPool());
      const executorDbs = Array.from({ length: config.concurrentExecutions }, () => drizzle(newPool()));
      for (;;) {
        const claim = await claimNextStep(claimDb, `idem-gen1-${loopIndex + 1}`, { leaseDurationMs: GEN1_LEASE_MS });
        if (!claim.claimed) return;
        phase1Claims += 1;
        const seen: Observation[] = [];
        observations.set(claim.step.id, seen);
        const executions = executorDbs.map((executorDb) => executeStep(claim.step, {
          applyEffect: async (request) => {
            const outcome = await applyIdempotentEffect(executorDb, request);
            seen.push({ applied: outcome.applied, effectId: outcome.result.effectId });
            return outcome;
          },
        }));
        phase1Executions += executions.length;
        const settled = await Promise.allSettled(executions);
        for (const outcome of settled) {
          if (outcome.status === "rejected") {
            phase1ExecutorErrors += 1;
            if (errorSamples.length < 5) errorSamples.push(String(outcome.reason));
          }
        }
        // Abandoned here on purpose: no completion, no failure report.
      }
    });
    await Promise.all(claimLoops);
    // Claim loops stop only when nothing is claimable, and no recovery sweep
    // runs during phase 1, so every fixture row must have been claimed
    // exactly once. Fewer claims means the phase did not run as configured.
    if (phase1Claims !== config.logicalKeys) {
      throw new Error(`phase 1 claimed ${phase1Claims} steps for ${config.logicalKeys} fixture rows`);
    }
    const effectsAfterPhase1 = await admin.query<{ n: number }>("select count(*)::int as n from idempotent_effects");

    // --- phase 2 ---------------------------------------------------------
    await waitFor("generation-1 leases expired on the database clock", async () => {
      const live = await admin.query<{ n: number }>(
        "select count(*)::int as n from steps where status = 'RUNNING' and lease_expires_at > clock_timestamp()",
      );
      return live.rows[0]!.n === 0;
    }, 30_000, 20);
    const sweeper = drizzle(newPool());
    let recovered = 0;
    for (;;) {
      const batch = await recoverExpiredSteps(sweeper);
      recovered += batch.length;
      if (batch.length === 0) break;
    }

    // --- phase 3 ---------------------------------------------------------
    const fingerprintBeforeConflicts = await effectFingerprint(admin);
    const steps = await admin.query<{ id: string; value: string }>("select id::text, payload->>'value' as value from steps");
    let conflictAttempts = 0;
    let conflictRejections = 0;
    let conflictAccepted = 0;
    const conflictDbs = Array.from({ length: config.concurrentExecutions }, () => drizzle(newPool()));
    const queue = [...steps.rows];
    await Promise.all(conflictDbs.map(async (conflictDb) => {
      for (let step = queue.pop(); step; step = queue.pop()) {
        conflictAttempts += 1;
        try {
          await applyIdempotentEffect(conflictDb, {
            idempotencyKey: stepEffectKey(step.id),
            effectType: DEMO_EFFECT_TYPE,
            request: { stepId: step.id.toLowerCase(), value: `${step.value}-conflicting` },
          });
          conflictAccepted += 1;
        } catch (error) {
          if (error instanceof IdempotencyConflictError) conflictRejections += 1;
          else throw error;
        }
      }
    }));
    const fingerprintAfterConflicts = await effectFingerprint(admin);

    // --- phase 4 ---------------------------------------------------------
    const phase4Start = await admin.query<{ t: string }>("select clock_timestamp()::text as t");
    const controller = new AbortController();
    let workerLoopErrors = 0;
    const workerLoops = Array.from({ length: config.workerLoops }, (_, index) =>
      runWorkerLoop(drizzle(newPool()), `idem-gen2-${index + 1}`, {
        signal: controller.signal,
        log: () => {},
        logError: () => { workerLoopErrors += 1; },
      }),
    );
    try {
      await waitFor("every step terminal", async () => {
        const open = await admin.query<{ n: number }>(
          "select count(*)::int as n from steps where status not in ('SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED')",
        );
        return open.rows[0]!.n === 0;
      }, 300_000, 100);
    } finally {
      controller.abort();
      await Promise.all(workerLoops);
    }
    const seconds = (performance.now() - start) / 1000;

    // --- verification -----------------------------------------------------
    let keysWithMultipleObservedEffectIds = 0;
    let keysWithoutExactlyOneApplied = 0;
    let appliedTrue = 0;
    let appliedFalse = 0;
    for (const seen of observations.values()) {
      if (new Set(seen.map((observation) => observation.effectId)).size !== 1) keysWithMultipleObservedEffectIds += 1;
      const applied = seen.filter((observation) => observation.applied).length;
      appliedTrue += applied;
      appliedFalse += seen.length - applied;
      if (applied !== 1) keysWithoutExactlyOneApplied += 1;
    }
    const observedMismatch = await admin.query<{ id: string; effect_id: string }>(
      "select replace(replace(idempotency_key, 'step:', ''), ':demo_receipt', '') as id, result->>'effectId' as effect_id from idempotent_effects",
    );
    let observedIdsDifferingFromStored = 0;
    for (const row of observedMismatch.rows) {
      const seen = observations.get(row.id) ?? [];
      if (seen.some((observation) => observation.effectId !== row.effect_id)) observedIdsDifferingFromStored += 1;
    }

    const durable = await admin.query(`
      with histories as (
        select step_id, string_agg(event_type || ':v' || (data->>'leaseVersion'), ' ' order by xid, id) as history
        from step_events group by step_id
      )
      select
        (select count(*)::int from idempotent_effects) as effect_rows,
        (select count(*)::int from (select idempotency_key from idempotent_effects group by 1 having count(*) > 1) d) as keys_with_multiple_rows,
        (select count(*)::int from idempotent_effects where created_at >= $1::timestamptz) as effects_created_in_phase4,
        (select count(*)::int from steps where status = 'SUCCEEDED') as succeeded,
        (select count(*)::int from steps s join idempotent_effects e
           on e.idempotency_key = 'step:' || s.id::text || ':demo_receipt'
         where s.status = 'SUCCEEDED' and s.result->>'effectId' = e.result->>'effectId') as results_matching_stored_effect,
        (select count(*)::int from steps s left join idempotent_effects e
           on e.idempotency_key = 'step:' || s.id::text || ':demo_receipt' where e.idempotency_key is null) as steps_without_effect,
        (select count(*)::int from steps where lease_version <> 2) as steps_not_at_generation_2,
        (select count(*)::int from histories
          where history <> 'STEP_CLAIMED:v1 LEASE_RECOVERED:v1 STEP_CLAIMED:v2 STEP_SUCCEEDED:v2') as unexpected_histories,
        (select count(*)::int from step_events where event_type = 'STEP_CLAIMED' and (data->>'leaseVersion')::int >= 2) as phase4_executions
    `, [phase4Start.rows[0]!.t]);
    const d = durable.rows[0];

    return {
      config: { ...config, gen1LeaseMs: GEN1_LEASE_MS },
      logicalEffectsRequested: config.logicalKeys,
      // Every execution of idempotent_effect makes exactly one effect call
      // with the step's own request; conflicting requests are counted apart.
      executionsTotal: phase1Executions + d.phase4_executions,
      phase1: {
        claims: phase1Claims,
        concurrentExecutions: phase1Executions,
        executorErrors: phase1ExecutorErrors,
        errorSamples,
        appliedTrue,
        appliedFalseReturnedStored: appliedFalse,
        keysWithoutExactlyOneApplied,
        keysWithMultipleObservedEffectIds,
        observedIdsDifferingFromStored,
        durableEffectsAfterPhase: effectsAfterPhase1.rows[0]!.n,
      },
      phase2: { recoveredToReady: recovered },
      phase3: {
        conflictingRequestAttempts: conflictAttempts,
        conflictingKeyRejections: conflictRejections,
        conflictingRequestsAccepted: conflictAccepted,
        storedEffectsUnchanged: fingerprintBeforeConflicts === fingerprintAfterConflicts,
      },
      phase4: {
        workerLoopExecutions: d.phase4_executions,
        effectsCreated: d.effects_created_in_phase4,
        workerLoopErrorsLogged: workerLoopErrors,
      },
      durableEffectRows: d.effect_rows,
      keysWithMoreThanOneDurableRow: d.keys_with_multiple_rows,
      duplicateLogicalEffects: d.keys_with_multiple_rows + keysWithMultipleObservedEffectIds,
      finalSucceededSteps: d.succeeded,
      stepResultsMatchingStoredEffect: d.results_matching_stored_effect,
      stepsWithoutEffect: d.steps_without_effect,
      stepsNotAtGeneration2: d.steps_not_at_generation_2,
      stepsWithUnexpectedEventHistory: d.unexpected_histories,
      wallSeconds: round(seconds, 2),
    };
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
