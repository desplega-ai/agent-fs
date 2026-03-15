import type { DB } from "../db/index.js";
import { Database } from "bun:sqlite";

function getRawDb(db: DB): Database {
  return (db as any).$client as Database;
}

export function indexFile(
  db: DB,
  params: { path: string; driveId: string; content: string }
): void {
  const raw = getRawDb(db);

  // Remove existing entry first (upsert pattern for FTS5)
  raw
    .prepare("DELETE FROM files_fts WHERE path = ? AND drive_id = ?")
    .run(params.path, params.driveId);

  // Insert new entry
  raw
    .prepare("INSERT INTO files_fts(path, content, drive_id) VALUES (?, ?, ?)")
    .run(params.path, params.content, params.driveId);
}

export function removeFromIndex(
  db: DB,
  params: { path: string; driveId: string }
): void {
  const raw = getRawDb(db);
  raw
    .prepare("DELETE FROM files_fts WHERE path = ? AND drive_id = ?")
    .run(params.path, params.driveId);
}

export interface FtsMatch {
  path: string;
  snippet: string;
  rank: number;
}

export function ftsQuery(
  db: DB,
  params: { pattern: string; driveId: string; pathPrefix?: string }
): FtsMatch[] {
  const raw = getRawDb(db);

  let sql: string;
  let binds: any[];

  // FTS5 MATCH requires content columns only (not UNINDEXED ones).
  // Filter by drive_id and path prefix after the MATCH.
  if (params.pathPrefix) {
    sql = `
      SELECT path, snippet(files_fts, 1, '<b>', '</b>', '...', 32) as snippet, rank
      FROM files_fts
      WHERE content MATCH ? AND drive_id = ? AND path LIKE ?
      ORDER BY rank
      LIMIT 50
    `;
    binds = [params.pattern, params.driveId, params.pathPrefix + "%"];
  } else {
    sql = `
      SELECT path, snippet(files_fts, 1, '<b>', '</b>', '...', 32) as snippet, rank
      FROM files_fts
      WHERE content MATCH ? AND drive_id = ?
      ORDER BY rank
      LIMIT 50
    `;
    binds = [params.pattern, params.driveId];
  }

  return raw.prepare(sql).all(...binds) as FtsMatch[];
}
