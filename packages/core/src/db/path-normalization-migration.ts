import type { Database } from "bun:sqlite";
import { normalizePath } from "../ops/paths.js";
import {
  hasLegacyFts,
  isLegacyFtsTable,
  LEGACY_FTS_TABLE,
} from "./fts-migration.js";

/**
 * Canonicalize legacy bare paths and merge split histories.
 *
 * Only the daemon calls this. `createDatabase()` must stay safe for CLI
 * commands that open the production database while an older daemon runs.
 */

export interface PathNormalizationMigrationSummary {
  renamedPaths: number;
  mergedPaths: number;
  versionsRenumbered: number;
  commentsRemapped: number;
  skippedPaths: number;
}

export interface PathNormalizationMigrationOptions {
  log?: (message: string) => void;
}

interface BarePath {
  driveId: string;
  path: string;
}

interface VersionRow {
  id: number;
  path: string;
  version: number;
  author: string;
  operation: "write" | "edit" | "append" | "delete" | "revert";
  size: number | null;
  createdAt: number;
}

interface FileRow {
  path: string;
  size: number;
  contentType: string | null;
  author: string;
  currentVersionId: string | null;
  createdAt: number;
  modifiedAt: number;
  isDeleted: number;
  embeddingStatus: "pending" | "indexed" | "failed" | null;
}

interface VirtualFtsTable {
  name: string;
  rowIdsByPath: Map<string, number[]>;
}

interface FtsTables {
  internal: VirtualFtsTable | null;
  legacy: VirtualFtsTable | null;
}

function collectBarePaths(sqlite: Database): BarePath[] {
  const seen = new Map<string, BarePath>();
  // These are covering-index scans. Do not scan the FTS virtual tables here.
  // Their rows are reconciled for paths found through the indexed source tables.
  const queries = [
    "SELECT drive_id AS driveId, path FROM files WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM file_versions WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM comments WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM shares WHERE path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, file_path AS path FROM content_chunks WHERE file_path NOT LIKE '/%'",
    "SELECT drive_id AS driveId, path FROM files_fts_docs WHERE path NOT LIKE '/%'",
  ];

  for (const query of queries) {
    for (const row of sqlite.query(query).all() as BarePath[]) {
      seen.set(`${row.driveId}\u0000${row.path}`, row);
    }
  }

  return [...seen.values()].sort(
    (a, b) => a.driveId.localeCompare(b.driveId) || a.path.localeCompare(b.path)
  );
}

function hasFileHistory(sqlite: Database, driveId: string, path: string): boolean {
  if (
    sqlite
      .query("SELECT 1 FROM files WHERE drive_id = ? AND path = ? LIMIT 1")
      .get(driveId, path)
  ) {
    return true;
  }
  return Boolean(
    sqlite
      .query("SELECT 1 FROM file_versions WHERE drive_id = ? AND path = ? LIMIT 1")
      .get(driveId, path)
  );
}

function deleteChunks(sqlite: Database, driveId: string, path: string): void {
  const chunks = sqlite
    .query(
      "SELECT id FROM content_chunks WHERE drive_id = ? AND file_path = ?"
    )
    .all(driveId, path) as Array<{ id: number }>;
  const deleteVector = sqlite.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
  for (const chunk of chunks) {
    deleteVector.run(chunk.id);
  }
  sqlite
    .query("DELETE FROM content_chunks WHERE drive_id = ? AND file_path = ?")
    .run(driveId, path);
}

function reconcileChunks(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): boolean {
  const preferredPath = preferCanonical ? canonicalPath : barePath;
  const discardedPath = preferCanonical ? barePath : canonicalPath;
  const hasPreferred = Boolean(
    sqlite
      .query(
        "SELECT 1 FROM content_chunks WHERE drive_id = ? AND file_path = ? LIMIT 1"
      )
      .get(driveId, preferredPath)
  );

  deleteChunks(sqlite, driveId, discardedPath);
  if (!preferCanonical && hasPreferred) {
    sqlite
      .query(
        "UPDATE content_chunks SET file_path = ? WHERE drive_id = ? AND file_path = ?"
      )
      .run(canonicalPath, driveId, barePath);
  }
  return hasPreferred;
}

