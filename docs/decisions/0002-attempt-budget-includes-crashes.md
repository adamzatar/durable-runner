# 0002 — The total attempt budget includes crashed claims

Status: accepted (Milestone 7)

## Context

`attempt_count` increments with a successful claim, before the executor is
entered. `max_attempts` is the maximum total attempts, including the first.
The prior recovery rule always returned expired RUNNING rows to READY.
Together those rules leave a conflict when the final claimant crashes:
another claim would exceed the budget, while refusing it without changing
recovery would leave an exhausted READY row stranded.

## Alternatives

- Keep unconditional recovery-to-READY and allow crash-driven claims beyond
  the budget. This preserves the old recovery rule but changes max_attempts
  into a reported-failure policy rather than a total attempt cap.
- Count only attempts that report failure, or add a separate execution-start
  protocol. These change the requested attempt definition or add a new
  coordination phase without eliminating all ambiguous crash windows.
- Enforce the total cap and dead-letter an expired final-attempt row.

## Decision

Use the total cap. A successful claim atomically increments attempt_count
and lease_version, while requiring `attempt_count < max_attempts`. Under its
existing expired-row locks, recovery selects READY if budget remains and
DEAD_LETTERED otherwise. Both transitions pass the lifecycle legality check.

This is still lease recovery, not an executor failure report. It is
authorized by expiry, never heartbeat age. It schedules no backoff and
preserves `last_error` instead of inventing an executor exception. Both
counters remain unchanged during recovery. The coordinator logs which
transition occurred. A final live attempt can still renew and complete.

Reported failures remain separate: a currently live, correctly fenced owner
selects RETRY_WAIT or DEAD_LETTERED from the locked row's budget and the
minimal input-validity distinction. Its authorization is evaluated after
an ID-only row lock in a READ COMMITTED transaction, consistent with
[PostgreSQL's per-statement snapshots](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED).

## Consequences

- Three allowed attempts means no fourth claim, including after crashes.
- A crash immediately after claim consumes an attempt even if no executor
  instruction ran. Repeated such crashes can exhaust the entire budget.
- DEAD_LETTERED means automatic execution has stopped. It does not prove
  an executor exception occurred; `last_error` may be null after expiry.
- Fencing generations and attempt accounting remain separate concepts.
  Neither recovery nor failure/promotion increments either one.
- No manual replay, execution-start protocol, attempt history, or external
  side-effect protection is introduced.
