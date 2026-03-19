import type { OpContext, WriteParams, WriteResult } from "./types.js";
import { getS3Key, getNextVersion } from "./versioning.js";
import { createVersion } from "./versioning.js";
import { detectMimeType } from "./mime.js";
import { indexFile } from "../search/fts.js";
import { scheduleEmbedding } from "../search/pipeline.js";
import { EditConflictError, ValidationError } from "../errors.js";

/** Max file size: 10 MB. Protects SQLite FTS indexing and embedding costs. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function write(
  ctx: OpContext,
  params: WriteParams
): Promise<WriteResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);
  const content = params.content;
  const size = Buffer.byteLength(content);

  // Content size limit — applies to all paths (HTTP, MCP, embedded)
  if (size > MAX_FILE_SIZE) {
    throw new ValidationError(
      `File size ${(size / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit`,
      { field: "content", suggestion: "Split large files into smaller chunks" }
    );
  }

  // Optimistic concurrency check
  if (params.expectedVersion !== undefined) {
    const nextVersion = await getNextVersion(ctx, params.path);
    const currentVersion = nextVersion - 1;
    if (currentVersion !== params.expectedVersion) {
      throw new EditConflictError(
        `Expected version ${params.expectedVersion} but file is at version ${currentVersion}`,
        {
          path: params.path,
          suggestion: "Re-read the file to get the current version and retry",
        }
      );
    }
  }

  // 1. Write to S3
  const contentType = detectMimeType(params.path);
  const s3Result = await ctx.s3.putObject(s3Key, content, undefined, contentType);

  // 2. Create version record
  const version = await createVersion(ctx, {
    path: params.path,
    s3VersionId: s3Result.versionId ?? "",
    operation: "write",
    message: params.message,
    size,
    etag: s3Result.etag,
    contentType,
  });

  // FTS5 index (sync)
  indexFile(ctx.db, { path: params.path, driveId: ctx.driveId, content });

  // Embedding index (async, fire-and-forget)
  scheduleEmbedding(ctx.db, ctx.embeddingProvider ?? null, {
    path: params.path,
    driveId: ctx.driveId,
    content,
  });

  return { version, path: params.path, size };
}
