import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_EFFECT_TYPE,
  IdempotencyConflictError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  applyIdempotentEffect,
  type EffectOutcome,
} from "../src/db/idempotent-effect.js";

// The simulated external effect boundary. Every assertion is against durable
// rows, and duplicate/conflicting behaviour is decided by PostgreSQL's
// primary key, not by application bookkeeping.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

let admin: Pool;
let callerPool: Pool;
let caller: NodePgDatabase<Record<string, never>>;

interface EffectRow {
  idempotency_key: string;
  effect_type: string;
  request: Record<string, unknown>;
  result: { effectId: string; value: unknown };
  created_at: string;
}

async function readEffect(key: string): Promise<EffectRow | undefined> {
  const result = await admin.query<EffectRow>(
    `select idempotency_key, effect_type, request, result, created_at::text from idempotent_effects where idempotency_key = $1`,
    [key],
  );
  return result.rows[0];
}

async function countEffects(key: string): Promise<number> {
  const result = await admin.query<{ n: string }>(
    "select count(*) as n from idempotent_effects where idempotency_key = $1",
    [key],
  );
  return Number(result.rows[0]!.n);
}

async function dbClockText(): Promise<string> {
  const result = await admin.query<{ t: string }>("select clock_timestamp()::text as t");
  return result.rows[0]!.t;
}

async function sqlBool(query: string, params: unknown[]): Promise<boolean> {
  const result = await admin.query<{ ok: boolean }>(query, params);
  return result.rows[0]!.ok;
}

function request(key: string, value = "receipt-created") {
  return { idempotencyKey: key, effectType: DEMO_EFFECT_TYPE, request: { value } };
}

beforeAll(() => {
  admin = new Pool({ connectionString, max: 4 });
  callerPool = new Pool({ connectionString, max: 1 });
  caller = drizzle(callerPool);
});

afterAll(async () => {
  await admin.end();
  await callerPool.end();
});

beforeEach(async () => {
  await admin.query("delete from idempotent_effects");
});

