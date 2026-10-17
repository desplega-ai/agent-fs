import { and, eq, inArray } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema, type DB } from "../db/index.js";
import { runKnn, type ChunkHit } from "./vector-worker.js";
import type { ChunkKind } from "./pipeline.js";

const MAX_KNN_RESULTS = 4096;
/** Chunks fetched per file still needed; files often match with several chunks. */
const OVERFETCH = 8;

export interface VectorCandidate {
  path: string;
  distance: number;
  snippet: string;
  page?: number;
  kind?: ChunkKind;
  author: string;
  modifiedAt: Date;
}

/**
 * Exact scan of every stored vector. Each scan reads the whole table, so the
 * first one fetches `OVERFETCH` chunks per wanted file, and later ones (only
 * when a few files hold most of the nearest chunks) skip the files already
 * taken. The scan runs on the vector search worker when the server started
 * one (see `vector-worker.ts`).
 */
export async function findVectorCandidates(
  db: DB,
  driveId: string,
  queryVector: Float32Array,
  limit: number
): Promise<VectorCandidate[]> {
  const raw = (db as any).$client as Database;
  const candidates: VectorCandidate[] = [];
  const selectedPaths = new Set<string>();

  while (candidates.length < limit) {
    const k = Math.min((limit - candidates.length) * OVERFETCH, MAX_KNN_RESULTS);
    const hits = await runKnn(raw, {
      query: queryVector,
      driveId,
      excludedPaths: [...selectedPaths],
      k,
    });

    if (hits.length === 0) break;
    const before = candidates.length;
    addDistinctFiles(db, driveId, hits, limit, candidates, selectedPaths);
    // Fewer hits than asked for: every remaining chunk was seen.
    if (hits.length < k || candidates.length === before) break;
  }

  return candidates;
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
      page: schema.contentChunks.page,
      kind: schema.contentChunks.kind,
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
      snippet: match.kind === "image"
        ? match.page === null ? "[image]" : `[PDF page ${match.page}]`
        : match.content.slice(0, 200),
      page: match.page ?? undefined,
      kind: match.kind,
      author: match.author,
      modifiedAt: match.modifiedAt,
    });
  }
}
