# 0003 — Streaming events on a transaction-id watermark, not on the sequence alone

Status: accepted (Milestone 9)

## Context

`step_events` is append-only history, and both the REST reader and the SSE
stream page through it with a cursor. The obvious cursor is the primary key:

```sql
WHERE id > $lastSeen ORDER BY id
```

That is wrong, and not in a subtle-in-theory way. A `bigserial` value is
allocated when the row is INSERTed; the row becomes visible when its
transaction COMMITs. Those two orders are independent, so a reader can
advance its cursor past an id that has not been decided yet.

Reproduced on PostgreSQL 16.15 before choosing a design, and kept as a test
(`event-cursor.test.ts`):

```text
transaction A inserts event id 1      (stays open)
transaction B inserts event id 2      (commits)
reader: WHERE id > 0  -> sees [2], advances cursor to 2
transaction A commits
reader: WHERE id > 2  -> sees []      -- event 1 is behind the cursor forever
```

Event 1 was committed, is in the table, and would never be delivered. For a
history whose whole purpose is "what happened to this step", silently
dropping a committed transition is the one thing the stream must not do.

## Alternatives

**A. Raw id cursor.** What the Phase-0 spike did. Simple, and loses events
exactly as above. Rejected.

**B. Re-read an overlap window and deduplicate** (`id > lastSeen - 1000`, or
"re-read the last 5 seconds"). Cheap, but the safe overlap is however long a
transaction might stay open, which is unbounded. It converts a certain bug
into a rare one, pushes deduplication onto every client, and makes the
guarantee a function of a magic number. Rejected.

**C. Serialize id allocation with commit order.** Have every event-writing
transaction take a shared lock before inserting and hold it to commit; then
commit order equals id order and a pure-id cursor is safe. It works, needs no
extra column, and is easy to explain — but it puts a single global
serialization point in front of *every* lifecycle transition in the system,
right before the milestone that benchmarks that runtime. Paying a
system-wide throughput cost to simplify a reader is the wrong trade.
Rejected.

**D. Order by `created_at`.** Has the same defect (a timestamp is taken
before commit) plus ties and clock questions. Rejected.

**E. Transaction-id watermark (chosen).**

## Decision

Every event row stores the transaction that wrote it, `xid xid8 NOT NULL
DEFAULT pg_current_xact_id()` (64-bit, so no wraparound concerns, and
indexable). Every read applies a watermark and a composite cursor in **one
statement**, so both halves see the same snapshot:

```sql
WHERE xid < pg_snapshot_xmin(pg_current_snapshot())
  AND (xid, id) > ($afterXid, $afterId)
ORDER BY xid, id
LIMIT $limit
```

Why this is safe:

- `pg_snapshot_xmin` is the oldest transaction id still running, so every
  transaction below it has finished. Those events are final, and the ones
  that committed are all visible to this same snapshot — the set is complete,
  not a partial view of an in-flight batch.
- `xmin` never moves backwards: transactions only finish.
- Anything not yet returned belongs to a transaction with `xid >= xmin`,
  which is greater than every `xid` already emitted. So no future event can
  sort behind the cursor.
- The sort key is `(xid, id)` rather than `id`, because a transaction can be
  assigned a lower xid and still allocate a higher id. Ordering on `id` alone
  would reintroduce the hazard between two already-final transactions.

The public cursor stays a durable event id. `Last-Event-ID` (or `afterId`)
names a row; the server resolves that row's `(xid, id)` and resumes from it.
Clients keep a single integer, the SSE `id:` field is the durable event id,
and the composite ordering stays an implementation detail.

## Consequences

- **No committed event is skipped**, which is the property the sequence-only
  cursor lacked.
- **Latency, not correctness, is the cost.** An event is withheld while any
  older *writing* transaction is still open, so the stream trails the oldest
  in-flight write transaction in the cluster. Read-only transactions are not
  assigned transaction ids and do not hold the watermark back. The runtime's
  own transitions are milliseconds long; an operator sitting in an open write
  transaction will visibly stall the stream, and that is the honest
  description of this design.
- **Delivery is not exactly-once to a client.** A client that reconnects with
  an older cursor re-receives events; the stream is resumable and lossless,
  not deduplicated for you.
- **Ids are not gap-free.** A rolled-back transition keeps its allocated id
  forever, and an unknown id is rejected rather than treated as "start over".
- **Per-step history needs none of this.** Every transition holds that step's
  row lock until commit, so one step's events are totally ordered and their
  id and `(xid, id)` orders agree. The ambiguity only exists across steps.
- Tests: `event-cursor.test.ts` demonstrates the naive cursor losing the
  event and the watermark cursor delivering both, including the
  already-caught-up reader and the per-step filtered case.
