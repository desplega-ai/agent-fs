import type { OpContext, CpParams, CpResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";

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

  return { from: params.from, to: params.to, version };
}
