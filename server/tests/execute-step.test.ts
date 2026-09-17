import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_TASK_DELAY_MS, executeStep } from "../src/worker/execute-step.js";

describe("executeStep", () => {
  describe("hash_after_delay", () => {
    it("produces the sha256 hex digest of the input, deterministically", async () => {
      const expected = createHash("sha256").update("abc").digest("hex");

      const first = await executeStep({ taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } });
      const second = await executeStep({ taskType: "hash_after_delay", payload: { input: "abc", delayMs: 0 } });

      expect(first).toEqual({ hash: expected });
      expect(second).toEqual({ hash: expected });
    });

    it("actually waits delayMs before resolving", async () => {
      const start = Date.now();
      await executeStep({ taskType: "hash_after_delay", payload: { input: "x", delayMs: 50 } });
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });

    it("rejects a missing or empty input", async () => {
      await expect(
        executeStep({ taskType: "hash_after_delay", payload: { delayMs: 0 } }),
      ).rejects.toThrow(/input/);
      await expect(
        executeStep({ taskType: "hash_after_delay", payload: { input: "", delayMs: 0 } }),
      ).rejects.toThrow(/input/);
    });

    it("rejects a negative, non-integer, or too-large delayMs", async () => {
      await expect(
        executeStep({ taskType: "hash_after_delay", payload: { input: "x", delayMs: -1 } }),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({ taskType: "hash_after_delay", payload: { input: "x", delayMs: 1.5 } }),
      ).rejects.toThrow(/delayMs/);
      await expect(
        executeStep({
          taskType: "hash_after_delay",
          payload: { input: "x", delayMs: MAX_TASK_DELAY_MS + 1 },
        }),
      ).rejects.toThrow(/delayMs/);
    });

    it("rejects a non-object payload", async () => {
      await expect(executeStep({ taskType: "hash_after_delay", payload: null })).rejects.toThrow();
      await expect(executeStep({ taskType: "hash_after_delay", payload: "abc" })).rejects.toThrow();
    });
  });

  it("rejects an unsupported task type", async () => {
    await expect(
      executeStep({ taskType: "does_not_exist", payload: {} }),
    ).rejects.toThrow(/does_not_exist/);
  });
});
