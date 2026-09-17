import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export async function registerHealthRoute(app: FastifyInstance) {
  app.get("/api/health", async () => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok", db: "ok", timestamp: new Date().toISOString() };
    } catch (err) {
      return {
        status: "ok",
        db: "error",
        dbError: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };
    }
  });
}
