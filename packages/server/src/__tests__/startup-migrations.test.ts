import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestContext } from "@/core/test-utils.js";
import { runPathNormalizationAtStartup } from "../startup-migrations.js";

describe("startup path normalization migration", () => {
  test("runs during daemon startup and logs a summary", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = (db as any).$client as Database;
    sqlite
      .query(
        `INSERT INTO files (
           path, drive_id, size, content_type, author, current_version_id,
           created_at, modified_at, is_deleted, embedding_status
         ) VALUES ('startup.md', ?, 1, 'text/markdown', ?, '1', 1, 1, 0, 'pending')`
      )
      .run(driveId, userId);
    sqlite
      .query(
        `INSERT INTO file_versions (
           path, drive_id, version, s3_version_id, author, operation, size, created_at
         ) VALUES ('startup.md', ?, 1, 'v1', ?, 'write', 1, 1)`
      )
      .run(driveId, userId);
    const logs: string[] = [];
    const errors: unknown[] = [];

    runPathNormalizationAtStartup(sqlite, {
      log: (message) => logs.push(message),
      error: (message, error) => errors.push([message, error]),
    });

    expect(sqlite.query("SELECT path FROM files").get()).toEqual({
      path: "/startup.md",
    });
    expect(logs).toEqual([
      "file path migration: 1 renamed, 0 merged, 0 versions renumbered, 0 comments remapped, 0 skipped",
    ]);
    expect(errors).toEqual([]);
  });

  test("logs a failure and lets startup continue with unchanged data", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = (db as any).$client as Database;
    sqlite
      .query(
        `INSERT INTO files (
           path, drive_id, size, content_type, author, current_version_id,
           created_at, modified_at, is_deleted, embedding_status
         ) VALUES ('blocked.md', ?, 1, 'text/markdown', ?, '1', 1, 1, 0, 'pending')`
      )
      .run(driveId, userId);
    sqlite
      .query(
        `INSERT INTO file_versions (
           path, drive_id, version, s3_version_id, author, operation, size, created_at
         ) VALUES ('blocked.md', ?, 1, 'v1', ?, 'write', 1, 1)`
      )
      .run(driveId, userId);
    sqlite.exec(
      `CREATE TRIGGER fail_startup_migration BEFORE UPDATE ON files
       BEGIN SELECT RAISE(FAIL, 'blocked'); END`
    );
    const errors: unknown[][] = [];

    expect(() =>
      runPathNormalizationAtStartup(sqlite, {
        log: () => {},
        error: (...args) => errors.push(args),
      })
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(sqlite.query("SELECT path FROM files").get()).toEqual({
      path: "blocked.md",
    });
  });
});
