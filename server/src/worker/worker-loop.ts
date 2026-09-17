import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { claimNextStep } from "../db/claim-step.js";
import { CompletionConsistencyError, completeStepSuccess } from "../db/complete-step.js";
import { executeStep } from "./execute-step.js";

// Fixed-interval polling, no LISTEN/NOTIFY. Small enough to feel responsive
// in a demo, large enough that an idle worker isn't hammering Postgres in a
// busy loop.
export const WORKER_POLL_INTERVAL_MS = 500;

// Resolves after `ms`, or immediately if the signal is already aborted or
// aborts while waiting. This is what lets shutdown interrupt an idle poll
// wait instead of making SIGTERM wait out the full interval.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WorkerLoopOptions {
  pollIntervalMs?: number;
  signal: AbortSignal;
  // Injectable for tests/logging; defaults to console.log/error so the
  // real process entrypoint needs no extra wiring.
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}

/**
 * One worker's claim/execute/complete loop.
 *
 * At most one claimed step is active at a time: the loop is a sequential
 * await chain, never fired concurrently within itself. Running more work
 * at once means running more of these loops (more worker processes), not
 * making one loop juggle multiple claims.
 *
 * Shutdown is checked between iterations only, never in the middle of an
 * executing step: `signal` being aborted stops the loop from starting a
 * new claim (or ends an idle poll wait early), but a step already claimed
 * always runs to its execute/complete attempt first.
 *
 * Two distinct unexpected-error cases, both logged with the loop moving on
 * to the next iteration — neither retries, backs off, resets to READY, or
 * changes lease_version:
 *
 * - executeStep throws: this worker makes no completion write at all. With
 *   no lease-expiry recovery yet, nothing else can act on the step either,
 *   so it stays RUNNING until recovery exists.
 * - completeStepSuccess throws CompletionConsistencyError: its UPDATE
 *   matched zero rows and made no mutation - this worker's ownership-
 *   generation predicate was rejected. That does NOT mean the row is
 *   still RUNNING under this worker: once reclaim/lease-expiry recovery
 *   exist, a zero-row match could mean another worker had already
 *   reclaimed or completed the step by then. With no reclaim path built
 *   yet, this case is not expected in normal operation today.
 *
 * See docs/architecture.md.
 */
export async function runWorkerLoop<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
  options: WorkerLoopOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? WORKER_POLL_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const { signal } = options;

  while (!signal.aborted) {
    const result = await claimNextStep(db, workerId);

    if (!result.claimed) {
      await sleep(pollIntervalMs, signal);
      continue;
    }

    const { step } = result;
    log(`[${workerId}] claimed step ${step.id} (${step.taskType})`);

    try {
      const output = await executeStep(step);
      await completeStepSuccess(db, {
        id: step.id,
        workerId,
        leaseVersion: step.leaseVersion,
        result: output,
      });
      log(`[${workerId}] completed step ${step.id}: ${JSON.stringify(output)}`);
    } catch (error) {
      // See the function doc comment above for why these two cases are
      // logged differently and neither is treated as a retry/reset signal.
      if (error instanceof CompletionConsistencyError) {
        logError(`[${workerId}] step ${step.id} completion rejected, no mutation made`, error);
      } else {
        logError(`[${workerId}] step ${step.id} execution failed, no completion attempted`, error);
      }
    }
  }
}
