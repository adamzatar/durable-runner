import { describe, expect, it } from "vitest";
import { createDbPool, DEFAULT_DB_POOL_MAX, parseDbPoolMax } from "../src/db/pool-config.js";

describe("parseDbPoolMax", () => {
  it("falls back to the default when DB_POOL_MAX is unset or empty", () => {
    expect(parseDbPoolMax(undefined)).toBe(DEFAULT_DB_POOL_MAX);
    expect(parseDbPoolMax("")).toBe(DEFAULT_DB_POOL_MAX);
    expect(parseDbPoolMax("  ")).toBe(DEFAULT_DB_POOL_MAX);
  });

  it("accepts a positive integer", () => {
    expect(parseDbPoolMax("1")).toBe(1);
    expect(parseDbPoolMax("4")).toBe(4);
    expect(parseDbPoolMax("25")).toBe(25);
  });

  it.each(["0", "-3", "2.5", "abc", "10x", "4 "])("rejects %j with a clear configuration error", (raw) => {
    expect(() => parseDbPoolMax(raw)).toThrow(/DB_POOL_MAX must be a positive integer/);
  });
});

describe("createDbPool", () => {
  it("applies the parsed limit and handles idle-connection errors instead of crashing", async () => {
    const pool = createDbPool("postgres://unused.invalid/db");
    try {
      expect(pool.options.max).toBe(DEFAULT_DB_POOL_MAX);
      // Without a listener, an idle client death is emitted as an unhandled
      // 'error' event and kills the whole process.
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
