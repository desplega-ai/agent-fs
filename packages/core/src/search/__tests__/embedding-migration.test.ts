import { describe, expect, test, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { write } from "../../ops/write.js";
import { vecSearch } from "../../ops/vec-search.js";
import { getS3Key } from "../../ops/versioning.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import {
  embeddingFormat,
  migrationCpuShare,
  prepareEmbeddingMigration,
  prepareEmbeddingMigrationWithWarmup,
  runPendingEmbeddings,
} from "../embedding-migration.js";
import { similarityFromDistance, toUnitVector } from "../vectors.js";
import { MAX_EMBED_CHARS, indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
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
  async embedQuery(text) {
    return fakeVector(text);
  },
  async embedDocuments(texts) {
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
    async embedDocuments(texts) {
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
  test.each(["failed", "unchanged", "changed"] as const)("boot gate: %s warmup", async (mode) => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/indexed.md", content: "cats" });
    await write(ctx, { path: "/failed.md", content: "cars" });
    const stored = mode === "unchanged" ? embeddingFormat(PROVIDER) : "old:v2";
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('embedding_format', ?)").run(stored);
    // An unchanged index has already spent its one failed-file retry.
    if (mode === "unchanged") prepareEmbeddingMigration(raw(db), PROVIDER);
    raw(db).prepare("UPDATE files SET embedding_status = 'indexed' WHERE path = '/indexed.md'").run();
    raw(db).prepare("UPDATE files SET embedding_status = 'failed' WHERE path = '/failed.md'").run();
    let calls = 0;
    const provider: EmbeddingProvider = {
      ...PROVIDER,
      async embedQuery(text) {
        calls++;
        expect(text).toBe("warmup");
        expect(statusOf(db, "/indexed.md")).toBe("indexed");
        expect(statusOf(db, "/failed.md")).toBe("failed");
        if (mode === "failed") throw new Error("model\nunavailable");
        return fakeVector(text);
      },
    };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await prepareEmbeddingMigrationWithWarmup(raw(db), provider)).toBe(mode === "changed");
      expect(calls).toBe(mode === "unchanged" ? 0 : 1);
      const format = (raw(db).prepare("SELECT value FROM meta WHERE key = 'embedding_format'").get() as { value: string }).value;
      expect(format).toBe(mode === "changed" ? embeddingFormat(provider) : stored);
      expect(statusOf(db, "/indexed.md")).toBe(mode === "changed" ? "pending" : "indexed");
      expect(statusOf(db, "/failed.md")).toBe(mode === "changed" ? "pending" : "failed");
      expect(error).toHaveBeenCalledTimes(mode === "failed" ? 1 : 0);
      if (mode === "failed") expect(error.mock.calls[0]).toEqual(["[agent-fs] Embedding warmup failed. Migration skipped: model unavailable"]);
    } finally {
      error.mockRestore();
    }
  });

  test("indexFileEmbeddings passes the file basename as the document title", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/notes/project/cats.md";
    const content = "all about cats";
    await write(ctx, { path, content });
    const calls: { texts: string[]; title: string }[] = [];
    const provider: EmbeddingProvider = {
      ...PROVIDER,
      async embedDocuments(texts, opts) {
        calls.push({ texts, title: opts.title });
        return texts.map(fakeVector);
      },
    };

    expect(await indexFileEmbeddings(db, provider, {
      path,
      driveId,
      content,
      version: readCurrentVersion(db, { path, driveId }) ?? null,
    })).toBe(true);
    expect(calls).toEqual([{ texts: [content], title: "cats.md" }]);
  });

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

  test("the local batch fix re-embeds local vectors only", async () => {
    for (const [name, migrates] of [["local", true], ["openai", false]] as const) {
      const { ctx, db } = createTestContext();
      await write(ctx, { path: "/a.md", content: "text" });
      raw(db)
        .prepare(
          "INSERT INTO meta(key, value) VALUES ('embedding_format', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(`${name}:v2`);
      raw(db).prepare("UPDATE files SET embedding_status = 'indexed'").run();

      expect(prepareEmbeddingMigration(raw(db), { ...PROVIDER, name })).toBe(migrates);
      expect(statusOf(db, "/a.md")).toBe(migrates ? "pending" : "indexed");
    }
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
      async embedQuery() {
        return vector();
      },
      async embedDocuments(texts) {
        return texts.map(vector);
      },
    };
    expect(await runPendingEmbeddings(db, s3, bad)).toEqual({ indexed: 0, failed: 1, skipped: 0, superseded: 0 });
    expect(statusOf(db, "/a.md")).toBe("failed");
    expect(chunkContents(db, "/a.md")).toEqual(["all about cats"]);
    expect(vectorCount(db)).toBe(1);
  });
});

