import { eq, and, or, isNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { indexFileEmbeddings, readCurrentVersion } from "../search/pipeline.js";
import { indexFile } from "../search/fts.js";
import { clearSearchData } from "./search-index.js";
import { extractIndexableText, detectMimeType } from "./mime.js";
import { normalizePrefix } from "./paths.js";
import { queueImageEmbeddings } from "../search/image-embedding.js";

export interface ReindexParams {
  path?: string;
}

export interface ReindexResult {
  reindexed: number;
  failed: number;
  skipped: number;
}

export async function reindex(
  ctx: OpContext,
  params: ReindexParams
): Promise<ReindexResult> {
  const fileConditions = [
    eq(schema.files.driveId, ctx.driveId),
    eq(schema.files.isDeleted, false),
  ];

  if (params.path) {
    const { like } = await import("drizzle-orm");
    const prefix = normalizePrefix(params.path);
    fileConditions.push(like(schema.files.path, prefix + "%"));
  }

  if (ctx.embeddingProvider?.supportsMime?.("image/png")) {
    ctx.db.update(schema.files).set({ imageEmbeddingStatus: "pending" })
      .where(and(...fileConditions, eq(schema.files.imageEmbeddingStatus, "failed"))).run();
    queueImageEmbeddings(ctx);
  }

  const files = ctx.db
    .select({ path: schema.files.path, version: schema.files.currentVersionId })
    .from(schema.files)
    .where(and(...fileConditions, or(
      eq(schema.files.embeddingStatus, "failed"),
      isNull(schema.files.embeddingStatus),
      eq(schema.files.embeddingStatus, "pending"),
    )))
    .all();

  let reindexed = 0;
  let failed = 0;
  let skipped = 0;

  const BATCH_SIZE = 3;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const s3Key = getS3Key(ctx.orgId, ctx.driveId, file.path);
        const result = await ctx.s3.getObject(s3Key);
        // A write landed during the read: its own indexing owns the file.
        const version = file.version ?? null;
        if (readCurrentVersion(ctx.db, { path: file.path, driveId: ctx.driveId }) !== version) {
          return "skipped" as const;
        }
        const contentType = result.contentType ?? detectMimeType(file.path);
        const extracted = await extractIndexableText(result.body, contentType);
        if (readCurrentVersion(ctx.db, { path: file.path, driveId: ctx.driveId }) !== version) {
          return "skipped" as const;
        }
        if (extracted === null) {
          clearSearchData(ctx, file.path, "text");
          return "skipped" as const;
        }

        // Re-index FTS5
        indexFile(ctx.db, { path: file.path, driveId: ctx.driveId, content: extracted.text });

        // Re-index embeddings if provider available
        if (ctx.embeddingProvider) {
          const outcome = await indexFileEmbeddings(ctx.db, ctx.embeddingProvider, {
            path: file.path,
            driveId: ctx.driveId,
            content: extracted.text,
            pageStarts: extracted.pageStarts,
            version,
          });
          return outcome === "indexed" ? ("reindexed" as const) : ("skipped" as const);
        }
        return "skipped" as const;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "reindexed") reindexed++;
        else skipped++;
      } else {
        console.error("Reindex failed:", r.reason);
        failed++;
      }
    }
  }

  return { reindexed, failed, skipped };
}
