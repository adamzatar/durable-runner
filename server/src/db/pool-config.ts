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

import { Pool } from "pg";

export const DEFAULT_DB_POOL_MAX = 4;

export function parseDbPoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DB_POOL_MAX;
  // Digits only: rejects negatives, decimals, whitespace-padded values and
  // garbage in one step instead of Number()'s permissive coercions.
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function createDbPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: parseDbPoolMax(process.env.DB_POOL_MAX),
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
