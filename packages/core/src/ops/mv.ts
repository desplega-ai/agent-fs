import type { OpContext, MvParams, MvResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";

export async function mv(
  ctx: OpContext,
  params: MvParams
): Promise<MvResult> {
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, params.from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, params.to);

  // 1. Copy to new location
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);

  // 2. Get size from head
  const head = await ctx.s3.headObject(toKey);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: params.to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: params.message ?? `Moved from ${params.from}`,
    size: head.size,
    etag: copyResult.etag,
  });

  // 4. Delete original
  await ctx.s3.deleteObject(fromKey);

  // 5. Mark old path as deleted
  await createVersion(ctx, {
    path: params.from,
    s3VersionId: "",
    operation: "delete",
    message: `Moved to ${params.to}`,
  });

  return { from: params.from, to: params.to, version };
}
