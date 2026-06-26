import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { buildAppUrl } from "./urls.js";
import { normalizePath } from "./paths.js";
import { NotFoundError, UnsupportedOperation } from "../errors.js";
import { detectMimeType } from "./mime.js";

export interface SignedUrlParams {
  path: string;
  expiresIn?: number;
}

export interface SignedUrlResult {
  url: string;
  path: string;
  expiresIn: number;
  /** ISO expiry for a `presigned` URL; empty for a non-expiring `app` link. */
  expiresAt: string;
  /**
   * `"presigned"` — a native, time-limited download URL (public, no auth).
   * `"app"` — an authenticated in-app link (the daemon `/raw` route + viewer
   * require sign-in) for backends without presigned URLs. It does not expire.
   */
  kind: "presigned" | "app";
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

  // Capability gate: backends that can't mint native presigned URLs (e.g. the
  // local-FS adapter) fall back to the daemon app URL instead of hard-failing.
  // NOTE: the daemon `GET …/raw` route and the `/file/~/…` viewer are auth-gated
  // (see server `routes/files.ts` + `authMiddleware`), so this is an
  // *authenticated in-app link* (requires sign-in), NOT a public/presigned URL.
  if (!ctx.s3.capabilities.presignedUrls) {
    if (!ctx.appUrl) {
      throw new UnsupportedOperation("signed-url", undefined, {
        suggestion:
          "This storage backend cannot mint presigned URLs and no app URL is configured to fall back to.",
      });
    }
    return {
      url: buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, normalizedPath),
      path: normalizedPath,
      expiresIn: 0,
      expiresAt: "",
      kind: "app",
    };
  }

  const contentType = detectMimeType(normalizedPath);
  const url = await ctx.s3.getPresignedUrl(
    key,
    expiresIn,
    contentType !== "application/octet-stream" ? contentType : undefined,
  );

  return {
    url,
    path: normalizedPath,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    kind: "presigned",
  };
}
