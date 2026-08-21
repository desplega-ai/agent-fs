import type { DB } from "../db/index.js";
import { Database } from "bun:sqlite";
import { hasLegacyFts, LEGACY_FTS_TABLE } from "../db/fts-migration.js";

function getRawDb(db: DB): Database {
  return (db as any).$client as Database;
}

// `files_fts` is an external-content FTS5 table over `files_fts_docs`, kept in
// sync by triggers (see FTS_SCHEMA_SQL). Writers only touch the docs table,
// where (drive_id, path) is a unique index. Writing through the FTS table by
// `WHERE path = ?` would be a full scan: FTS5 can only use MATCH and rowid.

export function indexFile(
  db: DB,
  params: { path: string; driveId: string; content: string }
): void {
  const raw = getRawDb(db);
  raw.transaction(() => {
    raw
      .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path = ?")
      .run(params.driveId, params.path);
    raw
      .prepare(
        "INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, ?, ?)"
      )
      .run(params.driveId, params.path, params.content);
  })();
}

export function removeFromIndex(
  db: DB,
  params: { path: string; driveId: string }
): void {
  const raw = getRawDb(db);
  raw
    .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path = ?")
    .run(params.driveId, params.path);
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
  const results = ftsQueryTable(raw, "files_fts", params);

  // During the one-time index migration the not-yet-copied rows still live in
  // the legacy table. Query it too, minus rows the new layout has superseded.
  if (!hasLegacyFts(raw)) return results;
  results.push(...ftsQueryTable(raw, LEGACY_FTS_TABLE, params));
  return results.sort((a, b) => a.rank - b.rank).slice(0, 50);
}

/**
 * Rows of the legacy table that the new layout has not superseded: the file
 * still exists and has not been re-indexed into files_fts_docs since the
 * rename. Both checks are index lookups on the (few) MATCH candidates.
 */
export function legacyRowIsCurrent(table: string): string {
  return `
    AND EXISTS (SELECT 1 FROM files f
                WHERE f.drive_id = ${table}.drive_id AND f.path = ${table}.path AND f.is_deleted = 0)
    AND NOT EXISTS (SELECT 1 FROM files_fts_docs d
                    WHERE d.drive_id = ${table}.drive_id AND d.path = ${table}.path)`;
}

function ftsQueryTable(
  raw: Database,
  table: string,
  params: { pattern: string; driveId: string; pathPrefix?: string }
): FtsMatch[] {
  // FTS5 MATCH requires content columns only (not UNINDEXED ones).
  // Filter by drive_id and path prefix after the MATCH.
  const pathFilter = params.pathPrefix ? " AND path LIKE ?" : "";
  const legacyFilter = table === LEGACY_FTS_TABLE ? legacyRowIsCurrent(table) : "";
  const sql = `
    SELECT path, snippet(${table}, 1, '<b>', '</b>', '...', 32) as snippet, rank
    FROM ${table}
    WHERE content MATCH ? AND drive_id = ?${pathFilter}${legacyFilter}
    ORDER BY rank
    LIMIT 50
  `;
  const binds: unknown[] = [params.pattern, params.driveId];
  if (params.pathPrefix) binds.push(params.pathPrefix + "%");
  return raw.prepare(sql).all(...(binds as any[])) as FtsMatch[];
}
