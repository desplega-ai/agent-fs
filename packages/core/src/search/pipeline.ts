import { basename } from "node:path";
import { eq, and } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { indexFile } from "./fts.js";
import { chunkContent, type Chunk } from "./chunker.js";
import { stripBase64 } from "./strip-base64.js";
import { toUnitVector } from "./vectors.js";
import { getEmbeddingExcludeDrives, getEmbeddingMaxBytes } from "../config.js";
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
const migrationSemaphores = new WeakMap<DB, Semaphore>();

/** Serialize text migrations and image jobs for this database. */
export async function withEmbeddingMigrationSlot<T>(db: DB, fn: () => Promise<T>): Promise<T> {
  let semaphore = migrationSemaphores.get(db);
  if (!semaphore) {
    semaphore = new Semaphore(1);
    migrationSemaphores.set(db, semaphore);
  }
  const release = await semaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

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

/** Maps each chunk's first non-whitespace character to its PDF page. */
export function chunkPages(chunks: Chunk[], pageStarts: number[]): number[] {
  let pageIndex = 0;
  return chunks.map((chunk) => {
    const offset = chunk.charOffset + (chunk.content.length - chunk.content.trimStart().length);
    while (pageIndex + 1 < pageStarts.length && pageStarts[pageIndex + 1] <= offset) {
      pageIndex++;
    }
    return pageIndex + 1;
  });
}

export type ChunkKind = "text" | "image";
export type ChunkDeleteScope = ChunkKind | "all";

export function deleteChunks(db: DB, params: { path: string; driveId: string }, kind: ChunkDeleteScope): void {
  const raw = getRawDb(db);
  const oldChunks = db
    .select({ id: schema.contentChunks.id })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.filePath, params.path),
        eq(schema.contentChunks.driveId, params.driveId),
        kind === "all" ? undefined : eq(schema.contentChunks.kind, kind)
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
        eq(schema.contentChunks.driveId, params.driveId),
        kind === "all" ? undefined : eq(schema.contentChunks.kind, kind)
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
  params: { path: string; driveId: string; version: string | null },
  kind: ChunkDeleteScope
): boolean {
  return getRawDb(db).transaction(() => {
    if (readCurrentVersion(db, params) !== params.version) return false;
    deleteChunks(db, params, kind);
    db.update(schema.files)
      .set({
        ...(kind !== "image" ? { embeddingStatus: null } : {}),
        ...(kind !== "text" ? { imageEmbeddingStatus: null } : {}),
      })
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
 * job changes nothing and returns `superseded`: the newer write owns the chunks and
 * the status. The check and the whole replacement run in one transaction, so
 * a failed insert rolls back to the previous index.
 *
 * Excluded drives and text over either size limit clear text chunks and end skipped.
 * Blank non-PDF text clears the chunks and status, and returns skipped.
 * Empty PDF text ends indexed with no chunks.
 */
export async function indexFileEmbeddings(
  db: DB,
  provider: EmbeddingProvider,
  params: {
    path: string;
    driveId: string;
    content: string;
    version: string | null;
    /**
     * Identifies PDF input. A PDF never ends with a NULL status, so the boot backfill runs once per PDF.
     */
    pageStarts?: number[];
    refreshFts?: boolean;
  }
): Promise<"indexed" | "skipped" | "superseded"> {
  const raw = getRawDb(db);
  const isCurrent = () => readCurrentVersion(db, params) === params.version;

  if (!isCurrent()) return "superseded";
  // Preserve PDF offsets for chunkPages. Other offsets refer to the stripped text.
  const content = params.pageStarts === undefined ? stripBase64(params.content) : params.content;
  const maxBytes = getEmbeddingMaxBytes();
  const skipped = getEmbeddingExcludeDrives().includes(params.driveId) || content.length > MAX_EMBED_CHARS ||
    (maxBytes !== undefined && Buffer.byteLength(content, "utf8") > maxBytes);

  try {
    // 1. Chunk content. Blank text has nothing to embed, and providers reject
    // an empty request.
    const chunks = skipped || content.trim() === ""
      ? []
      : await chunkContent(content);
    const status = skipped ? "skipped" : chunks.length === 0 && params.pageStarts === undefined ? null : "indexed";

    // 2. Generate and validate embeddings FIRST (before any DB writes)
    const texts = chunks.map((c) => c.content);
    const embeddings = chunks.length === 0
      ? []
      : await provider.embedDocuments(texts, { title: basename(params.path) });
    if (embeddings.length !== chunks.length) {
      throw new EmbeddingProviderError(
        `Embedding provider returned ${embeddings.length} vectors for ${chunks.length} chunks`
      );
    }
    const vectors = embeddings.map((values) => toUnitVector(values, provider.dimensions));
    const pages = params.pageStarts === undefined ? undefined : chunkPages(chunks, params.pageStarts);

    const insertVec = raw.prepare(
      "INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)"
    );

    return raw.transaction((): "indexed" | "skipped" | "superseded" => {
      if (!isCurrent()) return "superseded";

      // Refresh FTS inside this version-guarded transaction so an old version never overwrites a newer FTS row.
      if (params.refreshFts) {
        indexFile(db, { path: params.path, driveId: params.driveId, content: params.content });
      }

      // 3. Delete old chunks + vectors for this file
      deleteChunks(db, params, "text");

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
            page: pages?.[i] ?? null,
          })
          .returning({ id: schema.contentChunks.id })
          .get();

        insertVec.run(result.id, vectors[i]);
      }

      // 5. Update embedding status
      db.update(schema.files)
        .set({ embeddingStatus: status })
        .where(
          and(
            eq(schema.files.path, params.path),
            eq(schema.files.driveId, params.driveId)
          )
        )
        .run();
      return status ?? "skipped";
    })();
  } catch (err) {
    // A newer write is pending: its own job sets the status.
    if (!isCurrent()) return "superseded";
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
  params: { path: string; driveId: string; content: string; pageStarts?: number[] }
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
