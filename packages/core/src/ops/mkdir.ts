import type { OpContext, MkdirParams, MkdirResult } from "./types.js";
import { getS3Key } from "./versioning.js";

export async function mkdir(
  ctx: OpContext,
  params: MkdirParams
): Promise<MkdirResult> {
  // S3 prefix convention: trailing slash = directory marker
  const path = params.path.endsWith("/") ? params.path : params.path + "/";
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, path);

  await ctx.s3.putObject(s3Key, "");

  return { path };
}
