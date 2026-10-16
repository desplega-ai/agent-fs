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

function storedNorms(db: DB): number[] {
  return (raw(db).prepare("SELECT embedding FROM chunk_vectors").all() as { embedding: Uint8Array }[]).map(
    ({ embedding }) => {
      const vec = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
      return Math.hypot(...vec);
    }
  );
}

describe("vectors", () => {
  test("toUnitVector scales to length 1 and leaves a zero vector alone", () => {
    expect(Math.hypot(...toUnitVector([3, 4]))).toBeCloseTo(1, 6);
    expect(Array.from(toUnitVector([0, 0]))).toEqual([0, 0]);
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

    expect(result).toEqual({ indexed: 2, failed: 0, skipped: 0 });
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

    expect(result).toEqual({ indexed: 1, failed: 1, skipped: 1 });
    expect(statusOf(db, "/notes.md")).toBe("indexed");
    expect(statusOf(db, "/gone.md")).toBe("failed");
    expect(statusOf(db, "/song.mp3")).toBeNull();
  });
});
