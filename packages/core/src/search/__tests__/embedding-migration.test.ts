import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { write } from "../../ops/write.js";
import { vecSearch } from "../../ops/vec-search.js";
import { getS3Key } from "../../ops/versioning.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import {
  embeddingFormat,
  prepareEmbeddingMigration,
  runPendingEmbeddings,
} from "../embedding-migration.js";
import { similarityFromDistance, toUnitVector } from "../vectors.js";
import { indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
import { reindex } from "../../ops/reindex.js";
import { EmbeddingProviderError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";

// Not unit length on purpose: the local model returns vectors with a norm near 23.
function fakeVector(text: string): number[] {
  const vec = new Array<number>(768).fill(0);
  vec[0] = 20;
  vec[1] = text.includes("cats") ? 15 : -15;
  return vec;
}

const PROVIDER: EmbeddingProvider = {
  name: "fake",
  dimensions: 768,
  async embed(text) {
    return fakeVector(text);
  },
  async embedBatch(texts) {
    return texts.map(fakeVector);
  },
};

function raw(db: DB): Database {
  return (db as any).$client as Database;
}

function statusOf(db: DB, path: string): string | null {
  return (raw(db).prepare("SELECT embedding_status AS s FROM files WHERE path = ?").get(path) as { s: string | null }).s;
}

function chunkContents(db: DB, path: string): string[] {
  return (
    raw(db).prepare("SELECT content FROM content_chunks WHERE file_path = ? ORDER BY chunk_index").all(path) as {
      content: string;
    }[]
  ).map((row) => row.content);
}

function vectorCount(db: DB): number {
  return (raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number }).n;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** Like PROVIDER, but holds any batch that contains `word` until `release()`. */
function gatedProvider(word: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const provider: EmbeddingProvider = {
    ...PROVIDER,
    async embedBatch(texts) {
      if (texts.some((t) => t.includes(word))) {
        started = true;
        await gate;
      }
      return texts.map(fakeVector);
    },
  };
  return { provider, release, started: () => started };
}

function storedNorms(db: DB): number[] {
  return (raw(db).prepare("SELECT embedding FROM chunk_vectors").all() as { embedding: Uint8Array }[]).map(
    ({ embedding }) => {
      const vec = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
      return Math.hypot(...vec);
    }
  );
}

describe("vectors", () => {
  test("toUnitVector scales to length 1", () => {
    expect(Math.hypot(...toUnitVector([3, 4], 2))).toBeCloseTo(1, 6);
  });

  test.each([
    ["zero", [0, 0]],
    ["NaN", [1, NaN]],
    ["Infinity", [1, Infinity]],
    ["Float32 overflow", [1e39, 1]],
    ["wrong-dimension", [3, 4, 5]],
  ])("toUnitVector rejects a %s vector", (_, values) => {
    expect(() => toUnitVector(values, 2)).toThrow(EmbeddingProviderError);
  });

  test("similarityFromDistance maps unit-vector L2 distance to cosine", () => {
    expect(similarityFromDistance(0)).toBe(1);
    expect(similarityFromDistance(Math.SQRT2)).toBeCloseTo(0, 6);
    expect(similarityFromDistance(2)).toBe(-1);
  });
});

describe("embedding migration", () => {
  test("re-embeds indexed files once per format, as unit vectors, and search scores them as cosine", async () => {
    const { ctx, db, s3 } = createTestContext();
    await write(ctx, { path: "/cats.md", content: "all about cats" });
    await write(ctx, { path: "/dogs.md", content: "all about dogs" });
    raw(db).prepare("UPDATE files SET embedding_status = 'indexed'").run();

    expect(prepareEmbeddingMigration(raw(db), PROVIDER)).toBe(true);
    expect(statusOf(db, "/cats.md")).toBe("pending");

    const result = await runPendingEmbeddings(db, s3, PROVIDER);

    expect(result).toEqual({ indexed: 2, failed: 0, skipped: 0, superseded: 0 });
    expect(statusOf(db, "/cats.md")).toBe("indexed");
    for (const norm of storedNorms(db)) expect(norm).toBeCloseTo(1, 5);
    expect(
      (raw(db).prepare("SELECT value FROM meta WHERE key = 'embedding_format'").get() as { value: string }).value
    ).toBe(embeddingFormat(PROVIDER));

    // Same provider and format on the next boot: nothing to do.
    expect(prepareEmbeddingMigration(raw(db), PROVIDER)).toBe(false);
    expect(statusOf(db, "/cats.md")).toBe("indexed");

    ctx.embeddingProvider = PROVIDER;
    const { results } = await vecSearch(ctx, { query: "cats", limit: 2 });
    expect(results.map((r) => r.path)).toEqual(["/cats.md", "/dogs.md"]);
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].score).toBeLessThan(0.5);
  });

  test("a provider change triggers it again", async () => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/a.md", content: "text" });
    raw(db).prepare("UPDATE files SET embedding_status = 'indexed'").run();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    raw(db).prepare("UPDATE files SET embedding_status = 'indexed'").run();

    expect(prepareEmbeddingMigration(raw(db), { ...PROVIDER, name: "other" })).toBe(true);
    expect(statusOf(db, "/a.md")).toBe("pending");
  });

  test("clears binary files, marks unreadable ones failed, and terminates", async () => {
    const { ctx, db, s3, orgId, driveId } = createTestContext();
    await write(ctx, { path: "/notes.md", content: "hello" });
    await write(ctx, { path: "/gone.md", content: "bye" });
    await s3.putObject(getS3Key(orgId, driveId, "/song.mp3"), new Uint8Array([0x49, 0x44, 0x33, 0, 0xff]), {}, "audio/mpeg");
    raw(db)
      .prepare(
        "INSERT INTO files(path, drive_id, size, author, created_at, modified_at, is_deleted) SELECT '/song.mp3', drive_id, 5, author, created_at, modified_at, 0 FROM files WHERE path = '/notes.md'"
      )
      .run();
    await s3.deleteObject(getS3Key(orgId, driveId, "/gone.md"));
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    const result = await runPendingEmbeddings(db, s3, PROVIDER, { batchSize: 1 });

    expect(result).toEqual({ indexed: 1, failed: 1, skipped: 1, superseded: 0 });
    expect(statusOf(db, "/notes.md")).toBe("indexed");
    expect(statusOf(db, "/gone.md")).toBe("failed");
    expect(statusOf(db, "/song.mp3")).toBeNull();
  });

  test("a write during the run keeps its own content and status", async () => {
    const { ctx, db, s3 } = createTestContext();
    await write(ctx, { path: "/a.md", content: "old content" });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    const gated = gatedProvider("old content");
    const run = runPendingEmbeddings(db, s3, gated.provider);
    await waitFor(gated.started);

    // The write lands and its own job finishes while the migration still embeds the old text.
    ctx.embeddingProvider = gated.provider;
    await write(ctx, { path: "/a.md", content: "new content" });
    await waitFor(() => statusOf(db, "/a.md") === "indexed");
    gated.release();

    expect(await run).toEqual({ indexed: 0, failed: 0, skipped: 0, superseded: 1 });
    expect(chunkContents(db, "/a.md")).toEqual(["new content"]);
    expect(statusOf(db, "/a.md")).toBe("indexed");
  });

  test("a file queued again behind the cursor does not stop the run", async () => {
    const { ctx, db, s3 } = createTestContext();
    for (const name of ["a", "b", "c"]) await write(ctx, { path: `/${name}.md`, content: `file ${name}` });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    const gated = gatedProvider("file b");
    const run = runPendingEmbeddings(db, s3, gated.provider, { batchSize: 1 });
    await waitFor(gated.started);
    // A write to /a.md queued it again; its own job will embed it.
    raw(db).prepare("UPDATE files SET embedding_status = 'pending' WHERE path = '/a.md'").run();
    gated.release();

    expect(await run).toEqual({ indexed: 3, failed: 0, skipped: 0, superseded: 0 });
    expect(statusOf(db, "/b.md")).toBe("indexed");
    expect(statusOf(db, "/c.md")).toBe("indexed");
    expect(statusOf(db, "/a.md")).toBe("pending");
  });

  test("a write during a reindex keeps its own content and status", async () => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/a.md", content: "old content" });

    const gated = gatedProvider("old content");
    ctx.embeddingProvider = gated.provider;
    const run = reindex(ctx, {});
    await waitFor(gated.started);

    await write(ctx, { path: "/a.md", content: "new content" });
    await waitFor(() => statusOf(db, "/a.md") === "indexed");
    gated.release();

    expect(await run).toEqual({ reindexed: 0, failed: 0, skipped: 1 });
    expect(chunkContents(db, "/a.md")).toEqual(["new content"]);
    expect(statusOf(db, "/a.md")).toBe("indexed");
  });

  const vectorOf = (value: (i: number) => number) => Array.from({ length: 768 }, (_, i) => value(i));
  test.each([
    ["zero", PROVIDER.dimensions, () => vectorOf(() => 0)],
    ["NaN", PROVIDER.dimensions, () => vectorOf((i) => (i === 5 ? NaN : 1))],
    ["Infinity", PROVIDER.dimensions, () => vectorOf((i) => (i === 5 ? Infinity : 1))],
    ["wrong-dimension", PROVIDER.dimensions, () => [3, 4]],
    // Passes validation, then the 768-wide index rejects the insert mid-replace.
    ["index-rejected", 2, () => [3, 4]],
  ])("a %s embedding fails the file and keeps its previous index", async (_, dimensions, vector) => {
    const { ctx, db, s3, driveId } = createTestContext();
    await write(ctx, { path: "/a.md", content: "all about cats" });
    await indexFileEmbeddings(db, PROVIDER, {
      path: "/a.md",
      driveId,
      content: "all about cats",
      version: readCurrentVersion(db, { path: "/a.md", driveId }) ?? null,
    });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    const bad: EmbeddingProvider = {
      ...PROVIDER,
      dimensions,
      async embed() {
        return vector();
      },
      async embedBatch(texts) {
        return texts.map(vector);
      },
    };
    expect(await runPendingEmbeddings(db, s3, bad)).toEqual({ indexed: 0, failed: 1, skipped: 0, superseded: 0 });
    expect(statusOf(db, "/a.md")).toBe("failed");
    expect(chunkContents(db, "/a.md")).toEqual(["all about cats"]);
    expect(vectorCount(db)).toBe(1);
  });
});
