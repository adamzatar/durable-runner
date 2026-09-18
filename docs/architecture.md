# Architecture

This describes the design as currently decided. It is split into what's
actually planned, what's genuinely unresolved, and — clearly marked — what a
further production evolution might look like if asked about it. Nothing in
the third section is built, scheduled, or promised.

## Current planned implementation

### Coordination store

PostgreSQL is the only coordination mechanism. No message broker, no cache,
no separate lock service. Workers coordinate exclusively by reading and
writing Postgres rows — not through in-memory state shared between
processes, even when multiple workers happen to run in the same process.

### Repo layout

One root `package.json`, one install and one dependency graph — not npm
workspaces. `server/` and `web/` each get their own `tsconfig.json` (Node
lib/target for the server, DOM lib/JSX for the browser code) so the two
runtime targets don't fight over compiler settings, without the ceremony of
a multi-package workspace. No shared package is introduced unless real
shared code (e.g. a type used by both REST payloads and the frontend)
later makes one worthwhile — not created speculatively up front.

### Processes

- One Fastify server: REST endpoints for commands (submit a run, cancel a
  run, etc.) plus one SSE endpoint that streams live event/state updates to
  the browser.
- A coordinator process (`server/src/coordinator/coordinator.ts`,
  Milestone 5) that sweeps expired leases back to `READY`. A separate
  local process, not a loop inside the API server, so it can be stopped or
  killed independently; it shares nothing with the other processes except
  PostgreSQL. Retry scheduling will live here too once retries exist.
- Worker loops that claim steps, execute them, and report outcomes. Whether
  these run as separate Node child processes or as logical async loops
  inside one process depends on the environment spike
  (`tasks/00-environment-spike.md`). Whichever it turns out to be, the code
  and docs will say so directly — loops will not be presented as if they
  were independent machines. The spike's child-process experiment used
  `child_process.spawn` (a TS entrypoint run through `tsx`, not
  `child_process.fork`), which has no side benefit here beyond being what
  running a TS file requires — but it also means there's no Node IPC
  channel between coordinator and workers by construction, which matches
  the constraint that they only coordinate through Postgres. Confirmed
  locally on macOS (3 workers, kill one, coordinator and the other two
  survive, observed entirely by reading `spike_events` back); not yet
  confirmed on the Replit Reserved VM.

### Task state machine

States: `PENDING`, `READY`, `RUNNING`, `RETRY_WAIT`, `SUCCEEDED`,
`DEAD_LETTERED`, `CANCELLED`. There is no separate `LEASED` state:
ownership (current worker, lease expiry, lease version) is metadata on a
`RUNNING` step, stored as columns on `steps` (Milestone 3). Transitions and
their legality are centralized in `server/src/domain/step-status.ts` and
`server/src/domain/step-transitions.ts` (Milestone 2), covered by tests.
That module is pure — it validates transition shape only, with no I/O and
no knowledge of lease ownership or attempt counts. The claim transaction
(below) is the persistence-layer authority for the `READY -> RUNNING`
write, and checks that edge against the module while it holds the row
lock.

Cancellation is legal only from `PENDING`, `READY`, or `RETRY_WAIT` — never
directly from `RUNNING`, since a raw status flip would race the owning
worker's own completion/failure write. Cancelling in-flight work will need
a cooperative mechanism, not yet built.

### Claiming, leases, fencing

Implemented in Milestone 3: the `steps` table and claiming
(`server/src/db/claim-step.ts`). Worker loops followed in Milestone 4;
heartbeats, lease renewal, expiry and recovery in Milestone 5; demonstrated
stale-owner fencing after reclaim in Milestone 6; explicit reported-failure
retries and dead-lettering in Milestone 7 (see below).

- **Table.** `steps` holds `id` (random uuid), `status` (a PostgreSQL enum
  generated from `STEP_STATUSES`), `priority`, `available_at`,
  `current_worker_id`, `lease_version`, `lease_expires_at`, `created_at`,
  `updated_at`. A CHECK constraint requires every `RUNNING` row to have
  `current_worker_id IS NOT NULL`, `lease_expires_at IS NOT NULL`, and
  `lease_version > 0`. It does not validate the worker ID's content, so an
  empty or whitespace-only ID would satisfy it; `claimNextStep` separately
  rejects blank worker IDs. The CHECK only constrains `RUNNING` rows and
  doesn't decide what later transitions do with these columns.
- **Eligibility.** `status = 'READY' AND available_at <= now()`, where
  `now()` is the database's transaction start time. No dependency graph or
  run-level scheduling exists yet.
- **Ordering.** `priority DESC, available_at ASC, id ASC`: higher priority
  number first, then the step that became available earliest, then uuid
  as a total-order tie-break.
- **Transaction.** Drizzle's `db.transaction()` pins one connection and
  runs `BEGIN`; then, as raw SQL:
  1. `SELECT id, status ... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED`.
     No row means `{ claimed: false }`.
  2. With the row locked, `READY -> RUNNING` is checked against
     `step-transitions.ts`.
  3. `UPDATE steps SET status = 'RUNNING', current_worker_id = $worker,
     lease_version = lease_version + 1, lease_expires_at =
     clock_timestamp() + 30s, updated_at = now() WHERE id = $id AND status =
     'READY' RETURNING ...`.
  4. Anything other than exactly one returned row throws and rolls back.
  5. `COMMIT`. The claim does not exist until this succeeds.
- **Why two statements and raw SQL.** A single `WITH ... UPDATE` CTE would
  work and save a round trip, but "the CTE found nothing" and "the CTE
  found a row the UPDATE then didn't match" would both come back as zero
  rows. Keeping them separate lets the second case fail loudly instead of
  being reported as no work. Raw SQL (rather than Drizzle's select builder
  with `.for("update", { skipLocked: true })`) keeps the exact locking
  query readable in one place.
- **Why READ COMMITTED is enough.** Exclusivity comes from the row lock,
  not the snapshot. A row locked by an in-flight claimer is skipped. A row
  claimed by a transaction that has already committed is no longer locked,
  so it isn't skipped; PostgreSQL re-reads the latest committed version,
  re-applies the `WHERE`, sees `RUNNING`, and drops it. REPEATABLE READ
  would turn that case into a serialization error the caller would have to
  retry.
- **Index.** One partial index, `(priority DESC, available_at ASC, id ASC)
  WHERE status = 'READY'`, matching the claim's status filter and sort
  order and excluding `RUNNING`/terminal rows. The `available_at <= now()`
  condition is still checked per candidate. Nothing has been measured.
- **`lease_version`.** Starts at `0`, meaning never owned. Every successful
  claim increments it and never resets it, so a reclaim always produces a
  version no earlier owner could hold. The claim returns the version it
  wrote. Heartbeats and lease renewals do not change it (Milestone 5): it
  marks a change of owner, not a lease extension. Recovery does not change
  it either; the next claim does.
