import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { abortableSleep } from "../abortable-sleep.js";
import { STEP_LEASE_DURATION_MS, claimNextStep } from "../db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../db/complete-step.js";
import { renewStepLease } from "../db/renew-step-lease.js";
import { executeStep } from "./execute-step.js";

// Fixed-interval polling, no LISTEN/NOTIFY. Small enough to feel responsive
// in a demo, large enough that an idle worker isn't hammering Postgres in a
// busy loop.
export const WORKER_POLL_INTERVAL_MS = 500;

// How often a worker renews the lease on the step it is executing, relative
// to STEP_LEASE_DURATION_MS (30s). Every successful renewal pushes the
// deadline to (database clock + 30s), leaving several renewal opportunities
// under ordinary database/event-loop latency. Failures and write delays
// consume that margin; the interval is not a failure-tolerance bound.
// Renewing at 25s of a 30s lease would leave less room for a slow or failed
// write. The cost of the margin is one single-row renewal transaction per
// interval per busy worker.
//
// Healthy-path estimate only: with a recent successful renewal, a 30s
// lease, 5s renewal cadence, 1s recovery sweep, and ordinary database/event-
// loop latency, expiry is roughly 25-30s after a crash. Recovery/reclaim
// then takes roughly another sweep plus poll interval if the row is unlocked
// and fits in the next batch. This is not a universal upper or lower bound.
export const STEP_LEASE_RENEWAL_INTERVAL_MS = 5_000;

export interface WorkerLoopOptions {
  pollIntervalMs?: number;
  // Both default to the production constants above. Injectable so tests
  // can prove renewal and expiry with sub-second leases; production and the
  // demos use the real values.
  leaseDurationMs?: number;
  leaseRenewalIntervalMs?: number;
  signal: AbortSignal;
  // Injectable for tests/logging; defaults to console.log/error so the
  // real process entrypoint needs no extra wiring.
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}

interface LeaseRenewal {
  // Stops renewing and resolves once no renewal write is in flight.
  stop(): Promise<void>;
}

/**
 * Renews one ownership generation (step id + worker + lease_version) every
 * `intervalMs` until stopped or until a renewal is rejected.
 *
 * Renews exactly the step this loop claimed, not "every step whose
 * current_worker_id is mine". Worker IDs are reused across restarts (the
 * demo runs fixed IDs like "worker-b"), so a blanket renewal keyed on
 * worker ID would let a restarted process keep its crashed predecessor's
 * step leased forever. It would also keep renewing a step whose executor
 * has already thrown.
 *
 * Sequential, not setInterval: each renewal write is awaited before the
 * next wait begins, so renewals can't overlap each other. `stop()` waits
 * for an in-flight renewal to finish, which is what lets the worker loop
 * guarantee no renewal of this step is running when it attempts
 * completion.
 *
 * A rejected renewal (zero rows) ends the loop for good: that generation
 * cannot become renewable again. A thrown error (connection failure, etc.)
 * is logged and retried next tick — the outcome is unknown, and the lease
 * deadline, not this loop, decides whether the worker still has time.
 *
 * Timer-based, so it only runs while the Node event loop is free. The
 * current executor waits asynchronously, which keeps it free. Code that
 * blocks the event loop for longer than the lease prevents renewal and
 * loses the lease; nothing here protects against that.
 */
function startLeaseRenewal<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  params: {
    stepId: string;
    workerId: string;
    leaseVersion: number;
    leaseDurationMs: number;
    intervalMs: number;
    log: (message: string) => void;
    logError: (message: string, error: unknown) => void;
  },
): LeaseRenewal {
  const controller = new AbortController();
  const { stepId, workerId, leaseVersion } = params;

  const done = (async () => {
    while (!controller.signal.aborted) {
      await abortableSleep(params.intervalMs, controller.signal);
      if (controller.signal.aborted) return;
      try {
        const result = await renewStepLease(db, {
          id: stepId,
          workerId,
          leaseVersion,
          leaseDurationMs: params.leaseDurationMs,
        });
        if (!result.renewed) {
          params.log(
            `[${workerId}] lease renewal rejected for step ${stepId} at lease_version ${leaseVersion}: ` +
              `lease expired or ownership lost; renewal stopped`,
          );
          return;
        }
      } catch (error) {
        params.logError(`[${workerId}] lease renewal write failed for step ${stepId}; will retry`, error);
      }
    }
  })();

  return {
    async stop() {
      controller.abort();
      await done;
    },
  };
}

