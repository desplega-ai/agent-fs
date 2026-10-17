import type { OpContext } from "./types.js";
import { ftsQuery } from "../search/fts.js";
import { findVectorCandidates } from "../search/vector-candidates.js";
import { toUnitVector } from "../search/vectors.js";
import type { ChunkKind } from "../search/pipeline.js";

export interface SearchParams {
  query: string;
  limit?: number;
}

export interface SearchResultItem {
  path: string;
  score: number;
  snippet: string;
  page?: number;
  kind?: ChunkKind;
  author?: string;
  modifiedAt?: Date;
}

export interface SearchResult {
  results: SearchResultItem[];
  hint?: string;
  /** Server time for the whole search, in milliseconds. */
  tookMs: number;
}

/**
 * Hybrid search combining vector (semantic) and FTS5 (keyword) results
 * using Reciprocal Rank Fusion (RRF).
 */
export async function search(
  ctx: OpContext,
  params: SearchParams
): Promise<SearchResult> {
  const started = performance.now();
  const limit = params.limit ?? 10;
  const provider = ctx.embeddingProvider;
  // The default limit 10 times 3 preserves today's pool. Limits up to 30 share the same order.
  const MIN_CANDIDATE_POOL = 30;
  const pool = Math.max(limit, MIN_CANDIDATE_POOL);

  // Run vector search and FTS in parallel
  const [vecResults, ftsResults] = await Promise.all([
    provider ? vectorSearch(ctx, params.query, pool) : [],
    keywordSearch(ctx, params.query, pool),
  ]);

  if (vecResults.length === 0 && ftsResults.length === 0) {
    return {
      results: [],
      hint: provider
        ? `No results found for "${params.query}".`
        : "No embedding provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, or enable local embeddings for semantic search. Showing keyword results only.",
      tookMs: elapsedMs(started),
    };
  }

  // Reciprocal Rank Fusion (k=60 is the standard constant)
  const K = 60;
  const merged = new Map<
    string,
    { score: number; snippet: string; ftsHit?: boolean; page?: number; kind?: ChunkKind; author?: string; modifiedAt?: Date }
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
        page: item.page,
        kind: item.kind,
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
      existing.ftsHit = true;
      // Prefer FTS snippet (has keyword highlighting)
      if (item.snippet && existing.kind !== "image") {
        existing.snippet = item.snippet;
      }
    } else {
      merged.set(item.path, {
        score: rrfScore,
        snippet: item.snippet,
        kind: "text",
        ftsHit: true,
      });
    }
  }

  // FTS cannot match images. Count their vector rank for both lists.
  if (provider) {
    for (const data of merged.values()) {
      if (data.kind === "image" && !data.ftsHit) data.score *= 2;
    }
  }

  // Sort by combined RRF score, take top N. The raw sum is at most
  // lists / (K + 1), about 0.033, so it is scaled to 0..1: 1 means first in
  // every list that can match the file.
  const maxScore = (provider ? 2 : 1) / (K + 1);
  const results: SearchResultItem[] = Array.from(merged.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([path, data]) => ({
      path,
      score: data.score / maxScore,
      snippet: data.snippet,
      page: data.page,
      kind: data.kind,
      author: data.author,
      modifiedAt: data.modifiedAt,
    }));

  return {
    results,
    hint: !provider
      ? "Results are keyword-only. Enable embeddings for better semantic matching."
      : undefined,
    tookMs: elapsedMs(started),
  };
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

// --- Internal helpers ---

interface RankedItem {
  path: string;
  snippet: string;
  page?: number;
  kind?: ChunkKind;
  author?: string;
  modifiedAt?: Date;
}

async function vectorSearch(
  ctx: OpContext,
  query: string,
  limit: number
): Promise<RankedItem[]> {
  const provider = ctx.embeddingProvider!;
  const queryEmbedding = await provider.embedQuery(query);
  const queryVec = toUnitVector(queryEmbedding, provider.dimensions);

  return (await findVectorCandidates(ctx.db, ctx.driveId, queryVec, limit)).map(
    (candidate) => ({
      path: candidate.path,
      snippet: candidate.snippet,
      page: candidate.page,
      kind: candidate.kind,
      author: candidate.author,
      modifiedAt: candidate.modifiedAt,
    })
  );
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
    .map((term) => `"${term.replaceAll('"', '""')}"`)
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
