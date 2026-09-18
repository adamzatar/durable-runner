# Build journal

Entries only for things that actually happened and affected the build —
not a routine setup log.

## 2026-09-16 — environment spike

- The only local Postgres already present was a password-protected system
  service (EDB installer, port 5432) with no known credentials. Rather than
  touch it, installed an isolated `postgresql@16` via Homebrew (keg-only,
  not linked into `/opt/homebrew/bin`), with its own data directory under
  `~/.durable-runner/pgdata`, listening on port 5433. Fully separate from
  the system service.
- That new instance failed to start with
  `FATAL: postmaster became multithreaded during startup` — a known
  macOS-specific Postgres bug tied to locale environment variables not
  being set for the launching process. Fixed by exporting `LC_ALL=C`
  before calling `pg_ctl start`. Anything that starts this Postgres
  instance (locally) needs that env var set.
- Planned to load `.env` via `NODE_OPTIONS=--env-file=.env` in npm scripts.
  Node rejects `--env-file` inside `NODE_OPTIONS` outright
  (`--env-file= is not allowed in NODE_OPTIONS`). Also tried passing
  `--env-file` directly to the `vitest` CLI; vitest's own arg parser
  rejects unrecognized flags rather than forwarding them to Node. Settled
  on calling `process.loadEnvFile()` (Node 20.12+, no dependency) from a
  small `server/src/load-env.ts` imported first by each entrypoint
  (`index.ts`, `migrate.ts`, `run-experiment.ts`) and from a Vitest
  `setupFiles` entry — one mechanism, works everywhere, still no `dotenv`
  dependency needed.
- `drizzle-kit generate` turned out to already read `.env` from the
  working directory on its own (bundles its own env loading) — didn't need
  the workaround above for that one command.
- Pinned dependency versions initially picked (`drizzle-orm@^0.36.0`,
  `drizzle-kit@^0.28.0`) resolved to older releases than expected — a
  0.x caret range only floats the patch version, not the minor. `npm audit`
  flagged the resolved `drizzle-orm` as vulnerable to a real SQL-injection
  issue in identifier escaping (GHSA-gpj5-g38j-94v9). Bumped to
  `drizzle-orm@^0.45.2` and `drizzle-kit@^0.31.10`. Remaining `npm audit`
  findings after that are all dev-tooling-only (Vite dev server, Vitest UI
  server, the esbuild loader inside `drizzle-kit`) — none touch a runtime
  dependency, left as-is for now given local-only usage.
- The `vite` CLI takes the project root as a positional argument
  (`vite web`), not a `--root` flag — `vite --root web` fails with
  `Unknown option --root`. Fixed the `dev:web` script accordingly.

## 2026-09-16 — Milestone 3 claiming

