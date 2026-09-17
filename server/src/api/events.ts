import type { FastifyInstance } from "fastify";
import { gt, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { spikeEvents } from "../db/schema.js";

const POLL_INTERVAL_MS = 1000;

// SPIKE-ONLY: proves the SSE mechanism end to end (connect, stream, survive
// multiple pushes) by tailing the spike_events table. This is not the real
// event-streaming design — the real system will decide separately whether
// SSE tails a proper events table via polling or something else (see
// docs/architecture.md open questions).
export async function registerEventsRoute(app: FastifyInstance) {
  app.get("/api/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let lastSeenId = 0;

    const timer = setInterval(async () => {
      try {
        const rows = await db
          .select()
          .from(spikeEvents)
          .where(gt(spikeEvents.id, lastSeenId))
          .orderBy(asc(spikeEvents.id))
          .limit(50);

        if (rows.length === 0) {
          reply.raw.write(`event: heartbeat\ndata: ${new Date().toISOString()}\n\n`);
          return;
        }

        for (const row of rows) {
          lastSeenId = row.id;
          reply.raw.write(`event: spike-event\ndata: ${JSON.stringify(row)}\n\n`);
        }
      } catch (err) {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
        );
      }
    }, POLL_INTERVAL_MS);

    request.raw.on("close", () => {
      clearInterval(timer);
    });
  });
}
