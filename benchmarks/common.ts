import "../server/src/load-env.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export { sleep };

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Benchmarks run against their own database, never the development/test
// database in DATABASE_URL. Isolation by a row prefix is not possible here:
// claimNextStep claims whichever READY row sorts first, so benchmark workers
// would claim test/demo rows (and vice versa). A separate database also lets
// every run start from the same empty tables.
export function benchDatabaseUrl(): string {
  if (process.env.BENCH_DATABASE_URL) return process.env.BENCH_DATABASE_URL;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL (or BENCH_DATABASE_URL) is not set");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname.replace(/^\//, "")}_bench`;
  return url.toString();
}

function databaseName(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

// The maintenance database of the same cluster, which always exists (unlike
// the benchmark database on first use). Session-level advisory locks are
// cluster-wide, so the invocation lock can be taken here before the
// benchmark database is even created.
export function maintenanceDatabaseUrl(): string {
  const url = new URL(benchDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

// Every destructive statement in the harness goes through a pool created
// here, and this refuses to hand one out unless the database is named
// *_bench, so a misconfigured BENCH_DATABASE_URL cannot truncate real data.
export function benchPool(max = 1): Pool {
  const connectionString = benchDatabaseUrl();
  if (!databaseName(connectionString).endsWith("_bench")) {
    throw new Error(`refusing to benchmark against database ${databaseName(connectionString)}: name must end with _bench`);
  }
  return new Pool({ connectionString, max });
}

export function benchDb(max = 1) {
  const pool = benchPool(max);
  return { pool, db: drizzle(pool) };
}

// Creates the benchmark database if missing and applies the same migrations
// the application uses. Not timed.
export async function prepareBenchDatabase(): Promise<void> {
  const target = benchDatabaseUrl();
  const name = databaseName(target);
  if (!/^[a-z0-9_]+_bench$/.test(name)) throw new Error(`unexpected benchmark database name ${name}`);
  const maintenance = new Pool({ connectionString: maintenanceDatabaseUrl(), max: 1 });
  try {
    const exists = await maintenance.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) await maintenance.query(`create database ${name}`);
  } finally {
    await maintenance.end();
  }
  const { pool, db } = benchDb();
  try {
    await migrate(db, { migrationsFolder: `${repoRoot}server/drizzle` });
  } finally {
    await pool.end();
  }
}

// Empties every runtime table. The database-name guard lives in benchPool.
export async function resetBenchTables(pool: Pool): Promise<void> {
  const current = await pool.query<{ name: string }>("select current_database() as name");
  if (!current.rows[0]!.name.endsWith("_bench")) throw new Error("resetBenchTables refused: not a *_bench database");
  await pool.query("truncate steps, step_events, workers, idempotent_effects restart identity");
}

// Called after a fixture is inserted and before timing starts, so every run
// begins with fresh planner statistics, no pending insert-triggered
// autovacuum, and no dirty buffers left over from fixture creation.
export async function settleBenchTables(pool: Pool): Promise<void> {
  await pool.query("vacuum (analyze) steps");
  await pool.query("checkpoint");
}

export async function databaseClock(pool: Pool): Promise<string> {
  const result = await pool.query<{ now: string }>("select clock_timestamp()::text as now");
  return result.rows[0]!.now;
}

export async function walPosition(pool: Pool): Promise<{ lsn: string; walRecords: number; walFpi: number; walBytes: number }> {
  const result = await pool.query<{ lsn: string; wal_records: string; wal_fpi: string; wal_bytes: string }>(
    "select pg_current_wal_lsn()::text as lsn, wal_records::text, wal_fpi::text, wal_bytes::text from pg_stat_wal",
  );
  const row = result.rows[0]!;
  return { lsn: row.lsn, walRecords: Number(row.wal_records), walFpi: Number(row.wal_fpi), walBytes: Number(row.wal_bytes) };
}

export async function walDelta(pool: Pool, start: Awaited<ReturnType<typeof walPosition>>) {
  const end = await walPosition(pool);
  const bytes = await pool.query<{ bytes: string }>("select pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::text as bytes", [end.lsn, start.lsn]);
  return {
    walBytes: Number(bytes.rows[0]!.bytes),
    walRecords: end.walRecords - start.walRecords,
    walFullPageImages: end.walFpi - start.walFpi,
  };
}

// --- child processes -------------------------------------------------------

export interface Child {
  name: string;
  process: ChildProcess;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  closed: Promise<void>;
  exited: boolean;
  stderrFile: string;
}

// `node --import tsx <script>`, no tsx launcher in between, so the PID we
// signal is the process running the script (same approach as the fencing
// demo). stdout is discarded: the worker logs every claim/completion, and
// piping that volume back through the harness would put harness overhead on
// the workers' critical path. stderr goes to a file and is counted after
// the run, because worker errors (rejected completions, failed writes) are
// logged there.
export function startTsChild(
  name: string,
  script: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stderrFile: string; stdout?: "ignore" | "pipe"; stdin?: "ignore" | "pipe" },
): Child {
  const stderrFd = openSync(options.stderrFile, "w");
  const handle = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repoRoot,
    env: options.env,
    stdio: [options.stdin ?? "ignore", options.stdout ?? "ignore", stderrFd],
  });
  closeSync(stderrFd);
  const child: Child = {
    name, process: handle, exitCode: null, signal: null, exited: false,
    closed: Promise.resolve(), stderrFile: options.stderrFile,
  };
  child.closed = new Promise((resolve) => {
    handle.once("close", (code, signal) => {
      child.exitCode = code;
      child.signal = signal;
      child.exited = true;
      resolve();
    });
  });
  return child;
}

