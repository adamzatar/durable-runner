import "../load-env.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// SPIKE-ONLY. This is the child-process experiment from
// tasks/00-environment-spike.md: fork several worker child processes,
// prove the coordinator can observe their activity purely through
// PostgreSQL, kill one, and prove the coordinator and the remaining
// workers are unaffected. Not the real coordinator — no claiming,
// leasing, or failure detection here.

const tsxBin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const workerScript = fileURLToPath(new URL("./spike-worker.ts", import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWorker(id: string): ChildProcess {
  const child = spawn(tsxBin, [workerScript, id], { stdio: "inherit" });
  return child;
}

async function countsBySource(): Promise<Record<string, number>> {
  const result = await pool.query<{ source: string; count: string }>(
    "select source, count(*) as count from spike_events where source like 'worker-%' group by source order by source",
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.source] = Number(row.count);
  }
  return counts;
}

async function main() {
  console.log("[coordinator] starting 3 workers: a, b, c");
  const workers = {
    a: startWorker("a"),
    b: startWorker("b"),
    c: startWorker("c"),
  };

  await sleep(5000);
  const beforeKill = await countsBySource();
  console.log("[coordinator] row counts after 5s (before killing worker b):", beforeKill);

  console.log("[coordinator] sending SIGTERM to worker b");
  workers.b.kill("SIGTERM");

  await sleep(4000);
  const afterKill = await countsBySource();
  console.log("[coordinator] row counts 4s after killing worker b:", afterKill);

  console.log("[coordinator] is still running (this line only prints if the parent survived the kill)");
  console.log(
    "[coordinator] worker b produced",
    (afterKill["worker-b"] ?? 0) - (beforeKill["worker-b"] ?? 0),
    "new rows after being killed (expect 0)",
  );
  console.log(
    "[coordinator] worker a produced",
    (afterKill["worker-a"] ?? 0) - (beforeKill["worker-a"] ?? 0),
    "new rows after worker b was killed (expect > 0)",
  );
  console.log(
    "[coordinator] worker c produced",
    (afterKill["worker-c"] ?? 0) - (beforeKill["worker-c"] ?? 0),
    "new rows after worker b was killed (expect > 0)",
  );

  workers.a.kill("SIGTERM");
  workers.c.kill("SIGTERM");
  await sleep(500);
  await pool.end();
  console.log("[coordinator] experiment complete, remaining workers stopped");
}

main().catch((err) => {
  console.error("[coordinator] experiment failed:", err);
  process.exit(1);
});
