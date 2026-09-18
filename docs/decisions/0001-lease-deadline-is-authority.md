# 0001 — The lease deadline, not the recovery sweep, ends an owner's authority

Status: accepted (Milestone 5)

## Context

A `RUNNING` step carries an ownership generation (`current_worker_id`,
`lease_version`) and a deadline (`lease_expires_at`, database clock). The
owner renews the deadline while executing. A coordinator sweep returns
steps whose deadline has passed to `READY`, and the next claim increments
`lease_version`.

That leaves a window between "the deadline has passed" and "the sweep has
run". A lapsed owner can try to write inside it: a worker that was frozen,
paused, partitioned from PostgreSQL, or blocked its own event loop resumes
and either renews or completes. The question is what the database does with
that write.

Both options below keep the row itself safe. A new owner can only appear
after recovery, and recovery clears ownership, so neither option lets two
owners write the same generation. The difference is what the deadline
*means*, and what else a correctness argument has to depend on.

## Options considered

**A. The generation alone authorizes owner writes until recovery happens.**
Completion and renewal check `status`, `current_worker_id` and
`lease_version`, but not the deadline.

- A lapsed owner can complete anything it finishes before the sweep, so less
  work is thrown away.
- The owner's authority actually ends whenever the sweep happens to run.
  The sweep interval and the coordinator's uptime become part of the
  authority rule: with the coordinator down for an hour, owners whose leases
  expired an hour ago can still write.
- If renewal also skips the deadline check, a frozen worker that wakes after
  its deadline has its overdue renewal timer fire and races the sweep to
  extend a lease that already ran out. The deadline then only means "expired
  unless the owner wakes before the sweeper".
- Allowing late completion but rejecting late renewal would give an owner
  half its authority after the deadline, with no principled line between
  the two writes.

**B. Owner writes also require `lease_expires_at > clock_timestamp()`.**

- Authority is a function of the row and the database clock only. "No
  renewal or completion is authorized once the database clock reaches the
  deadline" holds, and can be tested, with no sweeper running.
- The sweep affects liveness only: how soon an expired step is claimable
  again. It never affects who is allowed to write.
- Renewal and completion share one definition of "holds a live lease on
  this generation".
- Cost: work that finishes after expiry but before the sweep is discarded
  and executes again. That only happens to an owner that went a full lease
  duration without a successful renewal, and re-execution is already the
  expected behaviour under at-least-once execution.

**Rejected alongside:**

- *Recover on missed heartbeats.* Heartbeat loss is suspicion, not proof,
  and a heartbeat says nothing about any particular step. Recovery reads the
  lease only.
- *Let the claim take expired `RUNNING` rows directly* (`WHERE status =
  'READY' OR (status = 'RUNNING' AND lease_expires_at <= now())`). No sweeper
  needed, but it creates an unlisted `RUNNING -> RUNNING` owner change,
  merges "authority ended" with "someone took the work" into one transition
  a later event history couldn't separate, and moves expiry logic into the
  claim's hot path and index.

## Decision

B. `renewStepLease` and `completeStepSuccess` each run one READ COMMITTED
transaction:

```text
BEGIN
SELECT id FROM steps WHERE id = $id FOR UPDATE      -- acquire the row lock; no decision
UPDATE steps SET ...
 WHERE id = $id AND status = 'RUNNING' AND current_worker_id = $worker
   AND lease_version = $version AND lease_expires_at > clock_timestamp()
COMMIT
```

The full authorization predicate is in the `UPDATE`, evaluated only after
the transaction holds the row lock. `recoverExpiredSteps` uses one statement:
a CTE selects at most 100 rows with `status = 'RUNNING' AND
lease_expires_at <= clock_timestamp()`, ordered by deadline and ID, using
`FOR UPDATE SKIP LOCKED`; the `UPDATE ... FROM` changes only those locked
candidates to `READY` (Milestone 7 instead dead-letters exhausted rows;
see [ADR 0002](0002-attempt-budget-includes-crashes.md)). The two time comparisons are exact complements for
the same row and instant.

`clock_timestamp()` rather than `now()` in all three predicates: `now()` is
fixed at transaction start, which for the owner transactions is `BEGIN`,
before any lock wait.

