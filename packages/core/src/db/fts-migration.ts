import { Database } from "bun:sqlite";
import { FTS_SCHEMA_SQL } from "./raw.js";

/**
 * One-time migration of the full-text index from the pre-0.13.1 layout
 * (FTS5 table with internal content) to the external-content layout over
 * `files_fts_docs` (see FTS_SCHEMA_SQL).
 *
 * Why this is not a plain startup migration: the old index holds a full copy
 * of every indexed file. Re-tokenizing it takes about a minute per GB on a
 * laptop and many minutes on a small cloud VM. Doing that inside
 * `createDatabase()` would keep the daemon from answering `/health` for the
 * whole time and, if the host kills the process meanwhile, the work would be
 * lost and retried forever. So the migration is split:
 *
 *   1. `prepareFtsMigration()` (sync, instant): renames the old table to
 *      `files_fts_legacy` and creates the new empty index plus triggers. From
 *      this moment every write goes to the new layout.
 *   2. `runFtsMigration()` (async, batched, resumable): copies the legacy rows
 *      into `files_fts_docs` in small committed batches, yielding to the event
 *      loop between them, then drops the legacy table. The cursor lives in the
 *      `meta` table, so a restart resumes where it stopped.
 *
 * While `files_fts_legacy` exists, `ftsQuery` and `grep` read both tables
 * (new rows win), so search stays whole during the copy.
 *
 * Only the daemon calls these. `createDatabase()` deliberately leaves a legacy
 * table untouched so that a newer CLI binary cannot rename it under an older
 * daemon that is still running against the same file.
 */

export const LEGACY_FTS_TABLE = "files_fts_legacy";
const CURSOR_KEY = "fts_migration_cursor";
/** Present in `meta` while the FTS5 crisismerge option is raised for the copy. */
const TUNING_KEY = "fts_migration_tuning";
const DEFAULT_BATCH_SIZE = 50;
// Tokenizing is the expensive part of a batch, and it scales with bytes, not
// rows. Cap each committed batch by content size so one batch stays short
// (512 KB is roughly 100 ms on a laptop) even on a throttled VM.
const DEFAULT_BATCH_BYTES = 512 * 1024;
// FTS5 writes one b-tree segment per committed batch. With the default
// crisismerge of 16, every 16th commit at a level merges that whole level at
// once, which at GB scale blocks for many seconds. Raising it for the copy
// leaves the merging to the incremental automerge (bounded work per commit);
// it is restored afterwards. Well below FTS5's hard 2000-segment limit.
const COPY_CRISISMERGE = 1000;
const DEFAULT_CRISISMERGE = 16;

/** `true` while `files_fts` is still the old internal-content table. */
export function isLegacyFtsTable(sqlite: Database): boolean {
  const row = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files_fts'"
    )
    .get() as { sql: string } | null;
  return !!row && !/content\s*=/i.test(row.sql);
}

// A legacy table only ever disappears, so once a connection has seen it gone
// there is no need to ask sqlite_master again on every query.
const legacyGone = new WeakSet<Database>();

/** `true` while a renamed legacy table still awaits copying. */
export function hasLegacyFts(sqlite: Database): boolean {
  if (legacyGone.has(sqlite)) return false;
  const row = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(LEGACY_FTS_TABLE);
  if (!row) legacyGone.add(sqlite);
  return !!row;
}

function metaHas(sqlite: Database, key: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM meta WHERE key = ?").get(key);
}

/** `true` while `runFtsMigration()` still has work to do (copy or cleanup). */
export function ftsMigrationPending(sqlite: Database): boolean {
  return hasLegacyFts(sqlite) || metaHas(sqlite, TUNING_KEY);
}

/**
 * Step 1. Rename a legacy `files_fts` out of the way and install the new
 * external-content index. Idempotent and instant (DDL only).
 *
 * Returns `true` when `runFtsMigration()` has work left to do.
 */
export function prepareFtsMigration(sqlite: Database): boolean {
  sqlite.transaction(() => {
    if (isLegacyFtsTable(sqlite)) {
      sqlite.exec(`ALTER TABLE files_fts RENAME TO ${LEGACY_FTS_TABLE}`);
      legacyGone.delete(sqlite);
    }
    sqlite.exec(FTS_SCHEMA_SQL);
  })();
  return ftsMigrationPending(sqlite);
}

export interface FtsMigrationResult {
  /** Rows copied into the new index. */
  copied: number;
  /** Legacy rows skipped: file deleted, or already re-indexed since the rename. */
  skipped: number;
}

export interface FtsMigrationOptions {
  /** Rows fetched from the legacy table per round trip. */
  batchSize?: number;
  /** Content bytes committed per transaction (one oversized row is its own batch). */
  batchBytes?: number;
  log?: (msg: string) => void;
}

