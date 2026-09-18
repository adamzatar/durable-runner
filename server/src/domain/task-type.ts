// Canonical task types a step can carry. Deliberately a plain array plus a
// text column, not a Postgres enum: unlike step_status (a closed lifecycle),
// this set is expected to grow, and a DB enum would need an
// ALTER TYPE ... ADD VALUE migration for every new task. The trade is that
// an invalid value isn't rejected at insert time, only when a worker
// actually tries to execute it — parseTaskType is that boundary check.
export const TASK_TYPES = ["hash_after_delay", "fail_then_hash", "idempotent_effect"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function parseTaskType(value: unknown): TaskType {
  if (typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value)) {
    return value as TaskType;
  }
  throw new Error(`Not a supported task type: ${JSON.stringify(value)}`);
}
