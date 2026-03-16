import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { OpContext, RmParams, RmResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { removeFromIndex } from "../search/fts.js";

export async function rm(
  ctx: OpContext,
  params: RmParams
): Promise<RmResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

  // 1. Delete from S3 (creates delete marker if versioning enabled)
  await ctx.s3.deleteObject(s3Key);

  // 2. Create version record
  await createVersion(ctx, {
    path: params.path,
    s3VersionId: "",
    operation: "delete",
  });

  // 3. Remove from FTS5 index
  removeFromIndex(ctx.db, { path: params.path, driveId: ctx.driveId });

  // 4. Remove chunks + vectors
  const oldChunks = ctx.db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, params.path),
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
          eq(schema.contentChunks.filePath, params.path),
          eq(schema.contentChunks.driveId, ctx.driveId)
        )
      )
      .run();
  }

  // 5. Soft-delete comments on this file
  ctx.db
    .update(schema.comments)
    .set({ isDeleted: true, updatedAt: new Date() })
    .where(
      and(
        eq(schema.comments.path, params.path),
        eq(schema.comments.driveId, ctx.driveId)
      )
    )
    .run();

  return { path: params.path, deleted: true };
}
