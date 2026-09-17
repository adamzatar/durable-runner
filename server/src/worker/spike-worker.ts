import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { spikeEvents } from "../db/schema.js";

// SPIKE-ONLY. Proves: a child process can take a unique identity, open its
// own independent Postgres connection (not inherited from the parent), and
// have its activity observed by another process purely by reading rows
// back from the database. No IPC/process.send is used for anything the
// coordinator needs to know — that's the property the real claiming design
// depends on.
const workerId = process.argv[2];
if (!workerId) {
  throw new Error("spike-worker requires a worker id as argv[2]");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

let tick = 0;

async function heartbeat() {
  tick += 1;
  await db.insert(spikeEvents).values({
    source: `worker-${workerId}`,
    message: `heartbeat #${tick} from pid ${process.pid}`,
  });
  console.log(`[worker-${workerId}] wrote heartbeat #${tick}`);
}

const interval = setInterval(() => {
  heartbeat().catch((err) => {
    console.error(`[worker-${workerId}] heartbeat failed:`, err);
  });
}, 1000);

process.on("SIGTERM", () => {
  clearInterval(interval);
  pool.end().finally(() => process.exit(0));
});

console.log(`[worker-${workerId}] started, pid ${process.pid}`);
