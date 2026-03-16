import { eq, and, or, isNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { indexFile } from "../search/fts.js";
import { indexFileEmbeddings } from "../search/pipeline.js";

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
  // Find files that need reindexing: failed, null, or pending status
  const conditions = [
    eq(schema.files.driveId, ctx.driveId),
    eq(schema.files.isDeleted, false),
    or(
      eq(schema.files.embeddingStatus, "failed"),
      isNull(schema.files.embeddingStatus),
      eq(schema.files.embeddingStatus, "pending"),
    ),
  ];

  if (params.path) {
    const { like } = await import("drizzle-orm");
    const prefix = params.path.endsWith("/") ? params.path : params.path + "/";
    conditions.push(like(schema.files.path, prefix + "%"));
  }

  const files = ctx.db
    .select({ path: schema.files.path })
    .from(schema.files)
    .where(and(...conditions))
    .all();

  let reindexed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of files) {
    const s3Key = getS3Key(ctx.orgId, ctx.driveId, file.path);

    try {
      const result = await ctx.s3.getObject(s3Key);
      const content = new TextDecoder().decode(result.body);

      // Re-index FTS5
      indexFile(ctx.db, { path: file.path, driveId: ctx.driveId, content });

      // Re-index embeddings if provider available
      if (ctx.embeddingProvider) {
        await indexFileEmbeddings(ctx.db, ctx.embeddingProvider, {
          path: file.path,
          driveId: ctx.driveId,
          content,
        });
      } else {
        skipped++;
        continue;
      }

      reindexed++;
    } catch (err) {
      console.error(`Reindex failed for ${file.path}:`, err);
      failed++;
    }
  }

  return { reindexed, failed, skipped };
}
