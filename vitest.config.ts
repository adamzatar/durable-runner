import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./server/tests/setup.ts"],
    // claim-step.test.ts, complete-step.test.ts, and worker-loop.test.ts
    // all own the `steps` table for their run (each deletes every row in
    // beforeEach) and assert on real Postgres row-lock contention. Running
    // test files in parallel would let one file's rows/locks interfere
    // with another's, which is exactly the kind of interference these
    // tests exist to rule out. Serializing files trades suite speed for
    // that isolation.
    fileParallelism: false,
  },
});