- **`lease_expires_at`.** Written at claim time as `clock_timestamp()` plus
  the lease duration. The lease is timed from the ownership `UPDATE`, not
  from `BEGIN` (`now()` would silently shorten it by however long the
  transaction took to get there) and not exactly from `COMMIT` either
  (PostgreSQL doesn't expose that instant inside the transaction). Enforced
  since Milestone 5 — see "Heartbeats, lease renewal, expiry, and recovery"
  below.
- **Tests** (`server/tests/claim-step.test.ts`). Each claimer has its own
  single-connection pool, so claims overlap as separate PostgreSQL backends.
  They are logical claimers inside the one Vitest process, not separate OS
  processes. 12 claimers race for 3 steps and 16 for 1; the tests assert
  exactly N claims, no step returned twice, and one distinct owner per
  persisted row. A second connection holds `FOR UPDATE` on the
  highest-priority row while a claimer runs; the claimer must take the
  lower-priority row, or report no work if no other row exists, instead
  of waiting for the locked row. Claimers do not wait on candidate step
  rows locked by other claim transactions; `SKIP LOCKED` makes them search
  for another eligible row instead. That says nothing about waits for
  unrelated PostgreSQL locks or infrastructure reasons. The tests were checked against deliberately broken versions:
  removing the locking clause, removing the locking clause and the UPDATE
  status guard, and dropping only `SKIP LOCKED` each make the relevant
  tests fail.
- A worker's completion write is conditioned on still holding the lease
  version it claimed with (Milestone 4). If another worker has since
  reclaimed the step (higher lease version), the stale write affects zero
  rows and is rejected. This is fencing. Milestone 6 demonstrates an old
  execution resuming after reclaim in real processes, and isolates the
  version predicate with same-worker-ID database tests while the newer
  generation is still RUNNING with a live lease.
- Fencing prevents a stale *write*, not a stale *side effect*. A worker
  whose lease expired may have already performed an external action before
  it lost ownership. That's a separate problem, handled by idempotency.
- A lease timeout is not treated as proof of worker death. A timed-out
  worker may still be alive and may still attempt to act — the system is
  built assuming that will happen sometimes, not as an edge case.

### Worker execution (Milestone 4)

Implemented: task representation on `steps`, one deterministic executor,
the completion write, the real worker loop, and a real (non-spike) worker
process entrypoint. Heartbeats, lease renewal and recovery were added in
Milestone 5 and changed parts of this section as noted. Not implemented:
retries, idempotency, verification, durable events.

Demonstrated concretely as multiple local OS child worker processes on one
machine, sharing one PostgreSQL instance as their only coordination
mechanism (`npm run demo:workers`). This does not validate separate
physical machines, nor has it been re-confirmed on the Replit Reserved VM
mentioned in the Phase 0 notes above — both remain open questions, not
claims this milestone makes.

- **Task representation.** `steps` gained `task_type` (`text`, not null, no
  default), `payload` (`jsonb`, not null, no default), and `result`
  (`jsonb`, nullable — set only on success). `task_type` is a plain text
  column validated at execution time by `parseTaskType`
  (`server/src/domain/task-type.ts`), not a Postgres enum like
  `step_status`: the type set is expected to grow, and an enum would need
  an `ALTER TYPE ... ADD VALUE` migration per new task, unlike the closed
  lifecycle `step_status` represents. `claimNextStep`'s `RETURNING` clause
  now also returns `task_type`/`payload`, passed through unvalidated — the
  claim transaction owns locking/ownership, not task semantics.
  - **Migration assumption.** `0002_last_eddie_brock.sql` adds `task_type`
    and `payload` as `NOT NULL` with no `DEFAULT`. Confirmed directly
    (against a scratch table, not `steps`): `ALTER TABLE ... ADD COLUMN
    ... NOT NULL` with no default fails against a table that already has
    rows — `ERROR: column "task_type" of relation "..." contains null
    values` — because it has nothing non-null to put in them. This
    migration therefore only applies cleanly to an empty `steps` table.
    That's a real precondition of this specific migration, not a
    hypothetical: before Milestone 4 there was no real submission/
    execution pathway writing durable steps, so there is no application
    data to preserve, and no fake `task_type`/`payload` was invented to
    backfill hypothetical old rows. This is a development-time assumption
    about this repo's actual history, not a production migration
    guarantee — a later milestone adding a `NOT NULL` column to a table
    that genuinely holds rows would need a default or a backfill step,
    and should not assume this precedent still applies.
- **Executor.** Milestone 4 introduced `hash_after_delay`: payload
  `{ input: string, delayMs: number }`, waits `delayMs` (validated
  `0 <= delayMs <= 5000`, raised to `60000` in Milestone 5 so a step can
  outlast one 30s lease; the cap exists so a bad payload can't stall a
  worker indefinitely, the range exists so a demo can make workers
  visibly overlap), then returns `{ hash: sha256(input) hex }`.
  Deterministic, side-effect-free, and validated explicitly (no schema
  library) — an invalid persisted payload throws rather than being
  silently coerced or retried. One `switch` in
  `server/src/worker/execute-step.ts`, not a registry: adding a task type
  means adding a case, not registering a plugin. Milestone 7 adds
  `fail_then_hash` in that same switch.
- **Completion.** In Milestone 4, `completeStepSuccess`
  (`server/src/db/complete-step.ts`) was one atomic
  `UPDATE ... WHERE id = $id AND status = 'RUNNING' AND
  current_worker_id = $workerId AND lease_version = $leaseVersion
  RETURNING id`, preceded by a static `transitionStepStatus("RUNNING",
  "SUCCEEDED")` call (same pattern as the claim routing its transition
  through the Milestone 2 table). Anything other than exactly one
  returned row throws `CompletionConsistencyError` and the row is left
  untouched — the caller cannot tell from that alone whether the step was
  already terminal, owned by someone else, or at a stale lease version,
  only that its own ownership generation no longer matches, which is
  enough to refuse the write safely.
  - Milestone 5 added a second condition, `lease_expires_at >
    clock_timestamp()`, and an ID-only row lock in a preceding statement
    within the same transaction, so completion requires a lease that is
    still unexpired when authorized after the lock wait.
    See the Milestone 5 section and
    `docs/decisions/0001-lease-deadline-is-authority.md`.
  - This is an **ownership-generation predicate**, and it is
    fencing-compatible, but it was not a demonstration of fencing in
    Milestone 4: no lease-expiry recovery existed, so no second worker
    could reclaim a `RUNNING` step out from under its owner. Milestone 5
    supplied recovery; Milestone 6 demonstrates stale writes rejected after
    real expiry, recovery, and reclaim, including reuse of the worker ID.
  - Fencing (this predicate) stops a stale *write*. It says nothing about
    a stale worker having already performed an external side effect
    before losing ownership — that is idempotency's job, not built yet.
- **Ownership fields on success.** `current_worker_id` and
  `lease_expires_at` are cleared; `lease_version` is preserved, never
  reset — a terminal step has no active owner, but the ownership
  generations it went through remain meaningful history. This is
  compatible with `steps_running_requires_owner`, which only constrains
  `RUNNING` rows.
  - No `completed_by_worker_id` column was added. Clearing
    `current_worker_id` does lose durable attribution, but persisting it
    twice (once as a point-in-time column, again later in durable event
    history) isn't worth it for this milestone. Attribution for now comes
    from each worker process's own stdout log line at completion time —
    see the demo command below — and durable attribution is left to the
    event-history table when that's built.
- **Worker loop.** `runWorkerLoop` (`server/src/worker/worker-loop.ts`):
  claim → if nothing claimed, sleep a fixed poll interval (500ms,
  interruptible by shutdown) and retry → if claimed, execute, then
  complete. Sequential, not concurrent within one loop: a worker process
  holds at most one active claimed step at a time. More throughput comes
  from running more worker processes, not from one loop claiming multiple
  steps at once. Shutdown is checked between iterations only — a signal
  abort stops a new claim from starting (or cuts an idle poll wait short)
  but never interrupts a step already claimed.
  - **Errors.** Two distinct cases, both logged with the loop continuing
    to the next iteration, without changing the ownership generation:
    - If `executeStep` throws, this worker makes no completion write at
      all. In Milestone 4 nothing else could act on the step, so it stayed
      `RUNNING` indefinitely. Milestone 5 stopped renewal and relied on
      lease recovery. Milestone 7 instead reports observed executor failure
      through a live-owner-authorized retry/dead-letter transition.
    - If `completeStepSuccess` throws `CompletionConsistencyError`, the
      completion `UPDATE` matched zero rows and made no mutation — this
      worker's ownership-generation predicate was rejected. That does
      *not* mean the row is still `RUNNING` under this worker: once
      lease-expiry recovery and reclaiming exist, a zero-row match could
      mean another worker had already reclaimed or completed the step by
      then. In Milestone 4, with no reclaim path, this was not expected in
      normal operation. Since Milestone 5 it is also the expected result
      for a worker whose lease expired before it completed.
- **Worker process.** `server/src/worker/worker.ts` — separate from the
  Phase 0 `spike-worker.ts`, which is retained and untouched. Worker ID
  from `argv[2]`, then `WORKER_ID`, then a generated UUID. Own
  `Pool`/Drizzle connection. `SIGTERM`/`SIGINT` abort the loop, which
  finishes its current step (if any), then the process closes its pool
  and exits. No Node IPC anywhere — coordination is Postgres rows only.
- **Demo.** `npm run demo:workers` (`server/src/worker/run-demo.ts`)
  inserts a handful of `hash_after_delay` steps, spawns 3 real
  `worker.ts` **child processes** via `child_process.spawn` (same
  mechanism as the Phase 0 `run-experiment.ts`), polls Postgres until
  every step is `SUCCEEDED`, prints the durable results, then stops the
  workers. Worker-to-task attribution is visible from each child's
  inherited stdout, not from a database column.
- **Tests.**
  `execute-step.test.ts`: pure executor unit tests (deterministic hash,
  invalid-payload rejection).
  `complete-step.test.ts`: claim → execute → complete happy path (asserts
  terminal ownership shape and preserved `lease_version`), plus
  wrong-worker, stale-lease-version, and non-`RUNNING` completion attempts
  (all rejected, row untouched).
  `worker-loop.test.ts`: the real loop against real Postgres, driving
  several `READY` rows to `SUCCEEDED` across multiple **logical** worker
  loops (separate single-connection pools inside one Vitest process — the
  same convention `claim-step.test.ts` uses for its contention tests),
  plus a graceful-shutdown-during-idle-poll test. This is not a test of OS
  process isolation; the child-process case is exercised only by
  `demo:workers`, run manually.
  Because `complete-step.test.ts` and `worker-loop.test.ts` now also write
  to `steps`, `vitest.config.ts` sets `fileParallelism: false` so test
  files don't interleave writes/locks on that table — `claim-step.test.ts`
  had already flagged this as a future requirement.

### Heartbeats, lease renewal, expiry, and recovery (Milestone 5)

Implemented: a `workers` table and heartbeats, renewal of the active
step's lease while it executes, the lease deadline as the limit on an
owner's renewal and completion writes, expired-lease recovery, a
coordinator process running the recovery sweep, and a real child-process
crash/recovery demo. Milestone 6 below adds the demonstration of a stale
owner resuming after reclaim and attempting completion. Milestone 7 below
adds reported-failure retries and attempt budgets. Idempotency, verification,
durable events, and UI remain unimplemented.

- **Two facts, two jobs.**
  - A *heartbeat* (`workers.last_heartbeat_at`) means only "a process using
    this worker ID reached PostgreSQL at this database time." It is
    observability. No ownership decision reads it.
  - A *lease* (`steps.current_worker_id`, `lease_version`,
    `lease_expires_at`) is authority over one step, for one ownership
    generation, until a database-clock deadline.
  - Heartbeat loss is suspicion, not proof of death. Lease expiry is what
    authorizes recovery, and it does not prove death either: it removes the
    old owner's authority, whatever that process is doing.
- **`workers` table.** `id text` primary key, `started_at`,
  `last_heartbeat_at` (both `timestamptz NOT NULL`, no defaults). No status
  column, no `stopped_at`, no PID/host, no capacity. One row per worker ID,
  not per process lifetime. `steps.current_worker_id` is deliberately not a
  foreign key to it: the lease row grants ownership, not registration.
- **Heartbeats** (`server/src/db/worker-heartbeat.ts`,
  `server/src/worker/heartbeat-loop.ts`).
  - `registerWorker` upserts at process start; registration counts as the
    first heartbeat (both columns get one `clock_timestamp()` value). A
    restart under the same ID resets `started_at`.
  - `recordWorkerHeartbeat` is an `UPDATE ... SET last_heartbeat_at =
    clock_timestamp()` every 2s. It throws if the worker never registered.
  - The loop runs for the whole process, idle or busy, independently of
    the claim/execute loop. It awaits each write before sleeping (no
    `setInterval` pile-up) and logs failures without stopping. It never
    touches `steps`.
- **Timing** (production values; tests inject shorter ones).

  | Interval | Value | Relationship |
  |---|---|---|
  | Lease duration | 30s | Measured from the claim write and from each renewal write, on the database clock. |
  | Renewal | 5s | Leaves several renewal opportunities with ordinary latency; failures and delays consume that margin. This is not a bound on tolerated failures. |
  | Heartbeat | 2s | With a recently renewed lease, missed beats normally become visible before expiry; prior renewal failures can reverse that order. |
  | Recovery sweep | 1s | Affects how soon an expired step is claimable again (liveness), never who holds authority. |
  | Worker poll | 500ms | Unchanged from Milestone 4. |

  **Healthy-path estimate:** assuming a recent successful renewal, the 30s
  lease, 5s renewal cadence, 1s recovery sweep, and ordinary database/event-loop
  latency, a step becomes recoverable roughly 25–30s after a crash. With an
  unlocked row that fits in the next batch, reclaim normally follows within
  about one sweep plus one poll interval. These are not universal upper or
  lower bounds; prior failures, lock retention, backlog, and delays change them.
- **Lease renewal** (`server/src/db/renew-step-lease.ts`). One READ
  COMMITTED transaction, lock first, authorize second:

  ```text
  BEGIN
  SELECT id FROM steps WHERE id = $id FOR UPDATE          -- lock only, no decision
  UPDATE steps SET lease_expires_at = clock_timestamp() + duration, updated_at = now()
   WHERE id = $id AND status = 'RUNNING' AND current_worker_id = $worker
     AND lease_version = $version AND lease_expires_at > clock_timestamp()  -- authorization
  COMMIT
  ```

  - The authorizing predicate is evaluated only once this transaction holds
    the row lock. The `UPDATE` takes a fresh snapshot, so it sees anything
    committed during the lock wait, and it cannot wait on another row lock
    between evaluating the predicate and writing. Why a single `UPDATE` was
    not enough: see "Lock-only holders" below.
  - It never changes `lease_version`, status, owner, payload or result.
  - Zero rows returns `{ renewed: false }` rather than throwing: losing a
    lease is an expected outcome. A rejected renewal never falls back to
    reacquiring the step.
  - **Expired leases cannot be renewed**, even before the sweeper runs.
    Otherwise a worker that froze past its deadline would, on waking, have
    its overdue renewal timer fire and race the sweeper to extend a lease
    that had already run out.
- **Renewal scope.** The worker renews exactly the generation it claimed
  (step id + worker + version). It does not extend every row whose
  `current_worker_id` matches. Worker IDs are reused across restarts (the
  demo uses fixed IDs), so a blanket renewal keyed on worker ID would let a
  restarted process keep its crashed predecessor's step leased
  indefinitely. It would also keep renewing a step whose executor had
  already thrown.
- **Lease authority on completion.** `completeStepSuccess` now also
  requires `lease_expires_at > clock_timestamp()`, using the same
  transaction shape as renewal (`SELECT ... FOR UPDATE`, then the `UPDATE`
  to `SUCCEEDED` carrying the full predicate, then `COMMIT`). An owner whose lease has
  expired cannot complete, whether or not recovery has run. The deadline,
  not the sweeper's schedule, ends the owner's authority. The cost is that
  work finishing after expiry but before the sweep is discarded and runs
  again. Full reasoning and rejected alternatives:
  `docs/decisions/0001-lease-deadline-is-authority.md`.
  - The time check and the generation check are not redundant. After a
    reclaim, `lease_expires_at` is the *new* owner's live deadline, so a
    stale owner passes the time check and only `lease_version` rejects it.
    Before any recovery, a lapsed owner passes the generation check and
    only the time check rejects it.
- **Which clock.**
  - Every coordination timestamp (heartbeat, claim deadline, renewal
    deadline) is written from PostgreSQL's `clock_timestamp()`, and every
    expiry comparison is made against it.
  - This is database **wall time**, not a monotonic logical clock. Both owner
    authority and recovery assume it does not jump backward across a
    previously expired deadline before recovery durably changes the row.
    Otherwise an expired but unswept generation can become time-eligible
    again. Milestone 5 does not solve wall-clock rollback.
  - Worker processes use their own clocks only to schedule *when* to
    attempt a write. The database decides whether the write is authorized.
    No worker compares `leaseExpiresAt` against its own clock.
  - `clock_timestamp()` rather than `now()` in the renewal/completion/
    recovery predicates. `now()` is fixed at transaction start — for the
    two-statement owner transactions that is `BEGIN`, before the lock wait —
    so it would evaluate expiry against a time from before the wait.
    Replacing it with `now()` in either owner predicate makes the lock-wait
    tests in `lease-races.test.ts` fail.
  - `EXPLAIN` confirms the cost: with `clock_timestamp()` the recovery
    deadline comparison is a filter, not an index condition. The partial
    index `steps_running_lease_idx ... WHERE status = 'RUNNING'` can avoid
    scanning terminal rows when chosen; small tables may use a sequential
    scan. The batch limit bounds recovered rows, not total scan work.
- **Lock-only holders: a hole found and fixed during Milestone 5.**
  Renewal and completion were first written as single `UPDATE` statements
  with the same predicates. An experiment on PostgreSQL 16.15 held a lock
  on the row from another transaction while a renewal waited and its
  deadline passed:

  | Lock holder | Predicate clock | Waiting renewal of an expired lease |
  |---|---|---|
  | Modifies the row | `clock_timestamp()` | Rejected |
  | Modifies the row | `now()` | Accepted |
  | Only `SELECT ... FOR UPDATE` | `clock_timestamp()` | **Accepted** |

  A single `UPDATE` evaluates its `WHERE` clause before it finds the row
  locked. After the wait PostgreSQL re-evaluates only if the holder
  modified the row; a lock-only holder leaves nothing to re-read, so the
  pre-wait "still live" result stood and an expired lease was extended.
  The first version relied on no application path intentionally taking a
  lock-only lock on a `RUNNING` row. That made the invariant "an owner cannot
  renew or complete once the database clock reaches its deadline" depend on
  no such lock ever existing.
  The first version documented this as a known gap; in review it was
  treated as a contradiction of the chosen semantic, and renewal and
  completion were changed to take the row lock before evaluating the
  predicate. `lease-races.test.ts` reproduces the lock-only case for both
  operations (the owner is confirmed waiting via `pg_stat_activity` while
  the database clock still shows the lease live, and the holder is released
  only after the database clock passes the deadline). Reverting either
  operation to a single `UPDATE`, or moving the expiry check into the lock
  query, makes those tests fail.
- **Recovery authority.** Recovery does not need a separate lock-first
  transaction to authorize expiry. For a fixed row version, "deadline has
  passed" stays true as the database clock advances. A concurrent committed
  change is checked/rechecked when locking the candidate. A renewed row is
  excluded only if its new deadline is still unexpired at that check; a
  delayed transaction can commit an already-expired deadline. A completed
  row fails the `RUNNING` predicate. The wall-clock assumption above applies.
- **Recovery** (`server/src/db/recover-expired-steps.ts`). One statement,
  preceded by static lifecycle checks. Milestone 7 adds the exhausted-budget
  terminal branch; the expired-candidate locking is unchanged:

  ```sql
  WITH expired AS (
      SELECT id
      FROM steps
      WHERE status = 'RUNNING'
        AND lease_expires_at <= clock_timestamp()
      ORDER BY lease_expires_at ASC, id ASC
      LIMIT 100
      FOR UPDATE SKIP LOCKED
  )
  UPDATE steps
  SET status = CASE WHEN attempt_count < max_attempts
                    THEN 'READY'::step_status ELSE 'DEAD_LETTERED'::step_status END,
      current_worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  FROM expired
  WHERE steps.id = expired.id
  RETURNING steps.id, steps.lease_version, steps.status;
  ```

  The CTE selects and locks at most 100 expired candidates. The same
  statement updates only those rows and holds their locks until transaction
  end. Locked candidates are skipped, allowing unrelated unlocked expired
  rows to recover. Later sweeps revisit skipped rows. `SKIP LOCKED` concerns
  row locks, not table locks or every possible database delay.
  - This is the only code path that performs `RUNNING -> READY`. The
    lifecycle table allows the edge's shape; this predicate authorizes it
    at runtime. There is no general "set status" operation.
  - It reads only the step row and the database clock, never `workers`.
    A stale heartbeat does not make a live lease recoverable, and a fresh
    heartbeat does not protect an expired one (both tested).
  - Both counters and `last_error` are preserved. When budget remains,
    recovery ends a generation; the next
    claim creates one (A claims v1 → expires → recovery leaves v1 → B
    claims v2).
  - `<= clock_timestamp()` is the exact complement of the owner-side
    `> clock_timestamp()`, so at any single instant a lease is either the
    owner's or recoverable, never both.
  - Batch size is fixed at 100. Only actively executing steps are bounded
    by worker loops. Persisted `RUNNING` rows can temporarily exceed worker
    count because failed/abandoned executions remain `RUNNING` until lease
    recovery: a worker can fail X, stop renewing it, then claim Y. This is
    another reason to bound each recovery batch.
- **Multiple sweepers.** Safe without leader election or advisory locks. A
  second sweeper skips locked candidates or rejects committed `READY` rows
  when checking/rechecking status (tested with four concurrent sweepers over
  30 expired rows: every row recovered exactly once). A failed statement
  rolls back its whole batch; the loop retries next tick. One coordinator is run.
- **Race outcomes.** Owner writes authorize under the row lock they hold;
  recovery selects unlocked expired candidates and updates them in the same
  statement. A sweep may skip even an expired row while a rejecting owner
  write holds it locked; the next sweep can recover it. No read-then-decide
  in application code.

  | Situation | Legal outcomes |
  |---|---|
  | Renewal vs recovery, lease live | Renewal extends; recovery matches nothing. |
  | Renewal vs recovery, lease expired | Renewal rejected; row either still `RUNNING` (not yet swept) or `READY`. Never re-extended. |
  | Completion vs recovery, lease live | `SUCCEEDED`; recovery matches nothing. |
  | Completion vs recovery, lease expired | Completion rejected; row `RUNNING`-expired or `READY`. |
  | Owner write waiting on a lock (modifying or lock-only holder) across the deadline | Rejected: evaluated after the lock is acquired. |
  | Owner write waiting on a lock, released while the lease is live | Accepted only if still live at the following UPDATE's predicate evaluation. |
  | Ownership replaced (new owner/version, live deadline) while the owner write waited | Rejected by owner/version, although the row's deadline is live. |
  | Sweep encounters an owner transaction whose renewal was authorized before the deadline | Skips the locked row; after commit, a later sweep skips only if the renewed deadline is still unexpired when checked. |

- **When authorization happens vs. when it is visible.** An owner write is
  authorized at the instant its `UPDATE` evaluates the predicate, while it
  holds the row lock. Its `COMMIT` arrives one client round trip later.
  Between those two points, other sessions reading without locks still see
  the old committed deadline, which may have passed; a recovery sweep skips
  the locked row. A later sweep sees the committed renewal or completion.
  So "no owner write is authorized at or after the deadline"
  holds; "no owner write becomes visible after the deadline" does not
  (tested: a sweep after the old deadline passes skips an in-flight renewal,
  and a subsequent sweep leaves its still-live committed deadline alone).
- **Tradeoff: the row lock is now held across client round trips.** Renewal
  and completion went from one round trip to four (`BEGIN`, lock, `UPDATE`,
  `COMMIT`), and the row lock is held from the lock statement until
  `COMMIT`. Normally that is well under a millisecond locally. But if the
  owning process stalls between those statements — frozen, paused, event
  loop blocked, or partitioned from PostgreSQL — the transaction stays open
  and keeps the lock. The original direct recovery `UPDATE` then stalled
  the entire batch (see the historical measurement in the build journal).
  Recovery now uses bounded `FOR UPDATE SKIP LOCKED` candidates, so unrelated
  expired rows can recover while this row remains locked. Recovery of the
  locked row itself is still delayed until the transaction releases it.
  PostgreSQL must detect a disconnected client before releasing its locks;
  partitions can delay that detection. No transaction timeout is introduced.

- **Worker loop** (`server/src/worker/worker-loop.ts`).
  - Per step: claim → start renewing that generation every 5s → execute →
    stop renewing, waiting out any in-flight renewal write → attempt
    guarded completion.
  - A rejected renewal stops renewal for good; a thrown renewal error is
    logged and retried next tick.
  - Completion is still attempted after a rejected renewal; the database
    rejects it. The worker does not decide ownership from local state.
  - In Milestone 5, executor exceptions stopped renewal and relied on lease
    recovery. Milestone 7 replaces that behavior with guarded failure
    reporting after renewal stops and drains; no deliberate expiry wait.
  - The executor is never cancelled when a lease is lost (no cancellation
    mechanism exists). It runs to the end and its completion is rejected.
  - Renewal is timer-based and only runs while the Node event loop is
    free. `hash_after_delay` waits asynchronously, which keeps it free.
    Code that blocks the event loop longer than the lease loses the lease
    (tested by synchronously blocking the loop past a short lease). Worker
    threads were not introduced to work around this.
- **Shutdown.**
  - SIGTERM/SIGINT stop new claims. A step already executing keeps its
    lease renewed while it finishes, then attempts completion or failure reporting.
  - The heartbeat loop is stopped only after the work loop has returned,
    then the pool closes. The `workers` row is left with its last
    heartbeat; there is no "stopped" marker.
  - SIGKILL or a crash runs none of this. Heartbeats and renewals stop, the
    step stays `RUNNING` until its deadline, and the sweep returns it to
    `READY` while attempt budget remains, or to `DEAD_LETTERED` if exhausted
    (Milestone 7). Work is not reassigned the moment a worker dies; it waits
    out the lease.
- **Coordinator process** (`server/src/coordinator/coordinator.ts`,
  `npm run coordinator`). Own pool, runs `runRecoveryLoop`, logs each
  recovered step with the lease version that expired. Milestone 7 adds a
  separate due-retry promotion pass before sleeping. It does not know
  which workers exist, does not read heartbeats, and does not signal
  workers. A dead coordinator delays recovery; it does not change who holds
  authority.
- **Tests.** All against real PostgreSQL. Concurrent actors use separate
  connections inside one Vitest process: they are logical actors, not
  separate OS processes.
  - `worker-heartbeat.test.ts`: registration, advancing heartbeats checked
    against database-clock readings, heartbeats leaving step rows
    byte-identical, stale heartbeat vs live lease, fresh heartbeat vs
    expired lease, the heartbeat loop starting and stopping.
  - `renew-step-lease.test.ts`: renewal advances only the deadline and
    `updated_at`; version never increments; wrong worker, older/newer
    version, `READY`, `SUCCEEDED` and expired-but-unswept leases are all
    rejected with the row untouched; a real 400ms claim lease is renewable
    before expiry and not after.
  - `recover-expired-steps.test.ts`: the full recovered-row shape;
    live leases (including 2s from expiry) untouched; non-`RUNNING` rows
    carrying an expired deadline and a stale owner untouched; the v1 → v2
    generation sequence, including that an expired-but-unswept step is not
    claimable; a locked expired row does not block an unrelated row and is
    recovered after release; batches stop at 100; four concurrent sweepers;
    the recovery loop.
  - `complete-step.test.ts`: completion by the right owner and version is
    rejected once the lease has expired, before any recovery.
  - `lease-races.test.ts`: renewal vs recovery and completion vs recovery
    raced on separate connections, 25 rounds each, against expired and live
    leases; renewal and completion held behind a row-modifying holder and
    behind a lock-only holder across the deadline (rejected), and behind a
    lock-only holder released while live (accepted); ownership replaced
    during the wait (rejected); sweeps skip lock-only and renewing holders,
    then recover an expired row or leave a still-live renewal alone after
    the holder commits;
    60 completions each sent close to their own row's deadline while three
    sweepers run continuously, with every row checked to be in exactly one
    legal state consistent with what each side reported.
  - `worker-loop.test.ts`: a step outlasting its lease completes at v1 via
    renewal; shutdown mid-step still completes; a throwing executor stops
    renewal; a blocked event loop loses the lease, completion is rejected,
    and after recovery the same step runs again and completes at v2.
  - The tests were checked against deliberately broken versions, each
    making specific tests fail: `now()` instead of `clock_timestamp()` in
    renewal or completion; removing the expiry check from renewal,
    completion or recovery; recovery or renewal incrementing
    `lease_version`; heartbeats extending the owner's leases; renewal left
    running after an executor failure. After the lock-first change: renewal
    or completion without the lock statement (a single `UPDATE` again), with
    the expiry check moved into the lock query, or with `now()` in the
    authorizing `UPDATE`.
- **Demo** (`npm run demo:recovery`, `server/src/worker/run-recovery-demo.ts`).
  - Real local child OS processes on one machine, one coordinator and three
    workers, at production timings (~50s).
  - Submits a 40s step, an 8s "victim" step and two short steps. SIGKILLs
    whichever worker owns the victim, then prints, from PostgreSQL:
    - the killed worker's heartbeat timestamp unchanged after a post-kill
      baseline while survivors stay fresh;
    - samples of the victim `RUNNING` under the killed worker before expiry;
    - later samples after expiry showing recovery/reclaim and generation
      advancing from v1 to v2;
    - the 40s step's lease being renewed past one 30s lease and finishing
      at `lease_version` 1.
  - Exits non-zero if a sampled check fails. Refuses to run if unrelated
    non-terminal steps exist.
  - Task state and `clock_timestamp()` are read in the same sample. A sampled
    recovered/reclaimed state before the original deadline fails the demo.
    Polling does not prove the exact instant recovery occurred; a transient
    state can be missed. Terminal state alone does not retain worker attribution.
  - Children are started as `node --import tsx`, not via the `tsx`
    launcher: the launcher forwards SIGTERM to the real Node process but
    cannot forward SIGKILL, so killing it would leave the worker running
    (see the build journal).
  - Confirmed locally on macOS only, not on the Replit Reserved VM.
- **What this milestone does not provide.**
  - Exactly-once execution. After recovery the same step runs again; a
    lapsed owner's executor may have finished its work too.
  - Protection for side effects performed before a lease was lost
    (idempotency, not built).
  - Cancellation of an executor that has lost its lease.
  - Protection against event-loop blocking longer than the lease.
  - Milestone 5 had no bound on retries; Milestone 7 adds a total claim budget.
  - Any guarantee on recovery latency if the coordinator is down.
  - Detection of a worker that heartbeats but makes no progress: its lease
    stays live as long as renewals succeed.
  - A bound on how long an owner process that stalls mid-transaction can
    hold a row lock and delay recovery of that row. Unrelated expired
    unlocked rows can now recover in bounded batches.
  - Protection against database wall-clock rollback across an expired
    deadline before recovery durably changes the row.

### Stale-owner fencing (Milestone 6)

Durable Runner uses increasing ownership generations (`lease_version`) as
fencing tokens: a worker carrying generation N cannot renew or complete
durable step state owned by generation N+1. The production write predicates
already supplied this protection; this milestone adds direct evidence.

Three mechanisms have distinct jobs:

- **Lease authority:** bounds an owner's authority by PostgreSQL wall time,
  even before a recovery sweep. Both renewal and completion require an
  unexpired deadline. The Milestone 5 wall-clock assumption still applies.
- **Recovery:** clears expired ownership and returns the step to READY,
  preserving its generation. It makes the work claimable again.
- **Fencing:** rejects writes carrying a superseded generation after a
  fresh claim increments the version. The stored live deadline now belongs
  to the new owner, so checking that deadline alone cannot reject the old one.

```text
A claims v4
A freezes
v4 expires
recovery -> READY v4
B claims -> RUNNING v5 with a live deadline
A wakes
A's v4 completion/renewal -> zero rows, rejected
```

Worker ID is not a process lifetime. If A1 and A2 both use `worker-a`, then
after recovery and A2's claim the stored worker ID still matches A1's stale
request. With RUNNING status and A2's live deadline, `lease_version` is the
only false term in A1's authorization predicate. This is why checking the
worker ID without its claimed generation is insufficient.

Renewal and completion retain their Milestone 5 transaction structure,
under READ COMMITTED on a single connection:

```sql
BEGIN;
SELECT id FROM steps WHERE id = $id FOR UPDATE;
-- Then UPDATE with the complete authorization predicate:
-- WHERE id = $id
--   AND status = 'RUNNING'
--   AND current_worker_id = $worker
--   AND lease_version = $claimed_version
--   AND lease_expires_at > clock_timestamp()
COMMIT;
```

The first statement acquires the row lock without deciding authority. The
second statement has a fresh snapshot and evaluates authority after the
lock wait. A zero-row UPDATE rejects the operation without compensating
writes. Renewal returns `renewed: false`; completion raises
`CompletionConsistencyError` after releasing the lock. The worker stops a
rejected renewal loop, lets its executor finish, and reauthorizes completion
in PostgreSQL. It logs rejection and moves on to ordinary fresh claiming;
it never resets ownership or retries a stale completion as compensation.

**Database evidence** (`server/tests/fencing.test.ts`): four integration
tests cover stale completion and renewal under both different and identical
worker IDs, using separate connections for the old and new lifetimes.
They use actual claims, PostgreSQL-confirmed expiry, recovery, and reclaim;
they do not fabricate a new owner/version with a fixture UPDATE. Each proves
`0 -> claim 1 -> recovery 1 -> claim 2 -> terminal 2`. A full-row comparison
around rejection preserves microsecond timestamps and checks status, owner,
version, deadline, result, payload, priority, availability and other stored
columns. V2 is live before and after rejection and can itself renew and
complete, ruling out a test that merely rejects all writers.
Removing only the completion version guard makes the same-ID completion
test fail because the stale write succeeds. Removing only the renewal
version guard makes the same-ID renewal test fail with `renewed: true`.
Both guards were restored afterward.

**Process evidence** (`npm run demo:fencing`): direct `node --import tsx`
children run the existing coordinator and ordinary workers at production
timings. A starts first; after its executor-start log, the parent sends
SIGSTOP to the PID logged by A and verifies the OS reports it stopped. A
lock-only NOWAIT probe fails promptly if the pause caught a retained step
transaction. Samples show RUNNING v1 before expiry, an unchanged post-stop
heartbeat baseline, PostgreSQL-confirmed expiry, then coordinator recovery
to READY v1. B starts after that sample, claims v2 and completes the same
12-second deterministic task. Its heartbeat advances while A stays stopped.
SIGCONT resumes the same A process and its original pending execution; the
demo requires A's explicit v1 completion rejection, forbids a v1 success
log, and compares the entire terminal row against a snapshot taken before resuming A.
It checks again after child shutdown and exits nonzero on failure.

This demo uses different worker IDs and resumes A after v2 is terminal:
status and worker identity also reject its write. The same-ID database
tests with a live RUNNING v2 isolate the version predicate itself. Polling
shows sampled states, not the exact recovery instant. Task state and database
time are sampled together, and any sampled handover before the original
deadline fails the demo. The demo refuses unrelated non-terminal work and
cleans up its child processes, including a stopped A on failure.

Fencing protects these controlled durable writes. It does not provide
exactly-once execution or exactly-once side effects, prevent stale code from
continuing to execute, physically kill stale workers, or protect external
side effects. Milestone 6 introduced no new lifecycle state, durable event history,
retry policy, or idempotency mechanism. Terminal rows preserve the generation
and result, but do not retain worker attribution or the intermediate history.

### Explicit failure, retries, and dead-lettering (Milestone 7)

`steps` now holds `attempt_count integer NOT NULL DEFAULT 0`,
`max_attempts integer NOT NULL DEFAULT 3`, and nullable `last_error text`.
Checks require a nonnegative attempt count and a positive maximum. These
are current policy/state fields, not an attempt history. Migration 0004
uses ordinary additive defaults. The existing development row was terminal;
its historical attempts were not inferred from its generation or backfilled.
Existing rows therefore start counting post-migration claims from zero.

`lease_version` counts ownership generations and fences stale writes.
`attempt_count` counts successful claims as execution attempts. A claimed
worker is about to execute; a crash between the claim and executor still
consumes an attempt. There is no two-phase claim/start protocol. Both
counters increment in the claim transaction and are returned to the worker,
but they serve different purposes and are never substituted for each other.
Failure, retry promotion, lease renewal, completion, and expiry recovery do
not increment either counter.

For an observed retryable executor failure, `max_attempts` includes the
first attempt: with a budget of three, failures on attempts one and two
enter RETRY_WAIT; failure on attempt three enters DEAD_LETTERED. Invalid
input or an unsupported task type dead-letters immediately. The executor's
single `InvalidTaskError` distinction identifies input validation failures;
ordinary runtime exceptions remain retryable until budget is exhausted.
There is no configurable error taxonomy or retry-policy framework.
Claim selection and its guarded UPDATE require `attempt_count < max_attempts`,
so even an exhausted READY row cannot consume a fourth attempt. The budget
is checked under the claim's existing row lock, including with concurrent
claimers. A final attempt may still renew and succeed while its lease is live;
reaching the count limit does not revoke its current authority.

`recordStepFailure` follows the existing lease-authority transaction:

```text
BEGIN (READ COMMITTED)
SELECT id FROM steps WHERE id = $id FOR UPDATE
UPDATE with id, RUNNING, worker ID, lease_version,
  AND lease_expires_at > clock_timestamp()
COMMIT
```

The first statement only takes the lock. The authorizing UPDATE runs with
its own fresh snapshot after any wait. Under that lock, SQL decides whether
`retryable AND attempt_count < max_attempts`; no unlocked read decides the
outcome. Both legal transition shapes pass through the lifecycle check.
A zero-row result means rejection with no compensating mutation. An expired
owner cannot choose retry/dead-letter policy even before recovery, and a
stale generation cannot make that decision for a new live owner, including
one using the same worker ID. The PostgreSQL wall-clock assumption from
Milestone 5 also applies to failure authorization and retry scheduling.

On RETRY_WAIT, failure reporting clears owner and lease, preserves both
counters, payload and result, stores `last_error`, and sets `available_at`
from PostgreSQL time plus deterministic backoff:

```text
min(500ms * 2^(attempt_count - 1), 4000ms)
500ms, 1000ms, 2000ms, 4000ms, 4000ms, ...
```

The exponent is capped before computing the power. Backoff is evaluated
only for a retry. A materialized one-row clock CTE in the authorizing
statement supplies one scheduling instant; it and the resulting deadline
are returned as PostgreSQL timestamp strings, retaining microseconds for
exact interval assertions. A delayed transaction may commit after its
scheduled availability; the delay is measured from the database scheduling
instant, not from COMMIT. There is no jitter.

On DEAD_LETTERED, failure reporting clears owner/lease and stores the error,
but leaves availability unchanged and schedules nothing. It is terminal:
no claim or promotion path reads it as eligible. There is no manual replay.
Successful completion retains `last_error` as the most recent failure, not
as an assertion that the terminal result failed.

`promoteDueRetries` locks up to 100 rows where `status = 'RETRY_WAIT' AND
available_at <= clock_timestamp()`, ordered by availability then ID, with
`FOR UPDATE SKIP LOCKED`. Its UPDATE only sets READY and updated_at. It
preserves generation, attempts, error, payload and availability. Locked
rows are eligible on later passes; multiple coordinators safely divide
candidates. RETRY_WAIT already represents a retry decision, so promotion
does not reclassify the error or reconsider the budget. A later fresh claim
consumes the next attempt and creates the next ownership generation.

The coordinator runs expiry recovery, then due-retry promotion, then sleeps.
Each pass has separate error handling and a 100-row batch; no generic
scheduler or leader election was introduced. Promotion is a liveness step:
coordinator downtime delays readiness without granting ownership to an old
worker. Backoff is minimum eligibility time, not an exact execution time.

On executor success or failure, the worker stops and drains lease renewal
before its corresponding guarded write. It does not wait for expiry after
a normal error. A rejected failure report is logged and abandoned; a DB
error means unknown outcome. Neither case resets the row or retries a stale
report. Only an ordinary fresh claim can supply further work.

`fail_then_hash` accepts `{ input, failuresBeforeSuccess }`. Input must be
a nonempty string and the failure count a nonnegative safe integer. It
throws a deterministic runtime error when the claim's durable attempt count
is at most that threshold, otherwise returns the input's SHA-256 hash.
No process-local attempt memory or side effect is involved.

`npm run demo:retries` starts a real coordinator and two direct Node worker
processes. With normal backoff values, one task fails twice then succeeds
at attempt 3/v3; a poison task dead-letters at attempt 3/v3. It asserts
terminal PostgreSQL state, counters, cleared ownership, unchanged payloads,
results and errors. Committed-operation logs show transient states that
polling can miss; no exact transition instant or durable event history is
claimed. The demo refuses unrelated non-terminal work and shuts down all
children.

Crash recovery remains distinct from an observed failure report: a missing
worker cannot report an exception. The expiry sweeper returns a row to READY
only while `attempt_count < max_attempts`; an exhausted expired row goes
directly from RUNNING to DEAD_LETTERED. Both branches preserve the counters,
availability, payload, result and `last_error`. No executor exception is
invented and no retry backoff is scheduled for a crash. `last_error` can be
null on a row dead-lettered solely due to repeated lease expiry.

This exception to unconditional recovery-to-READY is necessary because
claiming consumes attempts. Otherwise a final-attempt crash would either
permit a fourth claim or strand an unclaimable READY row. The decision and
tradeoff are recorded in [ADR 0002](decisions/0002-attempt-budget-includes-crashes.md).
The tests exercise three real claim/expiry/recovery cycles, ending terminal
at attempt 3/v3 without a fourth claim. Finite budgets mean a step can
dead-letter without ever reaching its executor if every claimant crashes
between claim and execution. There is no automatic or manual replay here.

### Idempotency

An idempotency record (keyed by something like `step_id` + `attempt` or a
caller-supplied key, table TBD) is written before/around performing an
external side effect, so a retried step can detect "this side effect
already happened" and skip re-performing it, independent of whether fencing
also applies.

### Verification

Executor completion (the executor function returned without error) and
verified success (the system checked the result and confirmed it) are
recorded as separate facts. A step can complete execution and still fail
verification, which is expected to trigger a retry like any other failure.

### Event history

An append-only table of structured events (state transitions, claims,
retries, verification outcomes) is the source of truth for what the browser
displays. The browser is not inferring history from current state alone.

### API shape

REST for commands and history queries; one SSE endpoint for live push. See
open question below on how SSE and REST history relate. Confirmed by the
environment spike: the local dev setup proxies `/api/*` from the Vite dev
server to the Fastify server, so no CORS middleware is needed for local
development. In production the frontend and API are served from the same
Fastify process (see below), so they're same-origin there too — no CORS
middleware needed in either mode.

### Production process & serving

One Fastify process is the whole deployed web service — it serves the
built React app (static files) and `/api/*`/SSE together. No reverse
proxy, no second server. Confirmed locally: `npm run build` (`vite build`
for the frontend, `tsc` for the server, excluding `tests/`) followed by
`node dist/server/src/index.js` serves the built `index.html`/JS, answers
`GET /api/health`, and streams `/api/events` correctly.

- `@fastify/static` is the one new dependency this required — the minimal,
  officially-maintained way to serve a static directory from Fastify
  without hand-rolling file serving/caching.
- The server only registers the static plugin if `web/dist` exists
  (checked at startup), so local dev (`npm run dev:server`, no build
  present) is unaffected — the Vite dev server keeps handling the frontend
  there, as before.
- The server binds to `HOST` (default `0.0.0.0`) and `PORT` (default
  `3000`) from the environment, needed for it to be reachable inside a
  container/VM rather than only from localhost.
- `.env` is a local-only convenience (loaded via `process.loadEnvFile()`,
  which no-ops if the file is absent). Confirmed locally: with `.env`
  removed and `DATABASE_URL` supplied only in the process environment, the
  production server starts and `GET /api/health` reports `"db": "ok"`.
  This is the mechanism Replit's own secrets/environment variables are
  expected to use.

## Unresolved questions

These need a decision before (or early in) the corresponding milestone —
see the "Unresolved architecture decisions" list tracked with Phase 0 for
the ones already framed with alternatives.

- Worker process model on Replit: child processes vs. logical loops —
  pending the environment spike.
- Wake-up mechanism for workers/coordinator: fixed-interval polling vs.
  Postgres `LISTEN`/`NOTIFY`.
- SSE relationship to REST history: does SSE only push new events after the
  client separately fetches history over REST, or does it also replay
  history on connect?

## Possible production evolution (explicitly not built)

This section exists only to be honest, if asked, about what a further
evolution beyond this project's scope might look like in general terms. None
of it is implemented, scheduled, or assumed by the current design:

- Running workers on more than one machine, which would require moving
  coordination fully into Postgres queries (already the plan) and removing
  any assumption of shared process memory (already avoided).
- Replacing fixed-interval polling with a push-based wake-up mechanism if
  latency mattered more than it does for this project's goals.
- Running more than one API server instance, which would need the SSE
  layer to source live updates from Postgres rather than from in-process
  state, since two server instances don't share memory.

Nothing above names a specific product to adopt (broker, cache, orchestration
platform); the point of this project is to demonstrate the mechanisms
themselves, not to pick a production stack for a system that doesn't exist
yet.
