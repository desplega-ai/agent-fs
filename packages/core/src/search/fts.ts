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

const MAX_RESULTS = 50;

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
  return results.sort((a, b) => a.rank - b.rank).slice(0, MAX_RESULTS);
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
  if (table === LEGACY_FTS_TABLE) return legacyFtsQuery(raw, params);

  // Step 1: the top rows by rank, with no snippet. drive_id and path come from
  // the content table by rowid: reading them through the FTS table would load
  // each matching document in full. octet_length() reads only the row header.
  const pathFilter = params.pathPrefix ? " AND d.path LIKE ?" : "";
  const binds: unknown[] = [params.pattern, params.driveId];
  if (params.pathPrefix) binds.push(params.pathPrefix + "%");
  const top = raw
    .prepare(
      `SELECT f.rowid AS id, d.path AS path, f.rank AS rank, octet_length(d.content) AS bytes
       FROM files_fts AS f
       JOIN files_fts_docs AS d ON d.id = f.rowid
       WHERE f.content MATCH ? AND d.drive_id = ?${pathFilter}
       ORDER BY f.rank
       LIMIT ${MAX_RESULTS}`
    )
    .all(...(binds as any[])) as { id: number; path: string; rank: number; bytes: number }[];

  // Step 2: snippets for those rows only.
  return top.map((row) => ({
    path: row.path,
    snippet: snippetFor(raw, params.pattern, row.id, row.bytes),
    rank: row.rank,
  }));
}

/**
 * FTS5 snippet() and highlight() cost O(hits²) per document: 8,000 hits of a
 * term in one document take 0.3 s, so a multi-MB CSV with a common word in
 * every row takes minutes. Larger documents get a snippet built here instead,
 * around the first match of a query term.
 */
const FTS5_SNIPPET_MAX_BYTES = 32 * 1024;

function snippetFor(raw: Database, pattern: string, id: number, bytes: number): string {
  if (bytes <= FTS5_SNIPPET_MAX_BYTES) {
    const row = raw
      .query(
        "SELECT snippet(files_fts, 1, '<b>', '</b>', '...', 32) AS snippet FROM files_fts WHERE content MATCH ? AND rowid = ?"
      )
      .get(pattern, id) as { snippet: string } | null;
    return row?.snippet ?? "";
  }
  const row = raw.query("SELECT content FROM files_fts_docs WHERE id = ?").get(id) as
    | { content: string }
    | null;
  return row ? plainSnippet(row.content, pattern) : "";
}

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 180;

/** A window of `content` around the first match of a term of `pattern`, matches in <b>. */
export function plainSnippet(content: string, pattern: string): string {
  const terms = queryTerms(pattern);
  const match = terms.length > 0 ? termRegex(terms, "iu").exec(content) : null;
  const at = match?.index ?? 0;

  let start = Math.max(0, at - SNIPPET_BEFORE);
  if (start > 0) {
    const space = content.indexOf(" ", start);
    if (space !== -1 && space < at) start = space + 1;
  }
  let end = Math.min(content.length, at + SNIPPET_AFTER);
  if (end < content.length) {
    const space = content.lastIndexOf(" ", end);
    if (space > at) end = space;
  }

  let text = content.slice(start, end);
  if (terms.length > 0) text = text.replace(termRegex(terms, "giu"), "<b>$&</b>");
  return (start > 0 ? "..." : "") + text + (end < content.length ? "..." : "");
}

/** Bare terms of an FTS5 query: no operators, column filters or quotes. A trailing `*` marks a prefix. */
function queryTerms(pattern: string): { text: string; prefix: boolean }[] {
  const terms: { text: string; prefix: boolean }[] = [];
  const stripped = pattern.replace(/\{[^}]*\}\s*:|\b\w+\s*:/g, " ");
  for (const m of stripped.matchAll(/[\p{L}\p{N}]+(\*)?/gu)) {
    const text = m[0].replace(/\*$/, "");
    if (["AND", "OR", "NOT", "NEAR"].includes(text)) continue;
    terms.push({ text, prefix: m[1] === "*" });
  }
  return terms;
}

function termRegex(terms: { text: string; prefix: boolean }[], flags: string): RegExp {
  const alternatives = terms.map((t) => (t.prefix ? `${t.text}[\\p{L}\\p{N}]*` : t.text));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

/** The pre-0.13.1 internal-content table, queried only while its rows are migrated. */
function legacyFtsQuery(
  raw: Database,
  params: { pattern: string; driveId: string; pathPrefix?: string }
): FtsMatch[] {
  const table = LEGACY_FTS_TABLE;
  // FTS5 MATCH requires content columns only (not UNINDEXED ones).
  // Filter by drive_id and path prefix after the MATCH.
  const pathFilter = params.pathPrefix ? " AND path LIKE ?" : "";
  const sql = `
    SELECT path, snippet(${table}, 1, '<b>', '</b>', '...', 32) as snippet, rank
    FROM ${table}
    WHERE content MATCH ? AND drive_id = ?${pathFilter}${legacyRowIsCurrent(table)}
    ORDER BY rank
    LIMIT ${MAX_RESULTS}
  `;
  const binds: unknown[] = [params.pattern, params.driveId];
  if (params.pathPrefix) binds.push(params.pathPrefix + "%");
  return raw.prepare(sql).all(...(binds as any[])) as FtsMatch[];
}
