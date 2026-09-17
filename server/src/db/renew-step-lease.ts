import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { STEP_LEASE_DURATION_MS } from "./claim-step.js";

export interface RenewStepLeaseParams {
  id: string;
  workerId: string;
  leaseVersion: number;
  // Defaults to STEP_LEASE_DURATION_MS. Injectable so tests can prove
  // renewal with sub-second leases instead of waiting out the real one.
  leaseDurationMs?: number;
}

// A rejected renewal is an expected outcome under leases, not a
// consistency failure: it is how an owner finds out its generation is over.
export type RenewStepLeaseResult = { renewed: true; leaseExpiresAt: Date } | { renewed: false };

type RenewedRow = {
  lease_expires_at: Date;
};

/**
 * Extends the lease of one ownership generation that is still live.
 *
 * Renewal is authorized only if, evaluated while this transaction holds the
 * row lock:
 *
 * - the step is still RUNNING,
 * - owned by `workerId`,
 * - at exactly `leaseVersion` (the generation this worker claimed), and
 * - its current deadline is still later than the database clock.
 *
 * The last condition is what makes an expired generation non-renewable
 * even if the recovery sweep has not run yet. Without it, a worker that
 * froze past its deadline would, on waking, have its overdue renewal timer
 * fire and race the sweeper to extend a lease that had already run out —
 * the deadline would then only mean "expired, unless the owner wakes up
 * before the sweeper gets there". With it, lease_expires_at is a boundary
 * the owner cannot cross back over.
 *
 * Transaction (READ COMMITTED), two statements:
 *
 *   BEGIN
 *   1. SELECT id FROM steps WHERE id = $id FOR UPDATE
 *        Acquires the row lock, waiting for any other lock holder. Makes no
 *        authorization decision: its only filter is the id.
 *   2. UPDATE steps SET lease_expires_at = clock_timestamp() + duration ...
 *        WHERE id AND status AND owner AND version
 *          AND lease_expires_at > clock_timestamp()
 *        The complete authorization predicate, evaluated only after step 1
 *        holds the lock. It runs with a fresh snapshot, so it sees whatever
 *        was committed while step 1 waited, and it cannot wait on another row
 *        lock: this transaction already holds the strongest row-lock mode.
 *   COMMIT
 *
 * Why not a single UPDATE: a lone UPDATE evaluates its WHERE clause before
 * it discovers the row is locked, then waits. PostgreSQL re-evaluates after
 * the wait only if the lock holder modified the row. If the holder merely
 * locked it (SELECT ... FOR UPDATE) and let go, the pre-wait evaluation
 * stands — so a renewal that checked "still live" before the deadline could
 * wait past the deadline and then extend an expired lease. That was
 * observed on PostgreSQL 16 (docs/build-journal.md, Milestone 5) and is
 * what lease-races.test.ts's lock-only tests reproduce. Taking the lock
 * first means no evaluation that authorizes the write can happen before a
 * lock wait.
 *
 * clock_timestamp(), never now(): inside this transaction now() is fixed at
 * BEGIN, before step 1's wait, so it would reintroduce exactly the stale
 * check this structure exists to remove.
 *
 * Tradeoff: the row lock is now held across two client round trips (the
 * UPDATE, then COMMIT) instead of inside one server-side statement. While
 * it is held, recovery skips this row and can recover unrelated rows. A
 * stalled transaction still delays recovery of this particular step; see
 * docs/architecture.md. The wall-clock assumption there applies to owner
 * authority as well as recovery.
 *
 * What renewal does not do: change lease_version (a renewal continues a
 * generation, it does not start one), change status or owner (a rejected
 * renewal never falls back to reacquiring the step), or touch payload or
 * result. The new deadline is measured from the database clock at the
 * write, same convention as the claim.
 */
export async function renewStepLease<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  params: RenewStepLeaseParams,
): Promise<RenewStepLeaseResult> {
  const leaseDurationMs = params.leaseDurationMs ?? STEP_LEASE_DURATION_MS;

  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select id from steps where id = ${params.id} for update
    `);
    if (locked.rows.length === 0) {
      return { renewed: false } as const;
    }

    const updated = await tx.execute<RenewedRow>(sql`
      update steps
      set lease_expires_at = clock_timestamp() + (${leaseDurationMs}::int * interval '1 millisecond'),
          updated_at = now()
      where id = ${params.id}
        and status = 'RUNNING'
        and current_worker_id = ${params.workerId}
        and lease_version = ${params.leaseVersion}
        and lease_expires_at > clock_timestamp()
      returning lease_expires_at
    `);

    const row = updated.rows[0];
    if (!row) {
      // Can't distinguish expired / recovered / completed / other owner /
      // stale version from zero rows, and doesn't need to: every one of
      // those means this generation can no longer be renewed, and none of
      // them can become renewable again (the deadline only moves forward
      // through a successful renewal, and lease_version never goes back).
      // Nothing was written; COMMIT just releases the lock.
      return { renewed: false } as const;
    }
    return { renewed: true, leaseExpiresAt: row.lease_expires_at } as const;
  });
}
