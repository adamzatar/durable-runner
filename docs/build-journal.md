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
