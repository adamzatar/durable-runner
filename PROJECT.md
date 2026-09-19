# Durable Task Runner

## What this is

A small backend system for executing steps of work with durable state,
concurrency-safe claiming, worker heartbeats/leases, fencing against stale
workers, retries with backoff, idempotent side effects, and durable event
history served over REST and Server-Sent Events (SSE). Grouping steps into
multi-step runs and a separate verification step after execution are
planned, not implemented. The React frontend is currently a diagnostic page
(health plus the live event feed), not an operational console.

This is a learning/demo project built to understand and be able to defend,
in detail, the mechanics of durable task execution and failure recovery. It
is not a product and is not trying to look like one.

## Core behavior

- The unit of work is a **step** (a row in `steps`). Multi-step **runs** are
  planned, not implemented; steps are currently inserted directly by demos,
  tests and the benchmark.
- Steps move through an explicit state machine (see `docs/architecture.md`).
- Multiple worker processes claim steps from PostgreSQL concurrently, without
  double-claiming the same step.
- Workers send heartbeats. A worker that stops heartbeating does not
  immediately lose its step — its lease must expire first.
- Once a lease expires, another worker may reclaim the step. The original
  worker may still be alive and may attempt to report completion after
  losing ownership; that attempt must be rejected (fencing).
- Fencing rejects a *write*, not a *side effect*. If the stale worker already
  performed an external action before losing its lease, fencing cannot undo
  that. Idempotency keys are the separate mechanism that suppresses a
  duplicate side effect if the step is retried.
- Failed steps retry with exponential backoff up to a max attempt count, then
  move to a dead-lettered state.
- An executor reporting success is not the same as the system verifying that
  success. Verification as a distinct step recorded separately from
  execution outcome is planned, not implemented.
- Every lifecycle state transition is recorded in a durable, append-only
  event history in the same transaction, readable over REST and streamed
  via SSE.

## Constraints

- TypeScript end to end (Node/Fastify backend, React/Vite frontend).
- PostgreSQL is the only coordination store. No message broker, no cache
  layer, no separate lock service.
- Intended to eventually run on Replit (Reserved VM). Locally, workers and
  the coordinator run as independent Node OS processes; this has not been
  validated on Replit.
- GitHub is the source of truth for the repository.

## What this project claims, and what it does not

- It claims **at-least-once** execution: a step may run more than once under
  worker failure, and the system is built around that fact rather than
  around hiding it.
- It does **not** claim exactly-once execution. Exactly-once is not
  achievable in the general case with this architecture (or most others),
  and nothing in this codebase should assert otherwise.
- It does **not** claim to be production-grade, enterprise-ready, highly
  available, or horizontally scaled. It is a single-database, small-scale
  system built to demonstrate specific mechanisms correctly.
- Workers run as separate local OS processes on one machine, not as
  separate machines, and are not presented as such.

## Intended demo

Start several workers, submit a deterministic run, and observe, through
actual backend behavior (not frontend animation):

1. Workers claim and execute steps concurrently without double-claiming.
2. A worker process is killed; its heartbeats stop.
3. Its step stays assigned to it until the lease expires, then another
   worker reclaims it.
4. The original worker's stale attempt to report completion is rejected via
   fencing.
5. A transiently-failing step retries with backoff and eventually succeeds.
6. A step that repeats an external side effect has the duplicate suppressed
   by idempotency, not by fencing.
7. A step whose executor reports success but fails verification is retried
   and later passes verification.
8. A step that keeps failing exhausts its attempts and is dead-lettered.
9. The browser shows this entire sequence as real event history, not staged
   UI state.

Items 1-6 and 8 are implemented as `npm run demo:*` scripts (see
`README.md`). Items 7 (verification) and 9 (a timeline UI) are not built yet;
the durable history behind item 9 exists and is exposed over REST/SSE.

## Architecture, broadly

The HTTP API currently exposes health plus durable event history (REST and
one SSE stream). Command endpoints (submit, cancel) are planned, not
implemented. Worker processes poll PostgreSQL to claim available steps,
execute them, and report outcomes back through the same claim/fencing
mechanism. See `docs/architecture.md`
for the current design, open questions, and what is explicitly out of scope
for now.

AI-backed tasks may be added later as one possible step executor type. AI is
not part of the core architecture and is not being built until the
deterministic system above is complete and demonstrated.
