import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { OpContext, MvParams, MvResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { indexFile, removeFromIndex } from "../search/fts.js";
import { schema } from "../db/index.js";
import { decodeIndexableText, detectMimeType } from "./mime.js";
import { clearSearchData } from "./search-index.js";

export async function mv(
  ctx: OpContext,
  params: MvParams
): Promise<MvResult> {
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, params.from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, params.to);

  // Optimistic concurrency: caller asserts the head of the *source* file.
  // If something else has bumped the source between read and mv, fail loudly.
  if (params.expectedVersion !== undefined) {
    await assertExpectedVersion(ctx, params.from, params.expectedVersion);
  }

  // 1. Copy to new location
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);

  // 2. Get size from head
  const head = await ctx.s3.headObject(toKey);

  // Fetch the moved content once so we can compute its hash and decide whether
  // existing search metadata should move with it.
  const obj = await ctx.s3.getObject(toKey);
  const contentHash = createHash("sha256").update(obj.body).digest("hex");
  const contentType = head.contentType ?? obj.contentType ?? detectMimeType(params.to);

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: params.to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: params.message ?? `Moved from ${params.from}`,
    size: head.size,
    etag: copyResult.etag,
    contentType,
    contentHash,
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

  removeFromIndex(ctx.db, { path: params.from, driveId: ctx.driveId });
  const content = decodeIndexableText(obj.body, contentType);
  if (content === null) {
    clearSearchData(ctx, params.to);
  } else {
    indexFile(ctx.db, { path: params.to, driveId: ctx.driveId, content });
    // Update chunk paths in-place (vectors stay the same).
    ctx.db
      .update(schema.contentChunks)
      .set({ filePath: params.to })
      .where(
        and(
          eq(schema.contentChunks.filePath, params.from),
          eq(schema.contentChunks.driveId, ctx.driveId)
        )
      )
      .run();
  }

  return { from: params.from, to: params.to, version };
}
