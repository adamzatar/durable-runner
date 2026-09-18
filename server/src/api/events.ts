import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { abortableSleep } from "../abortable-sleep.js";
import { db } from "../db/client.js";
import {
  DEFAULT_EVENT_PAGE_SIZE,
  EVENT_CURSOR_START,
  MAX_EVENT_PAGE_SIZE,
  listStepEvents,
  resolveEventCursor,
  type EventCursor,
  type StepEvent,
} from "../db/step-events.js";

// How often an open stream asks PostgreSQL for newly committed events.
// Polling, deliberately: no LISTEN/NOTIFY, no broker, no pub/sub. The stream
// is a tail of a durable table, so a client that misses messages recovers by
// reconnecting with a cursor rather than by the server retaining anything.
export const EVENT_STREAM_POLL_INTERVAL_MS = 500;

// Per-poll bound. A reconnecting client with an old cursor catches up over
// several polls instead of one unbounded read.
const STREAM_PAGE_SIZE = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Open streams, so shutdown and tests can see that a disconnect actually
// stopped its polling loop rather than leaving it running.
let openStreams = 0;
export function openEventStreamCount(): number {
  return openStreams;
}

interface ParsedQuery {
  afterId?: number;
  stepId?: string;
  limit?: number;
}

class BadRequestError extends Error {}

function parseQuery(query: unknown, maxLimit: number): ParsedQuery {
  const raw = (query ?? {}) as Record<string, unknown>;
  const parsed: ParsedQuery = {};

  if (raw.afterId !== undefined && raw.afterId !== "") {
    const afterId = Number(raw.afterId);
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new BadRequestError("afterId must be a non-negative integer");
    }
    parsed.afterId = afterId;
  }
  if (raw.stepId !== undefined && raw.stepId !== "") {
    const stepId = String(raw.stepId);
    if (!UUID_PATTERN.test(stepId)) {
      throw new BadRequestError("stepId must be a uuid");
    }
    parsed.stepId = stepId;
  }
  if (raw.limit !== undefined && raw.limit !== "") {
    const limit = Number(raw.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new BadRequestError(`limit must be an integer between 1 and ${maxLimit}`);
    }
    parsed.limit = limit;
  }
  return parsed;
}

// The wire shape. Explicit rather than returning database rows, so column
// names and driver types are not part of the API.
function toApiEvent(event: StepEvent) {
  return {
    id: event.id,
    stepId: event.stepId,
    workerId: event.workerId,
    eventType: event.eventType,
    data: event.data,
    createdAt: event.createdAt,
  };
}

// Turns "the last durable id I saw" into a position in the total (xid, id)
// order. Unknown ids are rejected rather than silently restarting the
// stream, which would replay history a client believes it already has.
async function cursorFor(afterId: number | undefined): Promise<EventCursor> {
  if (afterId === undefined || afterId === 0) return EVENT_CURSOR_START;
  const cursor = await resolveEventCursor(db, afterId);
  if (!cursor) {
    throw new BadRequestError(`afterId ${afterId} does not match a known event`);
  }
  return cursor;
}

export async function registerEventsRoute(app: FastifyInstance) {
  /**
   * Bounded history read.
   *
   * GET /api/events?afterId=<id>&stepId=<uuid>&limit=<n>
   *
   * Ascending, never unbounded, and safe to page with: `nextAfterId` is the
   * last durable id returned, and handing it back as `afterId` resumes
   * exactly where this page stopped. Events are withheld until their
   * transaction is known to be finished, so a just-committed event can take
   * a moment to appear — see db/step-events.ts.
   */
  app.get("/api/events", async (request: FastifyRequest, reply: FastifyReply) => {
    let parsed: ParsedQuery;
    try {
      parsed = parseQuery(request.query, MAX_EVENT_PAGE_SIZE);
    } catch (error) {
      if (error instanceof BadRequestError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    let cursor: EventCursor;
    try {
      cursor = await cursorFor(parsed.afterId);
    } catch (error) {
      if (error instanceof BadRequestError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    const { events } = await listStepEvents(db, {
      after: cursor,
      stepId: parsed.stepId,
      limit: parsed.limit ?? DEFAULT_EVENT_PAGE_SIZE,
    });

    return reply.send({
      events: events.map(toApiEvent),
      // Null only when this caller has never seen an event yet and none were
      // returned; otherwise the caller's own position, unchanged.
      nextAfterId: events.length > 0 ? events[events.length - 1]!.id : (parsed.afterId ?? null),
    });
  });

  /**
   * Durable event stream.
   *
   * GET /api/events/stream?afterId=<id>&stepId=<uuid>
   *
   * Each message carries the durable event id as its SSE `id:`, so a browser
   * reconnecting sends `Last-Event-ID` automatically and resumes after the
   * last event it actually received. `?afterId=` does the same thing for
   * non-browser clients. The server keeps no per-client state: the cursor
   * lives with the client, and the table is the only source.
   *
   * Sequential polling, not setInterval: the next read only starts after the
   * previous one finished, so a slow database cannot pile up overlapping
   * queries on one connection.
   */
  app.get("/api/events/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    let parsed: ParsedQuery;
    try {
      parsed = parseQuery(request.query, STREAM_PAGE_SIZE);
    } catch (error) {
      if (error instanceof BadRequestError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    // Standard SSE resume header wins over the query parameter: a browser
    // sets it automatically and it reflects what was actually delivered.
    const lastEventHeader = request.headers["last-event-id"];
    const headerId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader;
    let afterId = parsed.afterId;
    if (headerId !== undefined && headerId !== "") {
      const parsedHeader = Number(headerId);
      if (!Number.isSafeInteger(parsedHeader) || parsedHeader < 0) {
        return reply.code(400).send({ error: "Last-Event-ID must be a non-negative integer" });
      }
      afterId = parsedHeader;
    }

    let cursor: EventCursor;
    try {
      cursor = await cursorFor(afterId);
    } catch (error) {
      // Validate before any SSE header is written, so a bad cursor is an
      // ordinary 400 rather than an error frame inside a stream.
      if (error instanceof BadRequestError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    const controller = new AbortController();
    const { signal } = controller;
    openStreams += 1;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Comment frame: tells the client the stream is open without being
    // delivered as an event or disturbing its Last-Event-ID.
    reply.raw.write(": connected\n\n");

    request.raw.on("close", () => controller.abort());

    try {
      while (!signal.aborted) {
        const { events, cursor: next } = await listStepEvents(db, {
          after: cursor,
          stepId: parsed.stepId,
          limit: STREAM_PAGE_SIZE,
        });
        if (signal.aborted) break;

        for (const event of events) {
          reply.raw.write(`id: ${event.id}\nevent: step-event\ndata: ${JSON.stringify(toApiEvent(event))}\n\n`);
        }
        // Advanced only after the writes above, and only to what was read.
        cursor = next;

        if (events.length === 0) {
          reply.raw.write(": keepalive\n\n");
        }
        await abortableSleep(EVENT_STREAM_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      // A failed read ends this stream rather than silently skipping events;
      // the client reconnects with its last id and loses nothing.
      request.log.error({ err: error }, "event stream failed");
    } finally {
      openStreams -= 1;
      reply.raw.end();
    }
  });
}
