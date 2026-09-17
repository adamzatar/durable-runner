import { describe, expect, it } from "vitest";
import { STEP_STATUSES, isTerminalStepStatus, type StepStatus } from "../src/domain/step-status.js";
import {
  IllegalStepTransitionError,
  isLegalStepTransition,
  transitionStepStatus,
} from "../src/domain/step-transitions.js";

const LEGAL_TRANSITIONS: ReadonlyArray<[StepStatus, StepStatus]> = [
  ["PENDING", "READY"],
  ["PENDING", "CANCELLED"],
  ["READY", "RUNNING"],
  ["READY", "CANCELLED"],
  ["RUNNING", "SUCCEEDED"],
  ["RUNNING", "RETRY_WAIT"],
  ["RUNNING", "DEAD_LETTERED"],
  ["RUNNING", "READY"],
  ["RETRY_WAIT", "READY"],
  ["RETRY_WAIT", "CANCELLED"],
];

const TERMINAL_STATUSES: readonly StepStatus[] = ["SUCCEEDED", "DEAD_LETTERED", "CANCELLED"];

describe("step status transitions", () => {
  describe("every intended legal transition", () => {
    it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
      expect(isLegalStepTransition(from, to)).toBe(true);
      expect(transitionStepStatus(from, to)).toBe(to);
    });
  });

  describe("illegal transitions", () => {
    it("rejects skipping READY: PENDING -> RUNNING", () => {
      expect(isLegalStepTransition("PENDING", "RUNNING")).toBe(false);
      expect(() => transitionStepStatus("PENDING", "RUNNING")).toThrow(IllegalStepTransitionError);
    });

    it("rejects skipping RUNNING: READY -> SUCCEEDED", () => {
      expect(isLegalStepTransition("READY", "SUCCEEDED")).toBe(false);
    });

    it("rejects skipping READY on retry: RETRY_WAIT -> RUNNING", () => {
      expect(isLegalStepTransition("RETRY_WAIT", "RUNNING")).toBe(false);
    });

    it("rejects direct cancellation of active work: RUNNING -> CANCELLED", () => {
      expect(isLegalStepTransition("RUNNING", "CANCELLED")).toBe(false);
    });

    it("rejects RETRY_WAIT -> DEAD_LETTERED: retryability/attempt-budget is decided at RUNNING failure time, not re-decided after waiting", () => {
      // A step that has reached RETRY_WAIT has already had its retry
      // decision made — it must never dead-letter directly from there.
      // Encodes the Milestone 2 semantic correction: retryable-vs-fatal
      // and attempt-budget checks happen once, on the RUNNING failure
      // edge, not re-checked after waiting.
      expect(isLegalStepTransition("RETRY_WAIT", "DEAD_LETTERED")).toBe(false);
      expect(() => transitionStepStatus("RETRY_WAIT", "DEAD_LETTERED")).toThrow(
        IllegalStepTransitionError,
      );
    });

    it("rejects PENDING -> DEAD_LETTERED (no execution attempt has happened)", () => {
      expect(isLegalStepTransition("PENDING", "DEAD_LETTERED")).toBe(false);
    });

    it("rejects a no-op transition: RUNNING -> RUNNING", () => {
      expect(isLegalStepTransition("RUNNING", "RUNNING")).toBe(false);
    });
  });

  describe("RETRY_WAIT semantics", () => {
    it("limits a step in RETRY_WAIT to READY or CANCELLED as its only legal next transitions — never dead-lettered from there", () => {
      // Expresses the intended meaning of RETRY_WAIT directly: reaching
      // it means the retry decision was already made (retryable, budget
      // remained), so its only legal next lifecycle transition is READY,
      // unless cancelled first. This says nothing about *when* or
      // *whether* a coordinator actually processes the expired backoff —
      // only which transition is legal if/when it does. Fatal/exhausted-
      // attempts failures must dead-letter from RUNNING instead of
      // entering RETRY_WAIT at all.
      const reachableFromRetryWait = STEP_STATUSES.filter((to) =>
        isLegalStepTransition("RETRY_WAIT", to),
      );
      expect(reachableFromRetryWait.sort()).toEqual(["CANCELLED", "READY"]);
    });
  });

  describe("terminal states", () => {
    it("classifies SUCCEEDED, DEAD_LETTERED, and CANCELLED as terminal", () => {
      for (const status of TERMINAL_STATUSES) {
        expect(isTerminalStepStatus(status)).toBe(true);
      }
    });

    it("classifies PENDING, READY, RUNNING, and RETRY_WAIT as non-terminal", () => {
      const nonTerminal = STEP_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status));
      for (const status of nonTerminal) {
        expect(isTerminalStepStatus(status)).toBe(false);
      }
    });

    it.each(TERMINAL_STATUSES)("has no legal outgoing transitions from %s", (from) => {
      for (const to of STEP_STATUSES) {
        expect(isLegalStepTransition(from, to)).toBe(false);
      }
    });

    it.each(TERMINAL_STATUSES)("throws attempting any transition out of %s", (from) => {
      for (const to of STEP_STATUSES) {
        expect(() => transitionStepStatus(from, to)).toThrow(IllegalStepTransitionError);
      }
    });
  });

  describe("exhaustiveness", () => {
    it("every status has an explicit (possibly empty) entry in the transition table", () => {
      // Guards against a status being silently added to STEP_STATUSES
      // without a corresponding decision about its legal transitions.
      for (const status of STEP_STATUSES) {
        expect(() => isLegalStepTransition(status, status)).not.toThrow();
      }
    });

    it("the legal transition fixture covers exactly the non-terminal statuses as sources", () => {
      const sourcesInFixture = new Set(LEGAL_TRANSITIONS.map(([from]) => from));
      const nonTerminal = STEP_STATUSES.filter((status) => !isTerminalStepStatus(status));
      expect([...sourcesInFixture].sort()).toEqual([...nonTerminal].sort());
    });
  });

  describe("IllegalStepTransitionError", () => {
    it("carries the from/to statuses for callers that need to report the rejected transition", () => {
      try {
        transitionStepStatus("SUCCEEDED", "READY");
        throw new Error("expected transitionStepStatus to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalStepTransitionError);
        const transitionError = error as IllegalStepTransitionError;
        expect(transitionError.from).toBe("SUCCEEDED");
        expect(transitionError.to).toBe("READY");
      }
    });
  });
});
