import { createHash } from "node:crypto";
import { parseTaskType } from "../domain/task-type.js";

// Upper bound on delayMs. Exists so a bad or hostile payload can't make a
// worker sit on one step indefinitely; the value itself is only large
// enough to let multiple worker processes visibly overlap in a demo.
export const MAX_TASK_DELAY_MS = 5_000;

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

// Explicit shape validation rather than a schema library: one task type,
// two fields, not worth a dependency. Throws loudly on anything that
// doesn't match — an invalid persisted payload is a bug (bad insert, bad
// migration of old data), not something to route through retry logic that
// doesn't exist yet.
function parseHashAfterDelayPayload(payload: unknown): HashAfterDelayPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`hash_after_delay payload must be an object, got ${JSON.stringify(payload)}`);
  }
  const { input, delayMs } = payload as Record<string, unknown>;
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`hash_after_delay payload.input must be a non-empty string, got ${JSON.stringify(input)}`);
  }
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_TASK_DELAY_MS) {
    throw new Error(
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

// One switch over the one supported task type. Not a registry/plugin
// architecture — there is exactly one case, and adding a second is meant
// to mean adding a second case here, not registering a new module.
export async function executeStep(step: { taskType: string; payload: unknown }): Promise<Record<string, unknown>> {
  const taskType = parseTaskType(step.taskType);
  switch (taskType) {
    case "hash_after_delay":
      return runHashAfterDelay(step.payload);
  }
}
