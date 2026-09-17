import "../load-env.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Milestone 5 demo: worker crash, lease expiry, recovery, reclaim — using
// real local OS child processes and the real production timings (30s
// lease, 5s renewal, 2s heartbeat, 1s sweep). Nothing is shortened, so it
// takes a little under a minute.
//
// 1. Starts one coordinator process and three worker processes.
// 2. Submits a 40s step ("long", longer than one lease), an 8s step
//    ("victim"), and two short steps.
// 3. Once both long and victim are RUNNING, SIGKILLs whichever worker
//    process owns victim.
// 4. Prints what PostgreSQL shows while that happens: the killed worker's
//    heartbeat age growing, samples of victim RUNNING before expiry and
//    recovery/reclaim after expiry, and long's lease being renewed.
// 5. Waits for the coordinator to recover victim and another worker to
//    claim it at lease_version 2, then for every step to succeed.
//
// Everything printed is read back from PostgreSQL, and every time or
// duration printed is computed by PostgreSQL's clock. The demo's own
// clock is used only to decide when to poll and when to give up.
//
// Children are started as `node --import tsx <script>`, not through the
// `tsx` launcher binary that run-demo.ts uses. The launcher runs the script
// in a second, grandchild Node process and relays SIGTERM to it, but
// SIGKILL cannot be relayed: killing the launcher leaves the real worker
// running as an orphan, still heartbeating and renewing. Here the PID that
// gets SIGKILL is the worker itself.
//
// Deliberately NOT shown (Milestone 6): the killed worker resuming and
// attempting a stale completion after the reclaim.

const workerScript = fileURLToPath(new URL("./worker.ts", import.meta.url));
const coordinatorScript = fileURLToPath(new URL("../coordinator/coordinator.ts", import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startChild(script: string, args: string[]): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script, ...args], { stdio: "inherit" });
}

const STEPS = {
  long: { input: "recovery-demo-long", delayMs: 40_000, priority: 10 },
  victim: { input: "recovery-demo-victim", delayMs: 8_000, priority: 9 },
  short1: { input: "recovery-demo-short-1", delayMs: 1_500, priority: 1 },
  short2: { input: "recovery-demo-short-2", delayMs: 1_500, priority: 1 },
} as const;
type StepLabel = keyof typeof STEPS;
const WORKER_IDS = ["worker-a", "worker-b", "worker-c"] as const;

interface StepState {
  status: string;
  current_worker_id: string | null;
  lease_version: number;
  lease_expires_at: string | null;
  // Seconds of lease left by the database clock; negative once expired.
  lease_remaining_s: number | null;
  observed_at: string;
  original_deadline_passed: boolean | null;
  result: { hash: string } | null;
}

async function readStep(id: string, originalDeadline: string | null = null): Promise<StepState> {
  const result = await pool.query<StepState>(
    `select status, current_worker_id, lease_version, lease_expires_at::text,
            round(extract(epoch from lease_expires_at - db_clock.observed_at)::numeric, 1)::float as lease_remaining_s,
            db_clock.observed_at::text,
            db_clock.observed_at >= $2::timestamptz as original_deadline_passed,
            result
     from steps cross join (select clock_timestamp() as observed_at) as db_clock
     where id = $1`,
    [id, originalDeadline],
  );
  return result.rows[0]!;
}

