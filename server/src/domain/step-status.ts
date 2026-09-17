// Canonical status values for a step's lifecycle. Other modules (Drizzle
// schema, transition table, API/event payloads) should import this rather
// than redefining the set of statuses.
export const STEP_STATUSES = [
  "PENDING",
  "READY",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "DEAD_LETTERED",
  "CANCELLED",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

// Terminal statuses have no legal outgoing transitions — see
// step-transitions.ts, which is the authority on transition legality.
// This set exists for call sites that only need a terminal/non-terminal
// check without pulling in the full transition table.
const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  "SUCCEEDED",
  "DEAD_LETTERED",
  "CANCELLED",
]);

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}
