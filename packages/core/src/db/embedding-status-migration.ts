import type { Database } from "bun:sqlite";
import { EMBEDDING_STATUS_COLUMN_SQL } from "./raw.js";

/**
 * Only the daemon calls this before indexing starts.
 * CLI commands can open the database while an older daemon still runs.
 */
export function runEmbeddingStatusMigration(sqlite: Database): void {
  // Migration: admit skipped text embeddings.
  // Fresh databases already use this constraint in CREATE_TABLES_SQL.
  const filesSql = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'files'").get() as { sql: string };
  const statusCheck = filesSql.sql.match(/CHECK\s*\(\s*embedding_status\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (statusCheck && !statusCheck[1].includes("'skipped'")) {
    sqlite.transaction(() => {
      const objects = sqlite.prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'files' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
      ).all() as { type: string; name: string; sql: string }[];
      for (const object of objects) {
        sqlite.exec(`DROP ${object.type} "${object.name.replaceAll('"', '""')}"`);
      }
      sqlite.exec("ALTER TABLE files RENAME COLUMN embedding_status TO embedding_status_legacy");
      sqlite.exec(`ALTER TABLE files ADD COLUMN ${EMBEDDING_STATUS_COLUMN_SQL}`);
      sqlite.exec("UPDATE files SET embedding_status = embedding_status_legacy");
      sqlite.exec("ALTER TABLE files DROP COLUMN embedding_status_legacy");
      for (const object of objects) sqlite.exec(object.sql);
    })();
  }
}
