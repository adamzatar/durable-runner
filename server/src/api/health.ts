import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

interface HealthRouteOptions {
  // Injectable so tests can simulate a database failure without needing a
  // real outage. Production wiring always uses the shared pool.
  checkDb?: () => Promise<unknown>;
}

export async function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions = {}) {
  const checkDb = options.checkDb ?? (() => db.execute(sql`select 1`));

  // Liveness: is this process able to answer HTTP at all? Deliberately no
  // dependency checks — a transient PostgreSQL outage should not make an
  // orchestrator kill an otherwise healthy process.
  app.get("/api/health/live", () => ({ status: "ok" }));

  // Readiness: can this process do its dependency-backed work right now?
  // This is the check a load balancer should gate traffic on.
  app.get("/api/health/ready", async (request, reply) => {
    try {
      await checkDb();
      return { status: "ok", db: "ok" };
    } catch (error) {
      // The driver error text stays in the server log; clients get the fact
      // of failure, not its details.
      request.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable", db: "error" });
    }
  });
}
