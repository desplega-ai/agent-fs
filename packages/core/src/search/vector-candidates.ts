import { and, eq, inArray } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema, type DB } from "../db/index.js";

const MAX_KNN_RESULTS = 4096;

export interface VectorCandidate {
  path: string;
  distance: number;
  snippet: string;
  author: string;
  modifiedAt: Date;
}

export function findVectorCandidates(
  db: DB,
  driveId: string,
  queryVector: Float32Array,
  limit: number
): VectorCandidate[] {
  const raw = (db as any).$client as Database;
  const candidates: VectorCandidate[] = [];
  const selectedPaths = new Set<string>();

  while (candidates.length < limit) {
    const countBeforeRound = candidates.length;
    const remaining = limit - candidates.length;
    const vectorRows = raw
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
      .all(
        queryVector,
        driveId,
        JSON.stringify([...selectedPaths]),
        Math.min(remaining, MAX_KNN_RESULTS)
      ) as Array<{ chunk_id: number; distance: number }>;

    if (vectorRows.length === 0) break;

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
            vectorRows.map((row) => row.chunk_id)
          ),
          eq(schema.contentChunks.driveId, driveId),
          eq(schema.files.isDeleted, false)
        )
      )
      .all();
    const matchesById = new Map(matches.map((match) => [match.id, match]));

    for (const vectorRow of vectorRows) {
      const match = matchesById.get(vectorRow.chunk_id);

      if (!match || selectedPaths.has(match.path)) continue;

      selectedPaths.add(match.path);
      candidates.push({
        path: match.path,
        distance: vectorRow.distance,
        snippet: match.content.slice(0, 200),
        author: match.author,
        modifiedAt: match.modifiedAt,
      });

      if (candidates.length === limit) break;
    }

    if (candidates.length === countBeforeRound) break;
  }

  return candidates;
}
