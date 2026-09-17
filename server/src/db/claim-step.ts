import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { parseStepStatus } from "../domain/step-status.js";
import { transitionStepStatus } from "../domain/step-transitions.js";

// How long a claim's lease runs for. The deadline is computed from the
// DATABASE clock, not the claiming process's clock, so claimers with skewed
// clocks still agree on when a lease runs out.
//
// Nothing enforces this deadline yet. No sweeper exists, an expired lease
// does not make a step claimable again, and the owning worker is not told
// when it lapses. The column records the intended deadline so that the
// recovery mechanism, when it is built, has a value to read instead of a
// backfill to perform.
export const STEP_LEASE_DURATION_MS = 30_000;

export interface ClaimedStep {
  id: string;
  status: "RUNNING";
  workerId: string;
  // The ownership generation this claim produced. A later completion write
  // will have to condition on still holding this exact version (fencing).
  // That check is not implemented yet.
  leaseVersion: number;
  leaseExpiresAt: Date;
  priority: number;
  availableAt: Date;
}

// "No work" is a first-class outcome, not an absence. A claimer that finds
// nothing has not failed and has not been told the queue is empty — only
// that no row was both eligible and unlocked at that moment.
export type ClaimResult = { claimed: true; step: ClaimedStep } | { claimed: false };

// Thrown when the locked row could not be updated as expected. This means
// an assumption about the claim transaction is wrong, not that there was
// no work; the transaction is rolled back rather than reporting a claim
// that did not happen.
export class ClaimConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimConsistencyError";
  }
}

// Declared as type aliases rather than interfaces: Drizzle's execute()
// generic requires a type with an implicit index signature, which TypeScript
// gives to object type aliases but not to interfaces.
type CandidateRow = {
  id: string;
  status: string;
};

type ClaimedRow = {
  id: string;
  status: string;
  current_worker_id: string;
  lease_version: number;
  lease_expires_at: Date;
  priority: number;
  available_at: Date;
};

/**
 * Claims at most one step for `workerId`.
 *
 * Selection and the ownership write are a single transaction on a single
 * connection. The row is locked by the SELECT and stays locked until
 * COMMIT, so no other claimer can be looking at it in between — this is
 * not a read-then-write race, it is a locked-read-then-write.
 *
 * Concurrency behaviour relied upon (PostgreSQL, default READ COMMITTED):
 *
 * - FOR UPDATE takes an exclusive row lock. At most one transaction can
 *   hold it, so at most one claimer can be mid-claim on a given row.
 * - SKIP LOCKED means a claimer does not wait on a candidate step row
 *   that another transaction (such as another claim) has locked; it skips
 *   that row and searches for another eligible one instead. Two claimers
 *   racing for the same top-ranked step therefore end up on different
 *   rows rather than queueing behind each other. This covers row locks on
 *   candidate rows only: a claim can still wait for unrelated reasons,
 *   such as other PostgreSQL locks or acquiring a connection.
 * - If a competing claimer has already COMMITTED, its lock is gone, so
 *   SKIP LOCKED does not skip the row. PostgreSQL instead re-reads the
 *   newest committed version of the row and re-applies this query's WHERE
 *   clause to it; the row is now RUNNING, fails `status = 'READY'`, and
 *   drops out. That re-check is why READ COMMITTED is sufficient here and
 *   why a stronger isolation level is not used: exclusivity comes from the
 *   row lock, not from the snapshot. REPEATABLE READ would turn this case
 *   into a serialization failure that the caller would have to retry.
 *
 * Returns { claimed: false } when no row was both eligible and unlocked.
 * That is a normal outcome under contention, not an error.
 */
