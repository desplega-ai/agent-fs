import type { Database } from "bun:sqlite";
import { normalizePath } from "../ops/paths.js";

const MIGRATION_KEY = "migration:file-path-normalization:v1";
const REPORT_KEY = `${MIGRATION_KEY}:report`;
const REINDEX_KEY = `${MIGRATION_KEY}:reindex`;

export interface PathNormalizationMigrationSummary {
  renamedPaths: number;
  mergedPaths: number;
  versionsRenumbered: number;
  commentsRemapped: number;
  reindexPaths: number;
}

export interface PathReindexTarget {
  driveId: string;
  path: string;
}

interface BarePath {
  driveId: string;
  path: string;
}

interface VersionRow {
  id: number;
  path: string;
  version: number;
  s3VersionId: string;
  author: string;
  operation: "write" | "edit" | "append" | "delete" | "revert";
  message: string | null;
  diffSummary: string | null;
  size: number | null;
  etag: string | null;
  contentHash: string | null;
  createdAt: number;
}

interface FileRow {
  path: string;
  driveId: string;
  size: number;
  contentType: string | null;
  author: string;
  currentVersionId: string | null;
  createdAt: number;
  modifiedAt: number;
  isDeleted: number;
  embeddingStatus: "pending" | "indexed" | "failed" | null;
}

function tableSql(sqlite: Database, name: string): string | null {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string | null } | null;
  return row?.sql ?? null;
}

function isInternalFts(sqlite: Database, name: string): boolean {
  const sql = tableSql(sqlite, name);
  return sql !== null && !sql.includes("content='files_fts_docs'");
}

function collectBarePaths(sqlite: Database): BarePath[] {
  const seen = new Map<string, BarePath>();
  const queries = [
    "SELECT drive_id AS driveId, path FROM files WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM file_versions WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM comments WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM shares WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, file_path AS path FROM content_chunks WHERE file_path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM files_fts_docs WHERE path NOT LIKE '/%'",
  ];

  if (isInternalFts(sqlite, "files_fts")) {
    queries.push("SELECT drive_id AS driveId, path FROM files_fts WHERE path NOT LIKE '/%'");
  }
  if (tableSql(sqlite, "files_fts_legacy")) {
    queries.push("SELECT drive_id AS driveId, path FROM files_fts_legacy WHERE path NOT LIKE '/%'");
  }

  for (const query of queries) {
    for (const row of sqlite.prepare(query).all() as BarePath[]) {
      seen.set(`${row.driveId}\u0000${row.path}`, row);
    }
  }

  return [...seen.values()].sort(
    (a, b) => a.driveId.localeCompare(b.driveId) || a.path.localeCompare(b.path)
  );
}

function hasFileHistory(
  sqlite: Database,
  driveId: string,
  path: string
): boolean {
  const file = sqlite
    .prepare("SELECT 1 FROM files WHERE drive_id = ? AND path = ? LIMIT 1")
    .get(driveId, path);
  if (file) return true;
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM file_versions WHERE drive_id = ? AND path = ? LIMIT 1")
      .get(driveId, path)
  );
}

function deleteChunks(sqlite: Database, driveId: string, path: string): void {
  sqlite
    .prepare(
      "DELETE FROM chunk_vectors WHERE chunk_id IN " +
        "(SELECT id FROM content_chunks WHERE drive_id = ? AND file_path = ?)"
    )
    .run(driveId, path);
  sqlite
    .prepare("DELETE FROM content_chunks WHERE drive_id = ? AND file_path = ?")
    .run(driveId, path);
}

function deleteInternalFtsRows(
  sqlite: Database,
  driveId: string,
  paths: string[]
): void {
  for (const table of ["files_fts", "files_fts_legacy"]) {
    if (table === "files_fts" && !isInternalFts(sqlite, table)) continue;
    if (table === "files_fts_legacy" && !tableSql(sqlite, table)) continue;
    const remove = sqlite.prepare(`DELETE FROM ${table} WHERE drive_id = ? AND path = ?`);
    for (const path of paths) remove.run(driveId, path);
  }
}

