import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, StatParams, StatResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";
import { normalizePath } from "./paths.js";

export async function stat(
  ctx: OpContext,
  params: StatParams
): Promise<StatResult> {
  const path = normalizePath(params.path);
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, path);

  // Check S3
  let s3Head;
  try {
    s3Head = await ctx.s3.headObject(s3Key);
  } catch (err: any) {
    // S3 `headObject` misses surface as `NotFound`; the local-FS adapter
    // translates misses to the `NoSuchKey` shape every other op branches on
    // (cat/append/edit/tail/signed-url). Handle both so a missing file is a
    // clean NOT_FOUND on every backend rather than a raw 500.
    if (
      err?.name === "NotFound" ||
      err?.name === "NoSuchKey" ||
      err?.$metadata?.httpStatusCode === 404
    ) {
      throw new NotFoundError(`File not found: ${path}`, {
        path,
      });
    }
    throw err;
  }

  // Get SQLite metadata
  const dbFile = ctx.db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.path, path),
        eq(schema.files.driveId, ctx.driveId)
      )
    )
    .get();

  return {
    path,
    size: s3Head.size,
    contentType: s3Head.contentType,
    author: dbFile?.author ?? "unknown",
    currentVersion: dbFile?.currentVersionId
      ? parseInt(dbFile.currentVersionId)
      : undefined,
    createdAt: dbFile?.createdAt ?? new Date(),
    modifiedAt: dbFile?.modifiedAt ?? s3Head.lastModified ?? new Date(),
    isDeleted: dbFile?.isDeleted ?? false,
    embeddingStatus: dbFile?.embeddingStatus ?? undefined,
    etag: s3Head.etag,
  };
}