/**
 * One worker's claim/execute/complete loop, with lease renewal while
 * executing.
 *
 * At most one claimed step is active at a time: the loop is a sequential
 * await chain, never fired concurrently within itself. Running more work
 * at once means running more of these loops (more worker processes), not
 * making one loop juggle multiple claims.
 *
 * Per claimed step:
 *   1. claim (starts a lease generation, deadline = db clock + lease)
 *   2. start renewing that generation
 *   3. execute
 *   4. stop renewing, waiting out any in-flight renewal write
 *   5. attempt guarded completion, unless the executor threw
 *
 * The worker never decides from its own clock whether it still owns the
 * step. Step 5 is attempted even if a renewal was rejected along the way;
 * the completion predicate (generation + unexpired lease, evaluated by
 * PostgreSQL) is the authority, and it will reject the write.
 *
 * Shutdown is checked between iterations only, never in the middle of an
 * executing step: `signal` being aborted stops the loop from starting a
 * new claim (or ends an idle poll wait early), but a step already claimed
 * always runs to its execute/complete attempt first — and its lease keeps
 * being renewed while it does, since renewal is not tied to `signal`.
 *
 * Failure cases, all logged with the loop moving on to the next iteration.
 * None of them retries, backs off, resets the step, or changes
 * lease_version from this worker:
 *
 * - executeStep throws: renewal stops, no completion write is made. The
 *   step stays RUNNING under this worker until its lease expires, then the
 *   recovery sweep returns it to READY and it can run again. With no
 *   attempt budget yet, a step whose executor always throws will cycle
 *   like this indefinitely.
 * - completeStepSuccess throws CompletionConsistencyError: the UPDATE
 *   matched zero rows and made no mutation. This worker's lease on that
 *   generation had expired, or the step had already been recovered (and
 *   possibly reclaimed), completed, or never matched.
 * - completeStepSuccess throws anything else (e.g. a connection error):
 *   this worker cannot tell whether the write committed.
 *
 * See docs/architecture.md.
 */
export async function runWorkerLoop<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
  options: WorkerLoopOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? WORKER_POLL_INTERVAL_MS;
  const leaseDurationMs = options.leaseDurationMs ?? STEP_LEASE_DURATION_MS;
  const leaseRenewalIntervalMs = options.leaseRenewalIntervalMs ?? STEP_LEASE_RENEWAL_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const { signal } = options;

  while (!signal.aborted) {
    const result = await claimNextStep(db, workerId, { leaseDurationMs });

    if (!result.claimed) {
      await abortableSleep(pollIntervalMs, signal);
      continue;
    }

    const { step } = result;
    log(`[${workerId}] claimed step ${step.id} (${step.taskType}) at lease_version ${step.leaseVersion}`);

    const renewal = startLeaseRenewal(db, {
      stepId: step.id,
      workerId,
      leaseVersion: step.leaseVersion,
      leaseDurationMs,
      intervalMs: leaseRenewalIntervalMs,
      log,
      logError,
    });

    let execution: { ok: true; output: Record<string, unknown> } | { ok: false; error: unknown };
    try {
      const pendingExecution = executeStep(step);
      // Emitted after invoking the executor: the fencing demo can pause
      // this process with its original delay already underway.
      log(`[${workerId}] execution started for step ${step.id} at lease_version ${step.leaseVersion}`);
      execution = { ok: true, output: await pendingExecution };
    } catch (error) {
      execution = { ok: false, error };
    }

    // Stop renewing before acting on the outcome, whichever it is. On
    // failure, a renewal left running would keep a failed step leased
    // forever; on success, waiting here means no renewal of this step is
    // in flight while completion runs.
    await renewal.stop();

    if (!execution.ok) {
      logError(
        `[${workerId}] step ${step.id} execution failed; renewal stopped, no completion attempted ` +
          `(step stays RUNNING until its lease expires and recovery returns it to READY)`,
        execution.error,
      );
      continue;
    }

    try {
      await completeStepSuccess(db, {
        id: step.id,
        workerId,
        leaseVersion: step.leaseVersion,
        result: execution.output,
      });
      log(`[${workerId}] completed step ${step.id} at lease_version ${step.leaseVersion}: ${JSON.stringify(execution.output)}`);
    } catch (error) {
      if (error instanceof CompletionConsistencyError) {
        logError(
          `[${workerId}] step ${step.id} completion rejected at lease_version ${step.leaseVersion} ` +
            `(no live lease on that generation), no mutation made`,
          error,
        );
      } else {
        logError(`[${workerId}] step ${step.id} completion write failed; outcome unknown to this worker`, error);
      }
    }
  }
}
