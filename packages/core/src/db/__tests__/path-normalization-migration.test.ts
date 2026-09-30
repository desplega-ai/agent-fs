import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../index.js";
import { runMigrations } from "../migrate.js";
import {
  getQueuedPathReindexes,
  takePathNormalizationMigrationReport,
} from "../path-normalization-migration.js";
import { getS3Key } from "../../ops/versioning.js";
import { stat } from "../../ops/stat.js";
import { log } from "../../ops/log.js";
import { diff } from "../../ops/diff.js";
import { reindex } from "../../ops/reindex.js";
import { write } from "../../ops/write.js";

function rawDb(db: ReturnType<typeof createTestContext>["db"]): Database {
  return (db as any).$client as Database;
}

describe("file path normalization migration", () => {
  test("normalizes the pre-0.13.1 internal FTS table", () => {
    const { db, driveId, userId } = createTestContext();
    const raw = rawDb(db);
    raw.exec("DROP TRIGGER files_fts_docs_ai");
    raw.exec("DROP TRIGGER files_fts_docs_ad");
    raw.exec("DROP TRIGGER files_fts_docs_au");
    raw.exec("DROP TABLE files_fts");
    raw.exec("CREATE VIRTUAL TABLE files_fts USING fts5(path, content, drive_id UNINDEXED)");
    raw.prepare(
      `INSERT INTO files (
         path, drive_id, size, content_type, author, current_version_id,
         created_at, modified_at, is_deleted, embedding_status
       ) VALUES ('legacy.md', ?, 6, 'text/markdown', ?, '1', 1, 1, 0, 'indexed')`
    ).run(driveId, userId);
    raw.prepare(
      `INSERT INTO file_versions (
         path, drive_id, version, s3_version_id, author, operation, size, created_at
       ) VALUES ('legacy.md', ?, 1, 'legacy-v1', ?, 'write', 6, 1)`
    ).run(driveId, userId);
    raw.prepare("INSERT INTO files_fts(path, content, drive_id) VALUES ('legacy.md', 'legacy', ?)")
      .run(driveId);

    expect(runMigrations(raw)?.renamedPaths).toBe(1);
    expect(raw.prepare("SELECT path FROM files_fts").all()).toEqual([
      { path: "/legacy.md" },
    ]);
    expect(runMigrations(raw)).toBeNull();
  });

  test("normalizes an ancillary bare row without treating canonical history as split", async () => {
    const { ctx, db, driveId, orgId, userId } = createTestContext();
    const raw = rawDb(db);
    await write(ctx, { path: "/canonical.md", content: "canonical index content" });
    const version = raw
      .prepare("SELECT id FROM file_versions WHERE drive_id = ? AND path = '/canonical.md'")
      .get(driveId) as { id: number };
    raw.prepare(
      `INSERT INTO comments (
         id, org_id, drive_id, path, file_version_id, body, author,
         resolved, created_at, updated_at, is_deleted
       ) VALUES ('ancillary-comment', ?, ?, 'canonical.md', ?, 'legacy', ?, 0, 1, 1, 0)`
    ).run(orgId, driveId, version.id, userId);

    expect(runMigrations(raw)).toEqual({
      renamedPaths: 1,
      mergedPaths: 0,
      versionsRenumbered: 0,
      commentsRemapped: 1,
      reindexPaths: 0,
    });
    expect(raw.prepare("SELECT path FROM comments").all()).toEqual([
      { path: "/canonical.md" },
    ]);
    expect(raw.prepare("SELECT path, version FROM file_versions").all()).toEqual([
      { path: "/canonical.md", version: 1 },
    ]);
    expect(raw.prepare("SELECT path, content FROM files_fts_docs").all()).toEqual([
      { path: "/canonical.md", content: "canonical index content" },
    ]);
    expect(getQueuedPathReindexes(raw)).toEqual([]);
  });

  test("renames bare paths and merges split histories once", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext({
      versioningEnabled: true,
    });
    const raw = rawDb(db);
    const key = getS3Key(orgId, driveId, "/split.md");
    const storedVersions = [];
    for (const content of ["canonical one", "bare one", "canonical two", "bare latest"]) {
      const stored = await s3.putObject(key, content, undefined, "text/markdown");
      storedVersions.push(stored.versionId!);
    }

    const insertVersion = raw.prepare(
      `INSERT INTO file_versions (
         path, drive_id, version, s3_version_id, author, operation,
         message, diff_summary, size, etag, content_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, 'write', ?, ?, ?, ?, ?, ?)`
    );
    insertVersion.run("bare/only.md", driveId, 1, "bare-only-v1", userId, "one", null, 3, "e1", "h1", 50);
    insertVersion.run("bare/only.md", driveId, 2, "bare-only-v2", userId, "two", null, 6, "e2", "h2", 60);

    insertVersion.run("/split.md", driveId, 1, storedVersions[0], userId, "canonical one", null, 13, "e3", "h3", 100);
    const bareFirst = insertVersion.run("split.md", driveId, 1, storedVersions[1], userId, "bare one", null, 8, "e4", "h4", 100).lastInsertRowid;
    const canonicalSecond = insertVersion.run("/split.md", driveId, 2, storedVersions[2], userId, "canonical two", null, 13, "e5", "h5", 300).lastInsertRowid;
    const bareLatest = insertVersion.run("split.md", driveId, 2, storedVersions[3], "latest-author", "bare latest", null, 11, "e6", "h6", 400).lastInsertRowid;

    const insertFile = raw.prepare(
      `INSERT INTO files (
         path, drive_id, size, content_type, author, current_version_id,
         created_at, modified_at, is_deleted, embedding_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'indexed')`
    );
    insertFile.run("bare/only.md", driveId, 6, "text/markdown", userId, "2", 50, 60);
    insertFile.run("/split.md", driveId, 13, "text/markdown", userId, "2", 100, 300);
    insertFile.run("split.md", driveId, 11, "text/markdown", "latest-author", "2", 100, 400);

    const insertComment = raw.prepare(
      `INSERT INTO comments (
         id, org_id, drive_id, path, file_version_id, body, author,
         resolved, created_at, updated_at, is_deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`
    );
    insertComment.run("comment-bare", orgId, driveId, "split.md", Number(bareFirst), "bare", userId, 200, 200);
    insertComment.run("comment-canonical", orgId, driveId, "/split.md", Number(canonicalSecond), "canonical", userId, 300, 300);

    raw.prepare(
      `INSERT INTO shares (
         id, org_id, drive_id, path, token_hash, expires_at, views,
         created_by, created_at
       ) VALUES ('share-bare', ?, ?, 'split.md', 'hash', 9999999999, 0, ?, 100)`
    ).run(orgId, driveId, userId);

    const bareOnlyChunk = raw.prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES (?, ?, 0, ?, 0, 1)"
    ).run("bare/only.md", driveId, "bare only latest").lastInsertRowid;
    const splitBareChunk = raw.prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES (?, ?, 0, ?, 0, 1)"
    ).run("split.md", driveId, "bare latest").lastInsertRowid;
    const splitCanonicalChunk = raw.prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count) VALUES (?, ?, 0, ?, 0, 1)"
    ).run("/split.md", driveId, "canonical two").lastInsertRowid;
    const vector = new Float32Array(768);
    const insertVector = raw.prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)");
    insertVector.run(bareOnlyChunk, vector);
    insertVector.run(splitBareChunk, vector);
    insertVector.run(splitCanonicalChunk, vector);

    raw.prepare("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, ?, ?)")
      .run(driveId, "bare/only.md", "bare only latest");
    raw.prepare("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, ?, ?)")
      .run(driveId, "split.md", "bare latest");
    raw.prepare("INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, ?, ?)")
      .run(driveId, "/split.md", "canonical two");
    raw.exec(
      "CREATE VIRTUAL TABLE files_fts_legacy USING fts5(path, content, drive_id UNINDEXED)"
    );
    raw.prepare("INSERT INTO files_fts_legacy(path, content, drive_id) VALUES (?, ?, ?)")
      .run("bare/only.md", "bare only latest", driveId);
    raw.prepare("INSERT INTO files_fts_legacy(path, content, drive_id) VALUES (?, ?, ?)")
      .run("split.md", "bare latest", driveId);
    raw.prepare("INSERT INTO files_fts_legacy(path, content, drive_id) VALUES (?, ?, ?)")
      .run("/split.md", "canonical two", driveId);

    raw.prepare(
      `INSERT INTO events (
         id, org_id, type, resource_type, resource_id, actor, status, metadata, created_at
       ) VALUES ('event-comment', ?, 'comment_created', 'comment', 'comment-bare', ?, 'created', ?, 200)`
    ).run(orgId, userId, JSON.stringify({ path: "split.md" }));
    raw.prepare(
      `INSERT INTO events (
         id, org_id, type, resource_type, resource_id, actor, status, metadata, created_at
       ) VALUES ('event-share', ?, 'share_viewed', 'share', 'share-bare', ?, 'created', ?, 200)`
    ).run(orgId, userId, JSON.stringify({ path: "split.md" }));

    const first = runMigrations(raw);
    const second = runMigrations(raw);

    expect(first).toEqual({
      renamedPaths: 1,
      mergedPaths: 1,
      versionsRenumbered: 3,
      commentsRemapped: 2,
      reindexPaths: 1,
    });
    expect(second).toBeNull();
    expect(takePathNormalizationMigrationReport(raw)).toEqual(first);
    expect(takePathNormalizationMigrationReport(raw)).toBeNull();

    for (const [table, column] of [
      ["files", "path"],
      ["file_versions", "path"],
      ["comments", "path"],
      ["shares", "path"],
      ["content_chunks", "file_path"],
      ["files_fts_docs", "path"],
      ["files_fts", "path"],
      ["files_fts_legacy", "path"],
    ]) {
      const row = raw
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} NOT LIKE '/%'`)
        .get() as { count: number };
      expect(row.count).toBe(0);
    }

    const mergedVersions = raw
      .prepare(
        "SELECT id, version, s3_version_id AS s3VersionId, created_at AS createdAt FROM file_versions WHERE drive_id = ? AND path = '/split.md' ORDER BY version"
      )
      .all(driveId) as Array<{
        id: number;
        version: number;
        s3VersionId: string;
        createdAt: number;
      }>;
    expect(mergedVersions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(mergedVersions.map((row) => row.s3VersionId)).toEqual(storedVersions);
    expect(mergedVersions.map((row) => row.createdAt)).toEqual([100, 100, 300, 400]);
    expect(mergedVersions[1].id).toBe(Number(bareFirst));
    expect(mergedVersions[2].id).toBe(Number(canonicalSecond));
    expect(mergedVersions[3].id).toBe(Number(bareLatest));
    expect(raw.prepare("SELECT COUNT(*) AS count FROM file_versions").get()).toEqual({
      count: 6,
    });
    expect(
      raw
        .prepare(
          "SELECT version FROM file_versions WHERE path = '/bare/only.md' ORDER BY version"
        )
        .all()
    ).toEqual([{ version: 1 }, { version: 2 }]);

    const mergedFile = db
      .select()
      .from(schema.files)
      .where(eq(schema.files.path, "/split.md"))
      .get();
    expect(mergedFile).toMatchObject({
      size: 11,
      author: "latest-author",
      currentVersionId: "4",
      embeddingStatus: "pending",
      isDeleted: false,
    });
    expect(mergedFile?.modifiedAt.getTime()).toBe(400_000);

    const comments = raw
      .prepare(
        `SELECT c.id, c.path, v.version
         FROM comments c JOIN file_versions v ON v.id = c.file_version_id
         ORDER BY c.id`
      )
      .all() as Array<{ id: string; path: string; version: number }>;
    expect(comments).toEqual([
      { id: "comment-bare", path: "/split.md", version: 2 },
      { id: "comment-canonical", path: "/split.md", version: 3 },
    ]);

    expect(raw.prepare("SELECT path FROM shares WHERE id = 'share-bare'").get()).toEqual({
      path: "/split.md",
    });
    expect(
      raw.prepare("SELECT json_extract(metadata, '$.path') AS path FROM events ORDER BY id").all()
    ).toEqual([{ path: "/split.md" }, { path: "/split.md" }]);

    expect(
      raw.prepare("SELECT file_path AS path FROM content_chunks ORDER BY id").all()
    ).toEqual([{ path: "/bare/only.md" }]);
    expect(
      raw.prepare("SELECT chunk_id AS chunkId FROM chunk_vectors ORDER BY chunk_id").all()
    ).toEqual([{ chunkId: bareOnlyChunk }]);
    expect(
      raw.prepare("SELECT path FROM files_fts_docs ORDER BY path").all()
    ).toEqual([{ path: "/bare/only.md" }]);
    expect(
      raw.prepare("SELECT path FROM files_fts_legacy ORDER BY path").all()
    ).toEqual([{ path: "/bare/only.md" }]);
    expect(getQueuedPathReindexes(raw)).toEqual([{ driveId, path: "/split.md" }]);

    const reindexed = await reindex(ctx, { path: "split.md" });
    expect(reindexed.failed).toBe(0);
    expect(
      raw.prepare("SELECT path, content FROM files_fts_docs WHERE path = '/split.md'").get()
    ).toEqual({ path: "/split.md", content: "bare latest" });

    const fileStat = await stat(ctx, { path: "/split.md" });
    expect(fileStat).toMatchObject({
      path: "/split.md",
      currentVersion: 4,
      author: "latest-author",
      size: 11,
    });
    const history = await log(ctx, { path: "/split.md" });
    expect(history.versions.map((entry) => entry.version)).toEqual([4, 3, 2, 1]);
    const changes = await diff(ctx, { path: "/split.md", v1: 1, v2: 4 });
    expect(changes.changes.some((change) => change.content.includes("canonical one"))).toBe(true);
    expect(changes.changes.some((change) => change.content.includes("bare latest"))).toBe(true);
  });
});
