import { eq, and } from "drizzle-orm";
import type { OpContext, MvParams, MvResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { indexFile, removeFromIndex } from "../search/fts.js";
import { schema } from "../db/index.js";

export async function mv(
  ctx: OpContext,
  params: MvParams
): Promise<MvResult> {
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, params.from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, params.to);

  // 1. Copy to new location
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);

  // 2. Get size from head
  const head = await ctx.s3.headObject(toKey);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: params.to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: params.message ?? `Moved from ${params.from}`,
    size: head.size,
    etag: copyResult.etag,
  });

  // 4. Delete original
  await ctx.s3.deleteObject(fromKey);

  // 5. Mark old path as deleted
  await createVersion(ctx, {
    path: params.from,
    s3VersionId: "",
    operation: "delete",
    message: `Moved to ${params.to}`,
  });

  // Update search indexes: FTS5 and content_chunks
  // No re-embedding needed since content didn't change
  const obj = await ctx.s3.getObject(toKey);
  const content = new TextDecoder().decode(obj.body);

  removeFromIndex(ctx.db, { path: params.from, driveId: ctx.driveId });
  indexFile(ctx.db, { path: params.to, driveId: ctx.driveId, content });

  // Update chunk paths in-place (vectors stay the same)
  ctx.db
    .update(schema.contentChunks)
    .set({ filePath: params.to })
    .where(
      and(
        eq(schema.contentChunks.filePath, params.from),
        eq(schema.contentChunks.driveId, ctx.driveId)
      )
    )
    .run();

  return { from: params.from, to: params.to, version };
}
