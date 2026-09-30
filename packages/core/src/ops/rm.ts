import { eq, and, isNull } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { OpContext, RmParams, RmResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { removeFromIndex } from "../search/fts.js";
import { publishDriveEvent } from "../events/bus.js";
import { normalizePath } from "./paths.js";

export async function rm(
  ctx: OpContext,
  params: RmParams
): Promise<RmResult> {
  const path = normalizePath(params.path);
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, path);

  // Optimistic concurrency: assert the head version we are deleting.
  if (params.expectedVersion !== undefined) {
    await assertExpectedVersion(ctx, path, params.expectedVersion);
  }

  // 1. Delete from S3 (creates delete marker if versioning enabled)
  await ctx.s3.deleteObject(s3Key);

  // 2. Create version record
  await createVersion(ctx, {
    path,
    s3VersionId: "",
    operation: "delete",
  });

  // 3. Remove from FTS5 index
  removeFromIndex(ctx.db, { path, driveId: ctx.driveId });

  // 4. Remove chunks + vectors
  const oldChunks = ctx.db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, path),
        eq(schema.contentChunks.driveId, ctx.driveId)
      )
    )
    .all();

  if (oldChunks.length > 0) {
    const raw = (ctx.db as any).$client as Database;
    for (const chunk of oldChunks) {
      raw.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?").run(chunk.id);
    }

    ctx.db
      .delete(schema.contentChunks)
      .where(
        and(
          eq(schema.contentChunks.filePath, path),
          eq(schema.contentChunks.driveId, ctx.driveId)
        )
      )
      .run();
  }

  // 5. Soft-delete comments on this file
  const deletedComments = ctx.db
    .select({ id: schema.comments.id, path: schema.comments.path })
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.path, path),
        eq(schema.comments.driveId, ctx.driveId),
        isNull(schema.comments.parentId),
        eq(schema.comments.isDeleted, false)
      )
    )
    .all();
  const now = new Date();
  ctx.db
    .update(schema.comments)
    .set({ isDeleted: true, updatedAt: now })
    .where(
      and(
        eq(schema.comments.path, path),
        eq(schema.comments.driveId, ctx.driveId)
      )
    )
    .run();

  for (const comment of deletedComments) {
    publishDriveEvent({
      type: "comment.changed",
      driveId: ctx.driveId,
      path: comment.path,
      commentId: comment.id,
      parentId: null,
      action: "deleted",
      actor: ctx.userId,
      at: now.toISOString(),
    });
  }

  return { path, deleted: true };
}
