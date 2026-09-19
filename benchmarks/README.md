# Benchmarks (Milestone 10)

**Status: results pending.** The previously stored artifact was moved to
[`results/invalid/`](results/invalid/) unapproved; no numbers from it are
presented here. This document will be updated with methodology and results
from the first approved full run of `npm run bench`.

The benchmark measures the finished runtime: PostgreSQL `FOR UPDATE SKIP
LOCKED` claiming, leases, heartbeats, lease renewal, fencing by
`lease_version`, lease-expiry recovery, retries/backoff/dead-lettering,
idempotent effects, and a durable `step_events` row written inside every
lifecycle transition. Nothing is switched off for these numbers. The one
comparison that removes the event write is a separate, labeled,
benchmark-only experiment and is not the source of any other number here.

The benchmark answers six questions:

1. How does throughput change with the number of worker processes?
2. What is end-to-end completion latency, and what is it made of?
3. Does concurrent claiming ever grant the same ownership generation twice?
4. Does a worker whose generation has ended ever get a durable write accepted?
5. Does repeated or concurrent execution ever produce a second logical effect?
6. What machine and software produced the numbers?

## Isolation

The harness uses its own database, `<DATABASE_URL database>_bench`, created
on first use and migrated with the application's own migrations. It is never
the development/test database:

- `claimNextStep` claims whichever `READY` row sorts first, so isolation by a
  name prefix inside a shared database is not possible — benchmark workers
  would claim test or demo rows.
- A separate database lets each run start from truncated tables. The harness
  refuses to create a pool, or to truncate, unless the database name ends in
  `_bench`, and holds a PostgreSQL advisory lock for the whole invocation so
  two harness invocations cannot share the database. A second concurrent
  invocation exits with code 3 without touching the database.

Before each timed run: `TRUNCATE` the runtime tables, insert the fixture,
verify the fixture row count is exactly the requested size, `VACUUM
(ANALYZE) steps`, `CHECKPOINT`. Migration, process start-up and fixture
creation are never inside a timed window. After each timed run the measured
task count must equal the requested count and every reported rate/percentile
must be finite; a run that fails either check aborts the invocation instead
of recording a partial result.

## Reproduce

```bash
npm install
# PostgreSQL reachable at DATABASE_URL (see .env.example); the role must be
# able to CREATE DATABASE. The harness creates and migrates <db>_bench itself.
npm run bench -- --quick             # smoke run (a few minutes; repetitions included), written to the OS temp dir
npm run bench                        # full run (~15 min) -> benchmarks/results/<timestamp>_<commit>.json + .md
npm run bench -- contention stale    # selected suites only
```

Suites: `throughput`, `paced`, `contention`, `stale`, `idempotency`,
`events`. Set `BENCH_DATABASE_URL` to override the benchmark database (its
name must end in `_bench`). On battery or in Low Power Mode the harness
exits unless `--allow-low-power` is given; on an overloaded machine
(1-minute load above the core count, or macOS reporting under 15% memory
free) it exits unless `--allow-high-load` is given. Both flags are recorded
in the artifact. A second concurrent invocation exits without touching the
database.