function renameInternalFtsRows(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): void {
  for (const table of ["files_fts", "files_fts_legacy"]) {
    if (table === "files_fts" && !isInternalFts(sqlite, table)) continue;
    if (table === "files_fts_legacy" && !tableSql(sqlite, table)) continue;
    const hasBare = sqlite
      .prepare(`SELECT 1 FROM ${table} WHERE drive_id = ? AND path = ? LIMIT 1`)
      .get(driveId, barePath);
    if (!hasBare) continue;
    const hasCanonical = sqlite
      .prepare(`SELECT 1 FROM ${table} WHERE drive_id = ? AND path = ? LIMIT 1`)
      .get(driveId, canonicalPath);
    if (preferCanonical && hasCanonical) {
      sqlite
        .prepare(`DELETE FROM ${table} WHERE drive_id = ? AND path = ?`)
        .run(driveId, barePath);
      continue;
    }
    sqlite
      .prepare(`DELETE FROM ${table} WHERE drive_id = ? AND path = ?`)
      .run(driveId, canonicalPath);
    sqlite
      .prepare(`UPDATE ${table} SET path = ? WHERE drive_id = ? AND path = ?`)
      .run(canonicalPath, driveId, barePath);
  }
}

function renameBareOnlyPath(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): number {
  sqlite
    .prepare("UPDATE files SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  sqlite
    .prepare("UPDATE file_versions SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  const commentsRemapped = sqlite
    .prepare("UPDATE comments SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath).changes;
  sqlite
    .prepare("UPDATE shares SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);

  const hasBareChunks = sqlite
    .prepare("SELECT 1 FROM content_chunks WHERE drive_id = ? AND file_path = ? LIMIT 1")
    .get(driveId, barePath);
  if (hasBareChunks) {
    const hasCanonicalChunks = sqlite
      .prepare("SELECT 1 FROM content_chunks WHERE drive_id = ? AND file_path = ? LIMIT 1")
      .get(driveId, canonicalPath);
    if (preferCanonical && hasCanonicalChunks) {
      deleteChunks(sqlite, driveId, barePath);
    } else {
      deleteChunks(sqlite, driveId, canonicalPath);
      sqlite
        .prepare("UPDATE content_chunks SET file_path = ? WHERE drive_id = ? AND file_path = ?")
        .run(canonicalPath, driveId, barePath);
    }
  }

  const hasBareFts = sqlite
    .prepare("SELECT 1 FROM files_fts_docs WHERE drive_id = ? AND path = ? LIMIT 1")
    .get(driveId, barePath);
  if (hasBareFts) {
    const hasCanonicalFts = sqlite
      .prepare("SELECT 1 FROM files_fts_docs WHERE drive_id = ? AND path = ? LIMIT 1")
      .get(driveId, canonicalPath);
    if (preferCanonical && hasCanonicalFts) {
      sqlite
        .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path = ?")
        .run(driveId, barePath);
    } else {
      sqlite
        .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path = ?")
        .run(driveId, canonicalPath);
      sqlite
        .prepare("UPDATE files_fts_docs SET path = ? WHERE drive_id = ? AND path = ?")
        .run(canonicalPath, driveId, barePath);
    }
  }

  renameInternalFtsRows(sqlite, driveId, barePath, canonicalPath, preferCanonical);
  return commentsRemapped;
}

function readVersions(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string
): VersionRow[] {
  const rows = sqlite
    .prepare(
      `SELECT id, path, version, s3_version_id AS s3VersionId, author, operation,
              message, diff_summary AS diffSummary, size, etag,
              content_hash AS contentHash, created_at AS createdAt
       FROM file_versions
       WHERE drive_id = ? AND path IN (?, ?)`
    )
    .all(driveId, barePath, canonicalPath) as VersionRow[];

  return rows.sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      Number(b.path === canonicalPath) - Number(a.path === canonicalPath) ||
      a.version - b.version ||
      a.id - b.id
  );
}

function readFiles(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string
): FileRow[] {
  return sqlite
    .prepare(
      `SELECT path, drive_id AS driveId, size, content_type AS contentType,
              author, current_version_id AS currentVersionId,
              created_at AS createdAt, modified_at AS modifiedAt,
              is_deleted AS isDeleted, embedding_status AS embeddingStatus
       FROM files WHERE drive_id = ? AND path IN (?, ?)`
    )
    .all(driveId, barePath, canonicalPath) as FileRow[];
}

function mergeSplitPath(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  summary: PathNormalizationMigrationSummary
): boolean {
  const versions = readVersions(sqlite, driveId, barePath, canonicalPath);
  const files = readFiles(sqlite, driveId, barePath, canonicalPath);
  const maxOldVersion = versions.reduce((max, row) => Math.max(max, row.version), 0);
  const changedVersionIds = new Set<number>();

  for (let index = 0; index < versions.length; index++) {
    const row = versions[index];
    const newVersion = index + 1;
    if (row.version !== newVersion) {
      summary.versionsRenumbered++;
      changedVersionIds.add(row.id);
    }
    if (row.path !== canonicalPath) changedVersionIds.add(row.id);
    sqlite
      .prepare("UPDATE file_versions SET path = ?, version = ? WHERE id = ?")
      .run(canonicalPath, maxOldVersion + index + 1, row.id);
  }
  for (let index = 0; index < versions.length; index++) {
    sqlite
      .prepare("UPDATE file_versions SET version = ? WHERE id = ?")
      .run(index + 1, versions[index].id);
  }

  const comments = sqlite
    .prepare(
      "SELECT id, path, file_version_id AS fileVersionId FROM comments " +
        "WHERE drive_id = ? AND path IN (?, ?)"
    )
    .all(driveId, barePath, canonicalPath) as Array<{
      id: string;
      path: string;
      fileVersionId: number | null;
    }>;
  for (const comment of comments) {
    if (
      comment.path !== canonicalPath ||
      (comment.fileVersionId !== null && changedVersionIds.has(comment.fileVersionId))
    ) {
      summary.commentsRemapped++;
    }
  }

  sqlite
    .prepare("UPDATE comments SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  sqlite
    .prepare("UPDATE shares SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);

  const latestVersion = versions.at(-1);
  const latestFile = files.reduce<FileRow | undefined>(
    (latest, row) => (!latest || row.modifiedAt > latest.modifiedAt ? row : latest),
    undefined
  );
  const sourceFile = latestVersion
    ? files.find((row) => row.path === latestVersion.path) ?? latestFile
    : latestFile;
  const createdAt = Math.min(
    ...files.map((row) => row.createdAt),
    ...versions.map((row) => row.createdAt)
  );
  const fileCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
  const size = latestVersion?.size ?? sourceFile?.size ?? 0;
  const author = latestVersion?.author ?? sourceFile?.author ?? "unknown";
  const modifiedAt = latestVersion?.createdAt ?? sourceFile?.modifiedAt ?? fileCreatedAt;
  const isDeleted = latestVersion
    ? Number(latestVersion.operation === "delete")
    : sourceFile?.isDeleted ?? 0;

  sqlite
    .prepare("DELETE FROM files WHERE drive_id = ? AND path IN (?, ?)")
    .run(driveId, barePath, canonicalPath);
  sqlite
    .prepare(
      `INSERT INTO files (
         path, drive_id, size, content_type, author, current_version_id,
         created_at, modified_at, is_deleted, embedding_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      canonicalPath,
      driveId,
      size,
      sourceFile?.contentType ?? null,
      author,
      latestVersion ? String(versions.length) : sourceFile?.currentVersionId ?? null,
      fileCreatedAt,
      modifiedAt,
      isDeleted,
      "pending"
    );

  deleteChunks(sqlite, driveId, barePath);
  deleteChunks(sqlite, driveId, canonicalPath);
  sqlite
    .prepare("DELETE FROM files_fts_docs WHERE drive_id = ? AND path IN (?, ?)")
    .run(driveId, barePath, canonicalPath);
  deleteInternalFtsRows(sqlite, driveId, [barePath, canonicalPath]);

  return isDeleted === 0;
}

function normalizeEventMetadata(sqlite: Database): void {
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.metadata, c.path
       FROM events e JOIN comments c ON e.resource_type = 'comment' AND e.resource_id = c.id
       WHERE e.metadata IS NOT NULL
       UNION ALL
       SELECT e.id, e.metadata, s.path
       FROM events e JOIN shares s ON e.resource_type = 'share' AND e.resource_id = s.id
       WHERE e.metadata IS NOT NULL`
    )
    .all() as Array<{ id: string; metadata: string; path: string }>;

  const update = sqlite.prepare("UPDATE events SET metadata = ? WHERE id = ?");
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      if (metadata.path === row.path) continue;
      metadata.path = row.path;
      update.run(JSON.stringify(metadata), row.id);
    } catch {
      // Keep malformed legacy metadata unchanged.
    }
  }
}

export function runPathNormalizationMigration(
  sqlite: Database
): PathNormalizationMigrationSummary | null {
  const applied = sqlite.prepare("SELECT 1 FROM meta WHERE key = ?").get(MIGRATION_KEY);
  if (applied) return null;

  const summary: PathNormalizationMigrationSummary = {
    renamedPaths: 0,
    mergedPaths: 0,
    versionsRenumbered: 0,
    commentsRemapped: 0,
    reindexPaths: 0,
  };
  const reindex = new Map<string, PathReindexTarget>();

  sqlite.transaction(() => {
    for (const { driveId, path: barePath } of collectBarePaths(sqlite)) {
      const canonicalPath = normalizePath(barePath);
      const hasBareHistory = hasFileHistory(sqlite, driveId, barePath);
      const hasCanonicalHistory = hasFileHistory(sqlite, driveId, canonicalPath);
      if (hasBareHistory && hasCanonicalHistory) {
        summary.mergedPaths++;
        if (mergeSplitPath(sqlite, driveId, barePath, canonicalPath, summary)) {
          reindex.set(`${driveId}\u0000${canonicalPath}`, { driveId, path: canonicalPath });
        }
      } else {
        summary.commentsRemapped += renameBareOnlyPath(
          sqlite,
          driveId,
          barePath,
          canonicalPath,
          !hasBareHistory && hasCanonicalHistory
        );
        summary.renamedPaths++;
      }
    }

    normalizeEventMetadata(sqlite);
    summary.reindexPaths = reindex.size;
    const serializedSummary = JSON.stringify(summary);
    sqlite
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
      .run(MIGRATION_KEY, serializedSummary);
    if (summary.renamedPaths > 0 || summary.mergedPaths > 0) {
      sqlite
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
        .run(REPORT_KEY, serializedSummary);
    }
    if (reindex.size > 0) {
      sqlite
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
        .run(REINDEX_KEY, JSON.stringify([...reindex.values()]));
    }
  })();

  return summary;
}

export function takePathNormalizationMigrationReport(
  sqlite: Database
): PathNormalizationMigrationSummary | null {
  return sqlite.transaction(() => {
    const row = sqlite
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(REPORT_KEY) as { value: string } | null;
    if (!row) return null;
    sqlite.prepare("DELETE FROM meta WHERE key = ?").run(REPORT_KEY);
    return JSON.parse(row.value) as PathNormalizationMigrationSummary;
  })();
}

export function getQueuedPathReindexes(sqlite: Database): PathReindexTarget[] {
  const row = sqlite
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(REINDEX_KEY) as { value: string } | null;
  if (!row) return [];
  return JSON.parse(row.value) as PathReindexTarget[];
}

export function replaceQueuedPathReindexes(
  sqlite: Database,
  targets: PathReindexTarget[]
): void {
  if (targets.length === 0) {
    sqlite.prepare("DELETE FROM meta WHERE key = ?").run(REINDEX_KEY);
    return;
  }
  sqlite
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run(REINDEX_KEY, JSON.stringify(targets));
}