/**
 * Step 2. Copy legacy rows into `files_fts_docs` in batches and drop the
 * legacy table. Safe to call when there is nothing to migrate.
 *
 * Each batch is one short transaction that also advances the cursor, so the
 * copy survives a crash or restart at any point. Rows whose file was deleted,
 * or that were written again after the rename (already present in
 * `files_fts_docs`), are skipped: the new layout is the source of truth.
 */
export async function runFtsMigration(
  sqlite: Database,
  opts: FtsMigrationOptions = {}
): Promise<FtsMigrationResult> {
  const result: FtsMigrationResult = { copied: 0, skipped: 0 };
  if (!ftsMigrationPending(sqlite)) return result;
  const log = opts.log ?? (() => {});

  if (hasLegacyFts(sqlite)) {
    await copyLegacyRows(sqlite, result, opts);
  }

  // Restore the merge setting. Also runs when this is all that is left over
  // from a process that died between the copy and the restore.
  sqlite.transaction(() => {
    setCrisismerge(sqlite, DEFAULT_CRISISMERGE);
    sqlite.prepare("DELETE FROM meta WHERE key = ?").run(TUNING_KEY);
  })();

  log(
    `search index migration: done, ${result.copied} copied, ${result.skipped} skipped`
  );
  return result;
}

function setCrisismerge(sqlite: Database, value: number): void {
  sqlite
    .prepare("INSERT INTO files_fts(files_fts, rank) VALUES ('crisismerge', ?)")
    .run(value);
}

type LegacyRow = { rowid: number; drive_id: string; path: string; content: string };

async function copyLegacyRows(
  sqlite: Database,
  result: FtsMigrationResult,
  opts: FtsMigrationOptions
): Promise<void> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchBytes = opts.batchBytes ?? DEFAULT_BATCH_BYTES;
  const log = opts.log ?? (() => {});

  sqlite.transaction(() => {
    setCrisismerge(sqlite, COPY_CRISISMERGE);
    sqlite
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, '1')")
      .run(TUNING_KEY);
  })();

  const readCursor = sqlite.prepare("SELECT value FROM meta WHERE key = ?");
  const writeCursor = sqlite.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const selectBatch = sqlite.prepare(
    `SELECT rowid, drive_id, path, content FROM ${LEGACY_FTS_TABLE} WHERE rowid > ? ORDER BY rowid LIMIT ?`
  );
  const isLive = sqlite.prepare(
    "SELECT 1 FROM files WHERE drive_id = ? AND path = ? AND is_deleted = 0"
  );
  const docExists = sqlite.prepare(
    "SELECT 1 FROM files_fts_docs WHERE drive_id = ? AND path = ?"
  );
  const insertDoc = sqlite.prepare(
    "INSERT INTO files_fts_docs(drive_id, path, content) VALUES (?, ?, ?)"
  );

  let cursor = Number(
    (readCursor.get(CURSOR_KEY) as { value: string } | null)?.value ?? 0
  );
  log(`search index migration: starting at legacy rowid ${cursor}`);

  const copyBatch = sqlite.transaction((rows: LegacyRow[]) => {
    for (const row of rows) {
      // Skip files deleted since, and files re-indexed since the rename
      // (the docs row is newer than the legacy one).
      if (
        !isLive.get(row.drive_id, row.path) ||
        docExists.get(row.drive_id, row.path)
      ) {
        result.skipped++;
        continue;
      }
      insertDoc.run(row.drive_id, row.path, row.content);
      result.copied++;
    }
    cursor = rows[rows.length - 1].rowid;
    writeCursor.run(CURSOR_KEY, String(cursor));
  });

  let sinceLog = 0;
  for (;;) {
    const rows = selectBatch.all(cursor, batchSize) as LegacyRow[];
    if (rows.length === 0) break;

    // Commit in slices that stay under the byte budget (a single oversized
    // row is its own slice), yielding to the event loop after each one.
    let start = 0;
    while (start < rows.length) {
      let end = start;
      let bytes = 0;
      do {
        bytes += rows[end].content.length;
        end++;
      } while (end < rows.length && bytes + rows[end].content.length <= batchBytes);
      copyBatch(rows.slice(start, end));
      start = end;
      await Bun.sleep(0);
    }

    sinceLog += rows.length;
    if (sinceLog >= 1000) {
      sinceLog = 0;
      log(
        `search index migration: ${result.copied} copied, ${result.skipped} skipped (legacy rowid ${cursor})`
      );
    }
  }

  // Dropping the legacy table frees its pages in one synchronous step. That
  // is a single scan of the old index, about what one write used to cost.
  sqlite.transaction(() => {
    sqlite.exec(`DROP TABLE ${LEGACY_FTS_TABLE}`);
    sqlite.prepare("DELETE FROM meta WHERE key = ?").run(CURSOR_KEY);
  })();
  legacyGone.add(sqlite);
}
