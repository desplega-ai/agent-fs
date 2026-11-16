import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "../../db/index.js";
import { LocalStorageAdapter } from "../../storage/local-adapter.js";
import { createTestContext } from "../../test-utils.js";
import { ls } from "../ls.js";
import { getS3Key } from "../versioning.js";

const databases: Database[] = [];
const directories: string[] = [];
const storedAt = new Date("2025-01-02T00:00:00Z");
const modifiedAt = new Date("2025-02-03T00:00:00Z");

afterEach(async () => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

function setup() {
  const { ctx } = createTestContext();
  const sqlite = (ctx.db as unknown as { $client: Database }).$client;
  databases.push(sqlite);
  const queries: Array<{ sql: string; params: SQLQueryBindings[] }> = [];
  ctx.db = drizzle(sqlite, {
    schema,
    logger: { logQuery: (sql, params) => queries.push({ sql, params: params as SQLQueryBindings[] }) },
  });
  const insert = sqlite.prepare(
    "INSERT INTO files (path, drive_id, size, author, created_at, modified_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  function metadata(path: string, size = 42, deleted = false, driveId = ctx.driveId) {
    insert.run(path, driveId, size, ctx.userId, 0, modifiedAt.getTime() / 1000, Number(deleted));
  }
  const object = (path: string, size = 7) => ({
    key: getS3Key(ctx.orgId, ctx.driveId, path), size, lastModified: storedAt,
  });
  return { ctx, sqlite, queries, metadata, object };
}

describe("ls metadata", () => {
  test.each(["/", "/résumé_%/東京/"])("preserves storage entries and exact metadata paths under %s", async (prefix) => {
    const { ctx, sqlite, metadata, object } = setup();
    sqlite.prepare("INSERT INTO drives (id, org_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("other-drive", ctx.orgId, "Other", 0);
    const names = ["100%.txt", "a_b.txt", "café.txt", "cafe\u0301.txt", "東京.txt", "O'Brien.txt", "Case.txt"];
    for (const [i, name] of names.entries()) {
      metadata(prefix + name, i);
      metadata(prefix + name, 999, false, "other-drive");
    }
    metadata(prefix + "case.txt", 999);
    metadata(prefix + "deleted.txt", 999, true);
    metadata(prefix + "database-only.txt");
    metadata(prefix + "folder/deep/file.txt");
    ctx.s3.listObjects = async () => ({
      objects: [
        object(prefix),
        ...names.map((name) => object(prefix + name)),
        object(prefix + "deleted.txt"),
        object(prefix + "untracked.txt"),
        object(prefix + "marker/"),
      ],
      prefixes: [object(prefix + "folder/").key],
    });

    const result = await ls(ctx, { path: prefix.slice(1) });
    expect(result.entries).toEqual([
      { name: "folder", type: "directory", size: 0 },
      ...names.map((name, size) => ({ name, type: "file" as const, size, author: ctx.userId, modifiedAt })),
      { name: "deleted.txt", type: "file", size: 7, author: undefined, modifiedAt: storedAt },
      { name: "untracked.txt", type: "file", size: 7, author: undefined, modifiedAt: storedAt },
      { name: "marker", type: "directory", size: 0 },
    ]);
  });

  test("does not read metadata when storage has no file objects", async () => {
    const { ctx, queries, metadata, object } = setup();
    metadata("/stale/deep/file.txt");
    ctx.s3.listObjects = async () => ({ objects: [object("/"), object("/marker/")], prefixes: [] });

    expect(await ls(ctx, {})).toEqual({ entries: [{ name: "marker", type: "directory", size: 0 }] });
    expect(queries).toHaveLength(0);
  });

  test("large folders use bounded SQL parameters and retain metadata on every batch", async () => {
    const { ctx, sqlite, queries, metadata, object } = setup();
    // Exceeds SQLite's usual 32,766-variable limit if one statement binds every path.
    const count = 33_000;
    const objects = Array.from({ length: count }, (_, i) => object(`/large/file-${i}.txt`));
    sqlite.transaction(() => {
      for (let i = 0; i < count; i++) metadata(`/large/file-${i}.txt`, i);
    })();
    ctx.s3.listObjects = async () => ({ objects, prefixes: [] });

    const result = await ls(ctx, { path: "/large" });
    expect(result.entries).toHaveLength(count);
    expect(result.entries.every((entry, i) =>
      entry.name === `file-${i}.txt` && entry.size === i && entry.author === ctx.userId
      && entry.modifiedAt?.getTime() === modifiedAt.getTime()
    )).toBe(true);
    // Keep each statement below even the older 999-variable SQLite limit.
    expect(queries.every((query) => query.params.length <= 999)).toBe(true);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.length).toBeLessThan(100);
    const query = queries[0];
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
    expect(plan.some((row) =>
      /USING INDEX .*\((drive_id=\? AND path=\?|path=\? AND drive_id=\?)\)/.test(row.detail)
    )).toBe(true);
  });

  test.each(["/", "/focus_%/résumé/"])("metadata work stays bounded as unrelated descendants grow under %s", async (prefix) => {
    const { ctx, sqlite, queries, metadata, object } = setup();
    metadata(prefix + "visible.txt");
    metadata(prefix + "nested/first.txt");
    ctx.s3.listObjects = async () => ({
      objects: [object(prefix + "visible.txt")],
      prefixes: [object(prefix + "nested/").key],
    });

    async function measure() {
      queries.length = 0;
      const result = await ls(ctx, { path: prefix });
      const rows = queries.reduce((count, query) =>
        count + sqlite.prepare(query.sql).all(...query.params).length, 0);
      const plans = queries.map((query) =>
        (sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>)
          .map((row) => row.detail).join(" | "));
      return { result, rows, plans, statements: queries.length };
    }

    const before = await measure();
    sqlite.transaction(() => {
      for (let i = 0; i < 30_000; i++) {
        metadata(prefix + `nested/deeper/file-${i}.txt`);
        metadata(`/unrelated/deeper/file-${i}.txt`);
      }
    })();
    const after = await measure();

    expect(after.result).toEqual(before.result);
    expect(after.rows).toBe(before.rows);
    expect(before.rows).toBe(2); // One file plus one folder existence result.
    expect(after.statements).toBe(before.statements);
    // Require a path lookup, not just use of the drive index with a drive-wide scan.
    expect(after.plans.some((plan) =>
      /USING INDEX .*\((drive_id=\? AND path=\?|path=\? AND drive_id=\?)\)/.test(plan)
    )).toBe(true);
    expect(after.plans.every((plan) =>
      plan.includes("USING INDEX") && plan.includes("path") && !plan.includes("SCAN")
    )).toBe(true);
  });

  test("local storage retains immediate files, untracked folders, and deleted metadata fallback", async () => {
    const { ctx, metadata } = setup();
    const root = await mkdtemp(join(tmpdir(), "afs-ls-metadata-"));
    directories.push(root);
    ctx.s3 = new LocalStorageAdapter({ root });
    const prefix = "/résumé_%/";
    const key = (path: string) => getS3Key(ctx.orgId, ctx.driveId, prefix + path);
    for (const name of ["100%_東京.txt", "deleted.txt", "untracked/raw.txt"]) {
      await ctx.s3.putObject(key(name), "storage");
    }
    metadata(prefix + "100%_東京.txt", 0);
    metadata(prefix + "deleted.txt", 999, true);
    metadata(prefix + "database-only.txt");

    const result = await ls(ctx, { path: prefix });
    expect(result.entries).toEqual([
      { name: "untracked", type: "directory", size: 0 },
      { name: "100%_東京.txt", type: "file", size: 0, author: ctx.userId, modifiedAt },
      { name: "deleted.txt", type: "file", size: 7, author: undefined, modifiedAt: expect.any(Date) },
    ]);
  });
});