describe("embedding migration pacing", () => {
  test("reads the CPU share from the env value and falls back to 0.25", () => {
    for (const raw of [undefined, "", " ", "0", "-0.5", "1.5", "abc"]) {
      expect(migrationCpuShare(raw)).toBe(0.25);
    }
    expect(migrationCpuShare("0.1")).toBe(0.1);
    expect(migrationCpuShare(" 1 ")).toBe(1);
  });

  async function pausesFor(cpuShare: number): Promise<number[]> {
    const { ctx, db, s3 } = createTestContext();
    for (const name of ["a", "b", "c"]) await write(ctx, { path: `/${name}.md`, content: `file ${name}` });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    // Every file uses 100 ms of CPU: the clock reads 0 at its start and 100 at its end.
    let reads = 0;
    const pauses: number[] = [];
    const result = await runPendingEmbeddings(db, s3, PROVIDER, {
      cpuShare,
      cpuMs: () => (reads++ % 2 === 0 ? 0 : 100),
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.indexed).toBe(3);
    return pauses;
  }

  test("pauses after each file so the run uses its share of CPU time", async () => {
    expect(await pausesFor(0.25)).toEqual([300, 300, 300]);
    expect(await pausesFor(0.5)).toEqual([100, 100, 100]);
  });

  test("does not pause at share 1 and caps a pause at 30 s", async () => {
    expect(await pausesFor(1)).toEqual([]);
    expect(await pausesFor(0.001)).toEqual([30_000, 30_000, 30_000]);
  });
});

describe("oversized text", () => {
  const big = "word ".repeat(Math.ceil(MAX_EMBED_CHARS / 5) + 1);
  const refusing: EmbeddingProvider = {
    ...PROVIDER,
    async embedQuery() {
      throw new Error("must not embed");
    },
    async embedDocuments() {
      throw new Error("must not embed");
    },
  };

  test("the migration skips it without embedding and drops its old chunks", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    await write(ctx, { path: "/big.md", content: "small at first" });
    await indexFileEmbeddings(db, PROVIDER, {
      path: "/big.md",
      driveId,
      content: "small at first",
      version: readCurrentVersion(db, { path: "/big.md", driveId }) ?? null,
    });
    await write(ctx, { path: "/big.md", content: big });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    expect(await runPendingEmbeddings(db, s3, refusing, { cpuShare: 1 })).toEqual({
      indexed: 0,
      failed: 0,
      skipped: 1,
      superseded: 0,
    });
    expect(statusOf(db, "/big.md")).toBeNull();
    expect(chunkContents(db, "/big.md")).toEqual([]);
    expect(vectorCount(db)).toBe(0);
  });

  test("a write does not embed it either", async () => {
    const { ctx, db } = createTestContext();
    ctx.embeddingProvider = refusing;
    await write(ctx, { path: "/big.md", content: big });
    await waitFor(() => statusOf(db, "/big.md") === null);
    expect(chunkContents(db, "/big.md")).toEqual([]);
  });
});

describe("failed and blank files", () => {
  test("retries failed files once, logs each failure, and clears blank files", async () => {
    const { ctx, db, s3 } = createTestContext();
    await write(ctx, { path: "/ok.md", content: "fine now" });
    await write(ctx, { path: "/blank.txt", content: "  \n " });
    await write(ctx, { path: "/bad.md", content: "still bad" });
    raw(db).prepare("UPDATE files SET embedding_status = 'failed'").run();

    expect(prepareEmbeddingMigration(raw(db), PROVIDER)).toBe(true);
    expect(statusOf(db, "/ok.md")).toBe("pending");

    const failing: EmbeddingProvider = {
      ...PROVIDER,
      async embedDocuments(texts, opts) {
        if (texts.some((t) => t.includes("bad"))) throw new EmbeddingProviderError("400 too many tokens");
        return PROVIDER.embedDocuments(texts, opts);
      },
    };
    const logs: string[] = [];
    const result = await runPendingEmbeddings(db, s3, failing, { log: (m) => logs.push(m), cpuShare: 1 });

    expect(result).toEqual({ indexed: 1, failed: 1, skipped: 1, superseded: 0 });
    expect(statusOf(db, "/ok.md")).toBe("indexed");
    expect(statusOf(db, "/blank.txt")).toBeNull();
    expect(statusOf(db, "/bad.md")).toBe("failed");
    expect(logs).toContain("embedding failed for /bad.md: 400 too many tokens");

    // Once per retry revision: the next boot leaves the failure alone.
    expect(prepareEmbeddingMigration(raw(db), PROVIDER)).toBe(false);
    expect(statusOf(db, "/bad.md")).toBe("failed");
  });

  test("a file that became blank loses its old chunks", async () => {
    const { ctx, db, s3 } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    await write(ctx, { path: "/was-text.md", content: "all about cats" });
    await waitFor(() => statusOf(db, "/was-text.md") === "indexed");
    expect(chunkContents(db, "/was-text.md")).toEqual(["all about cats"]);

    // The new version is blank, and its own embedding job never ran.
    ctx.embeddingProvider = undefined;
    await write(ctx, { path: "/was-text.md", content: "   " });
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();

    const result = await runPendingEmbeddings(db, s3, PROVIDER, { cpuShare: 1 });

    expect(result).toEqual({ indexed: 0, failed: 0, skipped: 1, superseded: 0 });
    expect(statusOf(db, "/was-text.md")).toBeNull();
    expect(chunkContents(db, "/was-text.md")).toEqual([]);
    expect(vectorCount(db)).toBe(0);
  });

  test("blank text never reaches the provider", async () => {
    const { ctx, db } = createTestContext();
    await write(ctx, { path: "/empty.txt", content: "" });
    const path = "/empty.txt";
    const driveId = (raw(db).prepare("SELECT drive_id AS d FROM files WHERE path = ?").get(path) as { d: string }).d;
    raw(db).prepare("UPDATE files SET embedding_status = 'pending'").run();
    const calls: string[][] = [];
    const recording: EmbeddingProvider = {
      ...PROVIDER,
      async embedDocuments(texts, opts) {
        calls.push(texts);
        return PROVIDER.embedDocuments(texts, opts);
      },
    };

    for (const content of ["", "   \n\t "]) {
      expect(
        await indexFileEmbeddings(db, recording, {
          path,
          driveId,
          content,
          version: readCurrentVersion(db, { path, driveId }) ?? null,
        })
      ).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(statusOf(db, path)).toBeNull();
  });
});
