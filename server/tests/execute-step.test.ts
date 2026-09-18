import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_TASK_DELAY_MS, executeStep, InvalidTaskError } from "../src/worker/execute-step.js";

describe("executeStep", () => {
  it("fail_then_hash uses durable attempt count: two runtime failures, then deterministic success", async () => {
    const payload = { input: "hello", failuresBeforeSuccess: 2 };
    for (const attemptCount of [1, 2]) {
      const error = await executeStep({ taskType: "fail_then_hash", payload, attemptCount }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidTaskError);
      expect((error as Error).message).toContain(`attempt ${attemptCount}`);
    }
    const expected = { hash: createHash("sha256").update("hello").digest("hex") };
    expect(await executeStep({ taskType: "fail_then_hash", payload, attemptCount: 3 })).toEqual(expected);
    expect(await executeStep({ taskType: "fail_then_hash", payload, attemptCount: 3 })).toEqual(expected);
  });

  it("fail_then_hash poison input still fails on the final permitted attempt", async () => {
    await expect(executeStep({ taskType: "fail_then_hash", attemptCount: 3,
      payload: { input: "hello", failuresBeforeSuccess: 99 } })).rejects.toThrow(/attempt 3/);
  });

  it("classifies malformed retry payloads and unsupported tasks as invalid input", async () => {
    for (const payload of [null, {}, { input: "", failuresBeforeSuccess: 1 },
      { input: "hello", failuresBeforeSuccess: -1 }, { input: "hello", failuresBeforeSuccess: 1.5 },
      { input: "hello", failuresBeforeSuccess: "2" }]) {
      await expect(executeStep({ taskType: "fail_then_hash", payload, attemptCount: 1 })).rejects.toBeInstanceOf(InvalidTaskError);
    }
    await expect(executeStep({ taskType: "unknown", payload: {}, attemptCount: 1 })).rejects.toBeInstanceOf(InvalidTaskError);
    await expect(executeStep({ taskType: "hash_after_delay", payload: {}, attemptCount: 1 })).rejects.toBeInstanceOf(InvalidTaskError);
  });

  describe("hash_after_delay", () => {
    it("produces the sha256 hex digest of the input, deterministically", async () => {
      const expected = createHash("sha256").update("abc").digest("hex");

      const first = await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } });
      const second = await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } });

      expect(first).toEqual({ hash: expected });
      expect(second).toEqual({ hash: expected });
    });

    it("actually waits delayMs before resolving", async () => {
      const start = Date.now();
      await executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: 50 } });
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });

    it("rejects a missing or empty input", async () => {
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { delayMs: 0 } }),
      ).rejects.toThrow(/input/);
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "", delayMs: 0 } }),
      ).rejects.toThrow(/input/);
    });

    it("rejects a negative, non-integer, or too-large delayMs", async () => {
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: -1 } }),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: { input: "x", delayMs: 1.5 } }),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({
          attemptCount: 1,
          taskType: "hash_after_delay",
          payload: { input: "x", delayMs: MAX_TASK_DELAY_MS + 1 },
        }),
      ).rejects.toThrow(/delayMs/);
    });

    it("rejects a non-object payload", async () => {
      await expect(executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: null })).rejects.toThrow();
      await expect(executeStep({ attemptCount: 1, taskType: "hash_after_delay", payload: "abc" })).rejects.toThrow();
    });
  });

  it("rejects an unsupported task type", async () => {
    await expect(
      executeStep({ attemptCount: 1, taskType: "does_not_exist", payload: {} }),
    ).rejects.toThrow(/does_not_exist/);
  });
});
