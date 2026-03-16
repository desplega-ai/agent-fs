import type { OpContext } from "./types.js";
import { ftsQuery, type FtsMatch } from "../search/fts.js";

export interface FtsParams {
  pattern: string;
  path?: string;
}

export interface FtsOpMatch {
  path: string;
  snippet: string;
  rank: number;
}

export interface FtsResult {
  matches: FtsOpMatch[];
  hint?: string;
}

export async function fts(
  ctx: OpContext,
  params: FtsParams
): Promise<FtsResult> {
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
