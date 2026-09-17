import "./load-env.js";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { registerHealthRoute } from "./api/health.js";
import { registerEventsRoute } from "./api/events.js";

const app = Fastify({ logger: true });

await registerHealthRoute(app);
await registerEventsRoute(app);

// Resolved from cwd rather than import.meta.url so this works both under
// tsx (source at server/src/) and compiled (dist/server/src/) without the
// path needing to know which one it's running as — both are started with
// the repo root as cwd (npm scripts guarantee this).
const webDist = path.resolve(process.cwd(), "web/dist");
if (existsSync(webDist)) {
  // Single production web process: Fastify serves the built frontend
  // alongside /api/*, so there's no second server/reverse-proxy to run or
  // deploy. In dev, web/dist doesn't exist (Vite's dev server + proxy
  // handles the frontend instead), so this is skipped rather than failing.
  await app.register(fastifyStatic, { root: webDist });
} else {
  app.log.warn("web/dist not found — not serving the frontend (expected in local dev)");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
