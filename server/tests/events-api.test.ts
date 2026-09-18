import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openEventStreamCount, registerEventsRoute } from "../src/api/events.js";
import { pool } from "../src/db/client.js";

// The REST reader and the SSE stream over the durable table. The stream is
// exercised against a real listening server and a real HTTP client, because
// SSE framing, the `id:` field and reconnect headers are the things under
// test — not a mocked transport.
let app: FastifyInstance;
let baseUrl: string;

interface ApiEvent {
  id: number;
  stepId: string;
  workerId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

async function insertEvent(stepId: string, note: string, workerId: string | null = "worker-a"): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `insert into step_events (step_id, worker_id, event_type, data, created_at)
     values ($1, $2, 'STEP_CLAIMED', jsonb_build_object('note', $3::text), clock_timestamp())
     returning id`,
    [stepId, workerId, note],
  );
  return Number(result.rows[0]!.id);
}

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

// Opens a real SSE connection and parses frames in the background.
function openStream(path: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const frames: Frame[] = [];
  let status = 0;
  const done = (async () => {
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
    status = response.status;
    if (!response.ok || !response.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // Comment frames (": keepalive") carry no event and no id.
        if (!raw.startsWith(":")) {
          const frame: Frame = {};
          for (const line of raw.split("\n")) {
            const separator = line.indexOf(": ");
            if (separator === -1) continue;
            const field = line.slice(0, separator);
            const value = line.slice(separator + 2);
            if (field === "id") frame.id = value;
            if (field === "event") frame.event = value;
            if (field === "data") frame.data = value;
          }
          frames.push(frame);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  })().catch(() => undefined);

  return {
    frames,
    statusCode: () => status,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function eventFrames(frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.event === "step-event");
}

beforeAll(async () => {
  app = Fastify();
  await registerEventsRoute(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query("delete from step_events");
});

describe("GET /api/events", () => {
  it("returns the wire shape and pages with nextAfterId", async () => {
    const stepId = randomUUID();
    const ids = [await insertEvent(stepId, "one"), await insertEvent(stepId, "two"), await insertEvent(stepId, "three")];

    const first = await app.inject({ method: "GET", url: "/api/events?limit=2" });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { events: ApiEvent[]; nextAfterId: number | null };
    expect(firstBody.events.map((event) => event.id)).toEqual(ids.slice(0, 2));
    expect(firstBody.nextAfterId).toBe(ids[1]);
    expect(firstBody.events[0]).toEqual({
      id: ids[0],
      stepId,
      workerId: "worker-a",
      eventType: "STEP_CLAIMED",
      data: { note: "one" },
      createdAt: expect.any(String),
    });

    const second = await app.inject({ method: "GET", url: `/api/events?afterId=${firstBody.nextAfterId}` });
    const secondBody = second.json() as { events: ApiEvent[]; nextAfterId: number | null };
    expect(secondBody.events.map((event) => event.id)).toEqual([ids[2]]);

    const third = await app.inject({ method: "GET", url: `/api/events?afterId=${secondBody.nextAfterId}` });
    const thirdBody = third.json() as { events: ApiEvent[]; nextAfterId: number | null };
    expect(thirdBody.events).toEqual([]);
    // Nothing new: the caller keeps its position instead of rewinding.
    expect(thirdBody.nextAfterId).toBe(ids[2]);
  });

  it("filters by step", async () => {
    const stepA = randomUUID();
    const stepB = randomUUID();
    const a1 = await insertEvent(stepA, "a1");
    await insertEvent(stepB, "b1");
    const a2 = await insertEvent(stepA, "a2");

    const response = await app.inject({ method: "GET", url: `/api/events?stepId=${stepA}` });
    const body = response.json() as { events: ApiEvent[] };
    expect(body.events.map((event) => event.id)).toEqual([a1, a2]);
  });

  it("rejects malformed query parameters and unknown cursors", async () => {
    const stepId = randomUUID();
    const known = await insertEvent(stepId, "known");

    for (const url of [
      "/api/events?afterId=-1",
      "/api/events?afterId=abc",
      "/api/events?limit=0",
      "/api/events?limit=501",
      "/api/events?limit=abc",
      "/api/events?stepId=not-a-uuid",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toHaveProperty("error");
    }

    // An id this system never issued is refused rather than silently
    // restarting a client's history.
    const unknown = await app.inject({ method: "GET", url: `/api/events?afterId=${known + 5_000}` });
    expect(unknown.statusCode).toBe(400);
  });
});

describe("GET /api/events/stream", () => {
  it("emits newly committed events with the durable id as the SSE id", async () => {
    const stepId = randomUUID();
    const stream = openStream("/api/events/stream");
    try {
      const first = await insertEvent(stepId, "live-one");
      await waitUntil(() => eventFrames(stream.frames).length >= 1, 10_000, "no event delivered");

      const frame = eventFrames(stream.frames)[0]!;
      // The SSE id IS the durable event id, which is what makes
      // Last-Event-ID a usable cursor.
      expect(frame.id).toBe(String(first));
      const payload = JSON.parse(frame.data!) as ApiEvent;
      expect(payload).toMatchObject({ id: first, stepId, eventType: "STEP_CLAIMED", data: { note: "live-one" } });

      const second = await insertEvent(stepId, "live-two");
      await waitUntil(() => eventFrames(stream.frames).length >= 2, 10_000, "second event not delivered");
      expect(eventFrames(stream.frames)[1]!.id).toBe(String(second));
    } finally {
      await stream.close();
    }
  }, 30_000);

  it("resumes after reconnect from Last-Event-ID without repeating or losing events", async () => {
    const stepId = randomUUID();
    const first = openStream("/api/events/stream");
    let lastSeenId: string;
    try {
      const one = await insertEvent(stepId, "before-disconnect");
      await waitUntil(() => eventFrames(first.frames).length >= 1, 10_000, "first event not delivered");
      lastSeenId = eventFrames(first.frames)[0]!.id!;
      expect(lastSeenId).toBe(String(one));
    } finally {
      await first.close();
    }

    // Committed while nobody is listening: the table, not the server, is
    // what holds it.
    const missed = await insertEvent(stepId, "while-disconnected");

    const resumed = openStream("/api/events/stream", { "Last-Event-ID": lastSeenId });
    try {
      await waitUntil(() => eventFrames(resumed.frames).length >= 1, 10_000, "resumed stream delivered nothing");
      const ids = eventFrames(resumed.frames).map((frame) => frame.id);
      // The event committed during the gap arrives, and the one already
      // delivered is not repeated.
      expect(ids).toContain(String(missed));
      expect(ids).not.toContain(lastSeenId);
    } finally {
      await resumed.close();
    }
  }, 30_000);

  it("accepts an explicit afterId cursor for non-browser clients", async () => {
    const stepId = randomUUID();
    const one = await insertEvent(stepId, "one");
    const two = await insertEvent(stepId, "two");

    const stream = openStream(`/api/events/stream?afterId=${one}`);
    try {
      await waitUntil(() => eventFrames(stream.frames).length >= 1, 10_000, "nothing delivered");
      expect(eventFrames(stream.frames).map((frame) => frame.id)).toEqual([String(two)]);
    } finally {
      await stream.close();
    }
  }, 30_000);

  it("filters a stream by step", async () => {
    const stepA = randomUUID();
    const stepB = randomUUID();
    const stream = openStream(`/api/events/stream?stepId=${stepA}`);
    try {
      await insertEvent(stepB, "other-step");
      const mine = await insertEvent(stepA, "my-step");
      await waitUntil(() => eventFrames(stream.frames).length >= 1, 10_000, "nothing delivered");
      expect(eventFrames(stream.frames).map((frame) => frame.id)).toEqual([String(mine)]);
    } finally {
      await stream.close();
    }
  }, 30_000);

  it("rejects an invalid cursor before opening a stream", async () => {
    const response = await fetch(`${baseUrl}/api/events/stream?afterId=-5`);
    expect(response.status).toBe(400);
    await response.body?.cancel();

    const unknown = await fetch(`${baseUrl}/api/events/stream`, { headers: { "Last-Event-ID": "999999" } });
    expect(unknown.status).toBe(400);
    await unknown.body?.cancel();
  }, 20_000);

  it("stops its polling loop when the client disconnects", async () => {
    const stepId = randomUUID();
    const stream = openStream("/api/events/stream");
    await insertEvent(stepId, "one");
    await waitUntil(() => eventFrames(stream.frames).length >= 1, 10_000, "nothing delivered");
    expect(openEventStreamCount()).toBe(1);

    await stream.close();

    await waitUntil(() => openEventStreamCount() === 0, 10_000, "stream loop did not stop after disconnect");
    // Later events do not reach the closed stream.
    const delivered = eventFrames(stream.frames).length;
    await insertEvent(stepId, "after-close");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(eventFrames(stream.frames)).toHaveLength(delivered);
  }, 30_000);
});
