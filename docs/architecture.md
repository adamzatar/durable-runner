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
- A coordinator responsibility (sweeping expired leases back to READY,
  scheduling retries) — not yet decided whether this lives inside the
  server process or a separate loop. See open questions.
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
(`server/src/db/claim-step.ts`). Not implemented yet: worker loops,
heartbeats, lease expiry/recovery, fencing, retries.

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
  wrote. Heartbeats, when built, must not change it: it marks a change of
  owner, not a lease extension.
- **`lease_expires_at`.** Written at claim time as `clock_timestamp()` plus
  the lease duration. The lease is timed from the ownership `UPDATE`, not
  from `BEGIN` (`now()` would silently shorten it by however long the
  transaction took to get there) and not exactly from `COMMIT` either
  (PostgreSQL doesn't expose that instant inside the transaction). **It is
  recorded but not enforced**: nothing sweeps expired leases, expiry does
  not make a step claimable again, and the owner is never told its lease
  lapsed.
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
- A worker's completion write must be conditioned on still holding the
  lease version it claimed with. If another worker has since reclaimed the
  step (higher lease version), the stale write affects zero rows and is
  rejected. This is fencing. *Not implemented yet* — `lease_version` exists
  and is returned by the claim so this check has something to condition
  on.
- Fencing prevents a stale *write*, not a stale *side effect*. A worker
  whose lease expired may have already performed an external action before
  it lost ownership. That's a separate problem, handled by idempotency.
- A lease timeout is not treated as proof of worker death. A timed-out
  worker may still be alive and may still attempt to act — the system is
  built assuming that will happen sometimes, not as an edge case.

### Retries

Whether a `RUNNING` failure is retryable, and whether the attempt budget
remains, is decided once, at failure time. A retryable failure with
attempts remaining becomes `RETRY_WAIT`, meaning that decision has already
been made: once its backoff delay expires, if the system processes it and
it hasn't been cancelled, its only legal next transition is `READY` —
`RETRY_WAIT` never dead-letters directly. A non-retryable failure, or one
with no attempts remaining, becomes `DEAD_LETTERED` directly from
`RUNNING`, skipping the wait. This describes transition legality, not
liveness: nothing here guarantees a coordinator will actually process an
expired backoff in a timely way, or at all — a crashed or unavailable
coordinator could leave a step in `RETRY_WAIT` indefinitely without that
being an illegal state. Backoff scheduling logic is expected to be
hand-written — this is core "difficult behavior" for the project, not
something to delegate to a library.

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
- Whether the coordinator (lease-expiry sweep, retry scheduling) is its own
  loop or folded into the API server process.
- SSE relationship to REST history: does SSE only push new events after the
  client separately fetches history over REST, or does it also replay
  history on connect?
- Whether the `workers` table's "process identity" field is meaningful at
  all if workers end up being logical loops rather than OS processes.

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
