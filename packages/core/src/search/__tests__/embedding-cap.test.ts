import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { write, writeRaw } from "../../ops/write.js";
import { reindex } from "../../ops/reindex.js";
import { stat } from "../../ops/stat.js";
import { ftsQuery, indexFile, indexedContent } from "../fts.js";
import { indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
import { MAX_BYTES_KEY, prepareEmbeddingMigration, runPendingEmbeddings } from "../embedding-migration.js";
import { runPendingImageEmbeddings } from "../image-embedding.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

const raw = (db: DB) => (db as any).$client as Database;
const status = (db: DB, path: string) =>
  (raw(db).prepare("SELECT embedding_status AS status FROM files WHERE path = ?").get(path) as { status: string | null }).status;
const provider: EmbeddingProvider = {
  name: "fake",
  dimensions: 768,
  async embedQuery() { return [1, ...new Array(767).fill(0)]; },
  async embedDocuments(texts) { return texts.map(() => [1, ...new Array(767).fill(0)]); },
};
const options = { cpuShare: 1 };
const pdf = async (name: string) => new Uint8Array(await Bun.file(new URL(`fixtures/${name}.pdf`, import.meta.url)).arrayBuffer());

let savedCap: string | undefined;
beforeEach(() => {
  savedCap = process.env.AGENT_FS_EMBEDDING_MAX_BYTES;
  process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "";
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.AGENT_FS_EMBEDDING_MAX_BYTES;
  else process.env.AGENT_FS_EMBEDDING_MAX_BYTES = savedCap;
});

async function embed(db: DB, driveId: string, path: string, content: string, pageStarts?: number[]) {
  return indexFileEmbeddings(db, provider, {
    path, driveId, content, pageStarts,
    version: readCurrentVersion(db, { path, driveId }) ?? null,
  });
}

async function waitForStatus(db: DB, path: string, expected: string) {
  for (let i = 0; i < 500 && status(db, path) !== expected; i++) await Bun.sleep(2);
  expect(status(db, path)).toBe(expected);
}

describe("embedding byte cap", () => {
  test("a write keeps full FTS text, removes old text vectors and ends skipped", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/text.md";
    await write(ctx, { path, content: "old" });
    await embed(db, driveId, path, "old");
    expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 1 });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    const calls = spyOn(provider, "embedDocuments");
    try {
      ctx.embeddingProvider = provider;
      const content = "ééé terminalword";
      await write(ctx, { path, content });
      await waitForStatus(db, path, "skipped");
      expect(indexedContent(db, { path, driveId })).toBe(content);
      expect(ftsQuery(db, { pattern: "terminalword", driveId }).map((match) => match.path)).toEqual([path]);
      expect(raw(db).prepare("SELECT count(*) AS n FROM content_chunks").get()).toEqual({ n: 0 });
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
      expect(calls).not.toHaveBeenCalled();
      expect((await stat(ctx, { path })).embeddingStatus).toBe("skipped");
    } finally {
      calls.mockRestore();
    }
  });

  test("the cap counts UTF-8 bytes and includes its exact boundary", async () => {
    const { ctx, db, driveId } = createTestContext();
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    for (const [path, content, expected] of [
      ["/equal.md", "éé", "indexed"],
      ["/over.md", "ééa", "skipped"],
    ] as const) {
      await write(ctx, { path, content });
      expect(await embed(db, driveId, path, content)).toBe(expected);
      expect(status(db, path)).toBe(expected);
    }
  });

  test.each(["", "invalid", "0"])("cap %s preserves uncapped embedding", async (cap) => {
    const { ctx, db, driveId } = createTestContext();
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = cap;
    await write(ctx, { path: "/text.md", content: "ééa" });
    expect(await embed(db, driveId, "/text.md", "ééa")).toBe("indexed");
    expect(status(db, "/text.md")).toBe("indexed");
    expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 1 });
  });

  test("a stale version cannot replace FTS or mark the newer file skipped", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/text.md";
    await write(ctx, { path, content: "old text" });
    const version = readCurrentVersion(db, { path, driveId }) ?? null;
    await write(ctx, { path, content: "new" });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    expect(await indexFileEmbeddings(db, provider, {
      path, driveId, version, content: "old text", refreshFts: true,
    })).toBe("superseded");
    expect(status(db, path)).not.toBe("skipped");
    expect(indexedContent(db, { path, driveId })).toBe("new");
  });

  test("migration counts capped text as skipped and reindex leaves terminal files alone", async () => {
    const { ctx, db, s3 } = createTestContext();
    await write(ctx, { path: "/large.md", content: "large text" });
    await write(ctx, { path: "/small.md", content: "small" });
    await write(ctx, { path: "/blank.md", content: "      " });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "5";
    expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, skipped: 2, failed: 0, superseded: 0 });
    expect(status(db, "/blank.md")).toBe("skipped");
    const reads = spyOn(s3, "getObject");
    try {
      ctx.embeddingProvider = provider;
      expect(await reindex(ctx, {})).toEqual({ reindexed: 0, skipped: 0, failed: 0 });
      expect(reads).not.toHaveBeenCalled();
      expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
      await runPendingEmbeddings(db, s3, provider, options);
      expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
      expect(status(db, "/large.md")).toBe("skipped");
    } finally {
      reads.mockRestore();
    }
  });

  test("2.1M characters end skipped without a byte cap", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/huge.md";
    const content = "word ".repeat(420_000);
    await write(ctx, { path, content });
    const calls = spyOn(provider, "embedDocuments");
    try {
      expect(await embed(db, driveId, path, content)).toBe("skipped");
      expect(status(db, path)).toBe("skipped");
      expect(indexedContent(db, { path, driveId })).toBe(content);
      expect(raw(db).prepare("SELECT count(*) AS n FROM content_chunks").get()).toEqual({ n: 0 });
      expect(calls).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
    }
  });

  test("a cap requeues legacy NULL text only when its FTS bytes exceed the cap", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/huge.md", content: "word ".repeat(420_000) });
    await write(ctx, { path: "/small.md", content: "éé" });
    await write(ctx, { path: "/utf8.md", content: "ééa" });
    await writeRaw(ctx, { path: "/binary.bin", bytes: new Uint8Array(20) });
    raw(db).exec("UPDATE files SET embedding_status = NULL");
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/huge.md")).toBe("pending");
    expect(status(db, "/utf8.md")).toBe("pending");
    expect(status(db, "/small.md")).toBeNull();
    expect(status(db, "/binary.bin")).toBeNull();
    expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 0, skipped: 2, failed: 0, superseded: 0 });
    expect(status(db, "/huge.md")).toBe("skipped");
    expect(status(db, "/utf8.md")).toBe("skipped");
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
  });

  test("reindex counts newly capped text and blank text as skipped", async () => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/large.md", content: "large text" });
    await write(ctx, { path: "/blank.md", content: " " });
    await write(ctx, { path: "/small.md", content: "small" });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "5";
    ctx.embeddingProvider = provider;
    expect(await reindex(ctx, {})).toEqual({ reindexed: 1, skipped: 2, failed: 0 });
    expect(status(db, "/large.md")).toBe("skipped");
    expect(status(db, "/blank.md")).toBeNull();
  });

  test("PDF extraction controls the cap while PDF pages and images still embed", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    const multimodal: EmbeddingProvider = {
      ...provider,
      supportsMime: () => true,
      async embedParts(parts) { return parts.map(() => [1, ...new Array(767).fill(0)]); },
    };
    prepareEmbeddingMigration(raw(db), provider);
    await writeRaw(ctx, { path: "/report.pdf", bytes: await pdf("text") });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "100";
    const calls = spyOn(provider, "embedDocuments");
    try {
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 0, skipped: 1, failed: 0, superseded: 0 });
      expect(status(db, "/report.pdf")).toBe("skipped");
      expect(indexedContent(db, { path: "/report.pdf", driveId })).toContain("basalt lighthouse maintenance log");
      expect(calls).not.toHaveBeenCalled();
      raw(db).prepare("UPDATE files SET image_embedding_status = 'pending'").run();
      await runPendingImageEmbeddings(db, s3, multimodal, options);
      expect(raw(db).prepare("SELECT kind, count(*) AS n FROM content_chunks GROUP BY kind").all()).toEqual([{ kind: "image", n: 2 }]);
      expect(await embed(db, driveId, "/report.pdf", "x".repeat(101), [0])).toBe("skipped");
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 2 });
      expect(status(db, "/report.pdf")).toBe("skipped");
      await writeRaw(ctx, { path: "/blank.pdf", bytes: await pdf("image-only") });
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, skipped: 0, failed: 0, superseded: 0 });
      expect(status(db, "/blank.pdf")).toBe("indexed");
      await writeRaw(ctx, { path: "/picture.png", bytes: new Uint8Array([137, 80, 78, 71, 0, 255]) });
      raw(db).prepare("UPDATE files SET image_embedding_status = 'pending' WHERE path = '/picture.png'").run();
      await runPendingImageEmbeddings(db, s3, multimodal, options);
      expect(raw(db).prepare("SELECT image_embedding_status AS status FROM files WHERE path = '/picture.png'").get()).toEqual({ status: "indexed" });
    } finally {
      calls.mockRestore();
    }
  });

  test("cap transitions requeue skipped and newly oversized indexed text once", async () => {
    const { ctx, db, driveId, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), provider);
    for (const [path, content] of [["/small.md", "éé"], ["/large.md", "ééé"], ["/skipped.md", "abc"]]) {
      await write(ctx, { path, content });
      await embed(db, driveId, path, content);
    }
    raw(db).prepare("UPDATE files SET embedding_status = 'skipped' WHERE path = '/skipped.md'").run();
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/small.md")).toBe("indexed");
    expect(status(db, "/large.md")).toBe("pending");
    expect(status(db, "/skipped.md")).toBe("pending");
    await runPendingEmbeddings(db, s3, provider, options);
    expect(status(db, "/large.md")).toBe("skipped");
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "8";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/small.md")).toBe("indexed");
    await runPendingEmbeddings(db, s3, provider, options);
    expect(status(db, "/large.md")).toBe("indexed");
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "3";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    await runPendingEmbeddings(db, s3, provider, options);
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    await runPendingEmbeddings(db, s3, provider, options);
    expect(status(db, "/small.md")).toBe("indexed");
    expect(status(db, "/large.md")).toBe("indexed");
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(MAX_BYTES_KEY)).toEqual({ value: "" });
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
  });

  test("boot uses extracted PDF bytes and leaves deleted files alone", async () => {
    const { ctx, db, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), provider);
    for (const path of ["/large.pdf", "/small.pdf", "/deleted.md"]) {
      await write(ctx, { path, content: "content" });
      raw(db).prepare("UPDATE files SET embedding_status = 'indexed', size = 1000 WHERE path = ?").run(path);
    }
    indexFile(db, { path: "/large.pdf", driveId, content: "ééé" });
    indexFile(db, { path: "/small.pdf", driveId, content: "éé" });
    raw(db).prepare("UPDATE files SET embedding_status = 'skipped', is_deleted = 1 WHERE path = '/deleted.md'").run();
    await write(ctx, { path: "/legacy.md", content: "legacy text" });
    raw(db).prepare("UPDATE files SET embedding_status = 'indexed' WHERE path = '/legacy.md'").run();
    raw(db).prepare("DELETE FROM files_fts_docs WHERE path = '/legacy.md'").run();
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "4";
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/legacy.md")).toBe("pending");
    expect(status(db, "/large.pdf")).toBe("pending");
    expect(status(db, "/small.pdf")).toBe("indexed");
    expect(status(db, "/deleted.md")).toBe("skipped");
  });
});
