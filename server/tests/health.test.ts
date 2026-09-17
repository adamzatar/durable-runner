import { describe, expect, it, afterAll } from "vitest";
import Fastify from "fastify";
import { registerHealthRoute } from "../src/api/health.js";
import { pool } from "../src/db/client.js";

describe("GET /api/health", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("reports server and DB status", async () => {
    const app = Fastify();
    await registerHealthRoute(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");

    await app.close();
  });
});
