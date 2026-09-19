import "../server/src/load-env.js";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ClaimConsistencyError, claimNextStep } from "../server/src/db/claim-step.js";

// Child process for the claim-contention benchmark. Runs `claimers`
// independent claim loops, each on its own single-connection pool (its own
// PostgreSQL session), all calling the production claimNextStep. Every grant
// a claimer receives is recorded client-side and written out at exit, so the
// harness can check ownership from what claimers were actually told, not
// only from final row state.
//
// Harness control only (not runtime coordination): prints "ready" once every
// session is connected, waits for "go" on stdin, stops on SIGTERM.

interface ClaimerConfig {
  processIndex: number;
  claimers: number;
  leaseMs: number;
  // backlog: stop once no READY row remains. churn: run until SIGTERM.
  mode: "backlog" | "churn";
  outFile: string;
}

export interface ClaimerRecord {
  id: string;
  attempts: number;
  empty: number;
  consistencyErrors: number;
  otherErrors: number;
  otherErrorSamples: string[];
  // [step id, lease version, attempt count] per successful claim.
  grants: [string, number, number][];
}

const config = JSON.parse(process.argv[2]!) as ClaimerConfig;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });

let releaseGo!: () => void;
const go = new Promise<void>((resolve) => { releaseGo = resolve; });
createInterface({ input: process.stdin }).on("line", (line) => { if (line.trim() === "go") releaseGo(); });

async function claimerLoop(id: string, connected: () => void): Promise<ClaimerRecord> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = drizzle(pool);
  const record: ClaimerRecord = {
    id, attempts: 0, empty: 0, consistencyErrors: 0, otherErrors: 0, otherErrorSamples: [], grants: [],
  };
  await pool.query("select 1");
  connected();
  await go;
  while (!stopping) {
    record.attempts += 1;
    try {
      const result = await claimNextStep(db, id, { leaseDurationMs: config.leaseMs });
      if (result.claimed) {
        record.grants.push([result.step.id, result.step.leaseVersion, result.step.attemptCount]);
        continue;
      }
      record.empty += 1;
      if (config.mode === "backlog") {
        // A READY row that another session is mid-claim on is skipped by
        // SKIP LOCKED but still READY here, so this only ends the loop once
        // every row has actually been claimed.
        const remaining = await pool.query<{ any: boolean }>("select exists (select 1 from steps where status = 'READY') as any");
        if (!remaining.rows[0]!.any) break;
      }
    } catch (error) {
      if (error instanceof ClaimConsistencyError) {
        record.consistencyErrors += 1;
      } else {
        record.otherErrors += 1;
        if (record.otherErrorSamples.length < 5) record.otherErrorSamples.push(String(error));
      }
    }
  }
  await pool.end();
  return record;
}

let connectedCount = 0;
const loops = Array.from({ length: config.claimers }, (_, index) =>
  claimerLoop(`claimer-p${config.processIndex}-c${index + 1}`, () => {
    connectedCount += 1;
    if (connectedCount === config.claimers) process.stdout.write("ready\n");
  }),
);
const records = await Promise.all(loops);
writeFileSync(config.outFile, JSON.stringify(records));
process.exit(0);