- The first version of the claim computed `lease_expires_at` from `now()`,
  and a comment in it listed "the same instant is reused for the lease
  deadline" as a benefit. That was wrong. PostgreSQL's `now()` is fixed at
  transaction start, so any delay between `BEGIN` and the ownership
  `UPDATE` quietly came off the lease: a claimer could commit ownership of
  a "30-second" lease with noticeably less than 30 seconds left. Caught in
  review before commit. Changed the deadline to `clock_timestamp()` (the
  database's actual time when the `UPDATE` runs), kept `now()` for
  eligibility, and added a test that fails if the deadline goes back to
  being measured from transaction start.

## 2026-09-17 — Milestone 5 heartbeats, leases, recovery

- Before choosing between `now()` and `clock_timestamp()` in the lease
  expiry predicates, checked PostgreSQL 16's behaviour directly instead of
  assuming it. A single-statement renewal `UPDATE` was made to wait on a row
  lock while its lease deadline passed. When the lock holder had *modified*
  the row, PostgreSQL re-evaluated the `WHERE` clause after the wait:
  `clock_timestamp()` rejected the renewal, `now()` accepted it. When the
  lock holder had only run `SELECT ... FOR UPDATE`, there was no
  re-evaluation, and both versions renewed the already-expired lease. The
  first result decided the predicate. Renewal and completion were
  implemented as single `UPDATE` statements, and the lock-only result was
  written up as a known gap, on the grounds that nothing in the code takes
  that kind of lock on a `RUNNING` row.
- In review, that was called out as contradicting the lease-authority
  decision itself: "an owner cannot renew or complete once the database
  clock reaches its deadline" was only true as long as no lock-only holder
  ever existed. Changed renewal and completion to a transaction that runs
  `SELECT ... FOR UPDATE` first and evaluates the full predicate in the
  following `UPDATE`, after the lock is held. Added regression tests that
  hold a lock-only lock across the deadline for each operation. With the
  lock statement removed, with the expiry check moved into the lock query,
  or with `now()` in the `UPDATE`, those tests fail. Recovery was left as a
  single statement: its "expired" condition cannot become false during a
  lock-only wait, and two added tests cover it.
- That change moved the row lock from inside one server-side statement to
  across client round trips. Measured the consequence: with an owner
  transaction stalled for 2.5s after its lock statement, the recovery sweep
  (a single multi-row `UPDATE`) blocked for the whole 2.5s and did not
  recover an unrelated expired row in the meantime. Also checked two ways
  of avoiding that, neither adopted at that point: `SET LOCAL
  idle_in_transaction_session_timeout = '1s'` inside the owner transaction
  made PostgreSQL terminate the stalled session after ~1s and the sweep
  finished at ~1.0s; and a single-statement form (`WITH locked AS
  MATERIALIZED (SELECT ... FOR UPDATE) UPDATE ... FROM locked WHERE
  <predicate on locked's columns>`) also rejected an expired renewal held
  behind both a lock-only and a row-modifying holder.
- The crash demo needed to SIGKILL a worker. `run-demo.ts` and the Phase 0
  `run-experiment.ts` spawn children through the `node_modules/.bin/tsx`
  launcher. Checked by PID: that launcher runs the script in a separate
  grandchild Node process. Sending SIGKILL to the launcher killed the
  launcher but left the grandchild alive, reparented to PID 1 and still
  running. (A first version of that check grepped `ps` for the evaluated
  snippet and reported no survivors, but tsx had rewritten the code in the
  process's command line, so the grep could never have matched; checking by
  PID showed the orphan.) SIGTERM, which the earlier demos send, is forwarded
  by the launcher, which is why this had not shown up. `run-recovery-demo.ts`
  spawns `node --import tsx <script>` instead, so the PID that is killed is
  the worker. The earlier demos were left as they are; they only send SIGTERM.
- The first version of the completion-vs-recovery test spread 40 deadlines
  over -50ms..+500ms and fired every completion at once. Logging its outcome
  counts over five runs gave the identical split every time — 35 completed,
  5 recovered, 0 expired-unswept — so the test was only exercising rows whose
  outcome was already certain. Rewrote it to insert all deadlines from one
  statement approximately 5ms apart (`clock_timestamp()` is evaluated per
  row, not frozen for the statement) and send each completion aimed at its own row's
  deadline with a fixed ±4ms jitter while sweeps run continuously. Six runs
  then split 14/46, 21/39, 21/39, 21/39, 21/39, 27/33, showing completions
  actually landing on both sides of their deadlines.

## 2026-09-17 — Milestone 5 final recovery cleanup

- Changed recovery to one CTE/UPDATE statement selecting up to 100 expired
  RUNNING rows in deadline/ID order with `FOR UPDATE SKIP LOCKED`. The
  previously measured whole-batch stall is no longer the recovery behavior:
  a locked expired row is deferred while unrelated unlocked rows recover.
  The row's own recovery can still be delayed indefinitely by its lock.
- Added a two-connection regression: lock expired X without changing it,
  recover expired Y while X remains locked and unchanged, release X, then
  recover X. Both preserve their generations. A separate 101-row test checks
  the fixed batch limit and recovery of the remainder on the next sweep.
- Temporarily removed `SKIP LOCKED`: the new regression failed with
  PostgreSQL error 57014 (`statement timeout`) at its 2s test-only watchdog.
  Restored `SKIP LOCKED`; the same test passed. No timeout was added to
  production code.
- Corrected the false bound on persisted RUNNING rows: only executing
  steps are bounded by worker loops; abandoned/failed rows await recovery.
  Crash-to-recovery timings are healthy-path estimates, and both owner
  authority and recovery assume database wall time does not jump backward
  across an expired deadline before recovery durably changes the row.
- The demo now reads task state and database observation time in one
  sample, checks sampled handover against the original deadline, verifies
  the worker exited from SIGKILL, and describes its evidence as sampled.
  Its direct `node --import tsx` launch is unchanged. Polling does not prove
  the exact recovery instant.
- Validation: schema generation reported no changes, migrations applied,
  typecheck and build passed, and the full suite passed 106 tests. Three
  additional runs of the lease/recovery/renewal/completion files each passed
  all 35 tests. The real SIGKILL demo passed: worker-a died at v1, a sample
  after the original deadline saw READY, worker-c reclaimed and completed
  v2, and the 40s step completed at v1. The killed worker's heartbeat did
  not advance after the post-kill baseline. All recorded demo processes
  and their remaining helpers were verified gone afterward.

## 2026-09-17 — Milestone 6 stale-owner fencing

- The existing production predicates needed no change. Added four real
  PostgreSQL tests that actually claim v1, wait for database-confirmed expiry,
  recover READY v1, and claim v2. Completion and renewal reject stale v1
  with different worker IDs and with the same ID reused on a separate
  connection. The same-ID cases keep v2 RUNNING and live before and after
  rejection, isolating the version term. Full JSON row comparisons retain
  timestamp microseconds and verify rejection writes nothing; v2 can then
  renew and complete. Each test checks `0 -> 1 -> 1 -> 2 -> 2`.
- Removed only the completion version predicate temporarily: the same-ID
  test failed because its stale completion resolved successfully. Restored
  it, then removed only the renewal version predicate: that same-ID test
  failed with `renewed: true`. Restored both guards. No new fencing bug was
  found in the original write paths, and no architecture decision changed.
- Added an executor-start log after invoking the existing executor and a
  direct-Node SIGSTOP/SIGCONT demo. The logged worker PID matched the child
  being signalled, and `ps` reported it stopped. Samples showed unchanged
  RUNNING v1 before expiry, no post-stop heartbeat advancement, READY v1
  after database-confirmed expiry, and B claiming and completing v2. B's
  startup is delayed until READY is sampled so that state cannot be missed.
- Both demo runs resumed the same A PID with its original executor pending.
  An overdue renewal fired and was rejected; completion was still attempted
  with v1 and rejected with zero rows. The entire v2 terminal row remained
  unchanged through A's attempt and child shutdown. All children shut down
  cleanly. This different-ID, terminal-state demo demonstrates the real
  resumed execution; the live same-ID tests isolate generation fencing.
- Validation: 110 tests across 12 files passed. Three additional fencing
  runs passed all four tests each. Both real demos passed. Schema generation
  found no changes; migration, typecheck, build, and diff whitespace checks
  passed. The demo does not establish an exact recovery instant, and none
  of this protects external effects or provides exactly-once execution.

## 2026-09-17 — Milestone 7 total-budget edge

- Counting attempts at claim exposed a conflict with unconditional expiry
  recovery: a crash on the final allowed attempt would return an exhausted
  row to READY. Allowing another claim violates the total budget; refusing
  it alone strands that row. The total-cap policy now dead-letters expired
  exhausted rows and guards claims by remaining budget (ADR 0002). It does
  not turn expiry into an invented executor exception; last_error is preserved.
- The new crash regression exercises three actual claims, database-confirmed
  expiries, and recovery passes. Restoring unconditional READY recovery made
  it fail at the third expiry. Removing the claim-budget guards separately
  produced an actual fourth claim (`attemptCount: 4`) and failed the exhausted
  READY test. Both mutations were restored. The reported-failure off-by-one
  mutation (`<=` instead of `<`) also incorrectly scheduled another retry at
  attempt three and was detected.
- Existing development data had one terminal row at generation 2, with no
  durable attempt history. The additive migration initializes its attempt
  count to zero rather than pretending generation 2 proves two executions.
  New claims count attempts from migration onward; ownership generations
  retain their existing meaning.

## 2026-09-17 — Milestone 8 idempotent effects

- Checked PostgreSQL 16.15's `INSERT ... ON CONFLICT DO NOTHING` behaviour
  before designing around it, rather than assuming. With another transaction
  holding an uncommitted insert of the same key, the statement waits on that
  transaction (`pg_stat_activity.wait_event_type = Lock`) and returns zero
  rows once it commits; it does not raise a unique violation. That is what
  makes "zero rows means it already exists" a safe branch.
- The obvious single-statement form of the same operation is wrong, and the
  experiment caught it before any code depended on it. A CTE combining
  `INSERT ... ON CONFLICT DO NOTHING` with a `UNION ALL` fallback `SELECT`
  returned **zero rows** when the conflicting row was committed by another
  transaction during the wait: a statement's snapshot is taken before it
  blocks, so the fallback select cannot see that row. Under the same race,
  two separate statements returned the stored result correctly, because the
  second statement takes a fresh snapshot under READ COMMITTED. The effect
  operation is therefore two statements, and the reason is recorded in the
  code so nobody "optimizes" it back into one.
- Wrote a test for the `EffectStateError` guard (key present for the insert's
  conflict, gone by the follow-up read) and deleted it again: triggering it
  needs a delete to land between the two statements, and the attempt raced —
  the caller's read won and the effect was reused instead. Reaching that path
  reliably would need a test-only seam in production code, which is worse
  than an untested defensive guard. The guard stays, with a comment saying it
  is deliberately uncovered and why.
- The first demo run passed end to end with no adjustment: worker-a applied
  the effect, was SIGSTOPped inside `delayAfterEffectMs`, lost its lease,
  worker-b claimed v2 and completed the step carrying worker-a's `effectId`,
  and worker-a's resumed v1 completion was rejected — one effect row
  throughout.

## 2026-09-18 — Milestone 9 event cursor

- Checked the polling cursor against PostgreSQL before building on it, and
  the obvious design turned out to be broken. `bigserial` ids are allocated
  at INSERT, rows become visible at COMMIT, and those orders are independent.
  Staged it directly: transaction A inserted event id 1 and stayed open,
  transaction B inserted id 2 and committed. A reader doing
  `WHERE id > $cursor ORDER BY id` saw only id 2, advanced its cursor to 2,
  and after A committed, id 1 was permanently behind the cursor. A committed
  transition would simply never have been delivered. Both halves of that —
  the naive reader losing the event, and the watermark reader delivering
  both — are now tests rather than claims.
- Settled on storing each event's writing transaction (`xid8`) and reading
  with `xid < pg_snapshot_xmin(pg_current_snapshot())` plus a composite
  `(xid, id)` cursor, after rejecting an overlap window (the safe overlap is
  unbounded), serializing all event inserts behind a lock (a global
  bottleneck in front of every transition, right before the benchmarking
  milestone) and ordering by timestamp (same defect). ADR 0003 records the
  alternatives. Verified before implementing that `xid8` supports a btree
  index and that the planner uses `(xid, id)` for both the watermark and the
  cursor comparison.
- Ordering by `id` alone was not enough even with the watermark: a
  transaction can be assigned a lower xid and still allocate a higher id, so
  two already-final transactions can disagree. The sort key is `(xid, id)`
  for that reason.
- Recovery and promotion kept their single-statement `SKIP LOCKED` shape by
  writing their events in a data-modifying CTE over the rows the UPDATE
  returned. The alternative — UPDATE, then a separate INSERT inside a
  client-side transaction — would also have been atomic but would have held
  every recovered row's lock across an extra client round trip, which is the
  thing Milestone 5 established a sweep must not do.
- The rollback proof needed a deterministic way to fail an event insert. A
  `BEFORE INSERT` trigger created and dropped inside the test does it at the
  database boundary, with no permanent hook in production code. One surprise
  while writing it: Drizzle wraps driver errors as "Failed query: ...", so
  the injected message is on the cause chain, not `error.message` — the first
  version of the assertion passed for the wrong reason until that was fixed.
