import { createHash } from "node:crypto";
import type { OpContext, CpParams, CpResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { copiedMimeType } from "./mime.js";
import { indexBytesForSearch } from "./search-index.js";
import { invalidateDriveGlobListings } from "./glob-cache.js";
import { normalizePath } from "./paths.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { withPathLock } from "./path-lock.js";

export async function cp(
  ctx: OpContext,
  params: CpParams
): Promise<CpResult> {
  const from = normalizePath(params.from);
  const to = normalizePath(params.to);
  if (from === to) {
    throw new ValidationError("Source and destination are the same path");
  }
  return withPathLock(ctx.driveId, [from, to], async () => {
    const fromKey = getS3Key(ctx.orgId, ctx.driveId, from);
    const toKey = getS3Key(ctx.orgId, ctx.driveId, to);

    // Optimistic concurrency: caller asserts the head of the *destination*.
    // Pass `expectedVersion: 0` for "must not exist".
    if (params.expectedVersion !== undefined) {
      await assertExpectedVersion(ctx, to, params.expectedVersion);
    }

    // 1. Copy in S3
    let head;
    try {
      head = await ctx.s3.headObject(fromKey);
    } catch (err: any) {
      if (
        err?.name === "NotFound" ||
        err?.name === "NoSuchKey" ||
        err?.$metadata?.httpStatusCode === 404
      ) {
        throw new NotFoundError(`File not found: ${from}`, { path: from });
      }
      throw err;
    }
    const contentType = copiedMimeType(head.contentType, to);
    const copyResult = await ctx.s3.copyObject(
      fromKey,
      toKey,
      contentType === head.contentType ? undefined : contentType,
    );
    invalidateDriveGlobListings(ctx.orgId, ctx.driveId);

    // Fetch destination bytes once for both content hash + FTS5 indexing.
    const obj = await ctx.s3.getObject(toKey);
    const contentHash = createHash("sha256").update(obj.body).digest("hex");

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

    await indexBytesForSearch(ctx, to, obj.body, contentType);

    return { from, to, version };
  });
}
