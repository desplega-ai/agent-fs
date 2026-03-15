// This module must be imported BEFORE any Database is created.
// It configures Bun to use Homebrew's SQLite on macOS, which supports extensions.
// On other platforms, this is a no-op.

import { Database } from "bun:sqlite";
import { platform } from "node:os";
import { existsSync } from "node:fs";

let initialized = false;

export function ensureCustomSQLite(): void {
  if (initialized) return;
  initialized = true;

  if (platform() !== "darwin") return;

  const paths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib", // Intel Mac
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        Database.setCustomSQLite(p);
      } catch {
        // Already set — fine
      }
      return;
    }
  }

  console.warn(
    "Warning: Could not find Homebrew SQLite. Extension loading may fail on macOS.\n" +
      "Install with: brew install sqlite"
  );
}

// Auto-run on import
ensureCustomSQLite();
