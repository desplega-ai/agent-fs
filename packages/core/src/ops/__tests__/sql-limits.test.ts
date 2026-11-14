import { afterEach, describe, expect, test } from "bun:test";
import { createTestContext } from "../../test-utils.js";
import { sql } from "../sql.js";
import { ValidationError } from "../../errors.js";

const MiB = 1024 * 1024;

afterEach(() => {
  delete process.env.AGENT_FS_SQL_MAX_RESULT_BYTES;
  delete process.env.AGENT_FS_SQL_MAX_CONCURRENT;
});

describe("sql op result size", () => {
  test("a small computed result is returned in full", async () => {
    const { ctx } = createTestContext();
    const res = await sql(ctx, {
      query: "SELECT i, repeat('x', 100) AS v FROM range(5) t(i)",
      maxRows: 10,
    });
    expect(res.rowCount).toBe(5);
    expect(res.truncated).toBe(false);
    expect((res.rows[0].v as string).length).toBe(100);
  });

  test("large computed values are truncated to the result size limit", async () => {
    const { ctx } = createTestContext();
    // 10 rows x 8 MiB of computed text = 80 MiB of values, no bound files.
    // Row count is well under maxRows, so only a byte budget can bound it.
    let res: Awaited<ReturnType<typeof sql>> | null = null;
    try {
      res = await sql(ctx, {
        query: `SELECT i, repeat('x', ${8 * MiB}) AS v FROM range(10) t(i)`,
        maxRows: 10,
      });
    } catch (err) {
      // Rejecting the query with a clean validation error is also bounded.
      expect(err).toBeInstanceOf(ValidationError);
      return;
    }
    const bytes = JSON.stringify(res.rows).length;
    expect(bytes).toBeLessThanOrEqual(32 * MiB);
    expect(res.truncated).toBe(true);
  });

  test("escaped and multi-byte characters count toward the limit", async () => {
    process.env.AGENT_FS_SQL_MAX_RESULT_BYTES = String(MiB);
    const { ctx } = createTestContext();
    // Each value is 64 KiB of characters but about 384 KiB of JSON (\u0001).
    for (const ch of ["chr(1)", "'€'"]) {
      const res = await sql(ctx, {
        query: `SELECT i, repeat(${ch}, ${64 * 1024}) AS v FROM range(20) t(i)`,
        maxRows: 20,
      });
      expect(Buffer.byteLength(JSON.stringify(res.rows))).toBeLessThanOrEqual(MiB);
      expect(res.truncated).toBe(true);
    }
  });

  test("a single row over the limit is rejected", async () => {
    process.env.AGENT_FS_SQL_MAX_RESULT_BYTES = "1000";
    const { ctx } = createTestContext();
    await expect(sql(ctx, { query: "SELECT repeat('x', 5000) AS v" })).rejects.toThrow(
      /result size limit/
    );
  });
});

describe("sql op concurrency", () => {
  test("queries beyond the concurrency limit are rejected", async () => {
    process.env.AGENT_FS_SQL_MAX_CONCURRENT = "1";
    const { ctx } = createTestContext();
    const first = sql(ctx, { query: "SELECT 1 AS n" });
    await expect(sql(ctx, { query: "SELECT 2 AS n" })).rejects.toThrow(
      /Too many SQL queries running/
    );
    expect((await first).rows).toEqual([{ n: 1 }]);
    // The slot is released once the running query finishes.
    expect((await sql(ctx, { query: "SELECT 3 AS n" })).rows).toEqual([{ n: 3 }]);
  });
});
