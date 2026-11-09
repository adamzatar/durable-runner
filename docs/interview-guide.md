# Durable Runner interview guide

Durable Runner uses PostgreSQL as the queue, ownership authority and durable
history. Independent Node.js worker processes claim steps, a coordinator
recovers expired claims and promotes due retries, and a Fastify API exposes
history over REST and Server-Sent Events (SSE). The failure model allows
repeated attempts. The goal is to keep state correct when the old and new
owners overlap in time. [Runtime architecture](architecture.md)

## Claim, recover and fence

A worker chooses the highest-priority available step, with availability time
and ID as tie breakers. This is the selection inside the claim transaction:

```sql
SELECT id FROM steps
WHERE status = 'READY'
  AND available_at <= now()
  AND attempt_count < max_attempts
ORDER BY priority DESC, available_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

The transaction updates the locked row to `RUNNING`, increments
`lease_version` and `attempt_count`, sets the worker ID and database-clock
deadline, and inserts the claim event. The worker owns the step after commit.
Other claimers skip the locked row and can take different work. The
transaction ends before execution, so an executor never holds the claim's row
lock while it runs.

The default lease lasts 30 seconds and the worker renews it every five
seconds. Worker heartbeats describe liveness for observers. The database
deadline controls authority. The coordinator sweeps expired rows using
`FOR UPDATE SKIP LOCKED` and returns them to `READY` if they have attempts
left. An expired claim on the last attempt goes to `DEAD_LETTERED`. Ordinary
retryable executor errors use bounded exponential backoff. A claim spends
an attempt even if its worker dies before executing.
[Attempt budget decision](decisions/0002-attempt-budget-includes-crashes.md)

**Failure trace.** Worker A claims generation 1, then freezes. The lease
expires and the coordinator recovers the step. Worker B claims generation 2.
A resumes while B's lease is live and tries to complete. A check against
the row's current deadline alone could accept A's write because that
deadline now belongs to B. The version check rejects A even if B reused A's
worker ID. A can still run code it already started. Fencing controls which
writes PostgreSQL accepts. The local fencing demo uses `SIGSTOP` and
`SIGCONT` to reproduce this overlap. The recovery demo uses `SIGKILL`
and checks reclamation at generation 2. [Demo commands](../README.md#tests-and-demos)

**Questions.** Why keep a worker ID and a generation? What happens to an
expired step while the coordinator is down? What guarantees does
`SKIP LOCKED` give about fairness?

## Authorize after acquiring the lock

Under PostgreSQL's READ COMMITTED isolation, a guarded `UPDATE` can evaluate
its predicate, wait for a row lock, and proceed after the deadline passes.
The reproduced case held the row with `SELECT ... FOR UPDATE` without
modifying it. For example, the lease expires at 12:00:30 and the update
qualifies at 12:00:29. The locker releases at 12:00:31. The waiting statement
can still use its pre-wait predicate result. Using `clock_timestamp()`
inside that single statement still leaves the ordering problem.

The implementation locks by ID first, then issues a separate guarded write
inside the same transaction. A simplified completion, with bound parameters:

```sql
BEGIN;
SELECT id FROM steps WHERE id = $1 FOR UPDATE;
UPDATE steps
SET status = 'SUCCEEDED', result = $4,
    current_worker_id = NULL, lease_expires_at = NULL
WHERE id = $1 AND status = 'RUNNING'
  AND current_worker_id = $2 AND lease_version = $3
  AND lease_expires_at > clock_timestamp()
RETURNING id;
-- Insert the lifecycle event here if a row changed.
COMMIT;
```

The second statement sees the row after the wait and evaluates the deadline
with the lock held. `now()` is frozen at transaction start, so it would
still admit a lease that expired while waiting. Zero affected rows mean
the write lacked authority, and no lifecycle event is emitted. The deadline
applies at the guarded write, while commit can finish later. Renewal and
failure reporting use the same ordering. Recovery uses the complementary
`lease_expires_at <= clock_timestamp()` predicate. The tradeoff is another
round trip while holding the row lock. The lease rule assumes the database
clock does not jump backward across an expired deadline.
[Deadline decision and race reproduction](decisions/0001-lease-deadline-is-authority.md)

**Questions.** Why is a live deadline insufficient without a generation?
Why can `now()` produce the wrong result after the lock is acquired? What
happens when a recovery sweep encounters a locked expired row?

## Effect receipts and at-least-once execution

Fencing protects authoritative step state. The effect sink protects a
separate outcome. Its idempotency key comes from the logical step ID and
stays stable across retries. The receipt row is the simulated effect:

```sql
INSERT INTO idempotent_effects
  (idempotency_key, effect_type, request, result, created_at)
