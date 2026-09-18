import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_TASK_DELAY_MS, executeStep, InvalidTaskError, type ExecutionContext } from "../src/worker/execute-step.js";
import { DEMO_EFFECT_TYPE, MAX_IDEMPOTENCY_KEY_LENGTH, type EffectOutcome, type EffectRequest } from "../src/db/idempotent-effect.js";

// Pure tasks get a context that fails if touched: reaching the effect store
// from hash_after_delay or fail_then_hash would be a defect, not a detail.
const noEffects: ExecutionContext = {
  applyEffect: async () => {
    throw new Error("this task must not touch the effect store");
  },
};

// Records calls instead of hitting PostgreSQL; the real store has its own
// tests (idempotent-effects.test.ts). What matters here is what the task
// asks for, and what it does with the answer.
function recordingContext(outcome: Partial<EffectOutcome> = {}): ExecutionContext & { calls: EffectRequest[] } {
  const calls: EffectRequest[] = [];
  return {
    calls,
    async applyEffect(request) {
      calls.push(request);
      return {
        applied: outcome.applied ?? true,
        result: outcome.result ?? { effectId: "stored-effect-id", value: (request.request as { value: unknown }).value },
        createdAt: outcome.createdAt ?? "2026-01-01 00:00:00+00",
      };
    },
  };
}

