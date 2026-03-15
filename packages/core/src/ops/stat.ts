import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, StatParams, StatResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";

export async function stat(
  ctx: OpContext,
  params: StatParams
): Promise<StatResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

  // Check S3
  let s3Head;
  try {
    s3Head = await ctx.s3.headObject(s3Key);
  } catch (err: any) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${params.path}`, {
        path: params.path,
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
        eq(schema.files.path, params.path),
        eq(schema.files.driveId, ctx.driveId)
      )
    )
    .get();

  return {
    path: params.path,
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
  };
}
