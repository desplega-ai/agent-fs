import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { getS3Key } from "../ops/versioning.js";
import { decodeIndexableText, detectMimeType } from "../ops/mime.js";
import {
  MAX_EMBED_CHARS,
  clearEmbeddings,
  indexFileEmbeddings,
  withEmbeddingSlot,
} from "./pipeline.js";

/**
 * Re-embeds stored files when their vectors stop matching what the running
 * server writes:
 *
 *   1. `prepareEmbeddingMigration()` (sync, at boot): when the provider or the
 *      vector format differs from the one recorded in `meta`, marks every
 *      indexed file `pending`. The `reindex` op skips indexed files, so this is
 *      the only path that refreshes them.
 *   2. `runPendingEmbeddings()` (async, in the background): embeds every
 *      `pending` file again. A crash leaves the rest `pending`, so the next
 *      boot resumes. It also picks up files whose on-write job never ran.
 *
 * Search keeps working meanwhile; old and new vectors rank together until the
 * run ends.
 */

const FORMAT_KEY = "embedding_format";

/** Bump the suffix whenever stored vectors must be rebuilt. v2: unit length. */
export function embeddingFormat(provider: EmbeddingProvider): string {
  return `${provider.name}:v2`;
}

/** Returns `true` when `runPendingEmbeddings()` has files to embed. */
export function prepareEmbeddingMigration(sqlite: Database, provider: EmbeddingProvider): boolean {
  const format = embeddingFormat(provider);
  const stored = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(FORMAT_KEY) as
    | { value: string }
    | null;

  if (stored?.value !== format) {
    sqlite.transaction(() => {
      sqlite
        .prepare("UPDATE files SET embedding_status = 'pending' WHERE embedding_status = 'indexed' AND is_deleted = 0")
        .run();
      sqlite
        .prepare(
          "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(FORMAT_KEY, format);
    })();
  }

  return !!sqlite
    .prepare("SELECT 1 FROM files WHERE embedding_status = 'pending' AND is_deleted = 0 LIMIT 1")
    .get();
}

export interface PendingEmbeddingsResult {
  indexed: number;
  failed: number;
  /** Files with no indexable text, or text over `MAX_EMBED_CHARS`; their status is cleared. */
  skipped: number;
  /** Files written again during the run; the write's own job embeds them. */
  superseded: number;
}

type PendingRow = { orgId: string; driveId: string; path: string; version: string | null };

const DEFAULT_CPU_SHARE = 0.25;
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
function processCpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

export async function runPendingEmbeddings(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: {
    batchSize?: number;
    log?: (msg: string) => void;
    /**
     * After each file, pause long enough that the migration uses at most this
     * share of CPU time. On a small shared-CPU host, a run at full speed uses
     * up the CPU quota and slows every request.
     */
    cpuShare?: number;
    cpuMs?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
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
        const object = await s3.getObject(getS3Key(row.orgId, row.driveId, row.path));
        const content = decodeIndexableText(
          object.body,
          object.contentType ?? detectMimeType(row.path)
        );
        if (content === null) {
          if (setStatus.run(null, row.driveId, row.path, row.version).changes > 0) result.skipped++;
          else result.superseded++;
          continue;
        }
        if (content.length > MAX_EMBED_CHARS) {
          if (clearEmbeddings(db, row)) result.skipped++;
          else result.superseded++;
          continue;
        }
        const replaced = await withEmbeddingSlot(() =>
          indexFileEmbeddings(db, provider, {
            path: row.path,
            driveId: row.driveId,
            content,
            version: row.version,
          })
        );
        if (replaced) result.indexed++;
        else result.superseded++;
      } catch {
        // indexFileEmbeddings marks its own failures; this covers the read.
        setStatus.run("failed", row.driveId, row.path, row.version);
        result.failed++;
      } finally {
        // CPU used / pause = share / (1 - share). Requests run during the pause.
        const pauseMs = Math.min(MAX_PAUSE_MS, ((cpuMs() - cpuStart) * (1 - cpuShare)) / cpuShare);
        if (pauseMs >= 1) await sleep(pauseMs);
      }
    }

    log(
      `embedding migration: ${result.indexed} embedded, ${result.failed} failed, ${result.skipped} skipped, ${result.superseded} superseded`
    );
  }

  return result;
}
