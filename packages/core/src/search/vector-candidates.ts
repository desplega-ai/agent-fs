import { and, eq, inArray } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema, type DB } from "../db/index.js";
import { QUANTIZED_TABLE, isQuantizedIndexReady } from "./quantized-index.js";

const MAX_KNN_RESULTS = 4096;
/** Chunks fetched per file still needed; files often match with several chunks. */
const OVERFETCH = 8;
/** Coarse candidates from the int8 index, before exact rescoring. */
const MIN_QUANTIZED_CANDIDATES = 200;
const QUANTIZED_CANDIDATES_PER_RESULT = 20;

export interface VectorCandidate {
  path: string;
  distance: number;
  snippet: string;
  author: string;
  modifiedAt: Date;
}

type ChunkHit = { chunk_id: number; distance: number };

export function findVectorCandidates(
  db: DB,
  driveId: string,
  queryVector: Float32Array,
  limit: number
): VectorCandidate[] {
  const raw = (db as any).$client as Database;
  return isQuantizedIndexReady(raw)
    ? findWithQuantizedIndex(db, raw, driveId, queryVector, limit)
    : findExact(db, raw, driveId, queryVector, limit);
}

/**
 * Exact scan of every stored vector. Each scan reads the whole table, so the
 * first one fetches `OVERFETCH` chunks per wanted file, and later ones (only
 * when a few files hold most of the nearest chunks) skip the files already
 * taken.
 */
function findExact(
  db: DB,
  raw: Database,
  driveId: string,
  queryVector: Float32Array,
  limit: number
): VectorCandidate[] {
  const candidates: VectorCandidate[] = [];
  const selectedPaths = new Set<string>();

  while (candidates.length < limit) {
    const k = Math.min((limit - candidates.length) * OVERFETCH, MAX_KNN_RESULTS);
    const hits = raw
      .prepare(
        `SELECT chunk_id, distance
         FROM chunk_vectors
         WHERE embedding MATCH ?
           AND chunk_id IN (
             SELECT chunks.id
             FROM content_chunks AS chunks
             INNER JOIN files
               ON files.drive_id = chunks.drive_id
              AND files.path = chunks.file_path
             WHERE chunks.drive_id = ?
               AND files.is_deleted = 0
               AND chunks.file_path NOT IN (
                 SELECT value FROM json_each(?)
               )
           )
         ORDER BY distance
         LIMIT ?`
      )
      .all(queryVector, driveId, JSON.stringify([...selectedPaths]), k) as ChunkHit[];

    if (hits.length === 0) break;
    const before = candidates.length;
    addDistinctFiles(db, driveId, hits, limit, candidates, selectedPaths);
    // Fewer hits than asked for: every remaining chunk was seen.
    if (hits.length < k || candidates.length === before) break;
  }

  return candidates;
}

/**
 * Coarse search in the int8 index (this drive's partition only), then exact
 * float distances for the candidates. Widens the coarse set when it holds too
 * few distinct files.
 */
function findWithQuantizedIndex(
  db: DB,
  raw: Database,
  driveId: string,
  queryVector: Float32Array,
  limit: number
): VectorCandidate[] {
  const coarse = raw.prepare(
    `SELECT chunk_id FROM ${QUANTIZED_TABLE}
     WHERE embedding MATCH vec_quantize_int8(?, 'unit') AND k = ? AND drive_id = ?`
  );
  const getVector = raw.prepare("SELECT embedding FROM chunk_vectors WHERE chunk_id = ?");

  let k = Math.min(
    Math.max(limit * QUANTIZED_CANDIDATES_PER_RESULT, MIN_QUANTIZED_CANDIDATES),
    MAX_KNN_RESULTS
  );
  for (;;) {
    const ids = (coarse.all(queryVector, k, driveId) as { chunk_id: number }[]).map(
      (row) => row.chunk_id
    );
    const hits: ChunkHit[] = [];
    for (const id of ids) {
      const row = getVector.get(id) as { embedding: Uint8Array } | null;
      if (!row) continue;
      hits.push({ chunk_id: id, distance: l2Distance(queryVector, row.embedding) });
    }
    hits.sort((a, b) => a.distance - b.distance);

    const candidates: VectorCandidate[] = [];
    addDistinctFiles(db, driveId, hits, limit, candidates, new Set());
    if (candidates.length >= limit || ids.length < k || k === MAX_KNN_RESULTS) {
      return candidates;
    }
    k = Math.min(k * 4, MAX_KNN_RESULTS);
  }
}

function l2Distance(query: Float32Array, stored: Uint8Array): number {
  const vec = new Float32Array(stored.buffer, stored.byteOffset, stored.byteLength / 4);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const diff = query[i] - vec[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Appends the first live chunk of each new file, in distance order. */
function addDistinctFiles(
  db: DB,
  driveId: string,
  hits: ChunkHit[],
  limit: number,
  candidates: VectorCandidate[],
  selectedPaths: Set<string>
): void {
  if (hits.length === 0) return;
  const matches = db
    .select({
      id: schema.contentChunks.id,
      path: schema.contentChunks.filePath,
      content: schema.contentChunks.content,
      author: schema.files.author,
      modifiedAt: schema.files.modifiedAt,
    })
    .from(schema.contentChunks)
    .innerJoin(
      schema.files,
      and(
        eq(schema.files.driveId, schema.contentChunks.driveId),
        eq(schema.files.path, schema.contentChunks.filePath)
      )
    )
    .where(
      and(
        inArray(
          schema.contentChunks.id,
          hits.map((hit) => hit.chunk_id)
        ),
        eq(schema.contentChunks.driveId, driveId),
        eq(schema.files.isDeleted, false)
      )
    )
    .all();
  const matchesById = new Map(matches.map((match) => [match.id, match]));

  for (const hit of hits) {
    if (candidates.length === limit) break;
    const match = matchesById.get(hit.chunk_id);
    if (!match || selectedPaths.has(match.path)) continue;

    selectedPaths.add(match.path);
    candidates.push({
      path: match.path,
      distance: hit.distance,
      snippet: match.content.slice(0, 200),
      author: match.author,
      modifiedAt: match.modifiedAt,
    });
  }
}
