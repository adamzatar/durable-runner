import "./load-env.js";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { registerHealthRoute } from "./api/health.js";
import { closeOpenEventStreams, registerEventsRoute } from "./api/events.js";
import { onDbCredentialRejected, pool } from "./db/client.js";

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

// Graceful shutdown, to the same standard as the worker and coordinator:
// stop accepting new connections, let in-flight work finish, then close the
// pool. app.close() waits for in-flight handlers, and an SSE handler never
// finishes on its own, so open event streams are aborted first — their
// polling loops exit within one poll interval and close() can complete.
// No forced-exit timer: every long-lived response has an explicit close
// path, and a shutdown that hangs should be investigated, not papered over.
let shutdownStarted = false;

async function shutdown(exitCode: number) {
  // A second signal must not start a competing shutdown over the first.
  if (shutdownStarted) return;
  shutdownStarted = true;
  closeOpenEventStreams();
  await app.close();
  await pool.end();
  app.log.info("shutdown complete, pool closed");
  process.exit(exitCode);
}

function startShutdown(reason: string, exitCode: number) {
  if (!shutdownStarted) app.log.info(`${reason}, shutting down`);
  shutdown(exitCode).catch((error) => {
    console.error(`fatal error during shutdown (${reason})`, error);
    process.exit(1);
  });
}

process.on("SIGTERM", () => startShutdown("received SIGTERM", 0));
process.on("SIGINT", () => startShutdown("received SIGINT", 0));

// A rejected password means RDS has rotated it since this task started;
// every new pool connection will now fail, so readiness would report 503
// indefinitely. Shutting down with a non-zero exit makes ECS start a
// replacement task, which resolves the secret again and gets the current
// password. See db/pool-config.ts and docs/cloud-architecture.md.
onDbCredentialRejected(() => {
  startShutdown("database rejected the password (SQLSTATE 28P01); replacement task needed", 1);
});
