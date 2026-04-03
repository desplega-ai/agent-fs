import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";

export interface VecSearchParams {
  query: string;
  limit?: number;
}

export interface VecSearchResultItem {
  path: string;
  score: number;
  snippet: string;
  author?: string;
  modifiedAt?: Date;
}

export interface VecSearchResult {
  results: VecSearchResultItem[];
}

export async function vecSearch(
  ctx: OpContext,
  params: VecSearchParams
): Promise<VecSearchResult> {
  const provider = ctx.embeddingProvider;
  if (!provider) {
    return {
      results: [],
      hint: "No embedding provider configured. Set OPENAI_API_KEY or enable local embeddings to use semantic search.",
    } as VecSearchResult & { hint: string };
  }

  const limit = params.limit ?? 10;

  // 1. Embed the query
  const queryEmbedding = await provider.embed(params.query);
  const queryVec = new Float32Array(queryEmbedding);

  // 2. KNN query via sqlite-vec
  const raw = (ctx.db as any).$client as Database;

  const vecResults = raw
    .prepare(
      `SELECT chunk_id, distance
       FROM chunk_vectors
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryVec, limit * 2) as Array<{
    chunk_id: number;
    distance: number;
  }>;

  if (vecResults.length === 0) {
    return { results: [] };
  }

  // 3. Join with chunks and file metadata
  const results: VecSearchResultItem[] = [];
  const seenPaths = new Set<string>();

  for (const vr of vecResults) {
    const chunk = ctx.db
      .select()
      .from(schema.contentChunks)
      .where(eq(schema.contentChunks.id, vr.chunk_id))
      .get();

    if (!chunk) continue;
    // Filter to current drive
    if (chunk.driveId !== ctx.driveId) continue;
    // Deduplicate by path (take best match per file)
    if (seenPaths.has(chunk.filePath)) continue;
    seenPaths.add(chunk.filePath);

    const file = ctx.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.path, chunk.filePath),
          eq(schema.files.driveId, ctx.driveId)
        )
      )
      .get();

    results.push({
      path: chunk.filePath,
      score: 1 / (1 + vr.distance),
      snippet: chunk.content.slice(0, 200),
      author: file?.author,
      modifiedAt: file?.modifiedAt,
    });

    if (results.length >= limit) break;
  }

  return { results };
}
