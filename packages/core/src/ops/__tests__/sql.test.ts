import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createTestContext } from "../../test-utils.js";
import { write, writeRaw } from "../write.js";
import { sql, detectSqlFormat } from "../sql.js";
import type { OpContext } from "../types.js";

const CSV = "id,name,amount\n1,alpha,10.5\n2,beta,20.25\n3,gamma,30\n";

async function seedCsv(ctx: OpContext, path = "/data/sales.csv") {
  await write(ctx, { path, content: CSV });
  return path;
}

/** Build binary fixtures (parquet, xlsx, sqlite) in a local temp dir. */
async function makeBinaryFixtures(): Promise<{
  parquet: Uint8Array;
  xlsx: Uint8Array;
  sqlite: Uint8Array;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fs-sql-fixtures-"));
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(
    `COPY (SELECT * FROM (VALUES (1, 'aa'), (2, 'bb'), (3, 'cc')) t(id, tag)) TO '${dir}/f.parquet' (FORMAT parquet)`
  );
  await conn.run("INSTALL excel");
  await conn.run("LOAD excel");
  await conn.run(
    `COPY (SELECT * FROM (VALUES (1, 'x'), (2, 'y')) t(num, label)) TO '${dir}/f.xlsx' WITH (FORMAT xlsx, HEADER true)`
  );
  conn.closeSync();
  instance.closeSync();

  const db = new Database(join(dir, "f.db"));
  db.run("CREATE TABLE users (id INTEGER, email TEXT)");
  db.run("INSERT INTO users VALUES (1,'a@x.com'),(2,'b@x.com')");
  db.run("CREATE TABLE tags (id INTEGER, tag TEXT)");
  db.run("INSERT INTO tags VALUES (1,'red')");
  db.close();

  return {
    parquet: new Uint8Array(readFileSync(join(dir, "f.parquet"))),
    xlsx: new Uint8Array(readFileSync(join(dir, "f.xlsx"))),
    sqlite: new Uint8Array(readFileSync(join(dir, "f.db"))),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("detectSqlFormat", () => {
  test("maps extensions to formats", () => {
    expect(detectSqlFormat("/a/b.csv")).toEqual({ format: "csv", gzip: false });
    expect(detectSqlFormat("/a/b.CSV")).toEqual({ format: "csv", gzip: false });
    expect(detectSqlFormat("/a/b.tsv")).toEqual({ format: "tsv", gzip: false });
    expect(detectSqlFormat("/a/b.parquet")).toEqual({ format: "parquet", gzip: false });
    expect(detectSqlFormat("/a/b.xlsx")).toEqual({ format: "xlsx", gzip: false });
    expect(detectSqlFormat("/a/b.jsonl")).toEqual({ format: "ndjson", gzip: false });
    expect(detectSqlFormat("/a/b.csv.gz")).toEqual({ format: "csv", gzip: true });
    expect(detectSqlFormat("/a/b.sqlite3")).toEqual({ format: "sqlite", gzip: false });
    expect(detectSqlFormat("/a/b.duckdb")).toEqual({ format: "duckdb", gzip: false });
  });

  test("rejects unknown and invalid combinations", () => {
    expect(detectSqlFormat("/a/b.txt")).toBeNull();
    expect(detectSqlFormat("/a/noext")).toBeNull();
    expect(detectSqlFormat("/a/b.parquet.gz")).toBeNull();
    expect(detectSqlFormat("/a/b.gz")).toBeNull();
  });
});

describe("sql op", () => {
  test("queries a csv referenced by path literal", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);

    const result = await sql(ctx, {
      query: "SELECT count(*) AS n, sum(amount) AS total FROM '/data/sales.csv'",
    });
    expect(result.rows).toEqual([{ n: 3, total: 60.75 }]);
    expect(result.columns.map((c) => c.name)).toEqual(["n", "total"]);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      { table: "doc_1", path: "/data/sales.csv", format: "csv" },
    ]);
  });

  test("path literal without leading slash resolves too", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    const result = await sql(ctx, {
      query: "SELECT name FROM 'data/sales.csv' ORDER BY id LIMIT 1",
    });
    expect(result.rows).toEqual([{ name: "alpha" }]);
  });

  test("named table bindings and cross-format join", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    const fixtures = await makeBinaryFixtures();
    try {
      await writeRaw(ctx, { path: "/data/tags.parquet", bytes: fixtures.parquet });
      const result = await sql(ctx, {
        query:
          "SELECT s.name, t.tag FROM sales s JOIN tags t ON s.id = t.id ORDER BY s.id",
        tables: { sales: "/data/sales.csv", tags: "/data/tags.parquet" },
      });
      expect(result.rows).toEqual([
        { name: "alpha", tag: "aa" },
        { name: "beta", tag: "bb" },
        { name: "gamma", tag: "cc" },
      ]);
    } finally {
      fixtures.cleanup();
    }
  });

  test("tsv, json and ndjson formats", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/d/x.tsv", content: "id\tname\n1\taa\n2\tbb\n" });
    await write(ctx, { path: "/d/x.json", content: '[{"id":1},{"id":2},{"id":3}]' });
    await write(ctx, { path: "/d/x.ndjson", content: '{"id":1}\n{"id":2}\n' });

    const tsv = await sql(ctx, { query: "SELECT count(*) AS n FROM '/d/x.tsv'" });
    expect(tsv.rows).toEqual([{ n: 2 }]);
    const json = await sql(ctx, { query: "SELECT count(*) AS n FROM '/d/x.json'" });
    expect(json.rows).toEqual([{ n: 3 }]);
    const ndjson = await sql(ctx, { query: "SELECT count(*) AS n FROM '/d/x.ndjson'" });
    expect(ndjson.rows).toEqual([{ n: 2 }]);
  });

  test("xlsx via excel extension", async () => {
    const { ctx } = createTestContext();
    const fixtures = await makeBinaryFixtures();
    try {
      await writeRaw(ctx, { path: "/d/report.xlsx", bytes: fixtures.xlsx });
      const result = await sql(ctx, {
        query: "SELECT * FROM '/d/report.xlsx' ORDER BY num",
      });
      expect(result.rows).toEqual([
        { num: 1, label: "x" },
        { num: 2, label: "y" },
      ]);
    } finally {
      fixtures.cleanup();
    }
  });

  test("sqlite database exposes tables under the binding name", async () => {
    const { ctx } = createTestContext();
    const fixtures = await makeBinaryFixtures();
    try {
      await writeRaw(ctx, { path: "/d/app.db", bytes: fixtures.sqlite });
      const result = await sql(ctx, {
        query:
          "SELECT u.email, t.tag FROM app.users u LEFT JOIN app.tags t ON u.id = t.id ORDER BY u.id",
        tables: { app: "/d/app.db" },
      });
      expect(result.rows).toEqual([
        { email: "a@x.com", tag: "red" },
        { email: "b@x.com", tag: null },
      ]);
    } finally {
      fixtures.cleanup();
    }
  });

  test("format override makes a .txt document queryable", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/logs/data.txt", content: "a,b\n1,2\n3,4\n" });
    const result = await sql(ctx, {
      query: "SELECT sum(a) AS s FROM logs",
      tables: { logs: { path: "/logs/data.txt", format: "csv" } },
    });
    expect(result.rows).toEqual([{ s: 4 }]);
  });

  test("gzipped csv", async () => {
    const { ctx } = createTestContext();
    const gz = Bun.gzipSync(new TextEncoder().encode(CSV));
    await writeRaw(ctx, { path: "/d/sales.csv.gz", bytes: new Uint8Array(gz) });
    const result = await sql(ctx, {
      query: "SELECT count(*) AS n FROM '/d/sales.csv.gz'",
    });
    expect(result.rows).toEqual([{ n: 3 }]);
  });

  test("maxRows truncation", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    const result = await sql(ctx, {
      query: "SELECT * FROM '/data/sales.csv'",
      maxRows: 2,
    });
    expect(result.rowCount).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("queries without any document references work", async () => {
    const { ctx } = createTestContext();
    const result = await sql(ctx, { query: "SELECT 1 + 1 AS two" });
    expect(result.rows).toEqual([{ two: 2 }]);
    expect(result.files).toEqual([]);
  });

  test("multi-statement queries return the last result", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    const result = await sql(ctx, {
      query:
        "CREATE TABLE top AS SELECT * FROM '/data/sales.csv' WHERE amount > 15; SELECT count(*) AS n FROM top",
    });
    expect(result.rows).toEqual([{ n: 2 }]);
  });

  test("value conversion: bigint, decimal, timestamp, list, struct, blob", async () => {
    const { ctx } = createTestContext();
    const result = await sql(ctx, {
      query:
        "SELECT 9007199254740993::BIGINT AS big, 42::BIGINT AS small, 1.5::DECIMAL(10,2) AS dec, " +
        "TIMESTAMP '2024-01-01 12:00:00' AS ts, [1,2] AS lst, {'a': 1} AS st, 'x'::BLOB AS blb",
    });
    const row = result.rows[0];
    expect(row.big).toBe("9007199254740993");
    expect(row.small).toBe(42);
    expect(row.dec).toBe(1.5);
    expect(row.ts).toBe("2024-01-01 12:00:00");
    expect(row.lst).toEqual([1, 2]);
    expect(row.st).toEqual({ a: 1 });
    expect(String(row.blb)).toContain("blob");
  });

  test("binding a missing file throws NotFound", async () => {
    const { ctx } = createTestContext();
    await expect(
      sql(ctx, { query: "SELECT * FROM x", tables: { x: "/nope.csv" } })
    ).rejects.toThrow(/File not found/);
  });

  test("invalid table names are rejected", async () => {
    const { ctx } = createTestContext();
    await expect(
      sql(ctx, { query: "SELECT 1", tables: { "bad-name": "/a.csv" } })
    ).rejects.toThrow(/Invalid table name/);
  });

  test("sandbox: local filesystem reads are blocked", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    await expect(
      sql(ctx, { query: "SELECT * FROM read_csv('/etc/passwd')" })
    ).rejects.toThrow(/disabled|access/i);
  });

  test("sandbox: COPY out is blocked", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    await expect(
      sql(ctx, {
        query: "COPY (SELECT * FROM '/data/sales.csv') TO '/tmp/exfil.csv'",
      })
    ).rejects.toThrow(/disabled|access/i);
  });

  test("sandbox: configuration cannot be unlocked", async () => {
    const { ctx } = createTestContext();
    await expect(
      sql(ctx, { query: "SET enable_external_access=true; SELECT 1" })
    ).rejects.toThrow(/locked/i);
  });

  test("sandbox: sqlite escape via ATTACH is blocked even when sqlite docs are bound", async () => {
    const { ctx } = createTestContext();
    const fixtures = await makeBinaryFixtures();
    try {
      await writeRaw(ctx, { path: "/d/app.db", bytes: fixtures.sqlite });
      // The bound sqlite doc works, but the executing instance never loads the
      // sqlite extension, so attaching arbitrary host paths must fail.
      await expect(
        sql(ctx, {
          query: "ATTACH '/tmp/whatever.db' AS evil (TYPE sqlite); SELECT 1",
          tables: { app: "/d/app.db" },
        })
      ).rejects.toThrow();
      await expect(
        sql(ctx, {
          query: "SELECT * FROM sqlite_scan('/tmp/whatever.db', 'x')",
          tables: { app: "/d/app.db" },
        })
      ).rejects.toThrow();
    } finally {
      fixtures.cleanup();
    }
  });

  test("sandbox: http(s) reads are blocked", async () => {
    const { ctx } = createTestContext();
    await expect(
      sql(ctx, { query: "SELECT * FROM read_csv('https://example.com/x.csv')" })
    ).rejects.toThrow();
  });

  test("unknown path literals are left alone and fail with a helpful suggestion", async () => {
    const { ctx } = createTestContext();
    try {
      await sql(ctx, { query: "SELECT * FROM '/missing/file.csv'" });
      throw new Error("expected sql to throw");
    } catch (err: any) {
      expect(err.message).toMatch(/disabled|access/i);
      expect(err.suggestion).toMatch(/drive path/i);
    }
  });

  test("string literals that are not documents stay untouched", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    const result = await sql(ctx, {
      query: "SELECT count(*) AS n FROM '/data/sales.csv' WHERE name <> 'other.csv'",
    });
    expect(result.rows).toEqual([{ n: 3 }]);
  });

  test("a bound path used as a value (not a table) is not rewritten", async () => {
    const { ctx } = createTestContext();
    await seedCsv(ctx);
    // '/data/sales.csv' appears in both FROM (table) and WHERE (value) position.
    // Only the FROM occurrence must become the table; the predicate stays a string.
    const result = await sql(ctx, {
      query:
        "SELECT count(*) AS n FROM '/data/sales.csv' WHERE name <> '/data/sales.csv'",
    });
    expect(result.rows).toEqual([{ n: 3 }]);
  });

  test("gzip suffix is honored even when the format is overridden", async () => {
    const { ctx } = createTestContext();
    const gz = Bun.gzipSync(new TextEncoder().encode("a,b\n1,2\n3,4\n"));
    await writeRaw(ctx, { path: "/d/log.txt.gz", bytes: new Uint8Array(gz) });
    const result = await sql(ctx, {
      query: "SELECT sum(a) AS s FROM t",
      tables: { t: { path: "/d/log.txt.gz", format: "csv" } },
    });
    expect(result.rows).toEqual([{ s: 4 }]);
  });

  test("duplicate result columns are preserved (uniquified)", async () => {
    const { ctx } = createTestContext();
    const result = await sql(ctx, { query: "SELECT 1 AS id, 2 AS id" });
    expect(result.columns.map((c) => c.name)).toEqual(["id", "id_2"]);
    expect(result.rows).toEqual([{ id: 1, id_2: 2 }]);
  });
});
