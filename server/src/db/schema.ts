import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    // text, not a foreign key — there is no workers table yet, and
    // inventing one now would be speculative.
    currentWorkerId: text("current_worker_id"),
    // Ownership generation. 0 means "never claimed"; every successful
    // READY -> RUNNING claim increments it. See claim-step.ts.
    leaseVersion: integer("lease_version").notNull().default(0),
    // Written by the claim's ownership UPDATE from the database clock at
    // that moment (see claim-step.ts). NOTHING READS THIS YET: no sweeper,
    // no expiry check, no reclaim. An expired value currently has no
    // effect on eligibility or on the owning worker.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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
