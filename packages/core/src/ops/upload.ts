import { and, eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, WriteResult } from "./types.js";
import { getS3Key, assertExpectedVersion, assertDriveBudget, createVersion } from "./versioning.js";
import { normalizePath } from "./paths.js";
import { detectMimeType } from "./mime.js";
import { withPathLock } from "./path-lock.js";
import { withStorageIntent } from "./storage-intent.js";
import { clearSearchData, indexBytesForSearch } from "./search-index.js";
import { getMaxUploadBytes } from "../config.js";
import { NotFoundError, PermissionDeniedError, UnsupportedOperation, ValidationError } from "../errors.js";
import { supportsMultipartUpload } from "../storage/adapter.js";
import type { MultipartUploadAdapter, StorageAdapter } from "../storage/adapter.js";

/**
 * Large uploads: the client PUTs parts straight to storage through presigned
 * URLs, so no byte passes through this server. upload-start records the upload
 * id with its org, drive, path and the user who started it (multipart_uploads);
 * the other three ops accept the id only from that user at that path.
 * The object appears at its key only in `upload-finish`, under the path lock,
 * so versioning, conditional writes and the storage budget work as in `write`.
 */

/** shortcut: fixed 5 GiB per-file ceiling, make it an env setting if someone needs more. */
export const MAX_MULTIPART_UPLOAD_BYTES = 5 * 1024 ** 3;
/** S3 parts are 5 MiB minimum (except the last) and 10,000 at most. */
const MIN_PART_SIZE = 32 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** Part URLs live 15 minutes; clients ask for a fresh one per attempt. */
export const PART_URL_EXPIRES_IN = 900;

function adapter(ctx: OpContext, op: string): StorageAdapter & MultipartUploadAdapter {
  if (!supportsMultipartUpload(ctx.s3)) {
    throw new UnsupportedOperation(op, undefined, {
      suggestion: "This storage backend has no presigned uploads; use write (PUT /raw) up to the server upload limit",
    });
  }
  return ctx.s3;
}

/** The caller's own upload at `path`, or NOT_FOUND / PERMISSION_DENIED. */
function assertOwnUpload(ctx: OpContext, path: string, uploadId: string): void {
  const t = schema.multipartUploads;
  const row = ctx.db
    .select({ userId: t.userId })
    .from(t)
    .where(and(eq(t.orgId, ctx.orgId), eq(t.driveId, ctx.driveId), eq(t.path, path), eq(t.uploadId, uploadId)))
    .get();
  if (!row) {
    throw new NotFoundError(`No upload ${uploadId} in progress at ${path}`, {
      path,
      suggestion: "It was finished, aborted or started for another path or drive; start a new one with upload-start",
    });
  }
  if (row.userId !== ctx.userId) {
    throw new PermissionDeniedError("Only the user who started this upload can sign, finish or abort it", {
      suggestion: "Start your own upload with upload-start",
    });
  }
}

function forgetUpload(ctx: OpContext, path: string, uploadId: string): void {
  const t = schema.multipartUploads;
  ctx.db
    .delete(t)
    .where(and(eq(t.orgId, ctx.orgId), eq(t.driveId, ctx.driveId), eq(t.path, path), eq(t.uploadId, uploadId)))
    .run();
}

function assertSize(size: number): void {
  if (size > MAX_MULTIPART_UPLOAD_BYTES) {
    throw new ValidationError(`File size ${size} bytes exceeds the ${MAX_MULTIPART_UPLOAD_BYTES} byte upload limit`, { field: "size" });
  }
}

export async function uploadStart(ctx: OpContext, params: { path: string; size: number }) {
  const s3 = adapter(ctx, "upload-start");
  const path = normalizePath(params.path);
  assertSize(params.size);
  // Fail before the client sends gigabytes; upload-finish checks again with the real size.
  assertDriveBudget(ctx, params.size, [path]);
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(params.size / MAX_PARTS / 1024 ** 2) * 1024 ** 2);
  const uploadId = await s3.createMultipartUpload(getS3Key(ctx.orgId, ctx.driveId, path), detectMimeType(path));
  ctx.db
    .insert(schema.multipartUploads)
    .values({ orgId: ctx.orgId, driveId: ctx.driveId, path, uploadId, userId: ctx.userId, createdAt: new Date() })
    .run();
  return {
    uploadId,
    path,
    size: params.size,
    partSize,
    partCount: Math.max(1, Math.ceil(params.size / partSize)),
    partUrlExpiresIn: PART_URL_EXPIRES_IN,
  };
}

