import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createDbPool, INVALID_PASSWORD_SQLSTATE, isCredentialRejected } from "../src/db/pool-config.js";

// After RDS rotates the master password, a process started with the old one
// can keep its open sessions but gets SQLSTATE 28P01 on every new
// connection. These tests reproduce that second half without a server that
// enforces passwords: a TCP listener that answers every PostgreSQL startup
// packet with the ErrorResponse a real server sends. The processes under
// test never reach the shared test database, so nothing here touches its
// rows.

const SSL_REQUEST_CODE = 80877103;

function errorResponse(sqlstate: string, message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C${sqlstate}\0M${message}\0\0`, "utf8");
  const header = Buffer.alloc(5);
  header.write("E", 0, "ascii");
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

interface RefusingServer {
  url: string;
  connections(): number;
  close(): Promise<void>;
}

async function startRefusingServer(sqlstate: string, message: string): Promise<RefusingServer> {
  const reply = errorResponse(sqlstate, message);
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8) {
        const length = buffered.readInt32BE(0);
        if (buffered.length < length) return;
        const code = buffered.readInt32BE(4);
        buffered = buffered.subarray(length);
        // Decline TLS if asked, then wait for the real startup packet.
        if (code === SSL_REQUEST_CODE) {
          socket.write("N");
          continue;
        }
        socket.end(reply);
        return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgres://durable_runner_admin:stale-password@127.0.0.1:${port}/durable_runner`,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const PASSWORD_REJECTED = [INVALID_PASSWORD_SQLSTATE, 'password authentication failed for user "durable_runner_admin"'] as const;
// What RDS answers while it is starting up or rebooting: transient, and
// must not be treated as a stale credential.
const STARTING_UP = ["57P03", "the database system is starting up"] as const;

describe("createDbPool: rejected credentials", () => {
  it("reports SQLSTATE 28P01 on a new connection and still fails the caller", async () => {
    const server = await startRefusingServer(...PASSWORD_REJECTED);
    const reported: Error[] = [];
    const pool = createDbPool({ connectionString: server.url }, { onCredentialRejected: (error) => reported.push(error) });
    try {
      await expect(pool.query("select 1")).rejects.toMatchObject({ code: INVALID_PASSWORD_SQLSTATE });
      await expect(pool.connect()).rejects.toMatchObject({ code: INVALID_PASSWORD_SQLSTATE });
      expect(reported).toHaveLength(2);
      expect(reported.every(isCredentialRejected)).toBe(true);
    } finally {
      await pool.end();
      await server.close();
    }
  });

  it("does not report other connection failures", async () => {
    const server = await startRefusingServer(...STARTING_UP);
    const reported: Error[] = [];
    const pool = createDbPool({ connectionString: server.url }, { onCredentialRejected: (error) => reported.push(error) });
    // Nothing listens on this port once its server has closed.
    const closed = await startRefusingServer(...PASSWORD_REJECTED);
    const closedUrl = closed.url;
    await closed.close();
    const refusedPool = createDbPool({ connectionString: closedUrl }, { onCredentialRejected: (error) => reported.push(error) });
    try {
      await expect(pool.query("select 1")).rejects.toMatchObject({ code: "57P03" });
      await expect(refusedPool.query("select 1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(reported).toEqual([]);
    } finally {
      await pool.end();
      await refusedPool.end();
      await server.close();
    }
  });
});

// Real entrypoints as child processes, the way api-shutdown.test.ts runs
// them: node --import tsx from the repo root. DATABASE_URL in the child's
// environment takes precedence over .env, so the child connects to the
// refusing server, not the test database.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const entrypoints = {
  api: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  worker: fileURLToPath(new URL("../src/worker/worker.ts", import.meta.url)),
  coordinator: fileURLToPath(new URL("../src/coordinator/coordinator.ts", import.meta.url)),
};

function startProcess(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    output,
    exited,
    async waitForExit(timeoutMs: number) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms\n${output.stdout}\n${output.stderr}`)), timeoutMs);
      });
      try {
        return await Promise.race([exited, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("long-running processes stop when the database rejects their password", () => {
  it("coordinator: exits 1 instead of retrying its sweep forever", async () => {
    const server = await startRefusingServer(...PASSWORD_REJECTED);
    const proc = startProcess(entrypoints.coordinator, { DATABASE_URL: server.url });
    try {
      const { code, signal } = await proc.waitForExit(20_000);
      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(proc.output.stderr).toContain("SQLSTATE 28P01");
      // Took the orderly path: the loop ended and the pool was closed.
      expect(proc.output.stdout).toContain("[coordinator] stopped, pool closed");
      expect(server.connections()).toBeGreaterThan(0);
    } finally {
      await proc.kill();
      await server.close();
    }
  }, 30_000);

  it("coordinator: keeps retrying through a transient failure, and still stops cleanly on SIGTERM", async () => {
    const server = await startRefusingServer(...STARTING_UP);
    const proc = startProcess(entrypoints.coordinator, { DATABASE_URL: server.url });
    try {
      // Several sweeps (1s apart, two statements each, each statement
      // needing a new connection here) fail without the process giving up.
      await waitFor(() => server.connections() >= 6, 20_000, "three failed sweeps");
      expect(proc.child.exitCode).toBeNull();
      expect(proc.output.stderr).not.toContain("SQLSTATE 28P01");

      proc.child.kill("SIGTERM");
      const { code, signal } = await proc.waitForExit(10_000);
      expect(signal).toBeNull();
      expect(code).toBe(0);
    } finally {
      await proc.kill();
      await server.close();
    }
  }, 40_000);

  it("worker: exits 1 when it cannot authenticate", async () => {
    const server = await startRefusingServer(...PASSWORD_REJECTED);
    const proc = startProcess(entrypoints.worker, { DATABASE_URL: server.url, WORKER_ID: "worker-rotation-test" });
    try {
      const { code, signal } = await proc.waitForExit(20_000);
      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(proc.output.stderr).toContain("SQLSTATE 28P01");
    } finally {
      await proc.kill();
      await server.close();
    }
  }, 30_000);

  it("API: readiness fails, then the process shuts down gracefully and exits 1", async () => {
    const server = await startRefusingServer(...PASSWORD_REJECTED);
    const port = 34442;
    const base = `http://127.0.0.1:${port}`;
    const proc = startProcess(entrypoints.api, { DATABASE_URL: server.url, PORT: String(port) });
    try {
      // The API opens no database connection until a request needs one, so
      // it starts and serves liveness.
      await waitFor(async () => (await httpGet(`${base}/api/health/live`)).status === 200, 30_000, "API to listen");

      const ready = await httpGet(`${base}/api/health/ready`);
      expect(ready.status).toBe(503);

      const { code, signal } = await proc.waitForExit(20_000);
      expect(signal).toBeNull();
      expect(code).toBe(1);
      expect(proc.output.stdout).toContain("SQLSTATE 28P01");
      expect(proc.output.stdout).toContain("shutdown complete, pool closed");
    } finally {
      await proc.kill();
      await server.close();
    }
  }, 60_000);
});
