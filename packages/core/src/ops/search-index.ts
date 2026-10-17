import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import { removeFromIndex, indexFile } from "../search/fts.js";
import { deleteChunks, readCurrentVersion, scheduleEmbedding, type ChunkDeleteScope } from "../search/pipeline.js";
import { canRenderPdfPages } from "../search/pdf.js";
import { imageEligible, queueImageEmbeddings } from "../search/image-embedding.js";
import type { OpContext } from "./types.js";
import { detectMimeType, extractIndexableText } from "./mime.js";

export function clearSearchData(ctx: OpContext, path: string, kind: ChunkDeleteScope): void {
  if (kind !== "image") removeFromIndex(ctx.db, { path, driveId: ctx.driveId });
  deleteChunks(ctx.db, { path, driveId: ctx.driveId }, kind);
  ctx.db
    .update(schema.files)
    .set({
      ...(kind !== "image" ? { embeddingStatus: null } : {}),
      ...(kind !== "text" ? { imageEmbeddingStatus: null } : {}),
    })
    .where(
      and(
        eq(schema.files.path, path),
        eq(schema.files.driveId, ctx.driveId)
      )
    )
    .run();
}

export async function indexTextForSearch(
  ctx: OpContext,
  path: string,
  content: string,
  pageStarts?: number[]
): Promise<void> {
  const version = readCurrentVersion(ctx.db, { path, driveId: ctx.driveId });
  const pdfPageImages = await canRenderPdfPages(ctx.embeddingProvider);
  if (readCurrentVersion(ctx.db, { path, driveId: ctx.driveId }) !== version) return;
  const file = ctx.db.select({ mime: schema.files.contentType }).from(schema.files)
    .where(and(eq(schema.files.path, path), eq(schema.files.driveId, ctx.driveId))).get();
  const mime = file?.mime ?? detectMimeType(path);
  if (!imageEligible(ctx.embeddingProvider, mime, pdfPageImages)) {
    clearSearchData(ctx, path, "image");
  }
  indexFile(ctx.db, { path, driveId: ctx.driveId, content });
  scheduleEmbedding(ctx.db, ctx.embeddingProvider ?? null, {
    path,
    driveId: ctx.driveId,
    content,
    pageStarts,
  });
}

export async function indexBytesForSearch(
  ctx: OpContext,
  path: string,
  bytes: Uint8Array,
  contentType: string
): Promise<string | null> {
  const provider = ctx.embeddingProvider;
  const version = readCurrentVersion(ctx.db, { path, driveId: ctx.driveId });
  const pdfPageImages = await canRenderPdfPages(provider);
  const extracted = await extractIndexableText(bytes, contentType);
  if (readCurrentVersion(ctx.db, { path, driveId: ctx.driveId }) !== version) return null;
  clearSearchData(ctx, path, "image");
  const imagePending = imageEligible(provider, contentType, pdfPageImages);
  if (imagePending) {
    ctx.db.update(schema.files).set({ imageEmbeddingStatus: "pending" })
      .where(and(eq(schema.files.path, path), eq(schema.files.driveId, ctx.driveId))).run();
  }
  if (extracted === null) {
    clearSearchData(ctx, path, "text");
  } else {
    await indexTextForSearch(ctx, path, extracted.text, extracted.pageStarts);
  }
  if (imagePending) {
    queueImageEmbeddings(ctx);
  }
  return extracted?.text ?? null;
}
