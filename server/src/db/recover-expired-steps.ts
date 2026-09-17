import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";

export interface RecoveredStep {
  id: string;
  // The generation whose lease expired. Preserved on the row, so the next
  // claim produces leaseVersion + 1.
  leaseVersion: number;
}

type RecoveredRow = {
  id: string;
  lease_version: number;
};

/**
 * Returns up to 100 unlocked, expired RUNNING steps to READY per sweep.
 *
 * This is the only code path that performs RUNNING -> READY. The lifecycle
 * table allows that edge's shape; this statement's WHERE clause is what
 * authorizes it at runtime, by requiring that the lease deadline has
 * actually been reached on the database clock. There is intentionally no
 * general "set status" function a caller could use to reset a live step.
 *
 * Inputs to the decision are the step row and the database clock, nothing
 * else. In particular the owner's heartbeat in `workers` is not consulted:
 * a stale heartbeat is suspicion that the worker is gone, not proof, and a
 * fresh heartbeat does not mean the worker is still maintaining this
 * particular step. Only the lease deadline carries authority.
 *
 * Expiry does not mean the old owner is dead. It may be frozen, paused, or
 * partitioned from PostgreSQL and resume later. The deadline already ends
 * its authority before recovery; recovery clears ownership and makes the
 * step claimable. After reclaim, the old version rejects stale renewal or
 * completion even if the worker ID is reused and the new deadline is live
 * (renew-step-lease.ts, complete-step.ts).
 *
 * Effects on a recovered row: status READY, current_worker_id and
 * lease_expires_at cleared. lease_version is NOT changed — recovery ends a
 * generation, it does not create one; the next successful claim
 * increments it. Payload and result are untouched.
 *
 * One statement: the candidate SELECT locks expired rows with FOR UPDATE
 * SKIP LOCKED, and the UPDATE changes only those locked candidates. The
 * locks remain held until the statement's transaction ends. A locked row
 * does not stall recovery of unrelated rows; later sweeps can revisit it.
 *
 * - vs. an owner write: skip its locked row. If it commits before candidate
 *   locking, PostgreSQL checks/rechecks the committed row. A renewal excludes
 *   the row only while its new deadline is still unexpired at that check;
 *   a delayed transaction can commit a deadline that has already expired.
 *   A completed row fails the RUNNING predicate.
 * - vs. another sweeper: skip its locked candidates, or reject its committed
 *   READY rows when checking/rechecking status. No leader election is needed.
 *
 * `<= clock_timestamp()` is the exact complement of the owner-side
 * `> clock_timestamp()` checks, so at any one instant a lease is either
 * still the owner's or recoverable, never both.
 * Both owner authority and recovery assume PostgreSQL wall time does not
 * jump backward across an expired deadline before recovery durably changes
 * the row.
 *
 * Only actively executing steps are bounded by worker loops. Failed or
 * abandoned executions can leave additional RUNNING rows until recovery,
 * so each sweep bounds its writes to 100. SKIP LOCKED covers row locks,
 * not table locks or all other possible database delays.
 */
export async function recoverExpiredSteps<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
): Promise<RecoveredStep[]> {
  // Static shape check, same pattern as completeStepSuccess: the WHERE
  // clause hardcodes status = 'RUNNING', so this confirms RUNNING -> READY
  // is a legal lifecycle edge before any row is written.
  transitionStepStatus("RUNNING", "READY");

  const recovered = await db.execute<RecoveredRow>(sql`
    with expired as (
      select id
      from steps
      where status = 'RUNNING'
        and lease_expires_at <= clock_timestamp()
      order by lease_expires_at asc, id asc
      limit 100
      for update skip locked
    )
    update steps
    set status = 'READY',
        current_worker_id = null,
        lease_expires_at = null,
        updated_at = now()
    from expired
    where steps.id = expired.id
    returning steps.id, steps.lease_version
  `);

  return recovered.rows.map((row) => ({ id: row.id, leaseVersion: row.lease_version }));
}
