import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";
import { recordStepEvent } from "./step-events.js";

// Thrown when the completion write did not affect exactly one row. Unlike
// ClaimConsistencyError, this can mean several different things (lease
// expired, step recovered, wrong worker, stale lease_version, step already
// terminal, step doesn't exist) and the predicate can't tell them apart
// after the fact — it only proves this worker no longer holds a live lease
// on the ownership generation it claimed with. That's enough to reject the
// write; diagnosing which case it was is not needed to do that safely.
//
// Since Milestone 5 this is an expected outcome for a worker that failed to
// renew its lease in time, not only a sign of a bug.
export class CompletionConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionConsistencyError";
  }
}

export interface CompleteStepSuccessParams {
  id: string;
  workerId: string;
  leaseVersion: number;
  result: Record<string, unknown>;
}

/**
 * Persists RUNNING -> SUCCEEDED for a step this worker still holds a live
 * lease on.
 *
 * One atomic UPDATE whose predicate has two parts that do different jobs:
 *
 * - Ownership generation: status = 'RUNNING' AND current_worker_id =
 *   $workerId AND lease_version = $leaseVersion. If the step has been
 *   recovered and reclaimed, lease_version no longer matches and this
 *   write affects zero rows instead of overwriting the new owner. That is
 *   the fencing check. It stops a stale writer from recording completion,
 *   not from having already performed a side effect (idempotency's job,
 *   not built yet). Milestone 6 exercises the full expiry/recovery/reclaim
 *   sequence, including worker-ID reuse, in fencing.test.ts.
 * - Lease authority: lease_expires_at > clock_timestamp(). Once the
 *   database clock reaches the deadline, this generation can no longer
 *   complete, whether or not the recovery sweep has run. The deadline,
 *   not the sweeper's schedule, is where the owner's authority ends; the
 *   sweeper only decides how soon the step becomes claimable again. The
 *   cost is that work finishing after its lease expired but before
 *   recovery is discarded and runs again — accepted under at-least-once
 *   execution. See docs/decisions/0001-lease-deadline-is-authority.md.
 *
 * The two parts are not redundant. After a reclaim, lease_expires_at is
 * the NEW owner's live deadline, so the time check alone would pass for a
 * stale owner. With a reused worker ID, only the version check rejects it.
 * Before any recovery, the generation check alone would pass for an owner whose
 * lease has expired; only the time check rejects it.
 *
 * Same transaction shape as renewStepLease, for the same reason (see the
 * full explanation in renew-step-lease.ts):
 *
 *   BEGIN
 *   1. SELECT id FROM steps WHERE id = $id FOR UPDATE   -- lock only
 *   2. UPDATE ... SET status = 'SUCCEEDED', result, ownership cleared
 *        WHERE id AND status AND owner AND version
 *          AND lease_expires_at > clock_timestamp()     -- authorization
 *   COMMIT
 *
 * A single UPDATE would evaluate the deadline before discovering the row
 * is locked; if the holder only locked it and never modified it,
 * PostgreSQL would not re-evaluate after the wait, and a completion that
 * checked "still live" before the deadline could commit SUCCEEDED for an
 * expired generation. Locking first means the authorizing evaluation
 * always happens after any lock wait. clock_timestamp() rather than now(),
 * which inside this transaction is fixed at BEGIN, before that wait.
 *
 * Clears current_worker_id and lease_expires_at on success: a terminal
 * step is not actively owned by anyone. lease_version is preserved,
 * never reset, so it keeps meaning "the number of ownership generations
 * this step has gone through" even after the step is done.
 */
export async function completeStepSuccess<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  params: CompleteStepSuccessParams,
): Promise<void> {
  // Static check, not a query against the row's actual prior state: the
  // WHERE clause below already hardcodes status = 'RUNNING', so this only
  // confirms RUNNING -> SUCCEEDED is a legal transition shape before the
  // write is attempted, the same way claimNextStep routes READY -> RUNNING
  // through this table instead of asserting it inline.
  transitionStepStatus("RUNNING", "SUCCEEDED");

  const updatedCount = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select id from steps where id = ${params.id} for update
    `);
    if (locked.rows.length === 0) {
      return 0;
    }

    const updated = await tx.execute<{ id: string; lease_version: number; attempt_count: number }>(sql`
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
    // A zero-row result is returned rather than thrown here, so the
    // transaction commits (releasing the lock, having written nothing)
    // and the rejection is raised outside it. A rejected stale completion
    // therefore records NO event: nothing transitioned.
    const row = updated.rows[0];
    if (row) {
      await recordStepEvent(tx, {
        stepId: row.id,
        workerId: params.workerId,
        eventType: "STEP_SUCCEEDED",
        data: { leaseVersion: row.lease_version, attemptCount: row.attempt_count },
      });
    }
    return updated.rows.length;
  });

  if (updatedCount !== 1) {
    throw new CompletionConsistencyError(
      `completion of step ${params.id} for worker ${params.workerId} at lease_version ${params.leaseVersion} ` +
        `updated ${updatedCount} rows, expected exactly 1`,
    );
  }
}
