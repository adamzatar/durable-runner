# Engineering constraints for this repo

This is a learning project about durable task execution and failure
recovery (see `PROJECT.md`). These constraints are stable across the whole
project; task-specific context belongs in `tasks/`, not here.

## Complexity budget

Complexity is expected and welcome from: concurrency, ownership, failure
handling, duplicate execution, persistence, retries, recovery, and result
verification. That is the point of the project.

Complexity is not welcome from: extra services, generic repository/DAO
layers, dependency injection frameworks, speculative interfaces, plugin
architectures, event buses, or "enterprise" folder structures. Don't add
these unless a concrete, current requirement needs them — not a hypothetical
future one.

Don't add a dependency without a concrete reason tied to what is being built
right now.

## Correctness framing

- At-least-once execution is expected and intentional, not a bug to design
  around. Never claim or imply exactly-once execution anywhere (code
  comments, docs, UI copy).
- Fencing (lease versions) and idempotency (idempotency keys) are separate
  concerns solving separate problems. Fencing stops a stale worker from
  recording completion after losing ownership. Idempotency stops a step
  from repeating an external side effect. Don't conflate them in code or in
  writing.
- Executor success and verified success are separate states, recorded
  separately.
- Task state transitions are centralized in one place and tested. Don't
  scatter ad hoc status checks/writes around the codebase.

## Honesty about the environment

Don't describe worker loops as independent processes/machines unless they
actually are in the current implementation. If Replit worker processes turn
out to run as logical loops instead of OS processes, say so in code and
docs.

## Writing and comments

- No promotional language. Never describe this system as production-grade,
  enterprise-ready, infinitely scalable, exactly-once, or globally
  distributed.
- Comments explain non-obvious *why* — transaction boundaries, locking,
  lease behavior, fencing, retry behavior. Don't comment obvious syntax.
- Don't manufacture history: no fake bugs, fake benchmarks, fake TODOs, or
  build-journal entries for things that didn't happen.

## Process

- Don't implement beyond the current scoped task; don't rewrite unrelated
  code while doing it.
- Don't commit automatically. The user reviews and commits.
- For a real design choice (not a minor syntax/library pick), lay out the
  problem, the real alternatives, a recommendation, and the tradeoff before
  implementing — don't silently decide and move on.