describe("applyIdempotentEffect", () => {
  it("applies once: one durable row, a generated effectId, created_at from the database clock", async () => {
    const key = randomUUID();
    const before = await dbClockText();

    const outcome = await applyIdempotentEffect(caller, request(key));
    const after = await dbClockText();

    expect(outcome.applied).toBe(true);
    expect(outcome.result.value).toBe("receipt-created");
    expect(outcome.result.effectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await countEffects(key)).toBe(1);

    const row = await readEffect(key);
    expect(row).toMatchObject({
      idempotency_key: key,
      effect_type: DEMO_EFFECT_TYPE,
      request: { value: "receipt-created" },
      result: outcome.result,
    });
    expect(row!.created_at).toBe(outcome.createdAt);
    expect(
      await sqlBool("select $1::timestamptz between $2::timestamptz and $3::timestamptz as ok", [
        row!.created_at,
        before,
        after,
      ]),
    ).toBe(true);
  });

  it("returns the stored result on a repeat, applies nothing, and mints no second effectId", async () => {
    const key = randomUUID();
    const first = await applyIdempotentEffect(caller, request(key));
    const storedRow = await readEffect(key);

    const repeats: EffectOutcome[] = [];
    for (let i = 0; i < 3; i += 1) {
      repeats.push(await applyIdempotentEffect(caller, request(key)));
    }

    for (const repeat of repeats) {
      expect(repeat.applied).toBe(false);
      // The exact stored result, including the identifier the first
      // application minted — not a fresh one presented as a reuse.
      expect(repeat.result).toEqual(first.result);
      expect(repeat.result.effectId).toBe(first.result.effectId);
      expect(repeat.createdAt).toBe(first.createdAt);
    }
    expect(await countEffects(key)).toBe(1);
    // Byte-for-byte unchanged: a repeat writes nothing at all.
    expect(await readEffect(key)).toEqual(storedRow);
  });

  it("rejects the same key used for a different request, leaving the stored effect untouched", async () => {
    const key = randomUUID();
    const first = await applyIdempotentEffect(caller, request(key, "receipt-created"));
    const storedRow = await readEffect(key);

    await expect(applyIdempotentEffect(caller, request(key, "something-else"))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );

    expect(await countEffects(key)).toBe(1);
    expect(await readEffect(key)).toEqual(storedRow);
    expect(storedRow!.result.effectId).toBe(first.result.effectId);
  });

  it("rejects the same key used for a different effect type", async () => {
    const key = randomUUID();
    await applyIdempotentEffect(caller, request(key));
    const storedRow = await readEffect(key);

    await expect(
      applyIdempotentEffect(caller, { idempotencyKey: key, effectType: "other_effect", request: { value: "receipt-created" } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await readEffect(key)).toEqual(storedRow);
  });

  it("compares requests by jsonb equality, so key order alone is not a conflict", async () => {
    const key = randomUUID();
    const applied = await applyIdempotentEffect(caller, {
      idempotencyKey: key,
      effectType: DEMO_EFFECT_TYPE,
      request: { value: "receipt-created", note: "first" },
    });

    // Same logical request, different property order in the JSON text.
    const repeat = await applyIdempotentEffect(caller, {
      idempotencyKey: key,
      effectType: DEMO_EFFECT_TYPE,
      request: { note: "first", value: "receipt-created" },
    });

    expect(repeat.applied).toBe(false);
    expect(repeat.result).toEqual(applied.result);
  });

  it("keeps different keys independent", async () => {
    const first = randomUUID();
    const second = randomUUID();

    const a = await applyIdempotentEffect(caller, request(first));
    const b = await applyIdempotentEffect(caller, request(second));

    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(a.result.effectId).not.toBe(b.result.effectId);
    expect(await countEffects(first)).toBe(1);
    expect(await countEffects(second)).toBe(1);
  });

  it("rejects a blank or over-long key before touching the store", async () => {
    await expect(applyIdempotentEffect(caller, request("   "))).rejects.toThrow(/non-empty idempotencyKey/);
    await expect(applyIdempotentEffect(caller, request("x".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)))).rejects.toThrow(
      /at most/,
    );
    const count = await admin.query<{ n: string }>("select count(*) as n from idempotent_effects");
    expect(Number(count.rows[0]!.n)).toBe(0);
  });

});

describe("concurrent callers of the same key", () => {
  it("applies exactly one effect across independent connections and gives every caller the same stored result", async () => {
    const key = randomUUID();
    const callers = 12;
    const pools = Array.from({ length: callers }, () => new Pool({ connectionString, max: 1 }));

    try {
      // Connect first, so connection setup is not what serializes them.
      await Promise.all(pools.map((pool) => pool.query("select 1")));
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      const attempts = pools.map(async (pool) => {
        await barrier;
        return applyIdempotentEffect(drizzle(pool), request(key));
      });
      release();
      const outcomes = await Promise.all(attempts);

      // One durable effect, whichever caller won the insert.
      expect(await countEffects(key)).toBe(1);
      const stored = await readEffect(key);

      // Exactly one caller applied it; nobody errored.
      expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);

      // Every caller — winner and losers alike — observed the one stored
      // result. No caller saw an identifier that is not in the database.
      const effectIds = new Set(outcomes.map((outcome) => outcome.result.effectId));
      expect(effectIds.size).toBe(1);
      expect([...effectIds][0]).toBe(stored!.result.effectId);
      for (const outcome of outcomes) {
        expect(outcome.result).toEqual(stored!.result);
        expect(outcome.createdAt).toBe(stored!.created_at);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);

  it("keeps concurrent callers of different keys independent", async () => {
    const keys = Array.from({ length: 8 }, () => randomUUID());
    const pools = keys.map(() => new Pool({ connectionString, max: 1 }));

    try {
      await Promise.all(pools.map((pool) => pool.query("select 1")));
      const outcomes = await Promise.all(
        pools.map((pool, i) => applyIdempotentEffect(drizzle(pool), request(keys[i]!))),
      );

      expect(outcomes.every((outcome) => outcome.applied)).toBe(true);
      expect(new Set(outcomes.map((outcome) => outcome.result.effectId)).size).toBe(keys.length);
      for (const key of keys) {
        expect(await countEffects(key)).toBe(1);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);
});


describe("database atomicity and uniqueness", () => {
  it("database uniqueness rejects a duplicate even outside the application helper", async () => {
    const key = randomUUID();
    // No ON CONFLICT dependency: dropping the constraint must expose a
    // successful duplicate insert, not merely an invalid conflict target.
    await admin.query(`insert into idempotent_effects
      (idempotency_key, effect_type, request, result, created_at)
      values ($1, 'demo_receipt', '{"value":"v"}', '{"effectId":"original","value":"v"}', clock_timestamp())`, [key]);
    await expect(admin.query(`insert into idempotent_effects
      select * from idempotent_effects where idempotency_key = $1`, [key]))
      .rejects.toMatchObject({ code: "23505" });
    expect(await countEffects(key)).toBe(1);
  });

  it("rolling back the effect insert leaves neither a receipt nor an idempotency record", async () => {
    const key = randomUUID();
    await expect(caller.transaction(async (tx) => {
      const effect = await applyIdempotentEffect(tx, request(key));
      expect(effect.applied).toBe(true);
      expect(await countEffects(key)).toBe(0); // another connection sees no uncommitted row
      throw new Error("rollback after insert");
    })).rejects.toThrow("rollback after insert");
    expect(await countEffects(key)).toBe(0);
    const retried = await applyIdempotentEffect(caller, request(key));
    expect(retried.applied).toBe(true);
    expect(await readEffect(key)).toMatchObject({ result: retried.result });
    expect(await countEffects(key)).toBe(1);
  });

  it.each(["commit", "rollback"])("a caller waiting behind an uncommitted effect handles %s", async (finish) => {
    const key = randomUUID();
    const blocker = await admin.connect();
    const blockedPool = new Pool({ connectionString, max: 1, statement_timeout: 5000 });
    let pending: Promise<EffectOutcome> | undefined;
    try {
      const pid = (await blockedPool.query("select pg_backend_pid() as pid")).rows[0].pid;
      await blocker.query("begin");
      const first = await applyIdempotentEffect(drizzle(blocker), request(key));
      pending = applyIdempotentEffect(drizzle(blockedPool), request(key));
      // Observe a real database lock wait before releasing the transaction.
      const watchdog = Date.now() + 3000;
      while (!(await admin.query("select cardinality(pg_blocking_pids($1)) > 0 as waiting", [pid])).rows[0].waiting) {
        if (Date.now() > watchdog) throw new Error("caller never waited for insert");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query(finish);
      const outcome = await pending;
      expect(outcome.applied).toBe(finish === "rollback");
      if (finish === "commit") expect(outcome.result).toEqual(first.result);
      else expect(outcome.result.effectId).not.toBe(first.result.effectId);
      expect(await countEffects(key)).toBe(1);
      expect(await readEffect(key)).toMatchObject({ result: outcome.result });
    } finally {
      await blocker.query("rollback");
      if (pending) await pending.catch(() => {});
      blocker.release();
      await blockedPool.end();
    }
  });
});
