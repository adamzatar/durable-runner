import { describe, expect, it, afterAll } from "vitest";
import Fastify from "fastify";
import { registerHealthRoute } from "../src/api/health.js";
import { pool } from "../src/db/client.js";

describe("GET /api/health/live", () => {
  it("returns 200 and does not depend on the database", async () => {
    const app = Fastify();
    // Liveness must hold even when the dependency check would fail outright.
    await registerHealthRoute(app, { checkDb: () => Promise.reject(new Error("db is down")) });

    const response = await app.inject({ method: "GET", url: "/api/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});

describe("GET /api/health/ready", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("returns 200 when the database answers", async () => {
    const app = Fastify();
    await registerHealthRoute(app);

    const response = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", db: "ok" });

    await app.close();
  });

  it("returns 503 without raw database error details when the database fails", async () => {
    const marker = "synthetic-db-failure-7f3a9c";
    const app = Fastify();
    await registerHealthRoute(app, { checkDb: () => Promise.reject(new Error(marker)) });

    const response = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", db: "error" });
    expect(response.body).not.toContain(marker);

    await app.close();
  });
});

describe("GET /api/health", () => {
  it("is gone — superseded by the explicit liveness/readiness split", async () => {
    const app = Fastify();
    await registerHealthRoute(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
