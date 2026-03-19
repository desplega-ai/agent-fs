import type { OpContext, AppendParams, AppendResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { NotFoundError } from "../errors.js";
import { detectMimeType } from "./mime.js";
import { indexFile } from "../search/fts.js";
import { scheduleEmbedding } from "../search/pipeline.js";

export async function append(
  ctx: OpContext,
  params: AppendParams
): Promise<AppendResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

  // 1. Get current content
  let currentContent = "";
  try {
    const result = await ctx.s3.getObject(s3Key);
    currentContent = new TextDecoder().decode(result.body);
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${params.path}`, {
        path: params.path,
      });
    }
    throw err;
  }

  // 2. Append and write back
  const newContent = currentContent + params.content;
  const size = Buffer.byteLength(newContent);
  const contentType = detectMimeType(params.path);

  const s3Result = await ctx.s3.putObject(s3Key, newContent, undefined, contentType);

  // 3. Create version
  const version = await createVersion(ctx, {
    path: params.path,
    s3VersionId: s3Result.versionId ?? "",
    operation: "append",
    message: params.message,
    size,
    etag: s3Result.etag,
    contentType,
  });

  // FTS5 index (sync)
  indexFile(ctx.db, { path: params.path, driveId: ctx.driveId, content: newContent });

  // Embedding index (async)
  scheduleEmbedding(ctx.db, ctx.embeddingProvider ?? null, {
    path: params.path,
    driveId: ctx.driveId,
    content: newContent,
  });

  return { version, size };
}
