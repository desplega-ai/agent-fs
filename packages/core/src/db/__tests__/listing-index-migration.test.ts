import "../setup-sqlite.js";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATE_TABLES_SQL, FILES_LIVE_INDEX_SQL, FILE_VERSIONS_RECENT_INDEX_SQL } from "../raw.js";
import { runMigrations } from "../migrate.js";

test("existing databases receive both listing indexes without changing rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "afs-remaining-migration-"));
  const path = join(directory, "existing.db");
  let sqlite = new Database(path);
  try {
    sqlite.exec(CREATE_TABLES_SQL.replace(FILES_LIVE_INDEX_SQL, "").replace(FILE_VERSIONS_RECENT_INDEX_SQL, ""));
    sqlite.exec("INSERT INTO files (path, drive_id, size, author, created_at, modified_at) VALUES ('/a.txt', 'd', 1, 'u', 1, 1)");
    sqlite.exec("INSERT INTO file_versions (path, drive_id, version, s3_version_id, author, operation, created_at) VALUES ('/a.txt', 'd', 1, 'v1', 'u', 'write', 1)");
    const files = sqlite.query("SELECT * FROM files").all();
    const versions = sqlite.query("SELECT * FROM file_versions").all();
    sqlite.close();
    sqlite = new Database(path);
    runMigrations(sqlite);
    runMigrations(sqlite);
    expect(sqlite.query("SELECT * FROM files").all()).toEqual(files);
    expect(sqlite.query("SELECT * FROM file_versions").all()).toEqual(versions);
    const summary = sqlite.query("EXPLAIN QUERY PLAN SELECT 1 FROM files WHERE drive_id = ? AND is_deleted = 0 AND path NOT LIKE '%/' LIMIT 5").all("d") as { detail: string }[];
    expect(summary.some(({ detail }) => detail.includes("idx_files_live_drive_path"))).toBe(true);
    for (const since of ["", " AND created_at >= 1"]) {
      const recent = sqlite.query(`EXPLAIN QUERY PLAN SELECT * FROM file_versions WHERE drive_id = ?${since} ORDER BY created_at DESC LIMIT 5`).all("d") as { detail: string }[];
      expect(recent.some(({ detail }) => detail.includes("idx_file_versions_drive_created"))).toBe(true);
      expect(recent.some(({ detail }) => detail.includes("TEMP B-TREE") || detail.includes("SCAN file_versions"))).toBe(false);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
