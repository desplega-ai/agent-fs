import type { OpContext, WriteParams, WriteResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { indexFile } from "../search/fts.js";

export async function write(
  ctx: OpContext,
  params: WriteParams
): Promise<WriteResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);
  const content = params.content;
  const size = Buffer.byteLength(content);

  // 1. Write to S3
  const s3Result = await ctx.s3.putObject(s3Key, content);

  // 2. Create version record
  const version = await createVersion(ctx, {
    path: params.path,
    s3VersionId: s3Result.versionId ?? "",
    operation: "write",
    message: params.message,
    size,
    etag: s3Result.etag,
  });

  // FTS5 index (sync)
  indexFile(ctx.db, { path: params.path, driveId: ctx.driveId, content });

  return { version, path: params.path, size };
}
