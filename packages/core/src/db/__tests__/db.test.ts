import { describe, test, expect, afterEach } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as sqliteVec from "sqlite-vec";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CREATE_TABLES_SQL, VEC_TABLE_SQL } from "../raw.js";
import { createDatabase } from "../index.js";
import * as schema from "../schema.js";
import { createTestContext } from "../../test-utils.js";
import { ls } from "../../ops/ls.js";
import { glob } from "../../ops/glob.js";

// setup-sqlite.ts is auto-imported by db/index.ts, which runs setCustomSQLite once.

describe("Database initialization", () => {
  const testDbPaths: string[] = [];

  function makeTestDbPath(): string {
    const p = join(tmpdir(), `agent-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    testDbPaths.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of testDbPaths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    testDbPaths.length = 0;
  });

  test("sqlite-vec extension loads successfully", () => {
    const sqlite = new Database(":memory:");
    sqliteVec.load(sqlite);

    const result = sqlite.prepare("SELECT vec_version() as version").get() as {
      version: string;
    };
    expect(result.version).toBeTruthy();
    expect(typeof result.version).toBe("string");
  });

  test("FTS5 virtual table can be created and queried", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS test_fts USING fts5(title, content);"
    );

    sqlite.exec(
      "INSERT INTO test_fts(title, content) VALUES ('hello', 'world test content');"
    );
    const result = sqlite
      .prepare("SELECT * FROM test_fts WHERE test_fts MATCH 'world'")
      .get() as { title: string; content: string };
    expect(result.title).toBe("hello");
    expect(result.content).toBe("world test content");
  });

  test("vec0 virtual table can be created and queried", () => {
    const sqlite = new Database(":memory:");
    sqliteVec.load(sqlite);
    sqlite.exec(VEC_TABLE_SQL);

    // Insert a vector
    const embedding = new Float32Array(768);
    embedding[0] = 0.5;
    sqlite
      .prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(1, embedding);

    const result = sqlite
      .prepare(
        "SELECT chunk_id FROM chunk_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
      )
      .get(embedding) as { chunk_id: number };
    expect(result.chunk_id).toBe(1);
  });

  test("createDatabase initializes all tables", () => {
    const testDbPath = makeTestDbPath();
    const db = createDatabase(testDbPath);
    const sqlite = (db as any).$client as Database;

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("users");
    expect(tableNames).toContain("orgs");
    expect(tableNames).toContain("org_members");
    expect(tableNames).toContain("drives");
    expect(tableNames).toContain("drive_members");
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("file_versions");
    expect(tableNames).toContain("content_chunks");
    expect(tableNames).toContain("files_fts");
    expect(tableNames).toContain("chunk_vectors");
  });

  test("upgrades existing databases and indexes ls/glob metadata queries", async () => {
    const testDbPath = makeTestDbPath();
    const legacy = new Database(testDbPath);
    const schemaWithoutDrivePathIndex = CREATE_TABLES_SQL.replace(
      "CREATE INDEX IF NOT EXISTS idx_files_drive_path ON files(drive_id, path);\n",
      ""
    );
    legacy.exec(schemaWithoutDrivePathIndex);
    legacy
      .prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)")
      .run("org-1", "Org", 1);
    legacy
      .prepare("INSERT INTO drives (id, org_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("drive-1", "org-1", "Drive 1", 1);
    legacy
      .prepare("INSERT INTO drives (id, org_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("drive-2", "org-1", "Drive 2", 1);
    const insertFile = legacy.prepare(
      "INSERT INTO files (path, drive_id, size, author, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insertFile.run("/ls/existing.txt", "drive-1", 7, "user-1", 1, 2);
    insertFile.run("/glob/existing.txt", "drive-1", 10, "user-1", 1, 3);
    insertFile.run("/ls/existing.txt", "drive-2", 8, "user-2", 1, 4);
    expect(
      legacy
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_files_drive_path")
    ).toBeNull();
    legacy.close();

    const expectedRows = [
      { path: "/glob/existing.txt", drive_id: "drive-1", size: 10 },
      { path: "/ls/existing.txt", drive_id: "drive-1", size: 7 },
      { path: "/ls/existing.txt", drive_id: "drive-2", size: 8 },
    ];
    const db = createDatabase(testDbPath);
    const sqlite = (db as any).$client as Database;
    try {
      const rows = sqlite
        .prepare("SELECT path, drive_id, size FROM files ORDER BY drive_id, path")
        .all();
      expect(rows).toEqual(expectedRows);

      const queries: Array<{ sql: string; params: SQLQueryBindings[] }> = [];
      const loggedDb = drizzle(sqlite, {
        schema,
        logger: {
          logQuery(sql, params) {
            if (sql.includes("files")) {
              queries.push({ sql, params: params as SQLQueryBindings[] });
            }
          },
        },
      });
      const { ctx } = createTestContext();
      const opCtx = { ...ctx, db: loggedDb, orgId: "org-1", driveId: "drive-1" };
      await ls(opCtx, { path: "/ls" });
      const lsQuery = queries.at(-1)!;
      await glob(opCtx, { pattern: "**", path: "/glob" });
      const globQuery = queries.at(-1)!;

      const queryPlan = (query: { sql: string; params: SQLQueryBindings[] }) =>
        (
          sqlite
            .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.params) as Array<{ detail: string }>
        )
          .map((row) => row.detail)
          .join(" | ");

      expect(queryPlan(lsQuery)).toContain("idx_files_drive_path");
      expect(queryPlan(globQuery)).toContain("idx_files_drive_path");
    } finally {
      sqlite.close();
    }

    const reinitializedDb = createDatabase(testDbPath);
    const reinitializedSqlite = (reinitializedDb as any).$client as Database;
    try {
      const indexCount = reinitializedSqlite
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_files_drive_path") as { count: number };
      expect(indexCount.count).toBe(1);
      expect(
        reinitializedSqlite
          .prepare("SELECT path, drive_id, size FROM files ORDER BY drive_id, path")
          .all()
      ).toEqual(expectedRows);
    } finally {
      reinitializedSqlite.close();
    }
  });

  test("WAL mode is enabled", () => {
    const testDbPath = makeTestDbPath();
    const db = createDatabase(testDbPath);
    const sqlite = (db as any).$client as Database;

    const result = sqlite
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });
});
