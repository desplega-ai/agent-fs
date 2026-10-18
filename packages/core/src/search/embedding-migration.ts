import { getEmbeddingExcludeDrives, getEmbeddingMaxBytes } from "../config.js";
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { getS3Key } from "../ops/versioning.js";
import { extractIndexableText, detectMimeType } from "../ops/mime.js";
import {
  clearEmbeddings,
  indexFileEmbeddings,
  withEmbeddingSlot,
  withEmbeddingMigrationSlot,
} from "./pipeline.js";

/**
 * Re-embeds stored files when their vectors stop matching what the running
 * server writes:
 *
 *   1. `prepareEmbeddingMigrationWithWarmup()` (at boot): when the provider or
 *      the vector format differs from the one recorded in `meta`, it first
 *      embeds one query, so a provider that cannot load changes nothing. Then
 *      `prepareEmbeddingMigration()` deletes image chunks and their vectors
 *      when the format changes. It also resets image statuses and marks every
 *      indexed file `pending`. The `reindex` op skips indexed files, so only
 *      this path refreshes them. Once per `FAILED_RETRY` and format, it also
 *      marks `failed` files `pending`: nothing else retries them.
 *      It also marks NULL-status PDFs pending for a one-time text backfill.
 *   2. `runPendingEmbeddings()` (async, in the background): embeds every
 *      `pending` file again. A crash leaves the rest `pending`, so the next
 *      boot resumes. It also picks up files whose on-write job never ran.
 *
 * Search keeps working meanwhile. Old and new vectors rank together until the
 * run ends.
 */

export const FORMAT_KEY = "embedding_format";
export const MAX_BYTES_KEY = "embedding_max_bytes";
export const EXCLUDE_DRIVES_KEY = "embedding_exclude_drives";

/**
 * Bump a provider's revision whenever its stored vectors must be rebuilt.
 * v2: unit length. local v3: chunks over 512 tokens embedded in one batch.
 */
const REVISIONS: Record<string, number> = { local: 3 };

const FAILED_RETRY_KEY = "embedding_failed_retry";

/**
 * Bump to retry every `failed` file once more on the next boot, after a fix
 * to the embedding path. 1: empty text, and OpenAI requests over its limits.
 */
const FAILED_RETRY = 1;

export function embeddingFormat(provider: EmbeddingProvider): string {
  return `${provider.name}:v${REVISIONS[provider.name] ?? 2}`;
}

export function storedFormat(sqlite: Database): string | undefined {
  const row = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(FORMAT_KEY) as { value: string } | null;
  return row?.value;
}

export function hasChunks(sqlite: Database): boolean {
  return !!sqlite.prepare("SELECT 1 FROM content_chunks LIMIT 1").get();
}

/** Warm the provider before a format change. A failed warmup leaves the index unchanged. */
export async function prepareEmbeddingMigrationWithWarmup(sqlite: Database, provider: EmbeddingProvider): Promise<boolean> {
  if (storedFormat(sqlite) !== embeddingFormat(provider)) {
    try {
      await provider.embedQuery("warmup");
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
      console.error(`[agent-fs] Embedding warmup failed. Migration skipped: ${message}`);
      return false;
    }
  }
  return prepareEmbeddingMigration(sqlite, provider);
}

