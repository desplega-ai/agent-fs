import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePath } from "./paths.js";
import { NotFoundError } from "../errors.js";

export interface SignedUrlParams {
  path: string;
  expiresIn?: number;
}

export interface SignedUrlResult {
  url: string;
  path: string;
  expiresIn: number;
  expiresAt: string;
}

export async function signedUrl(
  ctx: OpContext,
  params: SignedUrlParams
): Promise<SignedUrlResult> {
  const normalizedPath = normalizePath(params.path);
  const key = getS3Key(ctx.orgId, ctx.driveId, normalizedPath);
  const expiresIn = params.expiresIn ?? 86400;

  // Verify file exists
  try {
    await ctx.s3.headObject(key);
  } catch (err: any) {
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${normalizedPath}`, {
        path: normalizedPath,
      });
    }
    throw err;
  }

  const url = await ctx.s3.getPresignedUrl(key, expiresIn);

  return {
    url,
    path: normalizedPath,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}
