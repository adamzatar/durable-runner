import { describe, expect, it, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";

describe("database connectivity and migration", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("can run a trivial query against DATABASE_URL", async () => {
    const result = await db.execute(sql`select 1 as value`);
    expect(result.rows[0]).toEqual({ value: 1 });
  });

  it("has applied the spike_events migration", async () => {
    const result = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'spike_events' order by column_name`,
    );
    const columns = result.rows.map((row) => (row as { column_name: string }).column_name);
    expect(columns).toEqual(["created_at", "id", "message", "source"]);
  });

  it("can write and read back a spike_events row", async () => {
    const inserted = await db.execute(
      sql`insert into spike_events (source, message) values ('test', 'db.test.ts write') returning id`,
    );
    const id = (inserted.rows[0] as { id: number }).id;

    const readBack = await db.execute(sql`select message from spike_events where id = ${id}`);
    expect((readBack.rows[0] as { message: string }).message).toBe("db.test.ts write");
  });
});