describe("executeStep", () => {
  it("fail_then_hash uses durable attempt count: two runtime failures, then deterministic success", async () => {
    const payload = { input: "hello", failuresBeforeSuccess: 2 };
    for (const attemptCount of [1, 2]) {
      const error = await executeStep({ taskType: "fail_then_hash", payload, attemptCount }, noEffects).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidTaskError);
      expect((error as Error).message).toContain(`attempt ${attemptCount}`);
    }
    const expected = { hash: createHash("sha256").update("hello").digest("hex") };
    expect(await executeStep({ taskType: "fail_then_hash", payload, attemptCount: 3 }, noEffects)).toEqual(expected);
    expect(await executeStep({ taskType: "fail_then_hash", payload, attemptCount: 3 }, noEffects)).toEqual(expected);
  });

  it("fail_then_hash poison input still fails on the final permitted attempt", async () => {
    await expect(executeStep({ taskType: "fail_then_hash", attemptCount: 3,
      payload: { input: "hello", failuresBeforeSuccess: 99 } }, noEffects)).rejects.toThrow(/attempt 3/);
  });

  it("classifies malformed retry payloads and unsupported tasks as invalid input", async () => {
    for (const payload of [null, {}, { input: "", failuresBeforeSuccess: 1 },
      { input: "hello", failuresBeforeSuccess: -1 }, { input: "hello", failuresBeforeSuccess: 1.5 },
      { input: "hello", failuresBeforeSuccess: "2" }]) {
      await expect(executeStep({ taskType: "fail_then_hash", payload, attemptCount: 1 }, noEffects)).rejects.toBeInstanceOf(InvalidTaskError);
    }
    await expect(executeStep({ taskType: "unknown", payload: {}, attemptCount: 1 }, noEffects)).rejects.toBeInstanceOf(InvalidTaskError);
    await expect(executeStep({ taskType: "hash_after_delay", payload: {}, attemptCount: 1 }, noEffects)).rejects.toBeInstanceOf(InvalidTaskError);
  });

  describe("hash_after_delay", () => {
    it("produces the sha256 hex digest of the input, deterministically", async () => {
      const expected = createHash("sha256").update("abc").digest("hex");

      const first = await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } }, noEffects);
      const second = await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } }, noEffects);

      expect(first).toEqual({ hash: expected });
      expect(second).toEqual({ hash: expected });
    });

    it("actually waits delayMs before resolving", async () => {
      const start = Date.now();
      await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: 50 } }, noEffects);
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });

    it("rejects a missing or empty input", async () => {
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { delayMs: 0 } }, noEffects),
      ).rejects.toThrow(/input/);
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "", delayMs: 0 } }, noEffects),
      ).rejects.toThrow(/input/);
    });

    it("rejects a negative, non-integer, or too-large delayMs", async () => {
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: -1 } }, noEffects),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: 1.5 } }, noEffects),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({
          attemptCount: 1,
          taskType: "hash_after_delay",
          payload: { input: "x", delayMs: MAX_TASK_DELAY_MS + 1 },
        }, noEffects),
      ).rejects.toThrow(/delayMs/);
    });

    it("rejects a non-object payload", async () => {
      await expect(executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: null }, noEffects)).rejects.toThrow();
      await expect(executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: "abc" }, noEffects)).rejects.toThrow();
    });
  });

  describe("idempotent_effect", () => {
    const payload = { idempotencyKey: "task-key", value: "receipt-created", delayAfterEffectMs: 0 };

    it("asks the effect layer for the payload's key and returns the stored result verbatim", async () => {
      const context = recordingContext({ applied: true, result: { effectId: "abc-123", value: "receipt-created" } });

      const result = await executeStep({ attemptCount: 1, taskType: "idempotent_effect", payload }, context);

      expect(context.calls).toEqual([
        { idempotencyKey: "task-key", effectType: DEMO_EFFECT_TYPE, request: { value: "receipt-created" } },
      ]);
      expect(result).toEqual({ effectId: "abc-123", value: "receipt-created" });
    });

    it("returns the same result whether this execution applied the effect or reused it", async () => {
      const stored = { effectId: "original-id", value: "receipt-created" };
      const applied = await executeStep(
        { attemptCount: 1, taskType: "idempotent_effect", payload },
        recordingContext({ applied: true, result: stored }),
      );
      // A re-execution after recovery sees applied: false and must still
      // produce the identical step result, including the original effectId.
      const reused = await executeStep(
        { attemptCount: 2, taskType: "idempotent_effect", payload },
        recordingContext({ applied: false, result: stored }),
      );

      expect(applied).toEqual(stored);
      expect(reused).toEqual(stored);
    });

    it("waits delayAfterEffectMs only after the effect layer has returned", async () => {
      const calledAt: number[] = [];
      const context: ExecutionContext = {
        applyEffect: async (request) => {
          calledAt.push(Date.now());
          return { applied: true, result: { effectId: randomUUID(), value: (request.request as { value: unknown }).value }, createdAt: "" };
        },
      };

      const start = Date.now();
      await executeStep(
        { attemptCount: 1, taskType: "idempotent_effect", payload: { ...payload, delayAfterEffectMs: 120 } },
        context,
      );
      const finished = Date.now();

      // The effect is durable well before the execution ends: that gap is
      // the window a crash has to land in for re-execution to matter.
      expect(calledAt).toHaveLength(1);
      expect(calledAt[0]! - start).toBeLessThan(100);
      expect(finished - start).toBeGreaterThanOrEqual(110);
    });

    it("rejects malformed payloads as invalid input, without calling the effect layer", async () => {
      const context = recordingContext();
      for (const bad of [
        null,
        "abc",
        {},
        { idempotencyKey: "", value: "v", delayAfterEffectMs: 0 },
        { idempotencyKey: "   ", value: "v", delayAfterEffectMs: 0 },
        { idempotencyKey: "k", value: "", delayAfterEffectMs: 0 },
        { idempotencyKey: "k", value: 7, delayAfterEffectMs: 0 },
        { idempotencyKey: "k", value: "v", delayAfterEffectMs: -1 },
        { idempotencyKey: "k", value: "v", delayAfterEffectMs: 1.5 },
        { idempotencyKey: "k", value: "v", delayAfterEffectMs: MAX_TASK_DELAY_MS + 1 },
        { idempotencyKey: "k", value: "v" },
        { idempotencyKey: "x".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1), value: "v", delayAfterEffectMs: 0 },
      ]) {
        await expect(
          executeStep({ attemptCount: 1, taskType: "idempotent_effect", payload: bad }, context),
        ).rejects.toBeInstanceOf(InvalidTaskError);
      }
      // Invalid input dead-letters immediately; no effect may be applied on
      // the way to that decision.
      expect(context.calls).toEqual([]);
    });

    it("propagates an effect-layer rejection to the worker as an ordinary failure", async () => {
      const context: ExecutionContext = {
        applyEffect: async () => {
          throw new Error("idempotency key already used for a different request");
        },
      };

      const error = await executeStep(
        { attemptCount: 1, taskType: "idempotent_effect", payload },
        context,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      // Not InvalidTaskError: the payload was well-formed, so this goes
      // through the ordinary retry path rather than dead-lettering at once.
      expect(error).not.toBeInstanceOf(InvalidTaskError);
    });
  });

  it("rejects an unsupported task type", async () => {
    await expect(
      executeStep({ attemptCount: 1, taskType: "does_not_exist", payload: {} }, noEffects),
    ).rejects.toThrow(/does_not_exist/);
  });
});
