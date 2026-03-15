import type { OpContext } from "./types.js";
import { ftsQuery, type FtsMatch } from "../search/fts.js";

export interface FindParams {
  pattern: string;
  path?: string;
}

export interface FindMatch {
  path: string;
  snippet: string;
  rank: number;
}

export interface FindResult {
  matches: FindMatch[];
  hint?: string;
}

export async function find(
  ctx: OpContext,
  params: FindParams
): Promise<FindResult> {
  const results = ftsQuery(ctx.db, {
    pattern: params.pattern,
    driveId: ctx.driveId,
    pathPrefix: params.path,
  });

  const matches = results.map((r) => ({
    path: r.path,
    snippet: r.snippet,
    rank: r.rank,
  }));

  if (matches.length === 0) {
    return {
      matches,
      hint: `No exact token matches for "${params.pattern}". Try 'search' for semantic/fuzzy matching.`,
    };
  }

  return { matches };
}
