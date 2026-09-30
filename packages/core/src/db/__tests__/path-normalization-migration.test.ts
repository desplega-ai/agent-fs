import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../index.js";
import { runMigrations } from "../migrate.js";
import { runPathNormalizationMigration } from "../path-normalization-migration.js";
import { getS3Key } from "../../ops/versioning.js";
import { stat } from "../../ops/stat.js";
import { log } from "../../ops/log.js";
import { diff } from "../../ops/diff.js";
import { fts } from "../../ops/fts.js";

function rawDb(db: ReturnType<typeof createTestContext>["db"]): Database {
  return (db as any).$client as Database;
}

function insertFile(
  sqlite: Database,
  driveId: string,
  path: string,
  author: string,
  modifiedAt: number,
  size = 1
): void {
  sqlite
    .query(
      `INSERT INTO files (
         path, drive_id, size, content_type, author, current_version_id,
         created_at, modified_at, is_deleted, embedding_status
       ) VALUES (?, ?, ?, 'text/markdown', ?, '1', ?, ?, 0, 'indexed')`
    )
    .run(path, driveId, size, author, modifiedAt, modifiedAt);
}

function insertVersion(
  sqlite: Database,
  params: {
    driveId: string;
    path: string;
    storageVersionId: string;
    author: string;
    createdAt: number;
    operation?: "write" | "delete";
    size?: number | null;
  }
): number {
  return Number(
    sqlite
      .query(
        `INSERT INTO file_versions (
           path, drive_id, version, s3_version_id, author, operation, size, created_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(
        params.path,
        params.driveId,
        params.storageVersionId,
        params.author,
        params.operation ?? "write",
        params.size ?? 1,
        params.createdAt
      ).lastInsertRowid
  );
}

function bareCount(sqlite: Database, table: string, column = "path"): number {
  return (
    sqlite
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} NOT LIKE '/%'`)
      .get() as { count: number }
  ).count;
}

