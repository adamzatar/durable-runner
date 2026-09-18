import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// The one simulated effect type. A constant rather than a caller-supplied
// string of arbitrary meaning: this is a demonstration of an idempotency
// contract, not a generic effect framework.
export const DEMO_EFFECT_TYPE = "demo_receipt";

// Bounds a key so a payload cannot store an unbounded blob as a primary key.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface EffectRequest {
  idempotencyKey: string;
  effectType: string;
  // The logical request. Compared with PostgreSQL's jsonb equality against
  // whatever the first application stored under this key.
  request: Record<string, unknown>;
}

export interface EffectResult extends Record<string, unknown> {
  effectId: string;
  value: unknown;
}

export interface EffectOutcome {
  // Describes THIS call, not the logical effect: true means this caller's
  // INSERT created the row, false means the effect already existed and its
  // stored result was returned unchanged. The primary key permits at most
  // one durable row per key.
  applied: boolean;
  result: EffectResult;
  createdAt: string;
}

// Thrown when a key is reused for something that is not the same logical
// request. Reusing a key by accident is a caller bug, and returning the
// earlier result for a different request would hide it behind a value that
// looks legitimate.
export class IdempotencyConflictError extends Error {
  constructor(
    readonly idempotencyKey: string,
    message: string,
  ) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

// Thrown if the key vanished between the insert attempt and the read. No
// code path deletes effects (no expiry, no garbage collection), so this
// means an assumption about the store is wrong. Deliberately not covered by
// a test: reaching it needs a delete to land between the two statements,
// which is a race no amount of test timing makes deterministic, and adding
// a seam to production code to force it would be worse than the guard.
export class EffectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectStateError";
  }
}

type InsertedRow = { result: EffectResult; created_at: string };
type ExistingRow = { result: EffectResult; created_at: string; matches: boolean };

/**
 * Applies the logical effect identified by `idempotencyKey`, or returns the
 * result of the application that already happened under that key.
 *
 * This is the simulated boundary to an external system. `idempotent_effects`
 * stands in for the far side of a call this system cannot take back once it
 * has happened: fencing can reject a stale worker's step write, but it
 * cannot undo an effect that worker already performed. The key is what makes
 * the effect safe to attempt again.
 *
 * Two statements, each its own autocommit transaction:
 *
 *   1. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING ...
 *      Uniqueness on the primary key is the concurrency authority, not
 *      application logic. One row returned means this caller applied the
 *      effect. Verified on PostgreSQL 16: when another transaction has
 *      inserted the same key but not yet committed, this statement waits on
 *      that transaction (it does not fail with a unique violation), then
 *      returns zero rows once the other commits.
 *   2. Zero rows means the effect already exists, so read it back and let
 *      PostgreSQL compare the stored effect_type/request against this
 *      request.
 *
 * Why two statements rather than one INSERT ... ON CONFLICT DO NOTHING with
 * a fallback SELECT in the same statement: a statement's snapshot is taken
 * before it waits. The fallback SELECT would not see the row the other
 * transaction committed during the wait, and the statement returns NO rows
 * at all. Measured on PostgreSQL 16 before choosing this shape (see
 * docs/build-journal.md). A second statement takes a fresh snapshot under
 * READ COMMITTED and sees the committed row.
 *
 * Deliberately NOT wrapped in a transaction with anything else, and in
 * particular not with the step's completion write:
 *
 * - Combining them would make the effect and the step outcome commit
 *   together, which would hide the failure window this milestone exists to
 *   demonstrate (effect commits, process dies, completion never commits).
 * - It also keeps this write off the critical path of a step row lock; the
 *   effect store is a separate durable boundary, not part of step state.
 *
 * The row IS the effect, so its insert atomically records and applies it.
 * Calling an arbitrary third-party API before or after this insert (even
 * inside a PostgreSQL transaction) would introduce a gap: one system can
 * commit while the other does not. This sink does not solve that gap; a
 * retried external API needs its own durable idempotency contract.
 */
export async function applyIdempotentEffect<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  request: EffectRequest,
): Promise<EffectOutcome> {
  const { idempotencyKey, effectType } = request;
  if (idempotencyKey.trim().length === 0) {
    throw new Error("applyIdempotentEffect requires a non-empty idempotencyKey");
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(
      `applyIdempotentEffect idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters, got ${idempotencyKey.length}`,
    );
  }
  if (effectType.trim().length === 0) {
    throw new Error("applyIdempotentEffect requires a non-empty effectType");
  }

  const requestJson = JSON.stringify(request.request);
  // Minted per call, but only durable if THIS call's insert wins. A caller
  // whose insert conflicts discards this and returns the stored identifier —
  // it never reports a freshly generated result as if it were the stored one.
  const candidate: EffectResult = { effectId: randomUUID(), value: (request.request as { value?: unknown }).value };

  const inserted = await db.execute<InsertedRow>(sql`
    insert into idempotent_effects (idempotency_key, effect_type, request, result, created_at)
    values (${idempotencyKey}, ${effectType}, ${requestJson}::jsonb, ${JSON.stringify(candidate)}::jsonb, clock_timestamp())
    on conflict (idempotency_key) do nothing
    returning result, created_at::text
  `);

  const appliedRow = inserted.rows[0];
  if (appliedRow) {
    return { applied: true, result: appliedRow.result, createdAt: appliedRow.created_at };
  }

  // Fresh snapshot: sees the row whichever transaction committed it.
  const existing = await db.execute<ExistingRow>(sql`
    select result,
           created_at::text,
           effect_type = ${effectType} and request = ${requestJson}::jsonb as matches
    from idempotent_effects
    where idempotency_key = ${idempotencyKey}
  `);

  const row = existing.rows[0];
  if (!row) {
    throw new EffectStateError(
      `effect ${idempotencyKey} was neither inserted nor found; nothing in this system deletes effects`,
    );
  }
  if (!row.matches) {
    // Nothing was written by this call: the INSERT did not apply, and this
    // read changes nothing. The stored effect stays exactly as it was.
    throw new IdempotencyConflictError(
      idempotencyKey,
      `idempotency key ${idempotencyKey} was already used for a different effect type or request`,
    );
  }
  return { applied: false, result: row.result, createdAt: row.created_at };
}
