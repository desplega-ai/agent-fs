import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { schema } from "../../db/index.js";
import { fts } from "../fts.js";
import { search } from "../search.js";
import { vecSearch } from "../vec-search.js";
import { indexFile } from "../../search/fts.js";
import type { EmbeddingProvider } from "../../search/embeddings/provider.js";
import { createTestContext } from "../../test-utils.js";

const QUERY_VECTOR = new Array<number>(768).fill(0);
const PROVIDER: EmbeddingProvider = {
  name: "deterministic-test",
  dimensions: 768,
  async embed() {
    return QUERY_VECTOR;
  },
  async embedBatch(texts) {
    return texts.map(() => QUERY_VECTOR);
  },
};

function addDrive(db: DB, orgId: string, driveId: string): void {
  db.insert(schema.drives)
    .values({
      id: driveId,
      orgId,
      name: driveId,
      isDefault: false,
      createdAt: new Date(),
    })
    .run();
}

function addFile(
  db: DB,
  params: {
    path: string;
    driveId: string;
    author: string;
    deleted?: boolean;
  }
): void {
  const now = new Date();
  db.insert(schema.files)
    .values({
      path: params.path,
      driveId: params.driveId,
      size: 1,
      author: params.author,
      createdAt: now,
      modifiedAt: now,
      isDeleted: params.deleted ?? false,
      embeddingStatus: "indexed",
    })
    .run();
}

function addChunk(
  db: DB,
  params: {
    path: string;
    driveId: string;
    distance: number;
    chunkIndex?: number;
  }
): void {
  const chunk = db
    .insert(schema.contentChunks)
    .values({
      filePath: params.path,
      driveId: params.driveId,
      chunkIndex: params.chunkIndex ?? 0,
      content: `${params.path} at ${params.distance}`,
      charOffset: params.chunkIndex ?? 0,
      tokenCount: 1,
    })
    .returning({ id: schema.contentChunks.id })
    .get();
  const vector = new Float32Array(768);
  vector[0] = params.distance;
  const raw = (db as any).$client as Database;
  raw
    .prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)")
    .run(chunk.id, vector);
}

function captureKnnLimits(db: DB): number[] {
  const limits: number[] = [];
  const raw = (db as any).$client as Database;

  (db as any).$client = {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      return {
        all(...params: unknown[]) {
          limits.push(params.at(-1) as number);
          return statement.all(...(params as any[]));
        },
      };
    },
  };

  return limits;
}

