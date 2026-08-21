import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as sqliteVec from "sqlite-vec";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "../schema.js";
import { CREATE_TABLES_SQL, VEC_TABLE_SQL } from "../raw.js";
import { createDatabase } from "../index.js";
import {
  isLegacyFtsTable,
  hasLegacyFts,
  prepareFtsMigration,
  runFtsMigration,
  LEGACY_FTS_TABLE,
} from "../fts-migration.js";
import { indexFile, removeFromIndex, ftsQuery } from "../../search/fts.js";
import { grep } from "../../ops/grep.js";
import { createTestContext } from "../../test-utils.js";

const DRIVE = "drive-1";

/**
 * Build a database in the pre-0.13.1 layout: every table of today's schema
 * except the full-text index, which is the old internal-content FTS5 table.
 */
function createLegacyDb(path = ":memory:"): Database {
  const sqlite = new Database(path);
  sqliteVec.load(sqlite);
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VEC_TABLE_SQL);
  sqlite.exec(
    "CREATE VIRTUAL TABLE files_fts USING fts5(path, content, drive_id UNINDEXED)"
  );
  return sqlite;
}

function addLegacyFile(
  sqlite: Database,
  path: string,
  content: string,
  opts: { deleted?: boolean } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO files(path, drive_id, size, author, created_at, modified_at, is_deleted)
       VALUES (?, ?, ?, 'u1', 0, 0, ?)`
    )
    .run(path, DRIVE, content.length, opts.deleted ? 1 : 0);
  sqlite
    .prepare("INSERT INTO files_fts(path, content, drive_id) VALUES (?, ?, ?)")
    .run(path, content, DRIVE);
}

function tableNames(sqlite: Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("FTS external-content migration", () => {
  const tmpPaths: string[] = [];
  afterEach(() => {
    for (const p of tmpPaths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(p + suffix);
        } catch {}
      }
    }
    tmpPaths.length = 0;
  });

  test("fresh database: nothing to migrate", async () => {
    const { db } = createTestContext();
    const sqlite = (db as any).$client as Database;

    expect(isLegacyFtsTable(sqlite)).toBe(false);
    expect(prepareFtsMigration(sqlite)).toBe(false);
    expect(hasLegacyFts(sqlite)).toBe(false);
    expect(await runFtsMigration(sqlite)).toEqual({ copied: 0, skipped: 0 });
    expect(tableNames(sqlite)).not.toContain(LEGACY_FTS_TABLE);
  });

  test("createDatabase leaves a legacy index alone", () => {
    const path = join(tmpdir(), `agent-fs-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpPaths.push(path);
    createLegacyDb(path).close();

    const db = createDatabase(path);
    const sqlite = (db as any).$client as Database;

    // Still the old table under the old name, no triggers installed: an older
    // daemon sharing this file keeps working until the new daemon takes over.
    expect(isLegacyFtsTable(sqlite)).toBe(true);
    expect(tableNames(sqlite)).not.toContain(LEGACY_FTS_TABLE);
    const triggers = sqlite
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'")
      .get() as { n: number };
    expect(triggers.n).toBe(0);

    // The daemon's step 1 then works on the handle createDatabase returned.
    expect(prepareFtsMigration(sqlite)).toBe(true);
    expect(isLegacyFtsTable(sqlite)).toBe(false);
    sqlite.close();
  });

  test("prepare renames the legacy index and routes writes to the new layout", () => {
    const sqlite = createLegacyDb();
    addLegacyFile(sqlite, "/old.md", "legacy content alpha");

    expect(prepareFtsMigration(sqlite)).toBe(true);
    expect(isLegacyFtsTable(sqlite)).toBe(false);
    expect(hasLegacyFts(sqlite)).toBe(true);
    expect(tableNames(sqlite)).toContain(LEGACY_FTS_TABLE);

    const db = drizzle(sqlite, { schema });
    indexFile(db, { path: "/new.md", driveId: DRIVE, content: "fresh content beta" });

    // New write landed in the docs table and is indexed through the trigger.
    const docs = sqlite.prepare("SELECT path FROM files_fts_docs").all() as Array<{ path: string }>;
    expect(docs.map((d) => d.path)).toEqual(["/new.md"]);
    expect(ftsQuery(db, { pattern: "beta", driveId: DRIVE }).map((m) => m.path)).toEqual(["/new.md"]);

    // Legacy rows stay searchable while the copy is pending.
    expect(ftsQuery(db, { pattern: "alpha", driveId: DRIVE }).map((m) => m.path)).toEqual(["/old.md"]);

    // Idempotent.
    expect(prepareFtsMigration(sqlite)).toBe(true);
  });

  test("search merges both layouts during the copy, new rows win", async () => {
    const sqlite = createLegacyDb();
    addLegacyFile(sqlite, "/a.md", "shared token stale");
    addLegacyFile(sqlite, "/b.md", "shared token legacy only");
    prepareFtsMigration(sqlite);
    const db = drizzle(sqlite, { schema });

    indexFile(db, { path: "/a.md", driveId: DRIVE, content: "shared token rewritten" });
    indexFile(db, { path: "/c.md", driveId: DRIVE, content: "shared token new only" });

    const hits = ftsQuery(db, { pattern: "shared", driveId: DRIVE });
    expect(hits.map((h) => h.path).sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(hits.find((h) => h.path === "/a.md")!.snippet).toContain("rewritten");
    expect(ftsQuery(db, { pattern: "stale", driveId: DRIVE })).toEqual([]);

    const { ctx } = createTestContext();
    const g = await grep({ ...ctx, db, driveId: DRIVE }, { pattern: "token", path: "/" });
    expect(g.matches.map((m) => m.path).sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(g.matches.find((m) => m.path === "/a.md")!.content).toContain("rewritten");
  });

  test("run copies live rows in batches, skips deleted and rewritten, drops legacy", async () => {
    const sqlite = createLegacyDb();
    for (let i = 0; i < 7; i++) {
      addLegacyFile(sqlite, `/doc-${i}.md`, `document number ${i} body`);
    }
    addLegacyFile(sqlite, "/gone.md", "deleted before migration", { deleted: true });
    addLegacyFile(sqlite, "/orphan.md", "no files row at all");
    sqlite.prepare("DELETE FROM files WHERE path = '/orphan.md'").run();

    prepareFtsMigration(sqlite);
    const db = drizzle(sqlite, { schema });
    // Written after the rename: the new row must survive the copy.
    indexFile(db, { path: "/doc-3.md", driveId: DRIVE, content: "document number 3 rewritten" });
    // Deleted after the rename: must not come back.
    removeFromIndex(db, { path: "/doc-5.md", driveId: DRIVE });
    sqlite.prepare("UPDATE files SET is_deleted = 1 WHERE path = '/doc-5.md'").run();

    const logs: string[] = [];
    const result = await runFtsMigration(sqlite, { batchSize: 2, log: (m) => logs.push(m) });

    expect(result).toEqual({ copied: 5, skipped: 4 });
    expect(hasLegacyFts(sqlite)).toBe(false);
    expect(tableNames(sqlite)).not.toContain(LEGACY_FTS_TABLE);
    expect(sqlite.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
    expect(logs.at(-1)).toContain("done");

    const paths = ftsQuery(db, { pattern: "document", driveId: DRIVE }).map((m) => m.path).sort();
    expect(paths).toEqual(["/doc-0.md", "/doc-1.md", "/doc-2.md", "/doc-3.md", "/doc-4.md", "/doc-6.md"]);
    expect(ftsQuery(db, { pattern: "rewritten", driveId: DRIVE }).map((m) => m.path)).toEqual(["/doc-3.md"]);
    expect(ftsQuery(db, { pattern: "deleted", driveId: DRIVE })).toEqual([]);
    expect(ftsQuery(db, { pattern: "orphan", driveId: DRIVE })).toEqual([]);

    // Index and content table agree row for row.
    const check = sqlite.prepare("INSERT INTO files_fts(files_fts) VALUES('integrity-check')");
    expect(() => check.run()).not.toThrow();
  });

  test("run slices batches by content size, oversized rows go alone", async () => {
    const sqlite = createLegacyDb();
    addLegacyFile(sqlite, "/big.md", "x".repeat(5000));
    for (let i = 0; i < 5; i++) addLegacyFile(sqlite, `/small-${i}.md`, `small row ${i}`);
    prepareFtsMigration(sqlite);

    const result = await runFtsMigration(sqlite, { batchSize: 50, batchBytes: 64 });
    expect(result).toEqual({ copied: 6, skipped: 0 });
    expect(hasLegacyFts(sqlite)).toBe(false);

    const db = drizzle(sqlite, { schema });
    expect(ftsQuery(db, { pattern: "small", driveId: DRIVE }).length).toBe(5);
    expect(
      (sqlite.prepare("SELECT length(content) AS n FROM files_fts_docs WHERE path = '/big.md'").get() as { n: number }).n
    ).toBe(5000);
  });

  test("run raises crisismerge for the copy and restores it, even after a crash in between", async () => {
    const sqlite = createLegacyDb();
    addLegacyFile(sqlite, "/one.md", "one row");
    prepareFtsMigration(sqlite);
    const crisismerge = () =>
      (sqlite.prepare("SELECT v FROM files_fts_config WHERE k = 'crisismerge'").get() as { v: number } | null)?.v ?? 16;

    // Simulate a process that died after the copy + drop but before the restore.
    await runFtsMigration(sqlite, { batchSize: 1 });
    expect(crisismerge()).toBe(16);
    sqlite.prepare("INSERT INTO files_fts(files_fts, rank) VALUES ('crisismerge', 1000)").run();
    sqlite.prepare("INSERT INTO meta(key, value) VALUES ('fts_migration_tuning', '1')").run();

    expect(prepareFtsMigration(sqlite)).toBe(true);
    expect(await runFtsMigration(sqlite)).toEqual({ copied: 0, skipped: 0 });
    expect(crisismerge()).toBe(16);
    expect(sqlite.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
    expect(prepareFtsMigration(sqlite)).toBe(false);
  });

  test("run resumes from the persisted cursor", async () => {
    const sqlite = createLegacyDb();
    addLegacyFile(sqlite, "/first.md", "first row");
    addLegacyFile(sqlite, "/second.md", "second row");
    prepareFtsMigration(sqlite);

    // Pretend an earlier run committed the first batch and then died.
    const firstRowid = (
      sqlite.prepare(`SELECT min(rowid) AS r FROM ${LEGACY_FTS_TABLE}`).get() as { r: number }
    ).r;
    sqlite
      .prepare("INSERT INTO meta(key, value) VALUES ('fts_migration_cursor', ?)")
      .run(String(firstRowid));

    const result = await runFtsMigration(sqlite, { batchSize: 1 });
    expect(result).toEqual({ copied: 1, skipped: 0 });

    const db = drizzle(sqlite, { schema });
    expect(ftsQuery(db, { pattern: "second", driveId: DRIVE }).map((m) => m.path)).toEqual(["/second.md"]);
    // The first row was (by assumption) copied by the earlier run, so it is not re-copied here.
    expect(ftsQuery(db, { pattern: "first", driveId: DRIVE })).toEqual([]);
  });
});

describe("search index write path uses indexes", () => {
  function plan(sqlite: Database, sql: string): string {
    return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
  }

  test("docs delete and chunk lookup are index searches, not scans", () => {
    const { db } = createTestContext();
    const sqlite = (db as any).$client as Database;

    const docsPlan = plan(sqlite, "DELETE FROM files_fts_docs WHERE drive_id = 'd' AND path = '/p'");
    expect(docsPlan).toContain("files_fts_docs_drive_path_uq");
    expect(docsPlan).not.toContain("SCAN");

    const chunksPlan = plan(sqlite, "SELECT id FROM content_chunks WHERE file_path = '/p' AND drive_id = 'd'");
    expect(chunksPlan).toContain("idx_content_chunks_drive_path");
    expect(chunksPlan).not.toContain("SCAN");
  });
});
