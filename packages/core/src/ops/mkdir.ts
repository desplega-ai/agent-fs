import type { OpContext, MkdirParams, MkdirResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

export async function mkdir(
  ctx: OpContext,
  params: MkdirParams
): Promise<MkdirResult> {
  const path = normalizePrefix(params.path);
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, path);

  await ctx.s3.putObject(s3Key, "");

  return { path };
}
