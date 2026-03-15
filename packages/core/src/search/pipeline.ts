import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { chunkContent } from "./chunker.js";

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

export async function indexFileEmbeddings(
  db: DB,
  provider: EmbeddingProvider,
  params: { path: string; driveId: string; content: string }
): Promise<void> {
  const raw = getRawDb(db);

  try {
    // 1. Chunk content
    const chunks = await chunkContent(params.content);

    // 2. Delete old chunks + vectors for this file
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

    // 3. Insert new chunks
    const chunkIds: number[] = [];
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
      chunkIds.push(result.id);
    }

    // 4. Embed all chunks
    const texts = chunks.map((c) => c.content);
    const embeddings = await provider.embedBatch(texts);

    // 5. Insert vectors into chunk_vectors
    const insertStmt = raw.prepare(
      "INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)"
    );

    for (let i = 0; i < chunkIds.length; i++) {
      const vec = new Float32Array(embeddings[i]);
      insertStmt.run(chunkIds[i], vec);
    }

    // 6. Update embedding status
    db.update(schema.files)
      .set({ embeddingStatus: "indexed" })
      .where(
        and(
          eq(schema.files.path, params.path),
          eq(schema.files.driveId, params.driveId)
        )
      )
      .run();
  } catch (err) {
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

  embeddingSemaphore.acquire().then(async (release) => {
    try {
      await indexFileEmbeddings(db, provider, params);
    } catch (e) {
      console.error("Embedding failed", { path: params.path, error: e });
    } finally {
      release();
    }
  });
}