This clock is PostgreSQL wall time, not a monotonic logical clock. Both
owner authority and recovery assume it does not jump backward across a
previously expired deadline before recovery durably changes the row. An
expired but unswept generation could otherwise become time-eligible again.
Handling wall-clock rollback is outside Milestone 5.

### How the owner writes got their shape

On PostgreSQL 16.15 a renewal was made to wait on a row lock held by
another transaction while its deadline passed:

| Lock holder | Predicate clock | Waiting renewal of an expired lease |
|---|---|---|
| Modifies the row | `clock_timestamp()` | Rejected |
| Modifies the row | `now()` | Accepted |
| Only `SELECT ... FOR UPDATE` | `clock_timestamp()` | Accepted |

The first result chose `clock_timestamp()`. The third showed that a
*single-statement* `UPDATE` — the first implementation — was not enough. A
lone `UPDATE` evaluates its `WHERE` clause before it discovers the row is
locked. PostgreSQL re-evaluates after the wait only when the holder modified
the row. A lock-only holder changes nothing, so the pre-wait "still live"
result stands and the write lands after the deadline. The first version
recorded this as a known gap on the grounds that no application code takes
such a lock on a `RUNNING` row. On review that was rejected: it left the
decision above true only as long as nothing ever held such a lock. Taking
the lock first, then evaluating, removes the dependency.

Recovery initially stayed a direct conditional UPDATE. For a fixed row
version, "the deadline has passed" can only go from false to true as the
database clock advances. A sweep that evaluated a row as expired before
waiting behind a lock-only holder is still right after the wait, and a
modifying holder triggers re-evaluation. The owner predicate ("still live") can go from true to false
during a wait, which is why only the owner writes needed to lock first.

The final Milestone 5 cleanup changes recovery for liveness: a locked
expired row is skipped, so it cannot hold up unrelated recovery. Skipped
rows are eligible on later sweeps. A concurrent committed renewal excludes
a candidate only if the renewed deadline is still unexpired when the
recovery predicate is evaluated/re-evaluated; a delayed transaction may
commit a deadline that is already expired. A completed row fails the
`RUNNING` condition. Selected rows remain locked through the update.

## Consequences

- The deadline check does not replace fencing. After a reclaim,
  `lease_expires_at` is the new owner's live deadline, so a stale owner
  passes the time check. If the worker ID is reused, only `lease_version`
  rejects it. Before any
  recovery, a lapsed owner passes the generation check; only the time check
  rejects it. Both are needed.
- A worker cannot tell from a rejected completion *why* it was rejected
  (expired, recovered, reclaimed, completed). It does not need to: every
  case means it has no authority.
- A dead coordinator stalls recovery but never extends anyone's authority.
- An owner write is authorized at the instant its `UPDATE` evaluates the
  predicate under the row lock. Its `COMMIT` can arrive later; until it
  does, sessions reading without locks see the old committed deadline, and
  a sweep skips that locked row. Later sweeps see the committed renewal or
  completion. "No owner write is authorized at or after the
  deadline" holds; "no owner write becomes visible after the deadline" does
  not.
- The row lock is held across client round trips (lock statement →
  `UPDATE` → `COMMIT`) instead of inside one server-side statement. If the
  owning process stalls in that window, recovery skips its row and can
  recover unrelated unlocked expired rows. The lock lifetime, and therefore
  recovery of that individual row, remains unbounded in this revision.
  `SKIP LOCKED` does not avoid table locks or all other database delays.
- Only actively executing steps are bounded by worker loops. Persisted
  `RUNNING` rows can temporarily exceed worker count because failed or
  abandoned executions await recovery while the worker claims another
  step. Each recovery statement therefore limits its batch to 100.
- Tests: `server/tests/complete-step.test.ts`,
  `server/tests/renew-step-lease.test.ts`, `server/tests/lease-races.test.ts`
  (including renewal and completion held behind a lock-only holder across
  the deadline). Each of these makes specific tests fail: removing the lock
  statement, moving the expiry check into it, using `now()`, or removing
  either expiry check.
