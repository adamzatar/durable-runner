import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";
import { recordStepEvent, truncateEventError } from "./step-events.js";

export interface RecordStepFailureParams {
  id: string;
  workerId: string;
  leaseVersion: number;
  error: string;
  retryable: boolean;
}

type FailureRow = {
  status: "RETRY_WAIT" | "DEAD_LETTERED";
  attempt_count: number;
  lease_version: number;
  available_at: string;
  decided_at: string;
};

export type RecordStepFailureResult =
  | { recorded: false }
  | { recorded: true; status: FailureRow["status"]; attemptCount: number; leaseVersion: number;
      availableAt: string; decidedAt: string };

/**
 * An observed executor failure is a policy decision by the current live
 * owner. An expired/stale owner cannot make that decision for a successor.
 *
 * Like renewal/completion: READ COMMITTED, lock by ID only, then authorize
 * in a separate statement. The row cannot change while this transaction
 * computes the budget decision. A lock-only wait cannot preserve a stale
 * pre-wait time check. Zero updated rows means no policy decision or write.
 *
 * The materialized one-row clock CTE is evaluated in the second statement,
 * after acquiring the lock. It supplies one scheduling timestamp, returned
 * for precise backoff verification without process-clock assumptions. The
 * authorization predicate still checks clock_timestamp() itself.
 */
export async function recordStepFailure<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>, params: RecordStepFailureParams,
): Promise<RecordStepFailureResult> {
  transitionStepStatus("RUNNING", "RETRY_WAIT");
  transitionStepStatus("RUNNING", "DEAD_LETTERED");
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from steps where id = ${params.id} for update`);
    if (locked.rows.length === 0) return { recorded: false } as const;
    const updated = await tx.execute<FailureRow>(sql`
      with decision_clock as materialized (select clock_timestamp() as decided_at)
      update steps
      set status = case when ${params.retryable} and attempt_count < max_attempts
                        then 'RETRY_WAIT'::step_status else 'DEAD_LETTERED'::step_status end,
          current_worker_id = null,
          lease_expires_at = null,
          last_error = ${params.error},
          available_at = case when ${params.retryable} and attempt_count < max_attempts
                              then decision_clock.decided_at +
                                (500 * power(2, least(greatest(attempt_count - 1, 0), 3)))::int * interval '1 millisecond'
                              else steps.available_at end,
          updated_at = now()
      from decision_clock
      where steps.id = ${params.id}
        and status = 'RUNNING'
        and current_worker_id = ${params.workerId}
        and lease_version = ${params.leaseVersion}
        and lease_expires_at > clock_timestamp()
      returning status, attempt_count, lease_version, available_at::text, decision_clock.decided_at::text
    `);
    const row = updated.rows[0];
    // Rejected (expired or stale) failure reports change nothing and are not
    // transitions, so they record no event.
    if (!row) return { recorded: false } as const;

    // One event per transition, chosen by the status the UPDATE actually
    // produced rather than by re-deriving the budget decision here.
    await recordStepEvent(tx, {
      stepId: params.id,
      workerId: params.workerId,
      eventType: row.status === "RETRY_WAIT" ? "STEP_RETRY_SCHEDULED" : "STEP_DEAD_LETTERED",
      data:
        row.status === "RETRY_WAIT"
          ? {
              leaseVersion: row.lease_version,
              attemptCount: row.attempt_count,
              availableAt: row.available_at,
              error: truncateEventError(params.error),
            }
          : {
              leaseVersion: row.lease_version,
              attemptCount: row.attempt_count,
              reason: params.retryable ? "attempt_budget_exhausted" : "non_retryable_failure",
              error: truncateEventError(params.error),
            },
    });

    return {
      recorded: true, status: row.status, attemptCount: row.attempt_count,
      leaseVersion: row.lease_version, availableAt: row.available_at, decidedAt: row.decided_at,
    } as const;
  });
}
