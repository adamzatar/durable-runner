import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { abortableSleep } from "../abortable-sleep.js";
import { recoverExpiredSteps } from "../db/recover-expired-steps.js";
import { promoteDueRetries } from "../db/promote-due-retries.js";

// How often the coordinator looks for expired leases. This affects
// liveness only — how long an expired step sits RUNNING before it is
// claimable again — never safety: an owner's authority ends at its lease
// deadline whether or not a sweep has happened (see complete-step.ts and
// renew-step-lease.ts). With the partial index on RUNNING rows, a sweep
// that finds nothing need not scan terminal rows and writes nothing.
// Each sweep recovers at most 100 unlocked expired rows. RUNNING rows can
// exceed worker count when failed/abandoned executions await recovery.
export const RECOVERY_SWEEP_INTERVAL_MS = 1_000;

export interface RecoveryLoopOptions {
  intervalMs?: number;
  signal: AbortSignal;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}

/**
 * Sweeps expired leases back to READY every `intervalMs` until `signal`
 * aborts.
 *
 * No leader election, advisory lock, or "am I the only coordinator" check:
 * the recovery UPDATE is safe to run concurrently with itself, so running
 * two of these would duplicate effort, not corrupt state. One is run.
 *
 * A failed sweep is logged and retried next tick. Its statement either
 * committed or rolled back entirely; there is no partially-recovered batch.
 */
export async function runRecoveryLoop<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  options: RecoveryLoopOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const { signal } = options;

  while (!signal.aborted) {
    try {
      const recovered = await recoverExpiredSteps(db);
      for (const step of recovered) {
        log(
          `[coordinator] lease expired on step ${step.id} at lease_version ${step.leaseVersion}; ` +
            `RUNNING -> ${step.status} ` +
            (step.status === "DEAD_LETTERED" ? "(attempt budget exhausted)" : "(previous owner may still be running)"),
        );
      }
    } catch (error) {
      logError("[coordinator] recovery sweep failed; will retry", error);
    }
    // Separate statements and error handling: a failed recovery sweep must
    // not prevent due retries from becoming claimable (or vice versa).
    try {
      const promoted = await promoteDueRetries(db);
      for (const step of promoted) {
        log(`[coordinator] step ${step.id} RETRY_WAIT -> READY at attempt_count ${step.attemptCount}, lease_version ${step.leaseVersion}`);
      }
    } catch (error) {
      logError("[coordinator] retry promotion failed; will retry", error);
    }
    await abortableSleep(intervalMs, signal);
  }
}
