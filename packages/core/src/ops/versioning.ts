import { eq, and, sql, desc } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { stripLeadingSlash } from "./paths.js";
import { EditConflictError } from "../errors.js";

/**
 * Compute the S3 object key for a file.
 * Format: <orgId>/drives/<driveId>/<path>
 */
export function getS3Key(orgId: string, driveId: string, path: string): string {
  const normalized = stripLeadingSlash(path);
  return `${orgId}/drives/${driveId}/${normalized}`;
}

/**
 * Get the next version number for a file (monotonically increasing).
 */
export async function getNextVersion(
  ctx: OpContext,
  path: string
): Promise<number> {
  const result = ctx.db
    .select({ maxVersion: sql<number>`MAX(version)` })
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, path),
        eq(schema.fileVersions.driveId, ctx.driveId)
      )
    )
    .get();

  return (result?.maxVersion ?? 0) + 1;
}

/**
 * Look up the head version row for a (path, drive) pair. Returns the
 * version number, content hash, etag, and createdAt — the exact fields
 * the `GET /raw` HTTP handler needs to emit ETag/Last-Modified/version
 * headers without forcing the route to import drizzle directly.
 *
 * Returns `null` if no versions exist yet for that file.
 */
export interface HeadVersionRow {
  version: number;
  contentHash: string | null;
  etag: string | null;
  createdAt: Date;
}

export function getHeadVersionRow(
  ctx: Pick<OpContext, "db" | "driveId">,
  path: string
): HeadVersionRow | null {
  const row = ctx.db
    .select({
      version: schema.fileVersions.version,
      contentHash: schema.fileVersions.contentHash,
      etag: schema.fileVersions.etag,
      createdAt: schema.fileVersions.createdAt,
    })
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, path),
        eq(schema.fileVersions.driveId, ctx.driveId)
      )
    )
    .orderBy(desc(schema.fileVersions.version))
    .limit(1)
    .get();

  if (!row) return null;
  return {
    version: row.version,
    contentHash: row.contentHash ?? null,
    etag: row.etag ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Pre-flight optimistic-concurrency check, shared across mutating ops.
 *
 * Returns the current head version (next - 1). If `expectedVersion` is
 * passed and doesn't match the current head, throws `EditConflictError`.
 *
 * `expectedVersion: 0` means "the file must not exist yet" (head version
 * is treated as 0 for non-existent files since `MAX(version)` is NULL).
 */
export async function assertExpectedVersion(
  ctx: OpContext,
  path: string,
  expectedVersion: number | undefined
): Promise<number> {
  const nextVersion = await getNextVersion(ctx, path);
  const currentVersion = nextVersion - 1;
  if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
    throw new EditConflictError(
      `Expected version ${expectedVersion} but file is at version ${currentVersion}`,
      {
        path,
        suggestion: "Re-read the file to get the current version and retry",
      }
    );
  }
  return currentVersion;
}

/**
 * Return the `content_hash` of the current head version for a file, or
 * null if the file has no versions or the head row was written before
 * the column existed.
 *
 * Used by `write` (and any future op) to short-circuit identical-content
 * writes — no S3 PUT, no version row, no FTS5/embedding work.
 */
export async function getHeadContentHash(
  ctx: OpContext,
  path: string
): Promise<string | null> {
  const result = ctx.db
    .select({ contentHash: schema.fileVersions.contentHash })
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, path),
        eq(schema.fileVersions.driveId, ctx.driveId)
      )
    )
    .orderBy(desc(schema.fileVersions.version))
    .limit(1)
    .get();

  return result?.contentHash ?? null;
}

/**
 * Create a version record and update file metadata.
 *
 * The version-row insert + files-row upsert run inside a single SQLite
 * transaction so the unique-index conflict (path, drive_id, version)
 * becomes a single atomic failure surface — closing the TOCTOU window
 * left open by the two separate `getNextVersion()` calls in callers
 * like `write.ts`.
 *
 * A `SQLITE_CONSTRAINT_UNIQUE` violation on `file_versions` is mapped
 * to `EditConflictError` so concurrent writers see the same conflict
 * shape that the app-layer `expectedVersion` check produces.
 */
export async function createVersion(
  ctx: OpContext,
  params: {
    path: string;
    s3VersionId: string;
    operation: "write" | "edit" | "append" | "delete" | "revert";
    message?: string;
    diffSummary?: string;
    size?: number;
    etag?: string;
    contentType?: string;
    contentHash?: string;
  }
): Promise<number> {
  const version = await getNextVersion(ctx, params.path);
  const now = new Date();

  // Wrap the version insert + files upsert in a single SQLite transaction.
  // drizzle's bun-sqlite `transaction` is sync — all queries inside are sync too.
  try {
    ctx.db.transaction((tx) => {
      // Insert version record
      tx.insert(schema.fileVersions)
        .values({
          path: params.path,
          driveId: ctx.driveId,
          version,
          s3VersionId: params.s3VersionId,
          author: ctx.userId,
          operation: params.operation,
          message: params.message ?? null,
          diffSummary: params.diffSummary ?? null,
          size: params.size ?? null,
          etag: params.etag ?? null,
          contentHash: params.contentHash ?? null,
          createdAt: now,
        })
        .run();

      // Upsert file metadata
      const existing = tx
        .select()
        .from(schema.files)
        .where(
          and(
            eq(schema.files.path, params.path),
            eq(schema.files.driveId, ctx.driveId)
          )
        )
        .get();

      if (existing) {
        tx.update(schema.files)
          .set({
            size: params.size ?? existing.size,
            contentType: params.contentType ?? existing.contentType,
            author: ctx.userId,
            currentVersionId: String(version),
            modifiedAt: now,
            isDeleted: params.operation === "delete",
          })
          .where(
            and(
              eq(schema.files.path, params.path),
              eq(schema.files.driveId, ctx.driveId)
            )
          )
          .run();
      } else {
        tx.insert(schema.files)
          .values({
            path: params.path,
            driveId: ctx.driveId,
            size: params.size ?? 0,
            contentType: params.contentType ?? null,
            author: ctx.userId,
            currentVersionId: String(version),
            createdAt: now,
            modifiedAt: now,
            isDeleted: params.operation === "delete",
          })
          .run();
      }
    });
  } catch (err: any) {
    // Map SQLite UNIQUE(path, drive_id, version) failures from concurrent
    // writers to EditConflictError. Both bun:sqlite (SQLiteError) and the
    // underlying libsqlite surface the constraint name in the message.
    const msg = String(err?.message ?? "");
    if (
      msg.includes("UNIQUE constraint failed") &&
      msg.includes("file_versions")
    ) {
      throw new EditConflictError(
        `Concurrent write detected for ${params.path}: version ${version} already exists`,
        {
          path: params.path,
          suggestion:
            "Re-read the file to get the current version and retry the write",
        }
      );
    }
    throw err;
  }

  return version;
}