describe("scoped vector search", () => {
  test("returns distinct live files from the active drive in distance order", async () => {
    const { ctx, db, driveId, orgId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    const foreignDriveId = "foreign-drive";
    addDrive(db, orgId, foreignDriveId);

    addFile(db, { path: "/foreign.md", driveId: foreignDriveId, author: userId });
    addChunk(db, { path: "/foreign.md", driveId: foreignDriveId, distance: 0.01 });
    addFile(db, { path: "/deleted.md", driveId, author: userId, deleted: true });
    addChunk(db, { path: "/deleted.md", driveId, distance: 0.02 });
    addChunk(db, { path: "/missing.md", driveId, distance: 0.03 });

    addFile(db, { path: "/nearest.md", driveId, author: userId });
    addChunk(db, { path: "/nearest.md", driveId, distance: 0.1, chunkIndex: 0 });
    addChunk(db, { path: "/nearest.md", driveId, distance: 0.11, chunkIndex: 1 });
    addChunk(db, { path: "/nearest.md", driveId, distance: 0.12, chunkIndex: 2 });
    addFile(db, { path: "/second.md", driveId, author: userId });
    addChunk(db, { path: "/second.md", driveId, distance: 0.2 });
    addFile(db, { path: "/third.md", driveId, author: userId });
    addChunk(db, { path: "/third.md", driveId, distance: 0.3 });

    const first = await vecSearch(ctx, { query: "semantic", limit: 1 });
    expect(first.results.map((item) => item.path)).toEqual(["/nearest.md"]);

    const semantic = await vecSearch(ctx, { query: "semantic", limit: 2 });
    expect(semantic.results.map((item) => item.path)).toEqual([
      "/nearest.md",
      "/second.md",
    ]);
    expect(semantic.results[0].score).toBeGreaterThan(semantic.results[1].score);
    expect(semantic.results[0].score).toBeCloseTo(1 / 1.1);
    expect(semantic.results[0].snippet).toContain("at 0.1");

    const hybrid = await search(ctx, { query: "semantic", limit: 2 });
    expect(hybrid.results.map((item) => item.path)).toEqual([
      "/nearest.md",
      "/second.md",
    ]);
    expect(hybrid.results.map((item) => item.score)).toEqual([1 / 61, 1 / 62]);
  });

  test("stops after an empty round when the drive has few eligible files", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    addFile(db, { path: "/only.md", driveId, author: userId });
    for (let index = 0; index < 5; index++) {
      addChunk(db, {
        path: "/only.md",
        driveId,
        distance: 0.1 + index / 100,
        chunkIndex: index,
      });
    }
    const limits = captureKnnLimits(db);

    const result = await vecSearch(ctx, { query: "semantic", limit: 10 });

    expect(result.results.map((item) => item.path)).toEqual(["/only.md"]);
    expect(limits).toEqual([10, 9]);
  });

  test("adds a file per round and does not exceed one round per requested file", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    const requested = 32;

    for (let fileIndex = 0; fileIndex < requested; fileIndex++) {
      const path = `/file-${fileIndex}.md`;
      addFile(db, { path, driveId, author: userId });
      for (let chunkIndex = 0; chunkIndex < requested; chunkIndex++) {
        addChunk(db, {
          path,
          driveId,
          distance: fileIndex + chunkIndex / 100,
          chunkIndex,
        });
      }
    }
    const limits = captureKnnLimits(db);

    const startedAt = performance.now();
    const result = await vecSearch(ctx, { query: "semantic", limit: requested });
    const elapsedMs = performance.now() - startedAt;

    expect(result.results).toHaveLength(requested);
    expect(limits).toEqual(
      Array.from({ length: requested }, (_, index) => requested - index)
    );
    expect(limits.length).toBeLessThanOrEqual(requested);
    console.info(
      `1024-chunk worst-case vector regression completed in ${elapsedMs.toFixed(1)} ms`
    );
  });

  test("caps every KNN request at the installed extension limit", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    const raw = (db as any).$client as Database;
    expect(() =>
      raw
        .prepare(
          "SELECT chunk_id FROM chunk_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
        )
        .all(new Float32Array(768), 4097)
    ).toThrow("limit is 4096");

    addFile(db, { path: "/only.md", driveId, author: userId });
    addChunk(db, { path: "/only.md", driveId, distance: 0.1 });
    const limits = captureKnnLimits(db);

    const startedAt = performance.now();
    const result = await vecSearch(ctx, { query: "semantic", limit: 5000 });
    const elapsedMs = performance.now() - startedAt;

    expect(result.results).toHaveLength(1);
    expect(limits).toEqual([4096, 4096]);
    expect(limits.every((limit) => limit <= 4096)).toBe(true);
    console.info(
      `5000-result sparse-drive regression completed in ${elapsedMs.toFixed(1)} ms`
    );
  });
});

describe("Hybrid keyword quoting", () => {
  test("doubles embedded quotes and preserves OR semantics", async () => {
    const { ctx, db, driveId } = createTestContext();
    indexFile(db, { path: "/alpha.md", driveId, content: "alpha only" });
    indexFile(db, { path: "/gamma.md", driveId, content: "gamma only" });

    const result = await search(ctx, {
      query: 'alpha "quoted" gamma',
      limit: 10,
    });

    expect(result.results.map((item) => item.path).sort()).toEqual([
      "/alpha.md",
      "/gamma.md",
    ]);
  });

  test("leaves raw FTS expressions unchanged", async () => {
    const { ctx, db, driveId } = createTestContext();
    indexFile(db, { path: "/both.md", driveId, content: "alpha beta" });
    indexFile(db, { path: "/alpha.md", driveId, content: "alpha only" });

    const result = await fts(ctx, { pattern: '"alpha" AND "beta"' });

    expect(result.matches.map((item) => item.path)).toEqual(["/both.md"]);
  });
});
