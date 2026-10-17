import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import { removeFromIndex, indexFile } from "../search/fts.js";
import { readCurrentVersion, scheduleEmbedding } from "../search/pipeline.js";
import type { OpContext } from "./types.js";
import { extractIndexableText } from "./mime.js";

export function clearSearchData(ctx: OpContext, path: string): void {
  removeFromIndex(ctx.db, { path, driveId: ctx.driveId });

  const oldChunks = ctx.db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, path),
        eq(schema.contentChunks.driveId, ctx.driveId)
      )
    )
    .all();

  if (oldChunks.length > 0) {
    const raw = (ctx.db as any).$client as Database;
    for (const chunk of oldChunks) {
      raw.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?").run(chunk.id);
    }

    ctx.db
      .delete(schema.contentChunks)
      .where(
        and(
          eq(schema.contentChunks.filePath, path),
          eq(schema.contentChunks.driveId, ctx.driveId)
        )
      )
      .run();
  }

  ctx.db
    .update(schema.files)
    .set({ embeddingStatus: null })
    .where(
      and(
        eq(schema.files.path, path),
        eq(schema.files.driveId, ctx.driveId)
      )
    )
    .run();
}

export function indexTextForSearch(
  ctx: OpContext,
  path: string,
  content: string,
  pageStarts?: number[]
): void {
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
  const version = readCurrentVersion(ctx.db, { path, driveId: ctx.driveId });
  const extracted = await extractIndexableText(bytes, contentType);
  if (readCurrentVersion(ctx.db, { path, driveId: ctx.driveId }) !== version) return null;
  if (extracted === null) {
    clearSearchData(ctx, path);
    return null;
  }

  indexTextForSearch(ctx, path, extracted.text, extracted.pageStarts);
  return extracted.text;
}
