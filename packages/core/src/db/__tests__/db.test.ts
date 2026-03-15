import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VIRTUAL_TABLE_SQL } from "../raw.js";
import { createDatabase } from "../index.js";

// setup-sqlite.ts is auto-imported by db/index.ts, which runs setCustomSQLite once.

describe("Database initialization", () => {
  const testDbPaths: string[] = [];

  function makeTestDbPath(): string {
    const p = join(tmpdir(), `agentfs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    sqlite.exec(VIRTUAL_TABLE_SQL);

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
