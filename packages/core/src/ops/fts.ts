import type { OpContext } from "./types.js";
import { ftsQuery, type FtsMatch } from "../search/fts.js";
import { withLeadingSlash } from "./paths.js";

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
  /** Server time for the query, in milliseconds. */
  tookMs: number;
}

export async function fts(
  ctx: OpContext,
  params: FtsParams
): Promise<FtsResult> {
  const started = performance.now();
  const results = ftsQuery(ctx.db, {
    pattern: params.pattern,
    driveId: ctx.driveId,
    pathPrefix: params.path ? withLeadingSlash(params.path) : undefined,
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
      tookMs: Math.round(performance.now() - started),
    };
  }

  return { matches, tookMs: Math.round(performance.now() - started) };
}
