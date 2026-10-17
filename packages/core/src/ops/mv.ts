import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { OpContext, MvParams, MvResult } from "./types.js";
import {
  getS3Key,
  createVersion,
  assertExpectedVersion,
} from "./versioning.js";
import { indexFile, indexedContent, removeFromIndex } from "../search/fts.js";
import { readCurrentVersion } from "../search/pipeline.js";
import { schema } from "../db/index.js";
import { extractIndexableText, detectMimeType } from "./mime.js";
import { clearSearchData } from "./search-index.js";
import { invalidateDriveGlobListings } from "./glob-cache.js";
import { normalizePath } from "./paths.js";
import { ValidationError } from "../errors.js";
import { favoritesAfterMove } from "./favorite.js";
import { imageEligible, queueImageEmbeddings } from "../search/image-embedding.js";
import { canRenderPdfPages } from "../search/pdf.js";

export async function mv(
  ctx: OpContext,
  params: MvParams
): Promise<MvResult> {
  const from = normalizePath(params.from);
  const to = normalizePath(params.to);
  if (from === to) {
    throw new ValidationError("Source and destination are the same path");
  }
  const pdfPageImages = await canRenderPdfPages(ctx.embeddingProvider);
  const fromKey = getS3Key(ctx.orgId, ctx.driveId, from);
  const toKey = getS3Key(ctx.orgId, ctx.driveId, to);

  // Optimistic concurrency: caller asserts the head of the *source* file.
  // If something else has bumped the source between read and mv, fail loudly.
  if (params.expectedVersion !== undefined) {
    await assertExpectedVersion(ctx, from, params.expectedVersion);
  }

  // 1. Copy to new location
  const copyResult = await ctx.s3.copyObject(fromKey, toKey);
  invalidateDriveGlobListings(ctx.orgId, ctx.driveId);

  // 2. Get size from head
  const head = await ctx.s3.headObject(toKey);

  // Fetch the moved content once so we can compute its hash and decide whether
  // existing search metadata should move with it.
  const obj = await ctx.s3.getObject(toKey);
  const contentHash = createHash("sha256").update(obj.body).digest("hex");
  const contentType = head.contentType ?? obj.contentType ?? detectMimeType(to);
  const preserveImages = imageEligible(ctx.embeddingProvider, contentType, pdfPageImages);
  const sourceFile = ctx.db.select({
    imageStatus: schema.files.imageEmbeddingStatus,
    textStatus: schema.files.embeddingStatus,
  }).from(schema.files).where(and(eq(schema.files.path, from), eq(schema.files.driveId, ctx.driveId))).get();
  const pdfText = contentType === "application/pdf"
    ? indexedContent(ctx.db, { path: from, driveId: ctx.driveId })
    : null;

  // 3. Create version on new path
  const version = await createVersion(ctx, {
    path: to,
    s3VersionId: copyResult.versionId ?? "",
    operation: "write",
    message: params.message ?? `Moved from ${from}`,
    size: head.size,
    etag: copyResult.etag,
    contentType,
    contentHash,
  });
  const targetVersion = readCurrentVersion(ctx.db, { path: to, driveId: ctx.driveId });

  // 4. Delete original
  await ctx.s3.deleteObject(fromKey);

  // 5. Mark old path as deleted
  await createVersion(ctx, {
    path: from,
    s3VersionId: "",
    operation: "delete",
    message: `Moved to ${to}`,
  });

  removeFromIndex(ctx.db, { path: from, driveId: ctx.driveId });
  const preserveText = contentType === "application/pdf" || preserveImages;
  const extracted = preserveText ? null : await extractIndexableText(obj.body, contentType);
  if (readCurrentVersion(ctx.db, { path: to, driveId: ctx.driveId }) === targetVersion) {
    clearSearchData(ctx, to, "all");
    if (!preserveImages) clearSearchData(ctx, from, "image");
    const content = preserveText ? pdfText : extracted?.text;
    if (content !== null && content !== undefined) {
      indexFile(ctx.db, { path: to, driveId: ctx.driveId, content });
    }
    if (preserveText || extracted !== null) {
      // Move chunks in place so their vectors keep the same IDs.
      ctx.db.update(schema.contentChunks).set({ filePath: to })
        .where(and(eq(schema.contentChunks.filePath, from), eq(schema.contentChunks.driveId, ctx.driveId))).run();
    } else {
      clearSearchData(ctx, from, "text");
    }
    ctx.db.update(schema.files).set({
      imageEmbeddingStatus: preserveImages ? sourceFile?.imageStatus ?? null : null,
      embeddingStatus: preserveText || extracted !== null ? sourceFile?.textStatus ?? null : null,
    }).where(and(eq(schema.files.path, to), eq(schema.files.driveId, ctx.driveId))).run();
    if (preserveImages && sourceFile?.imageStatus === "pending") queueImageEmbeddings(ctx);
  } else {
    clearSearchData(ctx, from, "all");
  }

  // Stars follow the file.
  await favoritesAfterMove(ctx, from, to);

  return { from, to, version };
}
