import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { chunkContent } from "./chunker.js";
import { toUnitVector } from "./vectors.js";

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

function readCurrentVersion(
  db: DB,
  params: { path: string; driveId: string }
): string | null {
  const file = db
    .select({ currentVersionId: schema.files.currentVersionId })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.path, params.path),
        eq(schema.files.driveId, params.driveId)
      )
    )
    .get();
  return file?.currentVersionId ?? null;
}

/**
 * Embeds `content` and replaces the file's chunks.
 *
 * `version` is the `files.current_version_id` that `content` was read at. When
 * it is set and a newer write has landed since, the job changes nothing and
 * returns `false`: the newer write owns the chunks and the status. Every
 * statement after that check is synchronous, so no other job can run between
 * the check and the replace.
 */
export async function indexFileEmbeddings(
  db: DB,
  provider: EmbeddingProvider,
  params: { path: string; driveId: string; content: string; version?: string | null }
): Promise<boolean> {
  const raw = getRawDb(db);
  const isCurrent = () =>
    params.version === undefined ||
    readCurrentVersion(db, params) === params.version;

  // Guard: bail if the file was deleted before this async job ran
  const file = db
    .select({ isDeleted: schema.files.isDeleted })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.path, params.path),
        eq(schema.files.driveId, params.driveId)
      )
    )
    .get();

  if (!file || file.isDeleted) return false;

  try {
    // 1. Chunk content
    const chunks = await chunkContent(params.content);

    // 2. Generate embeddings FIRST (before any DB writes)
    //    If this fails, no DB state is changed — no orphaned chunks.
    const texts = chunks.map((c) => c.content);
    const embeddings = await provider.embedBatch(texts);
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding provider returned ${embeddings.length} vectors for ${chunks.length} chunks`
      );
    }
    // Validate every vector before touching the old ones.
    const vectors = embeddings.map(toUnitVector);

    if (!isCurrent()) return false;

    // 3. Delete old chunks + vectors for this file
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
      raw
        .prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?")
        .run(chunk.id);
    }

    db.delete(schema.contentChunks)
      .where(
        and(
          eq(schema.contentChunks.filePath, params.path),
          eq(schema.contentChunks.driveId, params.driveId)
        )
      )
      .run();

    // 4. Insert new chunks + vectors (paired)
    const insertVec = raw.prepare(
      "INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)"
    );

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
