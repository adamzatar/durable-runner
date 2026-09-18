import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { transitionStepStatus } from "../domain/step-transitions.js";

/**
 * The retry decision was already made by recordStepFailure. This operation
 * only makes due work claimable. It does not reconsider the budget or claim
 * ownership. Locked candidates are skipped, preserving unrelated progress.
 * Selected row locks last through the UPDATE; concurrent promoters cannot
 * promote the same row twice. PostgreSQL wall-clock assumptions match recovery.
 */
export async function promoteDueRetries<TSchema extends Record<string, unknown>>(db: NodePgDatabase<TSchema>) {
  transitionStepStatus("RETRY_WAIT", "READY");
  // Single statement for the same reason as recovery: the promotion and its
  // RETRY_READY event commit together, the batch stays bounded, and locked
  // rows are still skipped rather than waited on. A row skipped here gets no
  // event now and exactly one when a later sweep promotes it, so concurrent
  // promoters cannot both record the same transition.
  const result = await db.execute<{ id: string; lease_version: number; attempt_count: number }>(sql`
    with due as (
      select id from steps
      where status = 'RETRY_WAIT' and available_at <= clock_timestamp()
      order by available_at asc, id asc
      limit 100
      for update skip locked
    ),
    promoted as (
      update steps set status = 'READY', updated_at = now()
      from due where steps.id = due.id
      returning steps.id, steps.lease_version, steps.attempt_count
    ),
    events as (
      insert into step_events (step_id, worker_id, event_type, data, created_at)
      select promoted.id,
             null::text,
             'RETRY_READY',
             jsonb_build_object('leaseVersion', promoted.lease_version, 'attemptCount', promoted.attempt_count),
             clock_timestamp()
      from promoted
      returning step_id
    )
    select promoted.id, promoted.lease_version, promoted.attempt_count
    from promoted
    join events on events.step_id = promoted.id
  `);
  return result.rows.map((row) => ({ id: row.id, leaseVersion: row.lease_version, attemptCount: row.attempt_count }));
}
