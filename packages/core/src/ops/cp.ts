import type { OpContext, CpParams, CpResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { indexFile } from "../search/fts.js";
import { scheduleEmbedding } from "../search/pipeline.js";

export async function cp(
  ctx: OpContext,
  params: CpParams
): Promise<CpResult> {
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, params.from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, params.to);

  // 1. Copy in S3
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);

  // 2. Get size
  const head = await ctx.s3.headObject(toKey);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: params.to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: `Copied from ${params.from}`,
    size: head.size,
    etag: copyResult.etag,
  });

  // Index the copied file for search
  const obj = await ctx.s3.getObject(toKey);
  const content = new TextDecoder().decode(obj.body);

  // FTS5 index (sync)
  indexFile(ctx.db, { path: params.to, driveId: ctx.driveId, content });

  // Embedding index (async, fire-and-forget)
  scheduleEmbedding(ctx.db, ctx.embeddingProvider ?? null, {
    path: params.to,
    driveId: ctx.driveId,
    content,
  });

  return { from: params.from, to: params.to, version };
}
