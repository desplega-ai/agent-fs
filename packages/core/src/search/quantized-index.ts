import type { Database } from "bun:sqlite";

/**
 * Optional int8 copy of `chunk_vectors`, for faster vector search on large
 * drives. Each vector keeps one byte per dimension (768 bytes instead of 3 KB),
 * and its scan is partitioned by drive. Search takes a few hundred coarse
 * candidates from it, then ranks them by their exact float distance, so scores
 * stay exact. `chunk_vectors` stays the source of truth.
 *
 * Measured on an 82k-chunk drive with 20 real queries: about 130 ms instead
 * of about 400 ms, finding 95% of the exact top 10 files. A one-bit-per-
 * dimension index was much faster but found only 25%, so it is not offered.
 *
 * Off by default. `AGENT_FS_VECTOR_INDEX=int8` turns it on:
 *
 *   1. `prepareQuantizedIndex()` (sync, at boot) creates the table and a trigger that
 *      drops a chunk's row when the chunk is deleted. With the index off, it
 *      drops both, so nothing is left to go stale.
 *   2. `runQuantizedIndexBackfill()` (async, in the background) copies every stored
 *      vector in batches. Until it finishes, search uses the exact scan.
 *   3. New chunks are added by `insertQuantizedVector()` in the embedding pipeline.
 */

export type VectorIndexMode = "exact" | "int8";

export const QUANTIZED_TABLE = "chunk_vectors_int8";
const READY_KEY = "vec_int8_index";

const CREATE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${QUANTIZED_TABLE} USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  drive_id TEXT PARTITION KEY,
  embedding int8[768]
);
CREATE TRIGGER IF NOT EXISTS content_chunks_int8_delete AFTER DELETE ON content_chunks
BEGIN
  DELETE FROM ${QUANTIZED_TABLE} WHERE chunk_id = OLD.id;
END;
`;

const DROP_SQL = `
DROP TRIGGER IF EXISTS content_chunks_int8_delete;
DROP TABLE IF EXISTS ${QUANTIZED_TABLE};
DELETE FROM meta WHERE key = '${READY_KEY}';
`;

/** `int8` turns the index on; anything else keeps the exact scan only. */
export function vectorIndexMode(raw: string | undefined): VectorIndexMode {
  return raw?.trim().toLowerCase() === "int8" ? "int8" : "exact";
}

const enabled = new WeakMap<Database, boolean>();

/** Returns `true` when `runQuantizedIndexBackfill()` has rows to copy. */
export function prepareQuantizedIndex(sqlite: Database, mode: VectorIndexMode): boolean {
  if (mode === "exact") {
    sqlite.exec(DROP_SQL);
    enabled.set(sqlite, false);
    return false;
  }
  sqlite.exec(CREATE_SQL);
  enabled.set(sqlite, true);
  return !isQuantizedIndexReady(sqlite);
}

/** True once the backfill finished; until then search uses the exact scan. */
export function isQuantizedIndexReady(sqlite: Database): boolean {
  if (!enabled.get(sqlite)) return false;
  const row = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(READY_KEY) as
    | { value: string }
    | null;
  return row?.value === "ready";
}

/** Adds one chunk's vector. A no-op while the index is off. */
export function insertQuantizedVector(
  sqlite: Database,
  chunkId: number,
  driveId: string,
  vector: Float32Array
): void {
  if (!enabled.get(sqlite)) return;
  sqlite
    .prepare(
      `INSERT INTO ${QUANTIZED_TABLE}(chunk_id, drive_id, embedding) VALUES (?, ?, vec_quantize_int8(?, 'unit'))`
    )
    .run(chunkId, driveId, vector);
}

/**
 * Copies every stored vector that has no row yet, in committed batches, and
 * marks the index ready. A restart resumes: copied rows are skipped.
 */
export async function runQuantizedIndexBackfill(
  sqlite: Database,
  opts: { batchSize?: number; log?: (msg: string) => void; sleep?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const batchSize = opts.batchSize ?? 1000;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  const selectBatch = sqlite.prepare(
    "SELECT id, drive_id AS driveId FROM content_chunks WHERE id > ? ORDER BY id LIMIT ?"
  );
  const hasRow = sqlite.prepare(`SELECT 1 FROM ${QUANTIZED_TABLE} WHERE chunk_id = ?`);
  const getVector = sqlite.prepare("SELECT embedding FROM chunk_vectors WHERE chunk_id = ?");
  const insert = sqlite.prepare(
    `INSERT INTO ${QUANTIZED_TABLE}(chunk_id, drive_id, embedding) VALUES (?, ?, vec_quantize_int8(?, 'unit'))`
  );

  let cursor = 0;
  let copied = 0;
  for (;;) {
    const rows = selectBatch.all(cursor, batchSize) as { id: number; driveId: string }[];
    if (rows.length === 0) break;
    sqlite.transaction(() => {
      for (const row of rows) {
        if (hasRow.get(row.id)) continue;
        const vector = getVector.get(row.id) as { embedding: Uint8Array } | null;
        if (!vector) continue;
        insert.run(row.id, row.driveId, vector.embedding);
        copied++;
      }
    })();
    cursor = rows[rows.length - 1].id;
    log(`vector int8 index: ${copied} copied`);
    // Let requests run between batches.
    await sleep(1);
  }

  sqlite
    .prepare("INSERT INTO meta(key, value) VALUES (?, 'ready') ON CONFLICT(key) DO UPDATE SET value = 'ready'")
    .run(READY_KEY);
  return copied;
}
