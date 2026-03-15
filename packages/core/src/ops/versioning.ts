import { eq, and, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";

/**
 * Compute the S3 object key for a file.
 * Format: <orgId>/drives/<driveId>/<path>
 */
export function getS3Key(orgId: string, driveId: string, path: string): string {
  // Normalize: strip leading slash from path
  const normalized = path.startsWith("/") ? path.slice(1) : path;
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
 * Create a version record and update file metadata.
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
  }
): Promise<number> {
  const version = await getNextVersion(ctx, params.path);
  const now = new Date();

  // Insert version record
  ctx.db.insert(schema.fileVersions).values({
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
    createdAt: now,
  }).run();

  // Upsert file metadata
  const existing = ctx.db
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
    ctx.db
      .update(schema.files)
      .set({
        size: params.size ?? existing.size,
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
    ctx.db.insert(schema.files).values({
      path: params.path,
      driveId: ctx.driveId,
      size: params.size ?? 0,
      author: ctx.userId,
      currentVersionId: String(version),
      createdAt: now,
      modifiedAt: now,
      isDeleted: params.operation === "delete",
    }).run();
  }

  return version;
}