export async function stopChildren(children: Child[], graceMs = 15_000): Promise<void> {
  for (const child of children) if (!child.exited) child.process.kill("SIGTERM");
  const all = Promise.all(children.map((child) => child.closed));
  const timedOut = await Promise.race([all.then(() => false), sleep(graceMs).then(() => true)]);
  if (timedOut) {
    for (const child of children) if (!child.exited) child.process.kill("SIGKILL");
    await all;
  }
}

export function stderrSummary(children: Child[]): { lines: number; sample: string[] } {
  const lines: string[] = [];
  for (const child of children) {
    const text = readFileSync(child.stderrFile, "utf8");
    for (const line of text.split("\n")) if (line.trim().length > 0) lines.push(`[${child.name}] ${line}`);
  }
  return { lines: lines.length, sample: lines.slice(0, 10) };
}

export function assertChildrenAlive(children: Child[]): void {
  for (const child of children) {
    if (child.exited) throw new Error(`${child.name} exited unexpectedly (code ${child.exitCode}, signal ${child.signal}); see ${child.stderrFile}`);
  }
}

// Process clock is only a watchdog here. Every measured instant in the
// results comes from PostgreSQL's clock.
export async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number, pollMs = 100): Promise<void> {
  const watchdog = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > watchdog) throw new Error(`timed out waiting for ${label}`);
    await sleep(pollMs);
  }
}

// --- small numeric helpers ---------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// --- environment metadata ----------------------------------------------------

function tryExec(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface PowerState {
  source: string | null;
  lowPowerMode: boolean | null;
}

// macOS only. Low Power Mode and battery operation both throttle the CPU on
// Apple Silicon, which changes every timing number, so the harness records
// them and refuses measured runs in either state unless explicitly told to.
export function powerState(): PowerState {
  if (process.platform !== "darwin") return { source: null, lowPowerMode: null };
  const batt = tryExec("pmset", ["-g", "batt"]);
  const settings = tryExec("pmset", ["-g"]);
  const source = batt?.match(/Now drawing from '([^']+)'/)?.[1] ?? null;
  const lowPower = settings?.match(/lowpowermode\s+(\d)/)?.[1];
  return { source, lowPowerMode: lowPower === undefined ? null : lowPower === "1" };
}

export interface MachineFitness {
  logicalCores: number;
  loadAverage1m: number;
  loadOk: boolean;
  // macOS memory-pressure percentage from `memory_pressure`; null elsewhere
  // or when unparsable (an unparsable value never refuses a run).
  memoryFreePercent: number | null;
  memoryOk: boolean;
}

