import { Database } from "bun:sqlite";
import type { OpContext } from "./types.js";
import { normalizePrefix } from "./paths.js";
import { hasLegacyFts, LEGACY_FTS_TABLE } from "../db/fts-migration.js";
import { legacyRowIsCurrent } from "../search/fts.js";

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

  // Read content from the local search index instead of fetching each file
  // from S3. files_fts_docs holds the full text and is indexed by (drive, path).
  const files = raw
    .prepare(
      "SELECT path, content FROM files_fts_docs WHERE drive_id = ? AND path LIKE ?"
    )
    .all(ctx.driveId, prefix + "%") as Array<{ path: string; content: string }>;

  // During the one-time index migration, rows not yet copied still live in
  // the legacy table, minus the ones the new layout has superseded.
  if (hasLegacyFts(raw)) {
    const legacy = raw
      .prepare(
        `SELECT path, content FROM ${LEGACY_FTS_TABLE}
         WHERE drive_id = ? AND path LIKE ?${legacyRowIsCurrent(LEGACY_FTS_TABLE)}`
      )
      .all(ctx.driveId, prefix + "%") as Array<{ path: string; content: string }>;
    files.push(...legacy);
  }

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
