import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_CURSOR_START,
  MAX_EVENT_PAGE_SIZE,
  listStepEvents,
  resolveEventCursor,
  type EventCursor,
} from "../src/db/step-events.js";

// The reader's contract: ascending, bounded, resumable, and — the point of
// this file — incapable of skipping an event that commits out of id order.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let readerPool: Pool;
let reader: NodePgDatabase<Record<string, never>>;

// Inserts an event directly. Cursor mechanics are about ordering and
// visibility, not about which operation produced the row; the real
// operations' events are covered in step-events.test.ts.
async function insertEvent(client: Pool | PoolClient, stepId: string, note: string): Promise<{ id: number; xid: string }> {
  const result = await client.query<{ id: string; xid: string }>(
    `insert into step_events (step_id, worker_id, event_type, data, created_at)
     values ($1, null, 'STEP_CLAIMED', jsonb_build_object('note', $2::text), clock_timestamp())
     returning id, xid::text`,
    [stepId, note],
  );
  return { id: Number(result.rows[0]!.id), xid: result.rows[0]!.xid };
}

// The cursor a reader would use if it paged on the sequence alone. Present
// so the hazard is demonstrated rather than asserted.
async function naiveRead(afterId: number): Promise<number[]> {
  const result = await admin.query<{ id: string }>(
    "select id from step_events where id > $1 order by id limit 100",
    [afterId],
  );
  return result.rows.map((row) => Number(row.id));
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  readerPool = new Pool({ connectionString, max: 1 });
  reader = drizzle(readerPool);
});

afterAll(async () => {
  await admin.end();
  await readerPool.end();
});

beforeEach(async () => {
  await admin.query("delete from step_events");
});

