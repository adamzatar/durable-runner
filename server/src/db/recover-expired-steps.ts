import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";

export interface RecoveredStep {
  id: string;
  // The generation whose lease expired. Preserved on the row, so the next
  // claim produces leaseVersion + 1.
  leaseVersion: number;
  status: "READY" | "DEAD_LETTERED";
}

type RecoveredRow = {
  id: string;
  lease_version: number;
  status: "READY" | "DEAD_LETTERED";
};

/**
 * Resolves up to 100 unlocked, expired RUNNING steps per sweep: READY if
 * attempt budget remains, DEAD_LETTERED if the final claimed attempt expired.
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
 * step claimable while budget remains. After reclaim, the old version rejects stale renewal or
 * completion even if the worker ID is reused and the new deadline is live
 * (renew-step-lease.ts, complete-step.ts).
 *
 * Effects on a recovered row: status READY or DEAD_LETTERED, owner and
 * lease_expires_at cleared. Neither counter changes — recovery ends a
 * generation, it does not create one; the next successful claim
 * increments it. Payload, result and last_error are untouched: expiry is
 * evidence of lost authority, not an observed executor exception.
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
  transitionStepStatus("RUNNING", "DEAD_LETTERED");

  // One statement, so the sweep's state changes and their events commit
  // together while keeping the bounded SKIP LOCKED batch. Wrapping the
  // UPDATE and a separate event INSERT in a client-side transaction would
  // also be atomic, but would hold every recovered row's lock across an
  // extra client round trip, which is exactly what a sweep should not do.
  //
  // `expired` captures current_worker_id BEFORE the UPDATE clears it, so
  // LEASE_RECOVERED names the owner that actually lost authority rather than
  // the NULL the row ends up with. Rows another sweeper has locked are
  // skipped here and get no event; whichever sweep actually recovers them
  // later writes the one event for that transition.
  const recovered = await db.execute<RecoveredRow>(sql`
    with expired as (
      select id, current_worker_id
      from steps
      where status = 'RUNNING'
        and lease_expires_at <= clock_timestamp()
      order by lease_expires_at asc, id asc
      limit 100
      for update skip locked
    ),
    resolved as (
      update steps
      set status = case when attempt_count < max_attempts
                        then 'READY'::step_status else 'DEAD_LETTERED'::step_status end,
          current_worker_id = null,
          lease_expires_at = null,
          updated_at = now()
      from expired
      where steps.id = expired.id
      returning steps.id, steps.lease_version, steps.attempt_count, steps.status,
                expired.current_worker_id as previous_worker_id
    ),
    events as (
      insert into step_events (step_id, worker_id, event_type, data, created_at)
      select resolved.id,
             resolved.previous_worker_id,
             case when resolved.status = 'READY' then 'LEASE_RECOVERED' else 'STEP_DEAD_LETTERED' end,
             jsonb_build_object(
               'leaseVersion', resolved.lease_version,
               'attemptCount', resolved.attempt_count,
               'previousWorkerId', resolved.previous_worker_id
             ) || case when resolved.status = 'READY' then '{}'::jsonb
                       else jsonb_build_object('reason', 'lease_expired_attempt_budget_exhausted') end,
             clock_timestamp()
      from resolved
      returning step_id
    )
    select resolved.id, resolved.lease_version, resolved.status
    from resolved
    join events on events.step_id = resolved.id
  `);

  return recovered.rows.map((row) => ({ id: row.id, leaseVersion: row.lease_version, status: row.status }));
}
