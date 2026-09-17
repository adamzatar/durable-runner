import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./server/tests/setup.ts"],
    // Every database test file owns the `steps` table (and, for the
    // heartbeat tests, `workers`) for its run — each deletes every row in
    // beforeEach — and several assert on real Postgres row-lock contention
    // and lease timing. Running
    // test files in parallel would let one file's rows/locks interfere
    // with another's, which is exactly the kind of interference these
    // tests exist to rule out. Serializing files trades suite speed for
    // that isolation.
    fileParallelism: false,
  },
});
