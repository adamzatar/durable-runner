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
