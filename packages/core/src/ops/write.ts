import { createHash } from "node:crypto";
import type { OpContext, WriteParams, WriteResult } from "./types.js";
import {
  getS3Key,
  assertExpectedVersion,
  getHeadContentHash,
  createVersion,
} from "./versioning.js";
import { detectMimeType } from "./mime.js";
import { indexFile } from "../search/fts.js";
import { scheduleEmbedding } from "../search/pipeline.js";
import { ValidationError } from "../errors.js";

/** Max file size: 10 MB. Protects SQLite FTS indexing and embedding costs. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Max file size for the binary `writeRaw` path (matches Hono body limit). */
const MAX_RAW_FILE_SIZE = 50 * 1024 * 1024;

export async function write(
  ctx: OpContext,
  params: WriteParams
): Promise<WriteResult> {
  return writeInternal(ctx, params, { maxSize: MAX_FILE_SIZE });
}

/**
 * Internal binary write path used by `PUT /raw`. Accepts up to 50 MB
 * (Hono's body limit) instead of the JSON-path 10 MB cap. Otherwise
 * identical to `write` — same RBAC, same versioning, same FTS5/embedding
 * side effects, same dedup short-circuit.
 *
 * Content is a UTF-8 string in v1 (the binary route already decodes the
 * body before calling this); native binary storage stays out of scope.
 */
export async function writeRaw(
  ctx: OpContext,
  params: WriteParams
): Promise<WriteResult> {
  return writeInternal(ctx, params, { maxSize: MAX_RAW_FILE_SIZE });
}

async function writeInternal(
  ctx: OpContext,
  params: WriteParams,
  opts: { maxSize: number }
): Promise<WriteResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);
  const content = params.content;
  const size = Buffer.byteLength(content);

  // Content size limit — applies to all paths (HTTP, MCP, embedded)
  if (size > opts.maxSize) {
    const limitMb = (opts.maxSize / 1024 / 1024).toFixed(0);
    throw new ValidationError(
      `File size ${(size / 1024 / 1024).toFixed(1)}MB exceeds the ${limitMb}MB limit`,
      { field: "content", suggestion: "Split large files into smaller chunks" }
    );
  }

  // Compute SHA-256 once. Used for both dedup short-circuit and the
  // persisted content_hash on the version row.
  const contentHash = createHash("sha256")
    .update(content)
    .digest("hex");

  // Optimistic concurrency check — and dedup short-circuit.
  if (params.expectedVersion !== undefined) {
    const currentVersion = await assertExpectedVersion(
      ctx,
      params.path,
      params.expectedVersion
    );

    // Dedup short-circuit: hash matches head AND expectedVersion matches.
    // No S3 PUT, no createVersion, no FTS5/embedding work, no mtime bump.
    // The server is the source of truth for hash, so this safely handles
    // FUSE-driven `touch`/idempotent-rewrite traffic.
    if (currentVersion > 0) {
      const headHash = await getHeadContentHash(ctx, params.path);
      if (headHash !== null && headHash === contentHash) {
        return {
          version: currentVersion,
          path: params.path,
          size,
          contentHash,
          deduped: true,
        };
      }
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
    contentHash,
  });

  // FTS5 index (sync)
  indexFile(ctx.db, { path: params.path, driveId: ctx.driveId, content });

  // Embedding index (async, fire-and-forget)
  scheduleEmbedding(ctx.db, ctx.embeddingProvider ?? null, {
    path: params.path,
    driveId: ctx.driveId,
    content,
  });

  return { version, path: params.path, size, contentHash, deduped: false };
}