/** Returns `true` when `runPendingEmbeddings()` has files to embed. */
export function prepareEmbeddingMigration(sqlite: Database, provider: EmbeddingProvider): boolean {
  const format = embeddingFormat(provider);
  const setMeta = sqlite.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  if (storedFormat(sqlite) !== format) {
    sqlite.transaction(() => {
      sqlite
        .prepare("UPDATE files SET embedding_status = 'pending' WHERE embedding_status IN ('indexed', 'skipped') AND is_deleted = 0")
        .run();
      sqlite.prepare("DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM content_chunks WHERE kind = 'image')").run();
      sqlite.prepare("DELETE FROM content_chunks WHERE kind = 'image'").run();
      sqlite.prepare("UPDATE files SET image_embedding_status = NULL").run();
      setMeta.run(FORMAT_KEY, format);
    })();
  }

  const maxBytes = getEmbeddingMaxBytes();
  const excludedDrives = getEmbeddingExcludeDrives();
  const settings = [
    { key: MAX_BYTES_KEY, value: maxBytes === undefined ? "" : String(maxBytes), fallback: "" },
    { key: EXCLUDE_DRIVES_KEY, value: JSON.stringify(excludedDrives), fallback: "[]" },
  ].map((setting) => {
    const stored = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(setting.key) as { value: string } | null;
    const previous = stored?.value ?? setting.fallback;
    return { ...setting, previous, changed: previous !== setting.value };
  });
  let previousDrives: string[] = [];
  try {
    const parsed = JSON.parse(settings[1].previous);
    if (Array.isArray(parsed)) previousDrives = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // A malformed list must not prevent startup.
  }
  const addedDrives = JSON.stringify(excludedDrives.filter((id) => !previousDrives.includes(id)));
  const removedDrives = JSON.stringify(previousDrives.filter((id) => !excludedDrives.includes(id)));
  sqlite.transaction(() => {
    if (settings[0].changed) {
      sqlite.prepare(
        `UPDATE files SET embedding_status = 'pending'
         WHERE is_deleted = 0 AND drive_id NOT IN (SELECT value FROM json_each(?)) AND (
           embedding_status = 'skipped' OR (
             embedding_status = 'indexed' AND COALESCE((
               SELECT octet_length(d.content) FROM files_fts_docs d
               WHERE d.drive_id = files.drive_id AND d.path = files.path
             ), CASE WHEN content_type = 'application/pdf' THEN 0 ELSE size END) > ?
           ) OR (
             embedding_status IS NULL AND ? IS NOT NULL AND EXISTS (
               SELECT 1 FROM files_fts_docs d
               WHERE d.drive_id = files.drive_id AND d.path = files.path
                 AND octet_length(d.content) > ?
             )
           )
         )`
      ).run(JSON.stringify(excludedDrives), maxBytes ?? Number.MAX_SAFE_INTEGER, maxBytes ?? null, maxBytes ?? null);
    }
    if (settings[1].changed) {
      sqlite.prepare(
        `UPDATE files SET embedding_status = 'pending'
         WHERE is_deleted = 0 AND drive_id IN (SELECT value FROM json_each(?))
           AND embedding_status IN ('indexed', 'pending', 'failed')`
      ).run(addedDrives);
      sqlite.prepare(
        `UPDATE files SET embedding_status = 'pending'
         WHERE is_deleted = 0 AND drive_id IN (SELECT value FROM json_each(?)) AND embedding_status = 'skipped'`
      ).run(removedDrives);
      sqlite.prepare(
        `DELETE FROM chunk_vectors WHERE chunk_id IN (
           SELECT id FROM content_chunks WHERE kind = 'image' AND drive_id IN (SELECT value FROM json_each(?))
         )`
      ).run(addedDrives);
      sqlite.prepare("DELETE FROM content_chunks WHERE kind = 'image' AND drive_id IN (SELECT value FROM json_each(?))").run(addedDrives);
      sqlite.prepare("UPDATE files SET image_embedding_status = NULL WHERE drive_id IN (SELECT value FROM json_each(?))").run(addedDrives);
    }
    for (const setting of settings) setMeta.run(setting.key, setting.value);
  })();

  // Keyed by format too: a new provider gets its own try at old failures.
  const retry = `${format}#${FAILED_RETRY}`;
  const retried = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(FAILED_RETRY_KEY) as
    | { value: string }
    | null;
  if (retried?.value !== retry) {
    sqlite.transaction(() => {
      sqlite
        .prepare("UPDATE files SET embedding_status = 'pending' WHERE embedding_status = 'failed' AND is_deleted = 0")
        .run();
      setMeta.run(FAILED_RETRY_KEY, retry);
    })();
  }

  // A processed PDF always ends indexed, skipped or failed, so IS NULL selects only PDFs that still need the backfill.
  // See indexFileEmbeddings.pageStarts for the terminal PDF status rule.
  sqlite
    .prepare(
      "UPDATE files SET embedding_status = 'pending' " +
        "WHERE embedding_status IS NULL AND is_deleted = 0 AND content_type = 'application/pdf'"
    )
    .run();

  return !!sqlite
    .prepare("SELECT 1 FROM files WHERE embedding_status = 'pending' AND is_deleted = 0 LIMIT 1")
    .get();
}

export interface PendingEmbeddingsResult {
  indexed: number;
  failed: number;
  /** Files in excluded drives, over either size limit, or with no text eligible for embedding. */
  skipped: number;
  /** Files written again during the run; the write's own job embeds them. */
  superseded: number;
}

type PendingRow = { orgId: string; driveId: string; path: string; version: string | null };

export const DEFAULT_CPU_SHARE = 0.25;
const MAX_PAUSE_MS = 30_000;

/**
 * Share of CPU time the migration may use, from
 * `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE`. A number above 0 and at most 1;
 * anything else gives the default. 1 runs without pauses.
 */
export function migrationCpuShare(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return raw?.trim() && value > 0 && value <= 1 ? value : DEFAULT_CPU_SHARE;
}

