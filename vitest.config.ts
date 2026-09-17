import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./server/tests/setup.ts"],
  },
});
