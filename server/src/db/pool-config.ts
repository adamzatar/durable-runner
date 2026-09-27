// Every production role (API, worker, coordinator, migrations) constructs
// its own pg.Pool through this module. It is the single place that turns
// the DB_POOL_MAX environment variable into a pool limit, so no role
// silently falls back to the pg driver default (10) once worker task count
// scales.
//
// The default is deliberately conservative. A worker runs one task at a
// time but can overlap execution, lease renewal and heartbeat queries (~3
// connections); the API serves a handful of concurrent REST requests plus
// SSE polling; the coordinator is serial. 4 covers all three roles at demo
// scale without hardcoding per-role values — deployments override per
// process via the environment.

import { Client, Pool } from "pg";
import type { DbConnectionConfig } from "./connection-config.js";

export const DEFAULT_DB_POOL_MAX = 4;

// PostgreSQL's SQLSTATE for "password authentication failed". It is what a
// new connection gets after RDS has rotated the password this process was
// started with.
export const INVALID_PASSWORD_SQLSTATE = "28P01";

export function isCredentialRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === INVALID_PASSWORD_SQLSTATE;
}

export interface DbPoolOptions {
  // Called each time PostgreSQL rejects the configured password while the
  // pool opens a new connection. The error still reaches whoever asked for
  // the connection; this only lets the process react as a whole.
  //
  // Why it exists: on ECS the password is injected once, at task start, and
  // RDS rotates it every 7 days. Rotation doesn't end sessions that are
  // already open, so a process keeps working until it needs a *new*
  // connection, and from then on every new connection fails. A loop that
  // logs and retries (the coordinator, the worker heartbeat, API readiness)
  // would do that forever while ECS still sees a running task. Exiting
  // instead makes ECS start a replacement, which resolves the secret again
  // and gets the current password. Only 28P01 triggers this: other
  // connection failures (network, a restarting database) are transient and
  // stay the retry loops' business. See docs/cloud-architecture.md.
  onCredentialRejected?: (error: Error) => void;
}

// pg.Pool builds every connection through the Client class it is given.
// Wrapping connect() here sees every connection attempt the pool makes,
// including those behind pool.query(), without each caller having to
// recognize the error.
type ConnectCallback = Parameters<Client["connect"]>[0] & {};

function clientReportingRejectedCredentials(onRejected: (error: Error) => void): typeof Client {
  return class extends Client {
    // pg-pool 3.x calls the callback form; the promise form is covered too
    // so the behavior doesn't depend on which one a pg version uses.
    override connect(): Promise<Client>;
    override connect(callback: ConnectCallback): void;
    override connect(callback?: ConnectCallback): Promise<Client> | void {
      if (callback) {
        super.connect((err: Error | null, client?: Client) => {
          if (err && isCredentialRejected(err)) onRejected(err);
          (callback as (err: Error | null, client?: Client) => void)(err, client);
        });
        return;
      }
      return super.connect().catch((err: unknown) => {
        if (isCredentialRejected(err)) onRejected(err as Error);
        throw err;
      });
    }
  };
}

export function parseDbPoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DB_POOL_MAX;
  // Digits only: rejects negatives, decimals, whitespace-padded values and
  // garbage in one step instead of Number()'s permissive coercions.
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function createDbPool(connection: DbConnectionConfig, options: DbPoolOptions = {}): Pool {
  const pool = new Pool({
    ...connection,
    max: parseDbPoolMax(process.env.DB_POOL_MAX),
    ...(options.onCredentialRejected ? { Client: clientReportingRejectedCredentials(options.onCredentialRejected) } : {}),
  });
  // An idle pooled connection can be killed at any time: server restart,
  // network drop, server-side idle timeout. pg.Pool re-emits that as an
  // 'error' event, and an UNHANDLED 'error' event crashes the process —
  // turning a survivable dropped idle connection (readiness should report
  // 503, the pool should reconnect) into a full process exit. The dead
  // client is evicted either way; the pool opens a fresh one on the next
  // checkout. Verified against a stopped-then-restarted PostgreSQL.
  pool.on("error", (error) => {
    console.error("idle database connection failed; the pool will open a fresh one on next use:", error.message);
  });
  return pool;
}