describe("listStepEvents", () => {
  it("returns events in ascending order and resumes exactly where the previous page stopped", async () => {
    const stepId = randomUUID();
    const inserted: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      inserted.push((await insertEvent(admin, stepId, `e${i}`)).id);
    }

    const first = await listStepEvents(reader, { limit: 4 });
    const second = await listStepEvents(reader, { after: first.cursor, limit: 4 });
    const third = await listStepEvents(reader, { after: second.cursor, limit: 4 });
    const fourth = await listStepEvents(reader, { after: third.cursor, limit: 4 });

    expect(first.events.map((event) => event.id)).toEqual(inserted.slice(0, 4));
    expect(second.events.map((event) => event.id)).toEqual(inserted.slice(4, 8));
    expect(third.events.map((event) => event.id)).toEqual(inserted.slice(8, 10));
    // Nothing left, and the cursor stays where it was rather than rewinding.
    expect(fourth.events).toEqual([]);
    expect(fourth.cursor).toEqual(third.cursor);
  });

  it("bounds every read: limit is honoured and clamped to the maximum", async () => {
    const stepId = randomUUID();
    for (let i = 0; i < 5; i += 1) await insertEvent(admin, stepId, `e${i}`);

    expect((await listStepEvents(reader, { limit: 2 })).events).toHaveLength(2);
    // Asking for more than the ceiling is clamped, not rejected, and never
    // turns into an unbounded read.
    expect((await listStepEvents(reader, { limit: MAX_EVENT_PAGE_SIZE + 5_000 })).events).toHaveLength(5);
    await expect(listStepEvents(reader, { limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(listStepEvents(reader, { limit: 1.5 })).rejects.toThrow(/positive integer/);
  });

  it("filters by step while keeping one global order", async () => {
    const stepA = randomUUID();
    const stepB = randomUUID();
    const a1 = await insertEvent(admin, stepA, "a1");
    const b1 = await insertEvent(admin, stepB, "b1");
    const a2 = await insertEvent(admin, stepA, "a2");

    const onlyA = await listStepEvents(reader, { stepId: stepA });
    expect(onlyA.events.map((event) => event.id)).toEqual([a1.id, a2.id]);
    expect(onlyA.events.every((event) => event.stepId === stepA)).toBe(true);

    const all = await listStepEvents(reader, {});
    expect(all.events.map((event) => event.id)).toEqual([a1.id, b1.id, a2.id]);
  });

  it("resolves a durable event id back to its position in the order", async () => {
    const stepId = randomUUID();
    const first = await insertEvent(admin, stepId, "first");
    const second = await insertEvent(admin, stepId, "second");

    const cursor = await resolveEventCursor(reader, first.id);
    expect(cursor).toEqual({ xid: first.xid, id: first.id });

    const resumed = await listStepEvents(reader, { after: cursor });
    expect(resumed.events.map((event) => event.id)).toEqual([second.id]);

    expect(await resolveEventCursor(reader, 0)).toEqual(EVENT_CURSOR_START);
    // An id this system never issued (or one left as a gap by a rolled-back
    // transaction) is not silently treated as "start from the beginning".
    expect(await resolveEventCursor(reader, second.id + 10_000)).toBeUndefined();
  });
});

describe("events committing out of id order", () => {
  // The hazard, reproduced deterministically: transaction A allocates the
  // LOWER id and stays uncommitted while transaction B allocates a HIGHER id
  // and commits first.
  async function stageOutOfOrderCommit(stepId: string) {
    const poolA = new Pool({ connectionString, max: 1 });
    const poolB = new Pool({ connectionString, max: 1 });
    const a = await poolA.connect();
    const b = await poolB.connect();
    await a.query("begin");
    const early = await insertEvent(a, stepId, "allocated-first-commits-last");
    await b.query("begin");
    const late = await insertEvent(b, stepId, "allocated-second-commits-first");
    await b.query("commit");
    expect(early.id).toBeLessThan(late.id);
    return {
      early,
      late,
      commitA: async () => {
        await a.query("commit");
      },
      cleanup: async () => {
        await a.query("rollback").catch(() => undefined);
        a.release();
        b.release();
        await poolA.end();
        await poolB.end();
      },
    };
  }

  it("a sequence-only cursor loses the late-committing event (the hazard this design exists for)", async () => {
    const stepId = randomUUID();
    const staged = await stageOutOfOrderCommit(stepId);
    try {
      // A reader paging on `id` alone sees only the higher id...
      const visible = await naiveRead(0);
      expect(visible).toEqual([staged.late.id]);

      // ...advances its cursor past it, and once A commits, the lower id is
      // behind the cursor forever.
      await staged.commitA();
      expect(await naiveRead(staged.late.id)).toEqual([]);
      const everything = await naiveRead(0);
      expect(everything).toContain(staged.early.id);
    } finally {
      await staged.cleanup();
    }
  });

  it("the watermark cursor withholds until the older transaction finishes, then delivers both in order", async () => {
    const stepId = randomUUID();
    const staged = await stageOutOfOrderCommit(stepId);
    try {
      // B committed, but A is still in flight and holds the watermark back,
      // so nothing is emitted yet. Withholding briefly is the price of never
      // advancing the cursor past an event that has not been decided.
      const withheld = await listStepEvents(reader, { after: EVENT_CURSOR_START });
      expect(withheld.events).toEqual([]);
      expect(withheld.cursor).toEqual(EVENT_CURSOR_START);

      await staged.commitA();

      const delivered = await listStepEvents(reader, { after: withheld.cursor });
      // Both events, neither skipped, ordered by the transaction that wrote
      // them rather than by the id they happened to allocate.
      expect(delivered.events.map((event) => event.id)).toEqual([staged.early.id, staged.late.id]);
    } finally {
      await staged.cleanup();
    }
  });

  it("a reader that consumed everything before the late commit still receives the late event", async () => {
    const stepId = randomUUID();
    // History the reader has already caught up on.
    const settled = await insertEvent(admin, stepId, "already-delivered");
    let cursor: EventCursor = (await listStepEvents(reader, {})).cursor;
    expect(cursor.id).toBe(settled.id);

    const staged = await stageOutOfOrderCommit(stepId);
    try {
      // Nothing new is deliverable while A is open, even though B committed.
      const duringFlight = await listStepEvents(reader, { after: cursor });
      expect(duringFlight.events).toEqual([]);

      await staged.commitA();

      const after = await listStepEvents(reader, { after: cursor });
      expect(after.events.map((event) => event.id)).toEqual([staged.early.id, staged.late.id]);
      cursor = after.cursor;
      // And the stream does not repeat itself on the next poll.
      expect((await listStepEvents(reader, { after: cursor })).events).toEqual([]);
    } finally {
      await staged.cleanup();
    }
  });

  it("the same guarantee holds for a per-step filtered read", async () => {
    const stepId = randomUUID();
    const staged = await stageOutOfOrderCommit(stepId);
    try {
      expect((await listStepEvents(reader, { stepId })).events).toEqual([]);
      await staged.commitA();
      expect((await listStepEvents(reader, { stepId })).events.map((event) => event.id)).toEqual([
        staged.early.id,
        staged.late.id,
      ]);
    } finally {
      await staged.cleanup();
    }
  });

  it("paging a backlog in small pages never skips or repeats an event", async () => {
    const stepId = randomUUID();
    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) ids.push((await insertEvent(admin, stepId, `e${i}`)).id);

    const seen: number[] = [];
    let cursor: EventCursor = EVENT_CURSOR_START;
    for (let page = 0; page < 10; page += 1) {
      const result = await listStepEvents(reader, { after: cursor, limit: 3 });
      if (result.events.length === 0) break;
      seen.push(...result.events.map((event) => event.id));
      cursor = result.cursor;
    }

    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });
});
