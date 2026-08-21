// MUST be imported before any Database usage
import "./setup-sqlite.js";

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "../config.js";
import * as schema from "./schema.js";
import { CREATE_TABLES_SQL, VEC_TABLE_SQL, FTS_SCHEMA_SQL } from "./raw.js";
import { runMigrations } from "./migrate.js";
import { isLegacyFtsTable } from "./fts-migration.js";
import {
  INLINE_BUILD_MAX_ROWID,
  contentChunksMaxRowid,
  ensureContentChunksIndexInline,
  hasContentChunksIndex,
} from "./content-chunks-index.js";

export type DB = ReturnType<typeof createDatabase>;

function loadSqliteVec(sqlite: Database): void {
  sqliteVec.load(sqlite);
}

/**
 * Per-connection pragmas shared by the daemon, the CLI and the test helper.
 *
 * synchronous=NORMAL: under WAL a process crash loses nothing (the WAL is
 * still fsynced at checkpoint), only a host power loss can lose the most
 * recent commits. It removes one fsync per commit, and a single write commits
 * several times.
 *
 * busy_timeout=250: bun:sqlite spins the event loop for the whole wait, so
 * keep it short. The only second connections this project has are the CLI in
 * embedded mode against a running daemon and the one-off index helper.
 */
export function applyConnectionPragmas(sqlite: Database): void {
  sqlite.exec("PRAGMA synchronous=NORMAL;");
  sqlite.exec("PRAGMA busy_timeout=250;");
}

export interface CreateDatabaseOptions {
  /**
   * Leave idx_content_chunks_drive_path unbuilt when the table is large, so
   * the caller (the daemon) can build it after its listener is open. Small
   * tables still build inline because that takes milliseconds.
   */
  deferContentChunksIndex?: boolean;
}

export function createDatabase(
  dbPath?: string,
  opts: CreateDatabaseOptions = {}
): ReturnType<typeof drizzle> {
  const resolvedPath = dbPath ?? getDbPath();

  // Ensure parent directory exists
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(resolvedPath);

  // Load sqlite-vec extension
  loadSqliteVec(sqlite);

  // Enable WAL mode for concurrent reads during async embedding writes
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  applyConnectionPragmas(sqlite);

  // Create all tables (idempotent)
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VEC_TABLE_SQL);

  // The full-text index is only installed when the name is free. A database
  // from before 0.13.1 still has the internal-content `files_fts`; the daemon
  // migrates it (fts-migration.ts) and nothing else may touch it, so a newer
  // CLI binary cannot rename it under an older daemon on the same file.
  if (!isLegacyFtsTable(sqlite)) {
    sqlite.exec(FTS_SCHEMA_SQL);
  }

  // Run additive migrations for older DBs (idempotent)
  runMigrations(sqlite);

  if (
    !hasContentChunksIndex(sqlite) &&
    (!opts.deferContentChunksIndex ||
      contentChunksMaxRowid(sqlite) <= INLINE_BUILD_MAX_ROWID)
  ) {
    ensureContentChunksIndexInline(sqlite);
  }

  const db = drizzle(sqlite, { schema });
  return db;
}

export { schema };