// The power guard covers throttling; this covers an already-overloaded
// machine. A full run once started with the 1-minute load at several times
// the core count and swap nearly full: every phase ran ~30-50x slower until
// a suite watchdog fired and the invocation produced no artifact at all.
// Refusing up front is cheaper than discovering it an hour in. Thresholds:
// load above the core count means runnable/blocked threads exceed what the
// machine can execute; under 15% memory free is Apple's own pressure metric
// well into the red zone. Both are recorded in the artifact either way.
export function machineFitness(): MachineFitness {
  const logicalCores = os.cpus().length;
  const loadAverage1m = round(os.loadavg()[0]!, 2);
  let memoryFreePercent: number | null = null;
  if (process.platform === "darwin") {
    const pressure = tryExec("memory_pressure", []);
    const match = pressure?.match(/System-wide memory free percentage:\s*(\d+)%/);
    memoryFreePercent = match ? Number(match[1]) : null;
  }
  return {
    logicalCores,
    loadAverage1m,
    loadOk: loadAverage1m <= logicalCores,
    memoryFreePercent,
    memoryOk: memoryFreePercent === null || memoryFreePercent >= 15,
  };
}

export async function collectEnvironment(pool: Pool) {
  const url = new URL(benchDatabaseUrl());
  const host = url.hostname || "(unix socket)";
  const pgVersion = await pool.query<{ version: string; server_version: string }>(
    "select version(), current_setting('server_version') as server_version",
  );
  const settings = await pool.query<{ name: string; setting: string }>(
    `select name, current_setting(name) as setting from pg_settings where name = any($1) order by name`,
    [[
      "shared_buffers", "max_connections", "synchronous_commit", "fsync", "wal_sync_method", "full_page_writes",
      "wal_level", "work_mem", "max_wal_size", "checkpoint_timeout", "autovacuum", "autovacuum_naptime",
      "default_transaction_isolation", "commit_delay",
    ]],
  );
  const porcelain = tryExec("git", ["status", "--porcelain"]) ?? "";
  const runtimePorcelain = tryExec("git", ["status", "--porcelain", "--", "server", "package-lock.json"]) ?? "";
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    git: {
      commit: tryExec("git", ["rev-parse", "HEAD"]),
      subject: tryExec("git", ["log", "-1", "--format=%s"]),
      // The benchmark harness itself may be uncommitted while it is being
      // run; what matters for the numbers is that the runtime is not.
      runtimeSourceUnmodified: runtimePorcelain.length === 0,
      uncommittedPaths: porcelain.split("\n").filter((line) => line.length > 0),
    },
    node: process.version,
    os: {
      platform: process.platform,
      release: os.release(),
      productVersion: process.platform === "darwin" ? tryExec("sw_vers", ["-productVersion"]) : null,
      arch: process.arch,
    },
    cpu: {
      model: cpus[0]?.model ?? null,
      logicalCores: cpus.length,
      performanceCores: process.platform === "darwin" ? Number(tryExec("sysctl", ["-n", "hw.perflevel0.logicalcpu"]) ?? NaN) : null,
      efficiencyCores: process.platform === "darwin" ? Number(tryExec("sysctl", ["-n", "hw.perflevel1.logicalcpu"]) ?? NaN) : null,
    },
    memoryGiB: round(os.totalmem() / 1024 ** 3, 1),
    power: powerState(),
    fitness: machineFitness(),
    loadAverageAtStart: os.loadavg().map((value) => round(value, 2)),
    postgres: {
      version: pgVersion.rows[0]!.version,
      serverVersion: pgVersion.rows[0]!.server_version,
      // Host/port/database only: no user name or password in artifacts.
      host,
      port: url.port || "5432",
      database: databaseName(url.toString()),
      location: ["127.0.0.1", "localhost", "::1", "[::1]", "(unix socket)"].includes(host)
        ? "local (same machine as workers and harness)"
        : "remote",
      settings: Object.fromEntries(settings.rows.map((row) => [row.name, row.setting])),
    },
  };
}

export type Environment = Awaited<ReturnType<typeof collectEnvironment>>;
