import { basename } from "node:path";
import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { chunkContent } from "./chunker.js";
import { toUnitVector } from "./vectors.js";
import { EmbeddingProviderError } from "../errors.js";

function getRawDb(db: DB): Database {
  return (db as any).$client as Database;
}

// Simple concurrency semaphore
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.permits--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const embeddingSemaphore = new Semaphore(2);

/** Run `fn` in one of the embedding slots shared with on-write embedding. */
export async function withEmbeddingSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await embeddingSemaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Text longer than this is not embedded. Chunking runs on the main thread, so
 * a 23 MB file blocked every request for many minutes on a small host. Its
 * batch would also exceed OpenAI's per-request limits.
 */
export const MAX_EMBED_CHARS = 2_000_000;

function deleteChunks(db: DB, params: { path: string; driveId: string }): void {
  const raw = getRawDb(db);
  const oldChunks = db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, params.path),
        eq(schema.contentChunks.driveId, params.driveId)
      )
    )
    .all();

  for (const chunk of oldChunks) {
    raw.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?").run(chunk.id);
  }

  db.delete(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, params.path),
        eq(schema.contentChunks.driveId, params.driveId)
      )
    )
    .run();
}

/**
 * Drops the file's chunks and clears its status, as for a file with no
 * indexable text. Does nothing and returns `false` when a newer write owns the
 * file (same `version` contract as `indexFileEmbeddings`).
 */
export function clearEmbeddings(
  db: DB,
  params: { path: string; driveId: string; version: string | null }
): boolean {
  return getRawDb(db).transaction(() => {
    if (readCurrentVersion(db, params) !== params.version) return false;
    deleteChunks(db, params);
    db.update(schema.files)
      .set({ embeddingStatus: null })
      .where(
        and(
          eq(schema.files.path, params.path),
          eq(schema.files.driveId, params.driveId)
        )
      )
      .run();
    return true;
  })();
}

/** The file's `current_version_id`, or `undefined` when the file is gone or deleted. */
export function readCurrentVersion(
  db: DB,
  params: { path: string; driveId: string }
): string | null | undefined {
  const file = db
    .select({
      currentVersionId: schema.files.currentVersionId,
      isDeleted: schema.files.isDeleted,
    })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.path, params.path),
        eq(schema.files.driveId, params.driveId)
      )
    )
    .get();
  if (!file || file.isDeleted) return undefined;
  return file.currentVersionId ?? null;
}

/**
 * Embeds `content` and replaces the file's chunks.
 *
 * `version` is the `files.current_version_id` the caller read before it read
 * `content`. If a newer write has landed since, or the file was deleted, the
 * job changes nothing and returns `false`: the newer write owns the chunks and
 * the status. The check and the whole replacement run in one transaction, so
 * a failed insert rolls back to the previous index.
 *
 * Text over `MAX_EMBED_CHARS`, or blank text, is not embedded: the job drops
 * the file's chunks, clears its status, and returns `false`.
 */
export async function indexFileEmbeddings(
  db: DB,
  provider: EmbeddingProvider,
  params: { path: string; driveId: string; content: string; version: string | null }
): Promise<boolean> {
  const raw = getRawDb(db);
  const isCurrent = () => readCurrentVersion(db, params) === params.version;

  if (!isCurrent()) return false;
  if (params.content.length > MAX_EMBED_CHARS) {
    clearEmbeddings(db, params);
    return false;
  }

  try {
    // 1. Chunk content. Blank text has nothing to embed, and providers reject
    // an empty request.
    const chunks = params.content.trim() === "" ? [] : await chunkContent(params.content);
    if (chunks.length === 0) {
      clearEmbeddings(db, params);
      return false;
    }

    // 2. Generate and validate embeddings FIRST (before any DB writes)
    const texts = chunks.map((c) => c.content);
    const embeddings = await provider.embedDocuments(texts, { title: basename(params.path) });
    if (embeddings.length !== chunks.length) {
      throw new EmbeddingProviderError(
        `Embedding provider returned ${embeddings.length} vectors for ${chunks.length} chunks`
      );
    }
    const vectors = embeddings.map((values) => toUnitVector(values, provider.dimensions));

    const insertVec = raw.prepare(
      "INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)"
    );

    return raw.transaction(() => {
      if (!isCurrent()) return false;

      // 3. Delete old chunks + vectors for this file
      deleteChunks(db, params);

      // 4. Insert new chunks + vectors (paired)
      for (let i = 0; i < chunks.length; i++) {
        const result = db
          .insert(schema.contentChunks)
          .values({
            filePath: params.path,
            driveId: params.driveId,
            chunkIndex: i,
            content: chunks[i].content,
            charOffset: chunks[i].charOffset,
            tokenCount: chunks[i].tokenCount,
          })
          .returning({ id: schema.contentChunks.id })
          .get();

        insertVec.run(result.id, vectors[i]);
      }

      // 5. Update embedding status
      db.update(schema.files)
        .set({ embeddingStatus: "indexed" })
        .where(
          and(
            eq(schema.files.path, params.path),
            eq(schema.files.driveId, params.driveId)
          )
        )
        .run();
      return true;
    })();
  } catch (err) {
    // A newer write is pending: its own job sets the status.
    if (!isCurrent()) return false;
    // Mark as failed but don't block
    db.update(schema.files)
      .set({ embeddingStatus: "failed" })
      .where(
        and(
          eq(schema.files.path, params.path),
          eq(schema.files.driveId, params.driveId)
        )
      )
      .run();
    throw err;
  }
}

export function scheduleEmbedding(
  db: DB,
  provider: EmbeddingProvider | null,
  params: { path: string; driveId: string; content: string }
): void {
  if (!provider) return;

  // Set pending synchronously so status is accurate during async window
  db.update(schema.files)
    .set({ embeddingStatus: "pending" })
    .where(
      and(
        eq(schema.files.path, params.path),
        eq(schema.files.driveId, params.driveId)
      )
    )
    .run();

  // Callers schedule after createVersion(), so this is the version of `content`.
  const version = readCurrentVersion(db, params);
  if (version === undefined) return;

  embeddingSemaphore.acquire().then(async (release) => {
    try {
      await indexFileEmbeddings(db, provider, { ...params, version });
    } catch (e) {
      console.error("Embedding failed", { path: params.path, error: e });
    } finally {
      release();
    }
  });
}