VALUES ($1, $2, $3, $4, clock_timestamp())
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING result;
```

If the insert conflicts, a fresh read returns the stored result for the
same effect type and request. Reusing the key for a different request is
rejected. The effect commits separately from completion. If A commits the
receipt and dies before reporting success, B can reclaim the step, reuse the
receipt and report completion with its own generation. Two attempts can
execute while the controlled sink stores one logical effect.

This is an at-least-once execution model with a finite attempt budget.
It permits repeated attempts and dead-lettering. A third-party API would
need its own durable idempotency contract because a local receipt cannot
commit atomically with an arbitrary remote call.
[Effect implementation](../server/src/db/idempotent-effect.ts)

**Questions.** What happens if the old worker reaches the effect sink first?
What is the failure window if an external API succeeds and the worker loses
the response? How would you verify an executor's reported result independently?

## Stream committed events without losing a late commit

Step updates and lifecycle events commit in the same transaction. Across
steps, a sequence allocates IDs before commit. A inserts event 101 and
waits. B inserts 102 and commits. A naive reader sees 102, advances its
cursor, and misses 101 when A finally commits. A creation timestamp has
the same pre-commit ordering problem.

Each event records its writing transaction ID. The reader uses the oldest
in-flight transaction ID as a watermark and orders the completed prefix
by transaction ID and event ID. The watermark and page share one snapshot:

```sql
SELECT id, xid, step_id, event_type
FROM step_events
WHERE xid < pg_snapshot_xmin(pg_current_snapshot())
  AND (xid, id) > ($1::xid8, $2::bigint)
ORDER BY xid, id
LIMIT $3;
```

An open older write transaction can delay newer committed events. Once the
watermark passes it, events from that prefix can be paged without a later
commit appearing behind the cursor. The SSE client keeps the public event ID
as `Last-Event-ID`. The server looks up its `(xid, id)` position. Reconnecting
with an older cursor can replay events.
[Cursor decision and concurrency trace](decisions/0003-event-cursor-watermark.md)

**Questions.** Why order by both columns? What does an idle open write
transaction do to delivery lag? How should a reconnecting client handle
events it has already processed?

## What the measurements establish

The approved run at `3cbb858` used an Apple M2, Node 20.19.4 and PostgreSQL
16.15 on the same machine. With eight worker processes, the median backlog
drain was **3,277.1 tasks/s** across three runs of 50,000 tasks. The correctness
workloads observed **200,266 ownership grants with zero duplicates**,
**4,750 rejected stale writes** and **zero duplicate logical effects across
45,000 effect executions** in the PostgreSQL sink.

These measurements cover the tested workloads and failure cases, with
durable writes enabled. They establish neither a general scaling curve nor
AWS capacity. The test and deployment run on Node 24 is separate evidence.
[Approved benchmark report](../benchmarks/results/2026-09-19T01-14-28-972Z_3cbb858.md)

**Questions.** What was timed in the backlog test? Why does zero duplicate
ownership coexist with repeat execution? What would change if workers and
PostgreSQL communicated across a network?

## AWS deployment and verification

Terraform defined the VPC, security groups, ECR, ECS services, ALB and
private RDS PostgreSQL. The API, worker and coordinator ran as separate
Fargate services using one ARM64 image and different startup commands.
The public HTTP ALB forwarded to the API and checked liveness. The separate
readiness check exercised database connectivity. Worker and coordinator
tasks had no inbound listener. Fargate tasks used public IPv4 for outbound
access to ECR and CloudWatch, avoiding a NAT Gateway. Security groups
restricted API ingress to the ALB and PostgreSQL ingress to the API and
backend groups. RDS used private subnets and the client checked the database
certificate and hostname. [AWS architecture](cloud-architecture.md)

After verification, GitHub Actions used OIDC to assume a deployment role
scoped to the repository and `main`. It published the immutable full-SHA
image to ECR, ran a one-off migration task and checked its exit code before
rolling the services. It waited for stability, compared task definitions
and running container digests with the expected deployment, then checked
API liveness, readiness and event history through the ALB. The September
deployment record also includes SSE and startup logs. [Phase 3 record](phase3-cloud-verification.md)
· [Successful CI/CD run](https://github.com/adamzatar/durable-runner/actions/runs/37248771108)

The application stack was later torn down to avoid ongoing costs. The demo
runs locally. Phase 5 (controlled Fargate crash recovery) and Phase 6 (cloud
benchmarking) were omitted. [Evidence ledger](resume-evidence.md)

**Questions.** Why separate liveness from readiness at the ALB? Why check the
running digest after the ECS service stabilizes? Why does the workflow need a
bootstrap task definition before it can deploy a new revision?

## Limits and potential extensions

- A worker that keeps renewing while its executor hangs can hold a step.
  Progress deadlines or cooperative cancellation could limit wasted work,
  with fencing still required at the storage boundary.
- Executor completion records success. Independent result verification would
  need its own state and evidence. A separate verification step and multi-step
  runs are outside the current runtime.
- PostgreSQL is the coordination dependency. An outage pauses claims and
  recovery. A workload with long write transactions would also need monitoring
  for event watermark lag.
- The AWS environment used a single-AZ database and a public HTTP listener.
  A production design would need separate availability, backup/restore and
  HTTPS decisions based on its workload and recovery requirements.
