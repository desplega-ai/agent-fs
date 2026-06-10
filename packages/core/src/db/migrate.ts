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

  // Migration 3: backfill explicit drive memberships (multi-tenant RBAC).
  //
  // Drive visibility is strict explicit membership: drives with zero
  // `drive_members` rows are visible to no one. Older DBs may contain
  // zero-member drives that used to be treated as "public" within the org.
  // Grant every org admin an explicit 'admin' membership on those drives so
  // they stay reachable; org admins can then share them explicitly.
  //
  // Idempotent: only matches drives that still have zero member rows, and
  // INSERT OR IGNORE tolerates the (drive_id, user_id) primary key.
  sqlite.exec(
    "INSERT OR IGNORE INTO drive_members (drive_id, user_id, role) " +
      "SELECT d.id, om.user_id, 'admin' " +
      "FROM drives d " +
      "JOIN org_members om ON om.org_id = d.org_id AND om.role = 'admin' " +
      "WHERE NOT EXISTS (SELECT 1 FROM drive_members dm WHERE dm.drive_id = d.id)"
  );
}
