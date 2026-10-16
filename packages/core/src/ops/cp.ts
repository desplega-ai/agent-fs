import { createHash } from "node:crypto";
import type { OpContext, CpParams, CpResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { detectMimeType } from "./mime.js";
import { indexBytesForSearch } from "./search-index.js";
import { invalidateDriveGlobListings } from "./glob-cache.js";
import { normalizePath } from "./paths.js";
import { ValidationError } from "../errors.js";

export async function cp(
  ctx: OpContext,
  params: CpParams
): Promise<CpResult> {
  const from = normalizePath(params.from);
  const to = normalizePath(params.to);
  if (from === to) {
    throw new ValidationError("Source and destination are the same path");
  }
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, to);

  // Optimistic concurrency: caller asserts the head of the *destination*.
  // Pass `expectedVersion: 0` for "must not exist".
  if (params.expectedVersion !== undefined) {
    await assertExpectedVersion(ctx, to, params.expectedVersion);
  }

  // 1. Copy in S3
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);
  invalidateDriveGlobListings(ctx.orgId, ctx.driveId);

  // 2. Get size
  const head = await ctx.s3.headObject(toKey);

  // Fetch destination bytes once for both content hash + FTS5 indexing.
  const obj = await ctx.s3.getObject(toKey);
  const contentHash = createHash("sha256").update(obj.body).digest("hex");
  const contentType = head.contentType ?? obj.contentType ?? detectMimeType(to);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: `Copied from ${from}`,
    size: head.size,
    etag: copyResult.etag,
    contentType,
    contentHash,
  });

  indexBytesForSearch(ctx, to, obj.body, contentType);

  return { from, to, version };
}