describe("file path normalization migration", () => {
  test("does not run through createDatabase additive migrations", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    insertFile(sqlite, driveId, "cli-safe.md", userId, 1);
    insertVersion(sqlite, {
      driveId,
      path: "cli-safe.md",
      storageVersionId: "v1",
      author: userId,
      createdAt: 1,
    });

    runMigrations(sqlite);

    expect(sqlite.query("SELECT path FROM files").get()).toEqual({
      path: "cli-safe.md",
    });
  });

  test("normalizes the pre-0.13.1 internal FTS table", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    sqlite.exec("DROP TRIGGER files_fts_docs_ai");
    sqlite.exec("DROP TRIGGER files_fts_docs_ad");
    sqlite.exec("DROP TRIGGER files_fts_docs_au");
    sqlite.exec("DROP TABLE files_fts");
    sqlite.exec("CREATE VIRTUAL TABLE files_fts USING fts5(path, content, drive_id UNINDEXED)");
    insertFile(sqlite, driveId, "legacy.md", userId, 1, 6);
    insertVersion(sqlite, {
      driveId,
      path: "legacy.md",
      storageVersionId: "legacy-v1",
      author: userId,
      createdAt: 1,
      size: 6,
    });
    sqlite
      .query("INSERT INTO files_fts(path, content, drive_id) VALUES ('legacy.md', 'legacy', ?)")
      .run(driveId);

    expect(runPathNormalizationMigration(sqlite)?.renamedPaths).toBe(1);
    expect(sqlite.query("SELECT path FROM files_fts").all()).toEqual([
      { path: "/legacy.md" },
    ]);
    expect(runPathNormalizationMigration(sqlite)).toBeNull();
  });

  test("detects and renames bare rows that exist only in both index tables", () => {
    const { db, driveId } = createTestContext();
    const sqlite = rawDb(db);
    const chunkId = sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('index-only.md', ?, 0, 'token', 0, 1)"
      )
      .run(driveId).lastInsertRowid;
    sqlite
      .query("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(chunkId, new Float32Array(768));
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, 'index-only.md', 'token')")
      .run(driveId);

    expect(runPathNormalizationMigration(sqlite)).toMatchObject({
      renamedPaths: 1,
      mergedPaths: 0,
    });
    expect(sqlite.query("SELECT file_path FROM content_chunks").get()).toEqual({
      file_path: "/index-only.md",
    });
    expect(sqlite.query("SELECT path FROM files_fts_docs").get()).toEqual({
      path: "/index-only.md",
    });
    expect(sqlite.query("SELECT chunk_id FROM chunk_vectors").get()).toEqual({
      chunk_id: chunkId,
    });
    expect(runPathNormalizationMigration(sqlite)).toBeNull();
  });

  test("merges by created_at then insertion id and keeps the latest form indexes", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext({
      versioningEnabled: true,
    });
    const sqlite = rawDb(db);
    const key = getS3Key(orgId, driveId, "/split.md");
    const bareStored = await s3.putObject(key, "bare first", undefined, "text/markdown");
    const latestStored = await s3.putObject(
      key,
      "latest canonical search token",
      undefined,
      "text/markdown"
    );

    const bareVersionId = insertVersion(sqlite, {
      driveId,
      path: "split.md",
      storageVersionId: bareStored.versionId!,
      author: "bare-author",
      createdAt: 100,
      size: 10,
    });
    const latestVersionId = insertVersion(sqlite, {
      driveId,
      path: "/split.md",
      storageVersionId: latestStored.versionId!,
      author: "latest-author",
      createdAt: 100,
      size: 29,
    });
    insertFile(sqlite, driveId, "split.md", "bare-author", 100, 10);
    insertFile(sqlite, driveId, "/split.md", "latest-author", 100, 29);
    sqlite.exec("ALTER TABLE files ADD COLUMN future_value TEXT");
    sqlite
      .query("UPDATE files SET future_value = 'keep-me' WHERE drive_id = ? AND path = '/split.md'")
      .run(driveId);

    sqlite
      .query(
        `INSERT INTO comments (
           id, org_id, drive_id, path, file_version_id, body, author,
           resolved, created_at, updated_at, is_deleted
         ) VALUES ('root', ?, ?, 'split.md', ?, 'root', ?, 0, 100, 100, 0)`
      )
      .run(orgId, driveId, bareVersionId, userId);
    sqlite
      .query(
        `INSERT INTO comments (
           id, parent_id, org_id, drive_id, path, file_version_id, body, author,
           resolved, created_at, updated_at, is_deleted
         ) VALUES ('reply', 'root', ?, ?, '/split.md', ?, 'reply', ?, 0, 101, 101, 0)`
      )
      .run(orgId, driveId, latestVersionId, userId);
    sqlite
      .query(
        `INSERT INTO shares (
           id, org_id, drive_id, path, token_hash, expires_at, views,
           created_by, created_at
         ) VALUES ('share-bare', ?, ?, 'split.md', 'hash', 9999999999, 0, ?, 100)`
      )
      .run(orgId, driveId, userId);

    const bareChunk = sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('split.md', ?, 0, 'bare first', 0, 2)"
      )
      .run(driveId).lastInsertRowid;
    const latestChunk = sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('/split.md', ?, 0, 'latest canonical search token', 0, 4)"
      )
      .run(driveId).lastInsertRowid;
    sqlite
      .query("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(bareChunk, new Float32Array(768));
    sqlite
      .query("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(latestChunk, new Float32Array(768));
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, 'split.md', 'bare first')")
      .run(driveId);
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, '/split.md', 'latest canonical search token')")
      .run(driveId);
    sqlite.exec(
      "CREATE VIRTUAL TABLE files_fts_legacy USING fts5(path, content, drive_id UNINDEXED)"
    );
    sqlite
      .query("INSERT INTO files_fts_legacy(path, content, drive_id) VALUES ('split.md', 'bare first', ?)")
      .run(driveId);
    sqlite
      .query("INSERT INTO files_fts_legacy(path, content, drive_id) VALUES ('/split.md', 'latest canonical search token', ?)")
      .run(driveId);

    const first = runPathNormalizationMigration(sqlite);
    expect(first).toEqual({
      renamedPaths: 0,
      mergedPaths: 1,
      versionsRenumbered: 1,
      commentsRemapped: 2,
      skippedPaths: 0,
    });
    expect(runPathNormalizationMigration(sqlite)).toBeNull();

    const versions = sqlite
      .query(
        "SELECT id, version, s3_version_id AS storageVersionId FROM file_versions WHERE drive_id = ? ORDER BY version"
      )
      .all(driveId);
    expect(versions).toEqual([
      { id: bareVersionId, version: 1, storageVersionId: bareStored.versionId! },
      { id: latestVersionId, version: 2, storageVersionId: latestStored.versionId! },
    ]);

    const file = sqlite
      .query(
        "SELECT path, size, author, current_version_id AS currentVersion, embedding_status AS embeddingStatus, future_value AS futureValue FROM files"
      )
      .get();
    expect(file).toEqual({
      path: "/split.md",
      size: 29,
      author: "latest-author",
      currentVersion: "2",
      embeddingStatus: "indexed",
      futureValue: "keep-me",
    });
    expect(
      sqlite.query("SELECT id, parent_id AS parentId, path FROM comments ORDER BY id").all()
    ).toEqual([
      { id: "reply", parentId: "root", path: "/split.md" },
      { id: "root", parentId: null, path: "/split.md" },
    ]);
    expect(sqlite.query("SELECT path FROM shares").get()).toEqual({ path: "/split.md" });
    expect(sqlite.query("SELECT id, file_path AS path, content FROM content_chunks").all()).toEqual([
      { id: latestChunk, path: "/split.md", content: "latest canonical search token" },
    ]);
    expect(sqlite.query("SELECT chunk_id AS chunkId FROM chunk_vectors").all()).toEqual([
      { chunkId: latestChunk },
    ]);
    expect(sqlite.query("SELECT path, content FROM files_fts_docs").all()).toEqual([
      { path: "/split.md", content: "latest canonical search token" },
    ]);
    expect(sqlite.query("SELECT path, content FROM files_fts_legacy").all()).toEqual([
      { path: "/split.md", content: "latest canonical search token" },
    ]);

    const search = await fts(ctx, { pattern: "canonical", path: "/" });
    expect(search.matches.length).toBeGreaterThan(0);
    expect(search.matches[0].path).toBe("/split.md");
    expect(await stat(ctx, { path: "/split.md" })).toMatchObject({
      currentVersion: 2,
      author: "latest-author",
      size: 29,
    });
    expect((await log(ctx, { path: "/split.md" })).versions.map((row) => row.version)).toEqual([
      2,
      1,
    ]);
    expect((await diff(ctx, { path: "/split.md", v1: 1, v2: 2 })).changes.length).toBeGreaterThan(0);

    for (const [table, column] of [
      ["files", "path"],
      ["file_versions", "path"],
      ["comments", "path"],
      ["shares", "path"],
      ["content_chunks", "file_path"],
      ["files_fts_docs", "path"],
      ["files_fts_legacy", "path"],
    ]) {
      expect(bareCount(sqlite, table, column)).toBe(0);
    }
  });

  test("uses the latest delete version and removes both forms of index data", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    insertVersion(sqlite, {
      driveId,
      path: "/deleted.md",
      storageVersionId: "write-v1",
      author: userId,
      createdAt: 10,
      size: 5,
    });
    insertVersion(sqlite, {
      driveId,
      path: "deleted.md",
      storageVersionId: "",
      author: "deleter",
      createdAt: 20,
      operation: "delete",
      size: null,
    });
    insertFile(sqlite, driveId, "/deleted.md", userId, 10, 5);
    insertFile(sqlite, driveId, "deleted.md", "deleter", 20, 5);
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, '/deleted.md', 'old')")
      .run(driveId);
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, 'deleted.md', 'stale')")
      .run(driveId);
    sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('/deleted.md', ?, 0, 'old', 0, 1)"
      )
      .run(driveId);
    sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('deleted.md', ?, 0, 'stale', 0, 1)"
      )
      .run(driveId);

    runPathNormalizationMigration(sqlite);

    expect(
      sqlite
        .query(
          "SELECT path, author, current_version_id AS currentVersion, is_deleted AS isDeleted FROM files"
        )
        .get()
    ).toEqual({
      path: "/deleted.md",
      author: "deleter",
      currentVersion: "2",
      isDeleted: 1,
    });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM files_fts_docs").get()).toEqual({
      count: 0,
    });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM content_chunks").get()).toEqual({
      count: 0,
    });
  });

  test("renames the latest bare form indexes and deletes stale canonical indexes", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    insertVersion(sqlite, {
      driveId,
      path: "/latest-bare.md",
      storageVersionId: "canonical-v1",
      author: userId,
      createdAt: 10,
    });
    insertVersion(sqlite, {
      driveId,
      path: "latest-bare.md",
      storageVersionId: "bare-v1",
      author: "latest-author",
      createdAt: 20,
    });
    insertFile(sqlite, driveId, "/latest-bare.md", userId, 10);
    insertFile(sqlite, driveId, "latest-bare.md", "latest-author", 20);
    const canonicalChunk = sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('/latest-bare.md', ?, 0, 'stale', 0, 1)"
      )
      .run(driveId).lastInsertRowid;
    const bareChunk = sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('latest-bare.md', ?, 0, 'current', 0, 1)"
      )
      .run(driveId).lastInsertRowid;
    sqlite
      .query("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(canonicalChunk, new Float32Array(768));
    sqlite
      .query("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
      .run(bareChunk, new Float32Array(768));
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, '/latest-bare.md', 'stale')")
      .run(driveId);
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, 'latest-bare.md', 'current')")
      .run(driveId);

    runPathNormalizationMigration(sqlite);

    expect(sqlite.query("SELECT id, file_path AS path, content FROM content_chunks").all()).toEqual([
      { id: bareChunk, path: "/latest-bare.md", content: "current" },
    ]);
    expect(sqlite.query("SELECT chunk_id AS chunkId FROM chunk_vectors").all()).toEqual([
      { chunkId: bareChunk },
    ]);
    expect(sqlite.query("SELECT path, content FROM files_fts_docs").all()).toEqual([
      { path: "/latest-bare.md", content: "current" },
    ]);
  });

  test("marks a split path pending when the latest form has no index rows", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    insertVersion(sqlite, {
      driveId,
      path: "/missing-index.md",
      storageVersionId: "canonical-v1",
      author: userId,
      createdAt: 10,
    });
    insertVersion(sqlite, {
      driveId,
      path: "missing-index.md",
      storageVersionId: "bare-v1",
      author: userId,
      createdAt: 20,
    });
    insertFile(sqlite, driveId, "/missing-index.md", userId, 10);
    insertFile(sqlite, driveId, "missing-index.md", userId, 20);
    sqlite
      .query("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, '/missing-index.md', 'stale')")
      .run(driveId);
    sqlite
      .query(
        "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES ('/missing-index.md', ?, 0, 'stale', 0, 1)"
      )
      .run(driveId);

    runPathNormalizationMigration(sqlite);

    expect(sqlite.query("SELECT embedding_status AS status FROM files").get()).toEqual({
      status: "pending",
    });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM files_fts_docs").get()).toEqual({
      count: 0,
    });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM content_chunks").get()).toEqual({
      count: 0,
    });
  });

  test("skips trailing-slash and repeated-slash paths and logs each path", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    for (const path of ["dir/", "a//b"]) {
      insertFile(sqlite, driveId, path, userId, 1);
      insertVersion(sqlite, {
        driveId,
        path,
        storageVersionId: path,
        author: userId,
        createdAt: 1,
      });
    }
    const messages: string[] = [];

    expect(
      runPathNormalizationMigration(sqlite, { log: (message) => messages.push(message) })
    ).toMatchObject({ skippedPaths: 2, renamedPaths: 0, mergedPaths: 0 });
    expect(sqlite.query("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "a//b" },
      { path: "dir/" },
    ]);
    expect(messages.some((message) => message.includes('"a//b"'))).toBe(true);
    expect(messages.some((message) => message.includes('"dir/"'))).toBe(true);
  });

  test("rolls back every change when a trigger fails midway", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    for (const path of ["a.md", "b.md"]) {
      insertFile(sqlite, driveId, path, userId, 1);
      insertVersion(sqlite, {
        driveId,
        path,
        storageVersionId: path,
        author: userId,
        createdAt: 1,
      });
    }
    sqlite.exec(
      `CREATE TRIGGER fail_path_migration BEFORE UPDATE ON file_versions
       WHEN old.path = 'b.md'
       BEGIN SELECT RAISE(FAIL, 'injected migration failure'); END`
    );
    const beforeFiles = sqlite.query("SELECT path FROM files ORDER BY path").all();
    const beforeVersions = sqlite
      .query("SELECT path, version FROM file_versions ORDER BY path")
      .all();

    expect(() => runPathNormalizationMigration(sqlite)).toThrow(
      "injected migration failure"
    );
    expect(sqlite.query("SELECT path FROM files ORDER BY path").all()).toEqual(
      beforeFiles
    );
    expect(
      sqlite.query("SELECT path, version FROM file_versions ORDER BY path").all()
    ).toEqual(beforeVersions);
  });

  test("detects new bare rows after an earlier successful run", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = rawDb(db);
    insertFile(sqlite, driveId, "first.md", userId, 1);
    insertVersion(sqlite, {
      driveId,
      path: "first.md",
      storageVersionId: "first",
      author: userId,
      createdAt: 1,
    });
    expect(runPathNormalizationMigration(sqlite)?.renamedPaths).toBe(1);

    insertFile(sqlite, driveId, "second.md", userId, 2);
    insertVersion(sqlite, {
      driveId,
      path: "second.md",
      storageVersionId: "second",
      author: userId,
      createdAt: 2,
    });
    expect(runPathNormalizationMigration(sqlite)?.renamedPaths).toBe(1);
    expect(runPathNormalizationMigration(sqlite)).toBeNull();
    expect(
      db.select({ path: schema.files.path }).from(schema.files).orderBy(schema.files.path).all()
    ).toEqual([{ path: "/first.md" }, { path: "/second.md" }]);
  });
});
