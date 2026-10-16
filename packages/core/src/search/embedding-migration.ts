import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { getS3Key } from "../ops/versioning.js";
import { decodeIndexableText, detectMimeType } from "../ops/mime.js";
import { indexFileEmbeddings, withEmbeddingSlot } from "./pipeline.js";

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
  /** Files with no indexable text; their status is cleared. */
  skipped: number;
}

type PendingRow = { orgId: string; driveId: string; path: string };

export async function runPendingEmbeddings(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: { batchSize?: number; log?: (msg: string) => void } = {}
): Promise<PendingEmbeddingsResult> {
  const sqlite = (db as any).$client as Database;
  const batchSize = opts.batchSize ?? 50;
  const log = opts.log ?? (() => {});
  const result: PendingEmbeddingsResult = { indexed: 0, failed: 0, skipped: 0 };

  const selectBatch = sqlite.prepare(
    `SELECT drives.org_id AS orgId, files.drive_id AS driveId, files.path AS path
     FROM files INNER JOIN drives ON drives.id = files.drive_id
     WHERE files.embedding_status = 'pending' AND files.is_deleted = 0
     LIMIT ?`
  );
  const setStatus = sqlite.prepare(
    "UPDATE files SET embedding_status = ? WHERE drive_id = ? AND path = ? AND embedding_status = 'pending'"
  );

  // A row that stays `pending` after its attempt (a concurrent write queued it
  // again) must not keep the loop alive.
  const attempted = new Set<string>();

  for (;;) {
    const rows = (selectBatch.all(batchSize) as PendingRow[]).filter(
      (row) => !attempted.has(`${row.driveId}\0${row.path}`)
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      attempted.add(`${row.driveId}\0${row.path}`);
      try {
        const object = await s3.getObject(getS3Key(row.orgId, row.driveId, row.path));
        const content = decodeIndexableText(
          object.body,
          object.contentType ?? detectMimeType(row.path)
        );
        if (content === null) {
          setStatus.run(null, row.driveId, row.path);
          result.skipped++;
          continue;
        }
        await withEmbeddingSlot(() =>
          indexFileEmbeddings(db, provider, { path: row.path, driveId: row.driveId, content })
        );
        result.indexed++;
      } catch {
        // indexFileEmbeddings marks its own failures; this covers the read.
        setStatus.run("failed", row.driveId, row.path);
        result.failed++;
      }
    }

    log(
      `embedding migration: ${result.indexed} embedded, ${result.failed} failed, ${result.skipped} skipped`
    );
  }

  return result;
}
