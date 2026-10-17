import type { OpContext } from "./types.js";
import { ftsQuery } from "../search/fts.js";
import { findVectorCandidates } from "../search/vector-candidates.js";
import { toUnitVector } from "../search/vectors.js";

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
      tookMs: elapsedMs(started),
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

  // Sort by combined RRF score, take top N. The raw sum is at most
  // lists / (K + 1), about 0.033, so it is scaled to 0..1: 1 means first in
  // every list that ran, 0.5 first in one of two.
  const maxScore = (provider ? 2 : 1) / (K + 1);
  const results: SearchResultItem[] = Array.from(merged.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([path, data]) => ({
      path,
      score: data.score / maxScore,
      snippet: data.snippet,
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
