import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { STEP_STATUSES } from "../domain/step-status.js";

// SPIKE-ONLY TABLE. Exists to prove that a real Drizzle migration, plus
// reads/writes from independent processes against shared PostgreSQL state,
// work in this environment (tasks/00-environment-spike.md). Not part of
// the real schema (runs/steps/workers/attempts/events) — delete once
// Phase 0 is reviewed.
export const spikeEvents = pgTable("spike_events", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Built from the canonical STEP_STATUSES tuple rather than a second
// hand-written list, so the database type and the domain module cannot
// drift apart. The database therefore rejects any status outside the
// lifecycle, independently of application code being correct.
export const stepStatusEnum = pgEnum("step_status", STEP_STATUSES);

export const steps = pgTable(
  "steps",
  {
    // Random UUID rather than a sequence: claim ordering must come from
    // priority/available_at explicitly, not from an incidental insertion
    // order that a serial key would smuggle in.
    id: uuid("id").primaryKey().defaultRandom(),
    // No default — a caller must state which lifecycle state it is
    // creating the step in.
    status: stepStatusEnum("status").notNull(),
    // Higher number = claimed sooner. See claim-step.ts for the full
    // ordering.
    priority: integer("priority").notNull().default(0),
    // "Not eligible to be claimed before this instant." Doubles as the
    // retry-backoff deadline later, so eligibility and retry scheduling
    // share one mechanism instead of two.
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    // Nullable: a step that no worker owns has no owner recorded. Plain
    // text, deliberately not a foreign key to `workers`: authority over a
    // step comes from this row's lease (owner + lease_version + deadline),
    // not from the worker being registered. The workers table is liveness
    // evidence for observability and must not become a precondition of,
    // or an input to, ownership decisions.
    currentWorkerId: text("current_worker_id"),
    // Ownership generation. 0 means "never claimed"; every successful
    // READY -> RUNNING claim increments it. See claim-step.ts.
    leaseVersion: integer("lease_version").notNull().default(0),
    // The authority boundary for the current ownership generation, always
    // written from the database clock: set by the claim, pushed forward by
    // renewStepLease, cleared by completion and by recovery. Once the
    // database clock reaches it, the owner can no longer renew or complete
    // (renew-step-lease.ts, complete-step.ts) and recovery may return the
    // step to READY (recover-expired-steps.ts). Those are three separate
    // statements checking the same boundary; no background process has to
    // run for the owner to lose authority.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // What a worker should execute. No default, same reasoning as status:
    // a caller must state what a step does, rather than silently getting a
    // placeholder task. Validity of the value (is this a task type a
    // worker actually knows how to run?) is checked at execution time by
    // parseTaskType, not by the database.
    taskType: text("task_type").notNull(),
    // Structured input for task_type. No default for the same reason as
    // task_type: every step must state its own input explicitly.
    payload: jsonb("payload").notNull(),
    // Structured output. Null until a step reaches SUCCEEDED; nothing
    // else currently writes it.
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Maintained by the writing statement, not by a trigger — the claim
    // sets it in the same UPDATE that takes ownership.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    // Key columns and their directions match the claim query's ORDER BY
    // exactly, and the partial predicate matches its status filter, so
    // the planner can walk claimable candidates in claim order. Partial
    // because RUNNING/terminal rows accumulate and are never claimable —
    // keeping them out keeps the index to the working set. The
    // available_at <= now() half of the filter still has to be evaluated
    // per candidate; no claim is made that one index covers everything.
    index("steps_claimable_idx")
      .on(sql`priority DESC`, sql`available_at ASC`, sql`id ASC`)
      .where(sql`status = 'READY'`),
    // Serves the recovery sweep (recover-expired-steps.ts), which runs on a
    // fixed interval whether or not anything has expired. Partial on
    // RUNNING for the same reason as above: terminal rows accumulate
    // forever. Only actively executing steps are bounded by worker loops;
    // failed/abandoned executions remain RUNNING until recovery and can
    // temporarily exceed worker count. The sweep compares against
    // clock_timestamp(), which is volatile, so this index is not used as a
    // range bound on the deadline — it can avoid scanning terminal rows
    // when the planner chooses it. Nothing has been measured.
    index("steps_running_lease_idx")
      .on(sql`lease_expires_at ASC`)
      .where(sql`status = 'RUNNING'`),
    // A RUNNING row must have a non-null current_worker_id, a non-null
    // lease_expires_at, and lease_version > 0. The database enforces those
    // three conditions whichever code path writes the row. It does not
    // validate the worker ID's content: an empty or whitespace-only string
    // satisfies this CHECK. Blank worker IDs are rejected separately, by
    // claimNextStep, before any claim is attempted.
    // Deliberately scoped to RUNNING only, so it does not pre-decide what
    // the later completion/recovery transitions do with these columns.
    check(
      "steps_running_requires_owner",
      sql`status <> 'RUNNING' OR (current_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_version > 0)`,
    ),
  ],
);

// Worker liveness evidence (Milestone 5). One row per worker ID, not per
// process lifetime: a process that restarts under the same ID overwrites
// started_at. A row here means only "a process using this ID reached
// PostgreSQL at last_heartbeat_at". It does not mean the worker is alive
// now, that it owns anything, or that its work is healthy, and nothing in
// the recovery path reads it — lease expiry on `steps` is the only thing
// that authorizes taking work away from a worker. See
// docs/architecture.md.
//
// Deliberately absent: a status column (liveness is inferred from
// heartbeat age by whoever reads it, not stored as a verdict), a stopped_at
// column (nothing reads it yet), PID/host (not a meaningful identity once
// processes restart or run elsewhere), capacity, labels.
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  // No defaults on either timestamp: both are written explicitly from the
  // database's clock_timestamp() by worker-heartbeat.ts, never from the
  // worker process's clock.
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
});
