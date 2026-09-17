# Durable Task Runner

## What this is

A small backend system for executing multi-step "runs" of work with durable
state, concurrency-safe claiming, worker heartbeats/leases, fencing against
stale workers, retries with backoff, idempotent side effects, and a separate
verification step after execution. A React frontend shows live state and
event history over Server-Sent Events (SSE).

This is a learning/demo project built to understand and be able to defend,
in detail, the mechanics of durable task execution and failure recovery. It
is not a product and is not trying to look like one.

## Core behavior

- Work is submitted as a **run** containing one or more **steps**.
- Steps move through an explicit state machine (see `docs/architecture.md`).
- Multiple worker loops claim steps from PostgreSQL concurrently, without
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
  success. Verification is a distinct step recorded separately from
  execution outcome.
- Every state transition and operationally relevant event is recorded in a
  durable, append-only event history, visible in the browser in near
  real time via SSE.

## Constraints

- TypeScript end to end (Node/Fastify backend, React/Vite frontend).
- PostgreSQL is the only coordination store. No message broker, no cache
  layer, no separate lock service.
- Intended to eventually run on Replit (Reserved VM). Whether worker
  processes there run as independent OS processes or as logical loops
  inside one process is an open question resolved by an environment spike,
  not assumed in advance.
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
- If worker processes turn out to run as logical loops in one process rather
  than separate OS processes (see environment spike), the system will say so
  plainly rather than presenting loops as if they were independent machines.

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

## Architecture, broadly

REST endpoints handle commands (submit a run, cancel, etc.). One SSE
endpoint streams live state changes and events to the browser. Worker loops
poll PostgreSQL to claim available steps, execute them, and report outcomes
back through the same claim/fencing mechanism. See `docs/architecture.md`
for the current design, open questions, and what is explicitly out of scope
for now.

AI-backed tasks may be added later as one possible step executor type. AI is
not part of the core architecture and is not being built until the
deterministic system above is complete and demonstrated.
