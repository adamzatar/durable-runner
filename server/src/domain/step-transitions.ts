import type { StepStatus } from "./step-status.js";

// The legal step lifecycle graph. This table only validates transition
// *shape* — it has no I/O and knows nothing about lease ownership, worker
// identity, or attempt counts. Some entries describe a real lifecycle
// possibility that a future layer must additionally gate on runtime
// conditions before actually invoking them:
//
// - RUNNING -> READY represents lease-expiry recovery. This table allows
//   the shape of that transition; it does not by itself authorize an
//   arbitrary caller to reset a running step. That authorization belongs
//   to the future claiming/lease layer (only the sweeper, on an actually
//   expired lease, may perform it).
//
// Cancellation is deliberately not legal directly from RUNNING. A step
// with an active worker holding it can't be cancelled by flipping a
// status column out from under that worker — the write would race the
// worker's own completion/failure report. Cancelling in-flight work needs
// a cooperative mechanism (the worker observing a cancellation request)
// that doesn't exist yet. Until then, a step can only be cancelled while
// no worker owns it: PENDING, READY, or RETRY_WAIT.
//
// RETRY_WAIT has one meaning: the retry decision has already been made —
// the failure was classified as retryable and attempt budget remained.
// That classification happens once, on the RUNNING -> {RETRY_WAIT,
// DEAD_LETTERED} edge, not deferred to a second check after waiting. There
// is no RETRY_WAIT -> DEAD_LETTERED: once a step is in RETRY_WAIT, its
// only legal next lifecycle transition (once the backoff expires and the
// system processes it, if it hasn't been cancelled first) is READY. This
// table governs transition *legality*, not liveness — it says nothing
// about whether or when a coordinator actually processes an expired
// backoff; a crashed or unavailable coordinator could leave a step in
// RETRY_WAIT indefinitely without that being an illegal state.
const LEGAL_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  PENDING: ["READY", "CANCELLED"],
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "RETRY_WAIT", "DEAD_LETTERED", "READY"],
  RETRY_WAIT: ["READY", "CANCELLED"],
  SUCCEEDED: [],
  DEAD_LETTERED: [],
  CANCELLED: [],
};

export function isLegalStepTransition(from: StepStatus, to: StepStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalStepTransitionError extends Error {
  readonly from: StepStatus;
  readonly to: StepStatus;

  constructor(from: StepStatus, to: StepStatus) {
    super(`Illegal step transition: ${from} -> ${to}`);
    this.name = "IllegalStepTransitionError";
    this.from = from;
    this.to = to;
  }
}

// Validates a requested transition and returns the destination status on
// success. Throws rather than returning a boolean so a caller can't
// silently drop a rejected transition and continue as if it happened.
export function transitionStepStatus(from: StepStatus, to: StepStatus): StepStatus {
  if (!isLegalStepTransition(from, to)) {
    throw new IllegalStepTransitionError(from, to);
  }
  return to;
}
