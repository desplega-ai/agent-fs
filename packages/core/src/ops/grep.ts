import { Database } from "bun:sqlite";
import type { OpContext } from "./types.js";
import { normalizePrefix } from "./paths.js";

export interface GrepParams {
  pattern: string;
  path: string;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
}

export async function grep(
  ctx: OpContext,
  params: GrepParams
): Promise<GrepResult> {
  const regex = new RegExp(params.pattern);
  const prefix = normalizePrefix(params.path);
  const raw = (ctx.db as any).$client as Database;

  // Read content from FTS5 index (local SQLite) instead of fetching each file from S3.
  // FTS5 stores the full content, so this avoids O(n) S3 GETs.
  const files = raw
    .prepare(
      "SELECT path, content FROM files_fts WHERE drive_id = ? AND path LIKE ?"
    )
    .all(ctx.driveId, prefix + "%") as Array<{ path: string; content: string }>;

  const matches: GrepMatch[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({
          path: file.path,
          lineNumber: i + 1,
          content: lines[i],
        });
      }
    }
  }

  return { matches };
}
