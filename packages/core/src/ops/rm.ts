import type { OpContext, RmParams, RmResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";

export async function rm(
  ctx: OpContext,
  params: RmParams
): Promise<RmResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

  // 1. Delete from S3 (creates delete marker if versioning enabled)
  await ctx.s3.deleteObject(s3Key);

  // 2. Create version record
  await createVersion(ctx, {
    path: params.path,
    s3VersionId: "",
    operation: "delete",
  });

  return { path: params.path, deleted: true };
}
