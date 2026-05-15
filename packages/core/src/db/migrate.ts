import { Database } from "bun:sqlite";

/**
 * Idempotent, additive migrations for existing databases.
 *
 * Each migration:
 *   - Checks whether the change is already applied (no-op if so).
 *   - Applies the change without touching existing data.
 *
 * Runs every time `createDatabase()` is called, so it's safe across
 * daemon restarts and fresh installs. Never destructive.
 */
export function runMigrations(sqlite: Database): void {
  // Migration 1: add file_versions.content_hash column (Phase 1 of FUSE mount).
  //
  // CREATE_TABLES_SQL already declares `content_hash TEXT` on fresh DBs, so
  // this only fires for DBs created before the column existed.
  const cols = sqlite
    .prepare("PRAGMA table_info(file_versions)")
    .all() as Array<{ name: string }>;
  const hasContentHash = cols.some((c) => c.name === "content_hash");
  if (!hasContentHash) {
    sqlite.exec("ALTER TABLE file_versions ADD COLUMN content_hash TEXT");
  }

  // Migration 2: add UNIQUE(path, drive_id, version) on file_versions.
  //
  // CREATE_TABLES_SQL already creates this for fresh DBs (via the same
  // statement), so this is the same statement re-run for safety.
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS file_versions_path_drive_version_uq " +
      "ON file_versions(path, drive_id, version)"
  );
}
