import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// The durable vocabulary. One value per meaningful, committed lifecycle
// transition — not telemetry. Heartbeats, lease renewals, idle polls,
// executor log lines and rejected stale writes are deliberately absent:
// they happen at a frequency that would turn this table into a metrics
// stream, and a rejected write is by definition not a transition.
export const STEP_EVENT_TYPES = [
  "STEP_CLAIMED",
  "STEP_SUCCEEDED",
  "STEP_RETRY_SCHEDULED",
  "STEP_DEAD_LETTERED",
  "LEASE_RECOVERED",
  "RETRY_READY",
] as const;

export type StepEventType = (typeof STEP_EVENT_TYPES)[number];

// Hard ceiling on a single read. A caller asking for more gets this.
export const MAX_EVENT_PAGE_SIZE = 500;
export const DEFAULT_EVENT_PAGE_SIZE = 100;

// Executor error text is arbitrary and can be large. The authoritative copy
// lives in steps.last_error, which is overwritten per attempt; the event
// keeps a bounded excerpt so append-only history (never pruned) does not
// accumulate unbounded arbitrary text.
export const MAX_EVENT_ERROR_LENGTH = 200;

export function truncateEventError(error: string): string {
  return error.length <= MAX_EVENT_ERROR_LENGTH ? error : `${error.slice(0, MAX_EVENT_ERROR_LENGTH - 1)}…`;
}

export interface StepEvent {
  id: number;
  stepId: string;
  workerId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

// Where a reader is in the total (xid, id) order. Callers hold this opaquely
// and hand it back; the API layer resolves a durable event id into one.
export interface EventCursor {
  xid: string;
  id: number;
}

export const EVENT_CURSOR_START: EventCursor = { xid: "0", id: 0 };

type EventRow = {
  id: string;
  step_id: string;
  worker_id: string | null;
  event_type: string;
  data: Record<string, unknown>;
  created_at: string;
  xid: string;
};

function toStepEvent(row: EventRow): StepEvent {
  return {
    // bigserial arrives as a string from node-postgres; these ids are far
    // below 2^53, so a number is safe and keeps JSON output natural.
    id: Number(row.id),
    stepId: row.step_id,
    workerId: row.worker_id,
    eventType: row.event_type,
    data: row.data,
    createdAt: row.created_at,
  };
}

/**
 * Appends one event, for use INSIDE the transaction that performs the state
 * change it describes.
 *
 * This takes a transaction handle rather than a pool on purpose. An event is
 * not a notification about a transition; it is part of it. If the caller's
 * transaction rolls back, the event must vanish with it, and if the event
 * insert fails, the transition must not commit. There is no asynchronous,
 * best-effort or after-the-fact path that could leave the two disagreeing.
 *
 * Recovery and retry promotion do not use this helper: they write their
 * events inside their single bulk statement (see recover-expired-steps.ts and
 * promote-due-retries.ts) so that batching, SKIP LOCKED and atomicity all
 * survive together.
 */
export async function recordStepEvent<TSchema extends Record<string, unknown>>(
  tx: NodePgDatabase<TSchema>,
  event: {
    stepId: string;
    workerId: string | null;
    eventType: StepEventType;
    data: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into step_events (step_id, worker_id, event_type, data, created_at)
    values (${event.stepId}, ${event.workerId}, ${event.eventType}, ${JSON.stringify(event.data)}::jsonb, clock_timestamp())
  `);
}

export interface ListStepEventsOptions {
  // Position in the total (xid, id) order. Omitted means "from the start".
  after?: EventCursor;
  stepId?: string;
  limit?: number;
}

export interface ListStepEventsResult {
  events: StepEvent[];
  // Where to resume. Equals `after` when nothing was returned.
  cursor: EventCursor;
}

/**
 * Reads committed events in a stable total order, with no risk of skipping
 * an event that commits out of id order.
 *
 * The problem this solves: `id` comes from a sequence allocated at INSERT,
 * while rows become visible at COMMIT. Those orders can disagree. A reader
 * doing `WHERE id > cursor ORDER BY id` can see a later-allocated event that
 * committed first, advance its cursor past an earlier-allocated event that
 * is still in flight, and then never return that event once it commits.
 * Reproduced deterministically in tests/event-cursor.test.ts.
 *
 * The fix, in one statement so both halves share one snapshot:
 *
 *   WHERE xid < pg_snapshot_xmin(pg_current_snapshot())   -- watermark
 *     AND (xid, id) > (cursor.xid, cursor.id)             -- position
 *   ORDER BY xid, id
 *
 * - `pg_snapshot_xmin` is the oldest transaction id still running, so every
 *   transaction below it has finished. Those events are final and, if
 *   committed, all visible to this same snapshot: the set is complete, not a
 *   partial view of some in-flight batch.
 * - `xmin` never moves backwards, and any event not yet returned belongs to
 *   a transaction with `xid >= xmin`, which is greater than every `xid`
 *   already emitted. So a future event can never sort behind the cursor.
 * - Ordering on `(xid, id)` rather than `id` alone matters because a
 *   transaction can be assigned a lower xid yet allocate a higher id.
 *
 * The cost is latency, not correctness: an event stays unread while any
 * older writing transaction is still open, so the stream trails the oldest
 * in-flight write transaction in the cluster. Read-only transactions are not
 * assigned transaction ids and do not hold the watermark back. The runtime's
 * own transitions are short; an operator sitting in an open write
 * transaction will visibly delay the stream.
 *
 * Within one step the question does not arise: every transition holds that
 * step's row lock until commit, so a single step's events are totally
 * ordered and `id` order and `(xid, id)` order agree.
 *
 * Reads are always bounded (MAX_EVENT_PAGE_SIZE) and ascending.
 */
export async function listStepEvents<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  options: ListStepEventsOptions = {},
): Promise<ListStepEventsResult> {
  const after = options.after ?? EVENT_CURSOR_START;
  const requested = options.limit ?? DEFAULT_EVENT_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`listStepEvents limit must be a positive integer, got ${String(requested)}`);
  }
  const limit = Math.min(requested, MAX_EVENT_PAGE_SIZE);
  const stepFilter: SQL = options.stepId ? sql`and step_id = ${options.stepId}::uuid` : sql``;

  const result = await db.execute<EventRow>(sql`
    select id, step_id, worker_id, event_type, data, created_at::text, xid::text
    from step_events
    where xid < pg_snapshot_xmin(pg_current_snapshot())
      and (xid, id) > (${after.xid}::xid8, ${after.id}::bigint)
      ${stepFilter}
    order by xid asc, id asc
    limit ${limit}
  `);

  const events = result.rows.map(toStepEvent);
  const lastRow = result.rows[result.rows.length - 1];
  return {
    events,
    cursor: lastRow ? { xid: lastRow.xid, id: Number(lastRow.id) } : after,
  };
}

/**
 * Translates a durable event id into its position in the (xid, id) order, so
 * clients can keep using "the last event id I saw" (including the SSE
 * `Last-Event-ID` header) while the server pages on the safe cursor.
 *
 * Returns undefined for an id that does not exist — an id the caller cannot
 * have received from this system, or one belonging to a rolled-back
 * transaction that left a gap in the sequence.
 */
export async function resolveEventCursor<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  eventId: number,
): Promise<EventCursor | undefined> {
  if (eventId <= 0) return EVENT_CURSOR_START;
  const result = await db.execute<{ id: string; xid: string }>(sql`
    select id, xid::text from step_events where id = ${eventId}::bigint
  `);
  const row = result.rows[0];
  return row ? { xid: row.xid, id: Number(row.id) } : undefined;
}
