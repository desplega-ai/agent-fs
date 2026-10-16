import type { Database } from "bun:sqlite";
import { runPathNormalizationMigration } from "@/core/db/path-normalization-migration.js";

interface MigrationLogger {
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

export function runPathNormalizationAtStartup(
  sqlite: Database,
  logger: MigrationLogger = console
): void {
  try {
    const summary = runPathNormalizationMigration(sqlite, {
      log: (message) => logger.log(message),
    });
    if (!summary) return;
    logger.log(
      "file path migration: " +
        `${summary.renamedPaths} renamed, ` +
        `${summary.mergedPaths} merged, ` +
        `${summary.versionsRenumbered} versions renumbered, ` +
        `${summary.commentsRemapped} comments remapped, ` +
        `${summary.skippedPaths} skipped`
    );
  } catch (error) {
    logger.error("file path migration failed (will retry on next start):", error);
  }
}
