import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

// Integration test of the real API process lifecycle: starts the actual
// server entrypoint as a child process (the same code the container runs,
// under tsx since this is the dev/test environment), opens an SSE stream,
// sends SIGTERM, and verifies the whole graceful-shutdown chain: listener
// stops, open stream ends instead of hanging, pool closes, exit code 0.
//
// The server runs as `node --import tsx`, not via the tsx CLI: the CLI
// spawns the server as a grandchild and only relays catchable signals, so a
// SIGKILL in cleanup killed the wrapper and orphaned the real server on
// PORT. Spawning node directly makes `child` the process that listens.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const PORT = 34441;
const BASE = `http://127.0.0.1:${PORT}`;

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await httpGet("/api/health/live");
      if (response.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("API process did not start listening in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("API graceful shutdown", () => {
  it("drains SSE, closes the pool and exits 0 on SIGTERM", async () => {
    // cwd is the repo root so `--import tsx` resolves from this repo's
    // node_modules, and the server's cwd-relative paths (.env, web/dist)
    // match `npm start`.
    const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});

    try {
      await waitForServer(30_000);

      // The process serves requests before shutdown.
      const ready = await httpGet("/api/health/ready");
      expect(ready.status).toBe(200);

      // Open an SSE stream and wait for its connect frame, so shutdown has
      // a live long-lived connection to deal with.
      let sseData = "";
      let sseEnded = false;
      const sseEndedPromise = new Promise<void>((resolve, reject) => {
        const request = http.get(`${BASE}/api/events/stream`, (res) => {
          res.on("data", (chunk) => (sseData += chunk));
          res.on("end", () => {
            sseEnded = true;
            resolve();
          });
          res.on("error", reject);
        });
        request.on("error", reject);
      });
      const connectDeadline = Date.now() + 10_000;
      while (!sseData.includes(": connected")) {
        if (Date.now() > connectDeadline) throw new Error("SSE stream never sent its connect frame");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // SIGTERM, then SIGINT right behind it: a second signal must not
      // start a competing shutdown.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGINT"), 100);

      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("API process did not exit within 20s of SIGTERM")), 20_000);
          child.on("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
        },
      );

      // The SSE stream ended cleanly rather than hanging or erroring.
      await sseEndedPromise;
      expect(sseEnded).toBe(true);

      // Clean shutdown: exit(0) after cleanup, not death by signal.
      expect(signal).toBeNull();
      expect(code).toBe(0);

      // Fastify finished closing and the pool was closed before exit.
      expect(stdout).toContain("shutdown complete, pool closed");

      // The listener is gone.
      await expect(httpGet("/api/health/live")).rejects.toThrow();
    } finally {
      // Fallback only: on the passing path the process already exited from
      // SIGTERM. Wait for the exit so the port is released before the next
      // test or run binds it.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 60_000);
});
