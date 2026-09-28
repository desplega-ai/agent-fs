import type { OpContext } from "./types.js";
import { findVectorCandidates } from "../search/vector-candidates.js";

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

  const results = findVectorCandidates(ctx.db, ctx.driveId, queryVec, limit).map(
    (candidate) => ({
      path: candidate.path,
      score: 1 / (1 + candidate.distance),
      snippet: candidate.snippet,
      author: candidate.author,
      modifiedAt: candidate.modifiedAt,
    })
  );

  return { results };
}