async function heartbeatAges(): Promise<Map<string, { ageS: number; lastHeartbeatAt: string }>> {
  const result = await pool.query<{ id: string; age_s: number; last_heartbeat_at: string }>(
    `select id, round(extract(epoch from clock_timestamp() - last_heartbeat_at)::numeric, 1)::float as age_s,
            last_heartbeat_at::text
     from workers where id = any($1::text[])`,
    [[...WORKER_IDS]],
  );
  return new Map(result.rows.map((row) => [row.id, { ageS: row.age_s, lastHeartbeatAt: row.last_heartbeat_at }]));
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function main() {
  const unfinished = await pool.query<{ n: string }>(
    `select count(*) as n from steps where status in ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT')`,
  );
  if (Number(unfinished.rows[0]!.n) > 0) {
    // Leftover claimable or running steps would compete for the three
    // workers and make the scenario below nondeterministic. Refuse rather
    // than delete someone's rows.
    throw new Error(
      `found ${unfinished.rows[0]!.n} non-terminal steps already in the database; this demo needs no other ` +
        `claimable/running work. Test runs leave rows behind; if this is a development database holding only ` +
        `test/demo data, clear them with: delete from steps where status in ('PENDING','READY','RUNNING','RETRY_WAIT')`,
    );
  }

  const ids = {} as Record<StepLabel, string>;
  for (const [label, step] of Object.entries(STEPS) as Array<[StepLabel, (typeof STEPS)[StepLabel]]>) {
    ids[label] = randomUUID();
    await pool.query(
      `insert into steps (id, status, priority, task_type, payload) values ($1, 'READY', $2, 'hash_after_delay', $3::jsonb)`,
      [ids[label], step.priority, JSON.stringify({ input: step.input, delayMs: step.delayMs })],
    );
  }
  const labelOf = new Map(Object.entries(ids).map(([label, id]) => [id, label]));
  console.log("[demo] submitted steps:");
  for (const [label, id] of Object.entries(ids)) {
    const step = STEPS[label as StepLabel];
    console.log(`  ${label.padEnd(7)} ${id}  delayMs=${step.delayMs}  priority=${step.priority}`);
  }

  console.log("[demo] starting coordinator and 3 worker processes");
  const coordinator = startChild(coordinatorScript, []);
  const workers = new Map<string, ChildProcess>(WORKER_IDS.map((id) => [id, startChild(workerScript, [id])]));
  const allChildren = [coordinator, ...workers.values()];
  const failures: string[] = [];
  let succeeded = false;

  try {
    const victimClaim = await waitFor("long and victim to be RUNNING", 20_000, async () => {
      const [long, victim] = await Promise.all([readStep(ids.long), readStep(ids.victim)]);
      return long.status === "RUNNING" && victim.status === "RUNNING" ? victim : undefined;
    });
    const killedWorkerId = victimClaim.current_worker_id!;
    const killed = workers.get(killedWorkerId)!;
    const originalDeadline = victimClaim.lease_expires_at!;
    if (victimClaim.lease_version !== 1) failures.push("victim was not at generation 1 before SIGKILL");

    console.log(
      `\n[demo] victim is RUNNING under ${killedWorkerId} (pid ${killed.pid}) at lease_version ${victimClaim.lease_version}, ` +
        `lease remaining ${victimClaim.lease_remaining_s}s`,
    );
    console.log(`[demo] SIGKILL ${killedWorkerId} (pid ${killed.pid}) — no shutdown handler runs, no final writes\n`);
    const killedExit = new Promise<NodeJS.Signals | null>((resolve) => killed.once("exit", (_code, signal) => resolve(signal)));
    if (!killed.kill("SIGKILL")) throw new Error(`could not signal ${killedWorkerId}`);
    if ((await killedExit) !== "SIGKILL") failures.push("victim worker did not exit due to SIGKILL");
    const killedAt = (await pool.query<{ t: string }>("select clock_timestamp()::text as t")).rows[0]!.t;

    // Let any write the killed process had already sent land, then freeze
    // what its heartbeat looked like.
    await sleep(1_000);
    const frozenHeartbeat = (await heartbeatAges()).get(killedWorkerId)!.lastHeartbeatAt;

    // Observe until victim leaves the killed worker's ownership.
    let sawLiveVictim = false;
    let lastPrintAt = 0;
    const handover = await waitFor("victim to be recovered and reclaimed", 60_000, async () => {
      const [victim, long, ages] = await Promise.all([readStep(ids.victim, originalDeadline), readStep(ids.long), heartbeatAges()]);
      const sinceKill = (await pool.query<{ s: number }>(
        "select round(extract(epoch from clock_timestamp() - $1::timestamptz)::numeric, 1)::float as s",
        [killedAt],
      )).rows[0]!.s;

      const stillKilledWorkers = victim.status === "RUNNING" && victim.current_worker_id === killedWorkerId;
      if (stillKilledWorkers) {
        if (victim.original_deadline_passed === false) sawLiveVictim = true;
        if (victim.lease_version !== 1) failures.push(`victim changed lease_version to ${victim.lease_version} without a new owner`);
      } else if (victim.original_deadline_passed !== true) {
        failures.push(`sample at ${victim.observed_at} saw victim leave ownership before original deadline ${originalDeadline}`);
      }

      if (Date.now() - lastPrintAt >= 3_000 || !stillKilledWorkers) {
        lastPrintAt = Date.now();
        const heartbeatSummary = WORKER_IDS.map((id) => `${id}=${ages.get(id)?.ageS ?? "?"}s${id === killedWorkerId ? "(killed)" : ""}`).join(" ");
        const victimSummary = stillKilledWorkers
          ? `victim RUNNING owner=${killedWorkerId} v${victim.lease_version} lease_left=${victim.lease_remaining_s}s`
          : `victim ${victim.status} owner=${victim.current_worker_id ?? "-"} v${victim.lease_version}`;
        console.log(
          `[demo] +${sinceKill.toFixed(1)}s  ${victimSummary} | long ${long.status} v${long.lease_version} ` +
            `lease_left=${long.lease_remaining_s ?? "-"}s | heartbeat age: ${heartbeatSummary}`,
        );
      }

      if (stillKilledWorkers) return undefined;
      return { victim, sinceKill };
    });

    // State and database time come from the same sample. Polling can detect
    // a contradictory observation, but cannot locate the transition itself.
    if (!sawLiveVictim) failures.push("never sampled victim RUNNING under the killed worker before expiry");
    console.log(
      `\n[demo] sampled victim out of ${killedWorkerId}'s ownership ${handover.sinceKill.toFixed(1)}s after the kill ` +
        `(sample DB time: ${handover.victim.observed_at}; original deadline: ${originalDeadline}); now ${handover.victim.status} ` +
        `owner=${handover.victim.current_worker_id ?? "-"} lease_version=${handover.victim.lease_version}\n`,
    );

    const reclaim = await waitFor("victim to be claimed again", 20_000, async () => {
      const victim = await readStep(ids.victim, originalDeadline);
      if (victim.lease_version >= 2 && victim.original_deadline_passed !== true) {
        failures.push(`sample at ${victim.observed_at} saw reclaim before original deadline ${originalDeadline}`);
      }
      return victim.lease_version >= 2 ? victim : undefined;
    });
    if (reclaim.lease_version !== 2) failures.push(`victim jumped to lease_version ${reclaim.lease_version}, expected 2`);
    if (reclaim.status === "RUNNING") {
      if (reclaim.current_worker_id === killedWorkerId) failures.push("victim was reclaimed under the killed worker's ID");
      console.log(
        `[demo] victim reclaimed: RUNNING owner=${reclaim.current_worker_id} lease_version=${reclaim.lease_version} ` +
          `lease_left=${reclaim.lease_remaining_s}s\n`,
      );
    } else {
      console.log(`[demo] victim already ${reclaim.status} at lease_version ${reclaim.lease_version} when next observed\n`);
    }

    const final = await waitFor("every step to reach SUCCEEDED", 90_000, async () => {
      const rows = await Promise.all(Object.values(ids).map((id) => readStep(id).then((row) => ({ id, row }))));
      return rows.every(({ row }) => row.status === "SUCCEEDED") ? rows : undefined;
    });

    console.log("\n[demo] final durable state:");
    for (const { id, row } of final) {
      console.log(`  ${labelOf.get(id)!.padEnd(7)} ${row.status}  lease_version=${row.lease_version}  hash=${row.result!.hash.slice(0, 16)}…`);
    }

    const versionOf = (label: StepLabel) => final.find((entry) => entry.id === ids[label])!.row.lease_version;
    if (versionOf("long") !== 1) failures.push(`long finished at lease_version ${versionOf("long")}, expected 1 (renewed, never reclaimed)`);
    if (versionOf("victim") !== 2) failures.push(`victim finished at lease_version ${versionOf("victim")}, expected 2 (one recovery, one reclaim)`);
    if (versionOf("short1") !== 1 || versionOf("short2") !== 1) failures.push("a short step was claimed more than once");

    const agesNow = await heartbeatAges();
    const heartbeatNow = agesNow.get(killedWorkerId)!;
    if (heartbeatNow.lastHeartbeatAt !== frozenHeartbeat) {
      failures.push(`${killedWorkerId}'s heartbeat advanced after the post-kill baseline`);
    }
    const survivors = WORKER_IDS.filter((id) => id !== killedWorkerId);
    for (const id of survivors) {
      // Three missed 2s heartbeats would be suspicious; a surviving worker
      // should be well inside that.
      if ((agesNow.get(id)?.ageS ?? Infinity) > 6) failures.push(`surviving ${id} has not heartbeated recently`);
    }
    console.log(
      `\n[demo] heartbeat age now: ${killedWorkerId}=${heartbeatNow.ageS}s (timestamp unchanged since post-kill baseline); ` +
        survivors.map((id) => `${id}=${agesNow.get(id)?.ageS}s`).join(" "),
    );
    succeeded = failures.length === 0;
  } finally {
    const running = allChildren.filter((child) => child.exitCode === null && child.signalCode === null);
    console.log(`\n[demo] stopping ${running.length} remaining processes`);
    const exits = running.map((child) => new Promise((resolve) => child.once("exit", resolve)));
    // After a successful run nothing is executing, so SIGTERM stops them
    // promptly. After a failure a worker may be mid-step for up to 40s;
    // don't wait for that.
    for (const child of running) child.kill(succeeded ? "SIGTERM" : "SIGKILL");
    await Promise.race([Promise.all(exits), sleep(10_000)]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error("\n[demo] CHECKS FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    "\n[demo] sampled checks passed: killed worker heartbeat did not advance after the post-kill baseline; " +
      "samples saw victim RUNNING before expiry and recovery/reclaim after expiry, with generation v1 -> v2. " +
      "Polling does not prove the exact recovery instant. Long outlived one 30s lease through renewal and finished at v1.",
  );
}

main().catch((error) => {
  console.error("[demo] failed:", error);
  process.exit(1);
});
