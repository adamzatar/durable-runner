# Task 00: Environment spike

## Purpose

Verify the target environment actually supports the mechanisms this project
depends on, before committing to an architecture around them. This task
produces a throwaway/minimal skeleton, not the real application. No queue
tables, no claiming logic, no state machine — that starts in Milestone 2.

## Scope

Build the smallest possible skeleton that can answer each question below
with a plain pass/fail, then record the results (in this file or
`docs/build-journal.md`, once something has actually happened to log).

### 1. Node/TypeScript app startup
Confirm a minimal Fastify server written in TypeScript starts and responds
to a health-check route, run via `tsx` (no separate build step needed for
dev).

### 2. React frontend serving
Confirm a minimal Vite + React app serves a page and can reach the Fastify
server's health-check route (decide during this task whether that's via
Vite dev-server proxy or CORS — see architecture doc open questions; don't
over-decide this beyond what the spike needs).

### 3. PostgreSQL connectivity
Confirm the Fastify server can open a connection to a Postgres instance
(local for this spike) using a `DATABASE_URL` env var and run a trivial
query (`SELECT 1`).

### 4. Database migrations
Wire up Drizzle + drizzle-kit with one trivial table (e.g. a
`spike_healthcheck` table with just an `id` and `created_at`). Confirm a
migration can be generated and applied against the local Postgres instance.

### 5. Replit deployment
Deploy this same skeleton to a Replit Reserved VM. Confirm it boots there,
serves the health route, and can reach a Postgres instance from that
environment (Replit-provided or external — whichever is intended for real
use; note which one was actually tested).

### 6. Server-Sent Events
Add one SSE endpoint that pushes a periodic (e.g. every 2s) heartbeat event.
Confirm a browser client (`EventSource`) connected from the Vite app
receives events in order, and that the connection survives more than a
couple of heartbeats without dropping.

### 7. Multiple Node child worker processes on the target deployment
From the main process, spawn 2-3 trivial child processes (`child_process.fork`
or equivalent) that do nothing but log a heartbeat on an interval. Confirm
this works both locally and on the Replit Reserved VM deployment from step 5.

### 8. Killing one child leaves the coordinator alive
Terminate one spawned child process (e.g. `child.kill()` or killing its PID
directly) and confirm: the parent/coordinator process keeps running, and any
other still-running children are unaffected.

### 9. Processes coordinate only through Postgres, not memory
Design check, not a UI feature: have a child process write a row to
Postgres, and have the parent process discover that fact only by reading it
back from Postgres — not via IPC message passing, `process.send`, or a
shared in-memory object. This is the constraint the whole later
claiming/fencing design depends on, so it needs to be true from the start,
not retrofitted.

## Explicitly out of scope for this task

- Any real task/step/run schema.
- Any claiming, leasing, or fencing logic.
- Any retry or idempotency logic.
- Any real frontend UI beyond "it loaded and can talk to the backend."

## Results (2026-09-16, local machine)

1. **Node/TypeScript app startup** — PASS. Fastify server boots via
   `tsx watch server/src/index.ts`, listens on `127.0.0.1:3000`.
2. **React frontend serving** — PASS. Vite serves the page at
   `localhost:5173`; `/api/*` proxied to the Fastify server per
   `web/vite.config.ts`, so no CORS middleware was needed.
3. **PostgreSQL connectivity** — PASS. `GET /api/health` reports
   `"db": "ok"` after running `select 1` through the Drizzle client.
4. **Database migrations** — PASS. `drizzle-kit generate` produced a real
   SQL migration (`server/drizzle/0000_amusing_quentin_quire.sql`);
   `npm run db:migrate` applied it; verified column list and a write/read
   round trip in `server/tests/db.test.ts`.
5. **REST communication browser → server** — PASS. Confirmed via the
   frontend's `/api/health` fetch, proxied through Vite.
6. **Server-Sent Events** — PASS. Browser `EventSource` connected to
   `/api/events`, received both `heartbeat` events and real `spike-event`
   events sourced from `spike_events` rows (including ones written by the
   child-process experiment below), sustained past 17+ pushes without
   dropping.
7. **Multiple Node child worker processes** — PASS locally. Coordinator
   script (`npm run spike:workers`) forked 3 independent
   `spike-worker.ts` processes, each with its own PostgreSQL connection.
8. **Killing one child leaves the coordinator alive** — PASS locally.
   Worker `b` was sent `SIGTERM` after producing 4 rows; the coordinator
   process kept running and printed a post-kill summary; workers `a`/`c`
   were unaffected and kept producing rows.
9. **Processes coordinate only through Postgres** — PASS. The coordinator
   never received data from workers via IPC/`process.send`; it learned
   everything (including that worker `b` stopped) purely by querying
   `spike_events`. Numbers: before kill, `a`/`b`/`c` each had 4 rows; 4
   seconds after killing `b`, `a` and `c` had 8 each, `b` still had 4.
10. **Replit deployment** — NOT YET RUN. Requires manual execution in
    Replit; see "Replit steps" below. Local evidence above doesn't
    substitute for it, especially for items 7–9 re-run on the Reserved VM.

## Replit steps (manual — not yet performed)

These require importing/publishing the project in Replit and cannot be
validated from this machine:

1. Import this GitHub repo into a new Replit project (Reserved VM type).
2. Provision Postgres for the Repl (Replit's own Postgres, or an external
   one — whichever is intended for real use) and set `DATABASE_URL` in
   Replit's Secrets, matching `.env.example`'s shape.
3. Run `npm install`, `npm run db:migrate`, then `npm run build` and
   `npm start` (production mode — see `docs/architecture.md` "Production
   process & serving") and confirm `GET /api/health` returns `"db": "ok"`
   from inside the Repl.
4. Confirm the Repl's public URL serves the built frontend and reaches
   `/api/health` and `/api/events` (SSE). The single-process approach (one
   Fastify process serving both, via `@fastify/static`) is decided and
   verified locally — this step confirms it also works through Replit's
   own networking/proxying in front of the Repl, which wasn't and can't be
   tested locally.
5. Re-run the child-process experiment (`npm run spike:workers`) on the
   Reserved VM itself and record the same before/after row counts as
   above. This is the one that actually answers the open "worker process
   model on Replit" question — local process behavior on macOS is not
   evidence for Replit's container/VM behavior.
6. Kill one child worker process on the Reserved VM (e.g. via its PID from
   `ps`) and confirm the coordinator process and other workers survive,
   the same way step 8 above was confirmed locally.

## Acceptance criteria

- Each of the 9 items above has a recorded pass/fail, with enough detail to
  explain a "fail" (error message, Replit-specific limitation, etc.).
- The result of items 7-9 directly feeds the "worker process model on
  Replit" decision in `docs/architecture.md` — if child processes prove
  unreliable on the Reserved VM, that gets written down as the reason for
  falling back to logical loops, not silently decided.
- Skeleton code from this task may be thrown away or heavily reworked once
  Milestone 1 (environment skeleton) starts — this task is about answers,
  not reusable code.
