import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, RevertParams, RevertResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { NotFoundError, AgentFSError } from "../errors.js";
import { detectMimeType } from "./mime.js";

export async function revert(
  ctx: OpContext,
  params: RevertParams
): Promise<RevertResult> {
  // 1. Find the target version
  const targetVersion = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, params.path),
        eq(schema.fileVersions.driveId, ctx.driveId),
        eq(schema.fileVersions.version, params.version)
      )
    )
    .get();

  if (!targetVersion) {
    throw new NotFoundError(
      `Version ${params.version} not found for ${params.path}`,
      { path: params.path }
    );
  }

  if (!targetVersion.s3VersionId) {
    throw new AgentFSError(
      "VERSIONING_REQUIRED",
      "S3 versioning required for revert",
      "Enable S3 versioning on the bucket"
    );
  }

  // 2. Get the old content from S3 using versionId
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);
  const oldContent = await ctx.s3.getObject(s3Key, targetVersion.s3VersionId);
  const contentType = detectMimeType(params.path);

  // 3. Write it as the new current version
  const s3Result = await ctx.s3.putObject(s3Key, oldContent.body, undefined, contentType);
  const size = oldContent.body.length;

  // 4. Create version record
  const version = await createVersion(ctx, {
    path: params.path,
    s3VersionId: s3Result.versionId ?? "",
    operation: "revert",
    message: `Reverted to version ${params.version}`,
    size,
    etag: s3Result.etag,
    contentType,
  });

  return { version, revertedTo: params.version };
}
