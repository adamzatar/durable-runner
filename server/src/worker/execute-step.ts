import { createHash } from "node:crypto";
import { parseTaskType } from "../domain/task-type.js";
import { DEMO_EFFECT_TYPE, MAX_IDEMPOTENCY_KEY_LENGTH, type EffectOutcome, type EffectRequest } from "../db/idempotent-effect.js";

// One distinction: unchanged invalid input cannot improve on a retry.
// Ordinary exceptions from a validated task remain retryable.
export class InvalidTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskError";
  }
}

// Upper bound on delayMs. Exists so a bad or hostile payload can't make a
// worker sit on one step indefinitely. Raised from 5s to 60s in Milestone
// 5: a step is now allowed to outlast STEP_LEASE_DURATION_MS (30s) because
// the worker renews its lease while executing, and the recovery demo uses
// a step longer than one lease to show that renewal happening in real
// worker processes.
//
// The delay is an async timer wait, so the event loop stays free and the
// lease-renewal timer keeps firing during it. That is a property of this
// executor, not of executors in general: code that blocks the event loop
// for longer than the lease stops renewal and loses the lease.
export const MAX_TASK_DELAY_MS = 60_000;

// The one capability an executor is handed. A single function, not a
// container, registry or repository layer: only idempotent_effect uses it,
// and it is passed explicitly so a task cannot reach the database for
// anything else.
export interface ExecutionContext {
  applyEffect: (request: EffectRequest) => Promise<EffectOutcome>;
}

export interface IdempotentEffectPayload {
  idempotencyKey: string;
  value: string;
  delayAfterEffectMs: number;
}

export interface HashAfterDelayPayload {
  input: string;
  delayMs: number;
}

export interface HashAfterDelayResult extends Record<string, unknown> {
  hash: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Explicit validation keeps invalid input separate from runtime failure.
function parseHashAfterDelayPayload(payload: unknown): HashAfterDelayPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidTaskError(`hash_after_delay payload must be an object, got ${JSON.stringify(payload)}`);
  }
  const { input, delayMs } = payload as Record<string, unknown>;
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidTaskError(`hash_after_delay payload.input must be a non-empty string, got ${JSON.stringify(input)}`);
  }
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_TASK_DELAY_MS) {
    throw new InvalidTaskError(
      `hash_after_delay payload.delayMs must be an integer in [0, ${MAX_TASK_DELAY_MS}], got ${JSON.stringify(delayMs)}`,
    );
  }
  return { input, delayMs };
}

async function runHashAfterDelay(payload: unknown): Promise<HashAfterDelayResult> {
  const { input, delayMs } = parseHashAfterDelayPayload(payload);
  await sleep(delayMs);
  return { hash: createHash("sha256").update(input).digest("hex") };
}

function failThenHash(payload: unknown, attemptCount: number): HashAfterDelayResult {
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidTaskError("fail_then_hash payload must be an object");
  }
  const { input, failuresBeforeSuccess } = payload as Record<string, unknown>;
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidTaskError("fail_then_hash payload.input must be a non-empty string");
  }
  if (typeof failuresBeforeSuccess !== "number" || !Number.isSafeInteger(failuresBeforeSuccess) || failuresBeforeSuccess < 0) {
    throw new InvalidTaskError("fail_then_hash payload.failuresBeforeSuccess must be a nonnegative safe integer");
  }
  if (attemptCount <= failuresBeforeSuccess) {
    throw new Error(`fail_then_hash deterministic failure on attempt ${attemptCount}`);
  }
  return { hash: createHash("sha256").update(input).digest("hex") };
}

function parseIdempotentEffectPayload(payload: unknown): IdempotentEffectPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidTaskError(`idempotent_effect payload must be an object, got ${JSON.stringify(payload)}`);
  }
  const { idempotencyKey, value, delayAfterEffectMs } = payload as Record<string, unknown>;
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new InvalidTaskError(
      `idempotent_effect payload.idempotencyKey must be a non-empty string, got ${JSON.stringify(idempotencyKey)}`,
    );
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidTaskError(
      `idempotent_effect payload.idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidTaskError(`idempotent_effect payload.value must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (
    typeof delayAfterEffectMs !== "number" ||
    !Number.isInteger(delayAfterEffectMs) ||
    delayAfterEffectMs < 0 ||
    delayAfterEffectMs > MAX_TASK_DELAY_MS
  ) {
    throw new InvalidTaskError(
      `idempotent_effect payload.delayAfterEffectMs must be an integer in [0, ${MAX_TASK_DELAY_MS}], got ${JSON.stringify(delayAfterEffectMs)}`,
    );
  }
  return { idempotencyKey, value, delayAfterEffectMs };
}

/**
 * Applies (or reuses) one keyed side effect, then optionally waits.
 *
 * The delay is deliberately AFTER the effect has committed: it is what makes
 * the interesting failure window — effect durable, step completion not yet
 * written — reachable on purpose in tests and the demo instead of only by
 * luck. It waits asynchronously, so lease renewal keeps running during it.
 *
 * The returned result is the stored effect result, whether this execution
 * applied it or reused an earlier one. That is what makes a re-execution's
 * step result identical to the original's, and it is why the result carries
 * no "did I apply it" flag: that fact is local to one execution, while the
 * step result describes the logical effect.
 */
async function runIdempotentEffect(payload: unknown, context: ExecutionContext): Promise<EffectOutcome["result"]> {
  const { idempotencyKey, value, delayAfterEffectMs } = parseIdempotentEffectPayload(payload);
  const outcome = await context.applyEffect({
    idempotencyKey,
    effectType: DEMO_EFFECT_TYPE,
    request: { value },
  });
  await sleep(delayAfterEffectMs);
  return outcome.result;
}

// Durable attempt input comes from the claim, never a process-local counter.
// `context` is required rather than optional so a task that needs an effect
// can never silently run without one.
export async function executeStep(
  step: { taskType: string; payload: unknown; attemptCount: number },
  context: ExecutionContext,
): Promise<Record<string, unknown>> {
  let taskType;
  try {
    taskType = parseTaskType(step.taskType);
  } catch (error) {
    throw new InvalidTaskError(error instanceof Error ? error.message : String(error));
  }
  if (!Number.isInteger(step.attemptCount) || step.attemptCount < 1) {
    throw new InvalidTaskError("execution requires a positive claimed attemptCount");
  }
  switch (taskType) {
    case "hash_after_delay":
      return runHashAfterDelay(step.payload);
    case "fail_then_hash":
      return failThenHash(step.payload, step.attemptCount);
    case "idempotent_effect":
      return runIdempotentEffect(step.payload, context);
  }
}