export async function uploadPartUrl(ctx: OpContext, params: { path: string; uploadId: string; partNumber: number }) {
  const s3 = adapter(ctx, "upload-part-url");
  const path = normalizePath(params.path);
  assertOwnUpload(ctx, path, params.uploadId);
  const url = await s3.getPresignedUploadPartUrl(getS3Key(ctx.orgId, ctx.driveId, path), params.uploadId, params.partNumber, PART_URL_EXPIRES_IN);
  return {
    url,
    method: "PUT",
    partNumber: params.partNumber,
    expiresIn: PART_URL_EXPIRES_IN,
    expiresAt: new Date(Date.now() + PART_URL_EXPIRES_IN * 1000).toISOString(),
  };
}

export async function uploadAbort(ctx: OpContext, params: { path: string; uploadId: string }) {
  const s3 = adapter(ctx, "upload-abort");
  const path = normalizePath(params.path);
  // Under the path lock, so an abort sent while upload-finish runs (say, after a
  // client timeout) waits for it, then finds the upload gone: committed data stays.
  return withPathLock(ctx.driveId, [path], async () => {
    assertOwnUpload(ctx, path, params.uploadId);
    await s3.abortMultipartUpload(getS3Key(ctx.orgId, ctx.driveId, path), params.uploadId);
    forgetUpload(ctx, path, params.uploadId);
    return { aborted: true, path, uploadId: params.uploadId };
  });
}

export async function uploadFinish(
  ctx: OpContext,
  params: { path: string; uploadId: string; size: number; message?: string; expectedVersion?: number }
): Promise<WriteResult> {
  const s3 = adapter(ctx, "upload-finish");
  const path = normalizePath(params.path);
  const key = getS3Key(ctx.orgId, ctx.driveId, path);
  assertSize(params.size);
  assertOwnUpload(ctx, path, params.uploadId);

  // Storage owns the part list; the client only states the size it sent.
  const parts = await s3.listUploadedParts(key, params.uploadId);
  const missing = parts.findIndex((p, i) => p.partNumber !== i + 1);
  if (parts.length === 0 || missing !== -1) {
    throw new ValidationError(
      parts.length === 0 ? "No parts were uploaded" : `Part ${missing + 1} is missing; upload it and call upload-finish again`,
      { field: "uploadId" }
    );
  }
  const size = parts.reduce((n, p) => n + p.size, 0);
  if (size !== params.size) {
    throw new ValidationError(`Uploaded parts hold ${size} bytes, expected ${params.size}`, { field: "size" });
  }

  return withPathLock(ctx.driveId, [path], async () => {
    // Again under the lock: an abort may have run while the parts were listed.
    assertOwnUpload(ctx, path, params.uploadId);
    if (params.expectedVersion !== undefined) {
      await assertExpectedVersion(ctx, path, params.expectedVersion);
    }
    assertDriveBudget(ctx, size, [path]);

    return withStorageIntent(ctx, [{ path, op: "write", message: params.message }], async () => {
      const result = await s3.completeMultipartUpload(key, params.uploadId, parts);
      forgetUpload(ctx, path, params.uploadId);
      const contentHash = await s3.hashObject(key, result.versionId);
      const contentType = detectMimeType(path);
      const version = await createVersion(ctx, {
        path,
        s3VersionId: result.versionId ?? "",
        operation: "write",
        message: params.message,
        size,
        etag: result.etag,
        contentType,
        contentHash,
      });
      // Files under the raw cap are indexed like a raw write; bigger ones (video,
      // archives) are not read back into memory and drop the old version's index.
      if (size <= getMaxUploadBytes()) {
        const { body } = await s3.getObject(key, result.versionId);
        await indexBytesForSearch(ctx, path, body, contentType);
      } else {
        clearSearchData(ctx, path, "all");
      }
      return { version, path, size, contentHash, deduped: false };
    });
  });
}
