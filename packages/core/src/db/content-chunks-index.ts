import type { Database } from "bun:sqlite";

/**
 * The (drive_id, file_path) index on content_chunks.
 *
 * Every write, rm, mv and the embedding job look chunks up by (drive, path).
 * Without this index each of those is a full scan of a table that holds a
 * copy of every indexed file.
 *
 * The index is NOT part of CREATE_TABLES_SQL on purpose. Building it on a
 * large existing database takes minutes on a small machine, and a single
 * CREATE INDEX cannot be split into batches. The daemon therefore opens the
 * listener first and builds it in a helper process (see the server boot), so
 * /health keeps answering and the platform does not restart the machine
 * mid-build. Everything else (CLI embedded mode, tests, fresh or small
 * databases) builds it inline.
 */
export const CONTENT_CHUNKS_INDEX_NAME = "idx_content_chunks_drive_path";

export const CONTENT_CHUNKS_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS ${CONTENT_CHUNKS_INDEX_NAME} ` +
  "ON content_chunks(drive_id, file_path)";

/** Tables at or below this rowid build the index inline in a few ms. */
export const INLINE_BUILD_MAX_ROWID = 10_000;

export function hasContentChunksIndex(sqlite: Database): boolean {
  const row = sqlite
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(CONTENT_CHUNKS_INDEX_NAME) as { present: number } | null;
  return row !== null;
}

/** Upper bound on the row count, O(1) via the integer primary key. */
export function contentChunksMaxRowid(sqlite: Database): number {
  const row = sqlite
    .prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM content_chunks")
    .get() as { max_id: number };
  return row.max_id;
}

/** Builds the index on this connection. Blocks the caller for the whole build. */
export function ensureContentChunksIndexInline(sqlite: Database): void {
  sqlite.exec(CONTENT_CHUNKS_INDEX_SQL);
}

// The helper opens its own connection, so the daemon's event loop stays free
// while SQLite builds the index. busy_timeout is generous here because the
// helper should wait for the daemon's in-flight commits rather than fail.
// Plain bun:sqlite is enough: the statement touches no virtual table, so the
// sqlite-vec extension is not loaded.
const HELPER_SCRIPT = [
  'const { Database } = require("bun:sqlite");',
  "const db = new Database(process.env.AGENT_FS_INDEX_DB_PATH);",
  'db.exec("PRAGMA busy_timeout=5000");',
  `db.exec(${JSON.stringify(CONTENT_CHUNKS_INDEX_SQL)});`,
  "db.close();",
].join("\n");

/**
 * Builds the index in a child `bun -e` process.
 *
 * A child process rather than a Worker because the daemon ships as one
 * bundled file (packages/cli/dist/cli.js): spawning `process.execPath` works
 * the same from source, from the bundle, and inside Docker, with no bundler
 * support for worker entry points required.
 *
 * While the build runs, the helper holds SQLite's write lock. Reads on the
 * daemon connection proceed (WAL), writes wait up to the daemon's busy_timeout
 * and then fail with SQLITE_BUSY. The server gates HTTP writes with a 503
 * for that window.
 */
export async function buildContentChunksIndexInHelperProcess(
  dbPath: string,
  opts: { execPath?: string } = {},
): Promise<{ elapsedMs: number }> {
  const started = performance.now();
  const proc = Bun.spawn([opts.execPath ?? process.execPath, "-e", HELPER_SCRIPT], {
    env: { ...process.env, AGENT_FS_INDEX_DB_PATH: dbPath },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `index helper exited with code ${exitCode} building ${CONTENT_CHUNKS_INDEX_NAME}: ${stderr.trim()}`,
    );
  }
  return { elapsedMs: Math.round(performance.now() - started) };
}