function reconcilePathTable(
  sqlite: Database,
  table: string,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): boolean {
  const preferredPath = preferCanonical ? canonicalPath : barePath;
  const discardedPath = preferCanonical ? barePath : canonicalPath;
  const hasPreferred = Boolean(
    sqlite
      .query(`SELECT 1 FROM ${table} WHERE drive_id = ? AND path = ? LIMIT 1`)
      .get(driveId, preferredPath)
  );

  sqlite
    .query(`DELETE FROM ${table} WHERE drive_id = ? AND path = ?`)
    .run(driveId, discardedPath);
  if (!preferCanonical && hasPreferred) {
    sqlite
      .query(`UPDATE ${table} SET path = ? WHERE drive_id = ? AND path = ?`)
      .run(canonicalPath, driveId, barePath);
  }
  return hasPreferred;
}

function readVirtualFtsTable(sqlite: Database, name: string): VirtualFtsTable {
  const rowIdsByPath = new Map<string, number[]>();
  const rows = sqlite
    .query(`SELECT rowid, drive_id AS driveId, path FROM ${name}`)
    .all() as Array<{ rowid: number; driveId: string; path: string }>;
  for (const row of rows) {
    const key = `${row.driveId}\u0000${row.path}`;
    const rowIds = rowIdsByPath.get(key) ?? [];
    rowIds.push(row.rowid);
    rowIdsByPath.set(key, rowIds);
  }
  return { name, rowIdsByPath };
}

function reconcileVirtualFtsRows(
  sqlite: Database,
  table: VirtualFtsTable,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): boolean {
  const preferredPath = preferCanonical ? canonicalPath : barePath;
  const discardedPath = preferCanonical ? barePath : canonicalPath;
  const preferredRowIds =
    table.rowIdsByPath.get(`${driveId}\u0000${preferredPath}`) ?? [];
  const discardedRowIds =
    table.rowIdsByPath.get(`${driveId}\u0000${discardedPath}`) ?? [];

  for (const rowid of discardedRowIds) {
    sqlite.query(`DELETE FROM ${table.name} WHERE rowid = ?`).run(rowid);
  }
  if (!preferCanonical) {
    for (const rowid of preferredRowIds) {
      sqlite
        .query(`UPDATE ${table.name} SET path = ? WHERE rowid = ?`)
        .run(canonicalPath, rowid);
    }
  }
  return preferredRowIds.length > 0;
}

function reconcileFtsRows(
  sqlite: Database,
  fts: FtsTables,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): boolean {
  let hasPreferred = reconcilePathTable(
    sqlite,
    "files_fts_docs",
    driveId,
    barePath,
    canonicalPath,
    preferCanonical
  );
  if (fts.internal !== null) {
    hasPreferred =
      reconcileVirtualFtsRows(
        sqlite,
        fts.internal,
        driveId,
        barePath,
        canonicalPath,
        preferCanonical
      ) || hasPreferred;
  }
  if (fts.legacy !== null) {
    hasPreferred =
      reconcileVirtualFtsRows(
        sqlite,
        fts.legacy,
        driveId,
        barePath,
        canonicalPath,
        preferCanonical
      ) || hasPreferred;
  }
  return hasPreferred;
}

function deleteAllIndexRows(
  sqlite: Database,
  fts: FtsTables,
  driveId: string,
  barePath: string,
  canonicalPath: string
): void {
  deleteChunks(sqlite, driveId, barePath);
  deleteChunks(sqlite, driveId, canonicalPath);
  sqlite
    .query("DELETE FROM files_fts_docs WHERE drive_id = ? AND path IN (?, ?)")
    .run(driveId, barePath, canonicalPath);
  for (const table of [fts.internal, fts.legacy]) {
    if (table === null) continue;
    for (const path of [barePath, canonicalPath]) {
      const rowIds = table.rowIdsByPath.get(`${driveId}\u0000${path}`) ?? [];
      for (const rowid of rowIds) {
        sqlite.query(`DELETE FROM ${table.name} WHERE rowid = ?`).run(rowid);
      }
    }
  }
}