/** Process CPU time (user + system) in milliseconds. */
export function processCpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/** Pause after `cpuUsedMs` of work so the work uses at most `cpuShare` of CPU time. */
export function pauseForCpuShare(cpuUsedMs: number, cpuShare: number): number {
  return Math.min(MAX_PAUSE_MS, (cpuUsedMs * (1 - cpuShare)) / cpuShare);
}

export interface PendingEmbeddingsOptions {
  batchSize?: number;
  log?: (msg: string) => void;
  /**
   * After each file, pause so the migration uses at most this share of CPU time.
   * Full speed can exhaust the CPU quota on a small shared host and slow requests.
   * Defaults to 0.25. 1 runs without pauses.
   */
  cpuShare?: number;
  cpuMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Reserve the migration slot before warmup, so writes cannot start image work during startup. */
export function runEmbeddingMigration(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: PendingEmbeddingsOptions & { afterMigration?: () => void | Promise<void> } = {}
): Promise<PendingEmbeddingsResult | null> {
  return withEmbeddingMigrationSlot(db, async () => {
    const sqlite = (db as any).$client as Database;
    try {
      if (!await prepareEmbeddingMigrationWithWarmup(sqlite, provider)) return null;
      return await runPendingEmbeddingsUnlocked(db, s3, provider, opts);
    } finally {
      await opts.afterMigration?.();
    }
  });
}

export function runPendingEmbeddings(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: PendingEmbeddingsOptions = {}
): Promise<PendingEmbeddingsResult> {
  return withEmbeddingMigrationSlot(db, () => runPendingEmbeddingsUnlocked(db, s3, provider, opts));
}

async function runPendingEmbeddingsUnlocked(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: PendingEmbeddingsOptions = {}
): Promise<PendingEmbeddingsResult> {
  const sqlite = (db as any).$client as Database;
  const batchSize = opts.batchSize ?? 50;
  const log = opts.log ?? (() => {});
  const cpuShare = opts.cpuShare ?? DEFAULT_CPU_SHARE;
  const cpuMs = opts.cpuMs ?? processCpuMs;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const result: PendingEmbeddingsResult = { indexed: 0, failed: 0, skipped: 0, superseded: 0 };

  // One pass in key order. A row that a write queues again behind the cursor
  // is left to that write's own job, so the loop always ends.
  const selectBatch = sqlite.prepare(
    `SELECT drives.org_id AS orgId, files.drive_id AS driveId, files.path AS path,
            files.current_version_id AS version
     FROM files INNER JOIN drives ON drives.id = files.drive_id
     WHERE files.embedding_status = 'pending' AND files.is_deleted = 0
       AND (files.drive_id, files.path) > (?, ?)
     ORDER BY files.drive_id, files.path
     LIMIT ?`
  );
  // Only while the row still holds the version that was read.
  const setStatus = sqlite.prepare(
    `UPDATE files SET embedding_status = ?
     WHERE drive_id = ? AND path = ? AND embedding_status = 'pending' AND current_version_id IS ?`
  );

  let cursor: [string, string] = ["", ""];

  for (;;) {
    const rows = selectBatch.all(cursor[0], cursor[1], batchSize) as PendingRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = [row.driveId, row.path];
      const cpuStart = cpuMs();
      try {
        if (getEmbeddingExcludeDrives().includes(row.driveId)) {
          result[await indexFileEmbeddings(db, provider, { ...row, content: "" })]++;
          continue;
        }
        const object = await s3.getObject(getS3Key(row.orgId, row.driveId, row.path));
        const extracted = await extractIndexableText(
          object.body,
          object.contentType ?? detectMimeType(row.path)
        );
        // Nothing to embed: drop chunks of an older, text version too.
        if (extracted === null) {
          if (clearEmbeddings(db, row, "text")) result.skipped++;
          else result.superseded++;
          continue;
        }
        const outcome = await withEmbeddingSlot(() =>
          indexFileEmbeddings(db, provider, {
            path: row.path,
            driveId: row.driveId,
            content: extracted.text,
            pageStarts: extracted.pageStarts,
            refreshFts: extracted.pageStarts !== undefined,
            version: row.version,
          })
        );
        result[outcome]++;
      } catch (err) {
        // indexFileEmbeddings marks its own failures; this covers the read.
        setStatus.run("failed", row.driveId, row.path, row.version);
        result.failed++;
        log(`embedding failed for ${row.path}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // CPU used / pause = share / (1 - share). Requests run during the pause.
        const pauseMs = pauseForCpuShare(cpuMs() - cpuStart, cpuShare);
        if (pauseMs >= 1) await sleep(pauseMs);
      }
    }

    log(
      `embedding migration: ${result.indexed} embedded, ${result.failed} failed, ${result.skipped} skipped, ${result.superseded} superseded`
    );
  }

  return result;
}