export async function claimNextStep<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  workerId: string,
): Promise<ClaimResult> {
  if (workerId.trim().length === 0) {
    // A blank owner would produce a RUNNING row whose owner cannot be
    // identified, which is the one thing a claim is supposed to establish.
    // The steps_running_requires_owner CHECK only requires
    // current_worker_id to be non-null, so it would accept a blank string;
    // this guard is what rejects it.
    throw new Error("claimNextStep requires a non-empty workerId");
  }

  return db.transaction(async (tx) => {
    // Eligibility: READY, and available_at has arrived. `now()` is the
    // database's transaction start time, so every claimer is judged against
    // one clock. Using the start time here is conservative: a step that
    // becomes available after this transaction began simply waits for the
    // next claim.
    //
    // Ordering (deterministic, total):
    //   1. priority DESC     — higher number first
    //   2. available_at ASC  — oldest eligible first within a priority,
    //                          so a low-priority step can't be starved by
    //                          newer peers at the same priority
    //   3. id ASC            — stable tie-break, so two rows identical in
    //                          priority and availability still have one
    //                          defined claim order
    const candidates = await tx.execute<CandidateRow>(sql`
      select id, status
      from steps
      where status = 'READY'
        and available_at <= now()
      order by priority desc, available_at asc, id asc
      limit 1
      for update skip locked
    `);

    const candidate = candidates.rows[0];
    if (!candidate) {
      return { claimed: false };
    }

    // The row is locked at this point, so reading its status and then
    // writing is safe: nothing else can change it before COMMIT. This
    // routes the persisted transition through the Milestone 2 table
    // instead of asserting READY -> RUNNING locally. The WHERE clause
    // above already restricts the status, so today this cannot reject —
    // it is here so that widening the eligibility predicate (say, to also
    // pick up RETRY_WAIT rows directly) fails loudly against the
    // lifecycle rules rather than quietly persisting an illegal
    // transition.
    transitionStepStatus(parseStepStatus(candidate.status), "RUNNING");

    // Same transaction, same lock. `status = 'READY'` is redundant while we
    // hold the lock; it is retained so that if that assumption is ever
    // wrong the UPDATE matches nothing and the check below aborts, instead
    // of overwriting ownership of a row somebody else owns.
    //
    // The lease deadline uses clock_timestamp(), not now(). now() is frozen
    // at BEGIN, so any delay between BEGIN and this write (a slow SELECT, a
    // stalled claimer process between statements) would silently come off
    // the lease: the step would be handed over with less than the full
    // duration left. clock_timestamp() is the database's actual time when
    // this expression is evaluated, which puts the start of the lease at
    // the ownership write. It is still not exactly COMMIT time —
    // PostgreSQL gives no way to read the commit instant from inside the
    // transaction — so the remaining lease at commit is short by the
    // UPDATE-to-COMMIT round trip. updated_at keeps using now(), which is
    // the usual meaning of a row's modification timestamp.
    const claimed = await tx.execute<ClaimedRow>(sql`
      update steps
      set status = 'RUNNING',
          current_worker_id = ${workerId},
          lease_version = lease_version + 1,
          lease_expires_at = clock_timestamp() + (${STEP_LEASE_DURATION_MS}::int * interval '1 millisecond'),
          updated_at = now()
      where id = ${candidate.id}
        and status = 'READY'
      returning id, status, current_worker_id, lease_version, lease_expires_at, priority, available_at
    `);

    if (claimed.rows.length !== 1) {
      // Fail loudly and roll back. Reporting a claim that did not happen
      // would hand the caller ownership of a step it does not own.
      throw new ClaimConsistencyError(
        `claim of step ${candidate.id} updated ${claimed.rows.length} rows, expected exactly 1`,
      );
    }

    const row = claimed.rows[0] as ClaimedRow;
    return {
      claimed: true,
      step: {
        id: row.id,
        status: "RUNNING",
        workerId: row.current_worker_id,
        leaseVersion: row.lease_version,
        leaseExpiresAt: row.lease_expires_at,
        priority: row.priority,
        availableAt: row.available_at,
      },
    };
    // The claim is only real once this callback returns and Drizzle
    // commits. Anything thrown above rolls the whole thing back, leaving
    // the step READY and unowned — there is no half-claimed state.
  });
}