function renameBareOnlyPath(
  sqlite: Database,
  fts: FtsTables,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  preferCanonical: boolean
): number {
  sqlite
    .query("UPDATE files SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  sqlite
    .query("UPDATE file_versions SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  const commentsRemapped = sqlite
    .query("UPDATE comments SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath).changes;
  sqlite
    .query("UPDATE shares SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);

  reconcileChunks(sqlite, driveId, barePath, canonicalPath, preferCanonical);
  reconcileFtsRows(
    sqlite,
    fts,
    driveId,
    barePath,
    canonicalPath,
    preferCanonical
  );
  return commentsRemapped;
}

function readVersions(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string
): VersionRow[] {
  const rows = sqlite
    .query(
      `SELECT id, path, version, author, operation, size, created_at AS createdAt
       FROM file_versions
       WHERE drive_id = ? AND path IN (?, ?)`
    )
    .all(driveId, barePath, canonicalPath) as VersionRow[];

  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

function readFiles(
  sqlite: Database,
  driveId: string,
  barePath: string,
  canonicalPath: string
): FileRow[] {
  return sqlite
    .query(
      `SELECT path, size, content_type AS contentType, author,
              current_version_id AS currentVersionId,
              created_at AS createdAt, modified_at AS modifiedAt,
              is_deleted AS isDeleted, embedding_status AS embeddingStatus
       FROM files WHERE drive_id = ? AND path IN (?, ?)`
    )
    .all(driveId, barePath, canonicalPath) as FileRow[];
}

function mergeSplitPath(
  sqlite: Database,
  fts: FtsTables,
  driveId: string,
  barePath: string,
  canonicalPath: string,
  summary: PathNormalizationMigrationSummary
): void {
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
    sqlite
      .query("UPDATE file_versions SET path = ?, version = ? WHERE id = ?")
      .run(canonicalPath, maxOldVersion + index + 1, row.id);
  }
  for (let index = 0; index < versions.length; index++) {
    sqlite
      .query("UPDATE file_versions SET version = ? WHERE id = ?")
      .run(index + 1, versions[index].id);
  }

  const comments = sqlite
    .query(
      `SELECT id, path, file_version_id AS fileVersionId FROM comments
       WHERE drive_id = ? AND path IN (?, ?)`
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
    .query("UPDATE comments SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);
  sqlite
    .query("UPDATE shares SET path = ? WHERE drive_id = ? AND path = ?")
    .run(canonicalPath, driveId, barePath);

  const latestVersion = versions.at(-1);
  const latestFile = files.reduce<FileRow | undefined>(
    (latest, row) => (!latest || row.modifiedAt > latest.modifiedAt ? row : latest),
    undefined
  );
  const sourceFile = latestVersion
    ? files.find((row) => row.path === latestVersion.path) ?? latestFile
    : latestFile;

  const canonicalFile = files.find((row) => row.path === canonicalPath);
  if (!canonicalFile) {
    sqlite
      .query("UPDATE files SET path = ? WHERE drive_id = ? AND path = ?")
      .run(canonicalPath, driveId, barePath);
  } else {
    sqlite
      .query("DELETE FROM files WHERE drive_id = ? AND path = ?")
      .run(driveId, barePath);
  }

  const createdAt = Math.min(
    ...files.map((row) => row.createdAt),
    ...versions.map((row) => row.createdAt)
  );
  const fileCreatedAt = Number.isFinite(createdAt)
    ? createdAt
    : Math.floor(Date.now() / 1000);
  const size = latestVersion?.size ?? sourceFile?.size ?? 0;
  const author = latestVersion?.author ?? sourceFile?.author ?? "unknown";
  const modifiedAt = latestVersion?.createdAt ?? sourceFile?.modifiedAt ?? fileCreatedAt;
  const isDeleted = latestVersion
    ? Number(latestVersion.operation === "delete")
    : sourceFile?.isDeleted ?? 0;

  let embeddingStatus = sourceFile ? sourceFile.embeddingStatus : "pending";
  if (isDeleted) {
    deleteAllIndexRows(sqlite, fts, driveId, barePath, canonicalPath);
  } else {
    const preferCanonical =
      (latestVersion?.path ?? sourceFile?.path) === canonicalPath;
    const hasChunks = reconcileChunks(
      sqlite,
      driveId,
      barePath,
      canonicalPath,
      preferCanonical
    );
    const hasFts = reconcileFtsRows(
      sqlite,
      fts,
      driveId,
      barePath,
      canonicalPath,
      preferCanonical
    );
    if ((!hasChunks || !hasFts) && embeddingStatus !== null) {
      embeddingStatus = "pending";
    }
  }

  sqlite
    .query(
      `UPDATE files SET
         size = ?, content_type = ?, author = ?, current_version_id = ?,
         created_at = ?, modified_at = ?, is_deleted = ?, embedding_status = ?
       WHERE drive_id = ? AND path = ?`
    )
    .run(
      size,
      sourceFile?.contentType ?? null,
      author,
      latestVersion ? String(versions.length) : sourceFile?.currentVersionId ?? null,
      fileCreatedAt,
      modifiedAt,
      isDeleted,
      embeddingStatus,
      driveId,
      canonicalPath
    );
}

function canSafelyPrefixBarePath(path: string): boolean {
  return normalizePath(path) === "/" + path && !path.includes("//");
}

export function runPathNormalizationMigration(
  sqlite: Database,
  opts: PathNormalizationMigrationOptions = {}
): PathNormalizationMigrationSummary | null {
  const skipped: BarePath[] = [];
  const migrate = sqlite.transaction(() => {
    const internalFts = isLegacyFtsTable(sqlite);
    const legacyFts = hasLegacyFts(sqlite);
    const barePaths = collectBarePaths(sqlite);
    if (barePaths.length === 0) return null;
    const fts = {
      internal: internalFts ? readVirtualFtsTable(sqlite, "files_fts") : null,
      legacy: legacyFts ? readVirtualFtsTable(sqlite, LEGACY_FTS_TABLE) : null,
    };

    const summary: PathNormalizationMigrationSummary = {
      renamedPaths: 0,
      mergedPaths: 0,
      versionsRenumbered: 0,
      commentsRemapped: 0,
      skippedPaths: 0,
    };

    for (const { driveId, path: barePath } of barePaths) {
      if (!canSafelyPrefixBarePath(barePath)) {
        skipped.push({ driveId, path: barePath });
        summary.skippedPaths++;
        continue;
      }

      const canonicalPath = "/" + barePath;
      const hasBareHistory = hasFileHistory(sqlite, driveId, barePath);
      const hasCanonicalHistory = hasFileHistory(sqlite, driveId, canonicalPath);
      if (hasBareHistory && hasCanonicalHistory) {
        summary.mergedPaths++;
        mergeSplitPath(
          sqlite,
          fts,
          driveId,
          barePath,
          canonicalPath,
          summary
        );
      } else {
        summary.commentsRemapped += renameBareOnlyPath(
          sqlite,
          fts,
          driveId,
          barePath,
          canonicalPath,
          !hasBareHistory && hasCanonicalHistory
        );
        summary.renamedPaths++;
      }
    }

    return summary;
  });

  const summary = migrate.immediate();
  if (skipped.length > 0) {
    const examples = skipped
      .slice(0, 10)
      .map((row) => `${JSON.stringify(row.path)} in drive ${row.driveId}`)
      .join(", ");
    opts.log?.(
      `file path migration: skipped ${skipped.length} unsafe bare paths: ${examples}`
    );
  }
  return summary;
}
