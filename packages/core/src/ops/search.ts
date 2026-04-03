import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { ftsQuery } from "../search/fts.js";

export interface SearchParams {
  query: string;
  limit?: number;
}

export interface SearchResultItem {
  path: string;
  score: number;
  snippet: string;
  author?: string;
  modifiedAt?: Date;
}

export interface SearchResult {
  results: SearchResultItem[];
  hint?: string;
}

/**
 * Hybrid search combining vector (semantic) and FTS5 (keyword) results
 * using Reciprocal Rank Fusion (RRF).
 */
export async function search(
  ctx: OpContext,
  params: SearchParams
): Promise<SearchResult> {
  const limit = params.limit ?? 10;
  const provider = ctx.embeddingProvider;

  // Run vector search and FTS in parallel
  const [vecResults, ftsResults] = await Promise.all([
    provider ? vectorSearch(ctx, params.query, limit * 3) : [],
    keywordSearch(ctx, params.query, limit * 3),
  ]);

  if (vecResults.length === 0 && ftsResults.length === 0) {
    return {
      results: [],
      hint: provider
        ? `No results found for "${params.query}".`
        : "No embedding provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, or enable local embeddings for semantic search. Showing keyword results only.",
    };
  }

  // Reciprocal Rank Fusion (k=60 is the standard constant)
  const K = 60;
  const merged = new Map<
    string,
    { score: number; snippet: string; author?: string; modifiedAt?: Date }
  >();

  // Score vector results by rank position
  for (let rank = 0; rank < vecResults.length; rank++) {
    const item = vecResults[rank];
    const rrfScore = 1 / (K + rank + 1);
    const existing = merged.get(item.path);
    if (existing) {
      existing.score += rrfScore;
    } else {
      merged.set(item.path, {
        score: rrfScore,
        snippet: item.snippet,
        author: item.author,
        modifiedAt: item.modifiedAt,
      });
    }
  }

  // Score FTS results by rank position
  for (let rank = 0; rank < ftsResults.length; rank++) {
    const item = ftsResults[rank];
    const rrfScore = 1 / (K + rank + 1);
    const existing = merged.get(item.path);
    if (existing) {
      existing.score += rrfScore;
      // Prefer FTS snippet (has keyword highlighting)
      if (item.snippet) {
        existing.snippet = item.snippet;
      }
    } else {
      merged.set(item.path, {
        score: rrfScore,
        snippet: item.snippet,
      });
    }
  }

  // Sort by combined RRF score, take top N
  const results: SearchResultItem[] = Array.from(merged.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([path, data]) => ({
      path,
      score: data.score,
      snippet: data.snippet,
      author: data.author,
      modifiedAt: data.modifiedAt,
    }));

  return {
    results,
    hint: !provider
      ? "Results are keyword-only. Enable embeddings for better semantic matching."
      : undefined,
  };
}

// --- Internal helpers ---

interface RankedItem {
  path: string;
  snippet: string;
  author?: string;
  modifiedAt?: Date;
}

async function vectorSearch(
  ctx: OpContext,
  query: string,
  limit: number
): Promise<RankedItem[]> {
  const provider = ctx.embeddingProvider!;
  const queryEmbedding = await provider.embed(query);
  const queryVec = new Float32Array(queryEmbedding);
  const raw = (ctx.db as any).$client as Database;

  const vecResults = raw
    .prepare(
      `SELECT chunk_id, distance
       FROM chunk_vectors
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryVec, limit) as Array<{ chunk_id: number; distance: number }>;

  const items: RankedItem[] = [];
  const seenPaths = new Set<string>();

  for (const vr of vecResults) {
    const chunk = ctx.db
      .select()
      .from(schema.contentChunks)
      .where(eq(schema.contentChunks.id, vr.chunk_id))
      .get();

    if (!chunk || chunk.driveId !== ctx.driveId) continue;
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

    items.push({
      path: chunk.filePath,
      snippet: chunk.content.slice(0, 200),
      author: file?.author,
      modifiedAt: file?.modifiedAt,
    });
  }

  return items;
}

function keywordSearch(
  ctx: OpContext,
  query: string,
  limit: number
): RankedItem[] {
  // Convert natural language query to FTS5 OR'd quoted terms
  const ftsPattern = query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" OR ");

  if (!ftsPattern) return [];

  try {
    const results = ftsQuery(ctx.db, {
      pattern: ftsPattern,
      driveId: ctx.driveId,
    });

    return results.slice(0, limit).map((r) => ({
      path: r.path,
      snippet: r.snippet,
    }));
  } catch {
    // FTS5 MATCH can fail with certain query syntax; fall back to empty
    return [];
  }
}
