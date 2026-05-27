import { createHash } from "node:crypto";
import type { OpContext, CpParams, CpResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { detectMimeType } from "./mime.js";
import { indexBytesForSearch } from "./search-index.js";

export async function cp(
  ctx: OpContext,
  params: CpParams
): Promise<CpResult> {
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, params.from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, params.to);

  // Optimistic concurrency: caller asserts the head of the *destination*.
  // Pass `expectedVersion: 0` for "must not exist".
  if (params.expectedVersion !== undefined) {
    await assertExpectedVersion(ctx, params.to, params.expectedVersion);
  }

  // 1. Copy in S3
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);

  // 2. Get size
  const head = await ctx.s3.headObject(toKey);

  // Fetch destination bytes once for both content hash + FTS5 indexing.
  const obj = await ctx.s3.getObject(toKey);
  const contentHash = createHash("sha256").update(obj.body).digest("hex");
  const contentType = head.contentType ?? obj.contentType ?? detectMimeType(params.to);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: params.to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: `Copied from ${params.from}`,
    size: head.size,
    etag: copyResult.etag,
    contentType,
    contentHash,
  });

  indexBytesForSearch(ctx, params.to, obj.body, contentType);

  return { from: params.from, to: params.to, version };
}
