import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";

// Thrown when the completion write did not affect exactly one row. Unlike
// ClaimConsistencyError, this can mean several different things (wrong
// worker, stale lease_version, step already terminal, step doesn't exist)
// and the predicate can't tell them apart after the fact — it only proves
// this worker no longer matches the ownership generation it claimed with.
// That's enough to reject the write; diagnosing which case it was is not
// needed to do that safely.
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
 * Persists RUNNING -> SUCCEEDED for a step this worker still owns.
 *
 * The ownership-generation predicate (status = 'RUNNING' AND
 * current_worker_id = $workerId AND lease_version = $leaseVersion) is one
 * atomic UPDATE, so there is no read-then-write gap for another writer to
 * land in between. If another worker had already reclaimed this step
 * (which cannot yet happen — no lease-expiry recovery exists in this
 * milestone, so no second claim of a RUNNING step is currently possible),
 * lease_version would no longer match and this write would affect zero
 * rows instead of overwriting that worker's ownership. That is fencing:
 * it stops a stale writer from recording completion, not from having
 * already performed a side effect (idempotency's job, not built yet).
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

  const updated = await db.execute(sql`
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
    returning id
  `);

  if (updated.rows.length !== 1) {
    throw new CompletionConsistencyError(
      `completion of step ${params.id} for worker ${params.workerId} at lease_version ${params.leaseVersion} ` +
        `updated ${updated.rows.length} rows, expected exactly 1`,
    );
  }
}
