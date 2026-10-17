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

// The query is e0. A chunk stored as e0 + distance * e1 sits exactly `distance` away.
const QUERY_VECTOR = new Array<number>(768).fill(0);
QUERY_VECTOR[0] = 1;
const PROVIDER: EmbeddingProvider = {
  name: "deterministic-test",
  dimensions: 768,
  async embedQuery() {
    return QUERY_VECTOR;
  },
  async embedDocuments(texts) {
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
    page?: number;
    kind?: "text" | "image";
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
      page: params.page,
      kind: params.kind ?? "text",
    })
    .returning({ id: schema.contentChunks.id })
    .get();
  const vector = new Float32Array(768);
  vector[0] = 1;
  vector[1] = params.distance;
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
    // Cosine from unit-vector L2 distance: 1 - 0.1² / 2.
    expect(semantic.results[0].score).toBeCloseTo(0.995);
    expect(semantic.results[0].snippet).toContain("at 0.1");

    const hybrid = await search(ctx, { query: "semantic", limit: 2 });
    expect(hybrid.results.map((item) => item.path)).toEqual([
      "/nearest.md",
      "/second.md",
    ]);
    // Only the vector list matched: RRF 1/61 and 1/62, scaled by the
    // two-list maximum 2/61, so first place in one of two lists is 0.5.
    expect(hybrid.results[0].score).toBeCloseTo(0.5, 10);
    expect(hybrid.results[1].score).toBeCloseTo(61 / 124, 10);
    expect(hybrid.tookMs).toBeGreaterThanOrEqual(0);
    expect(semantic.tookMs).toBeGreaterThanOrEqual(0);
  });

  test("keeps the best vector page when FTS replaces the PDF snippet", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    addFile(db, { path: "/report.pdf", driveId, author: userId });
    addChunk(db, { path: "/report.pdf", driveId, distance: 0.2, page: 1 });
    addChunk(db, { path: "/report.pdf", driveId, distance: 0.1, page: 2, chunkIndex: 1 });
    indexFile(db, { path: "/report.pdf", driveId, content: "basalt lighthouse maintenance log" });
    indexFile(db, { path: "/keyword-only.pdf", driveId, content: "basalt" });

    const semantic = await vecSearch(ctx, { query: "basalt" });
    expect(semantic.results[0].page).toBe(2);
    expect(semantic.results[0].snippet).toContain("at 0.1");
    const hybrid = await search(ctx, { query: "basalt" });
    expect(hybrid.results[0].path).toBe("/report.pdf");
    expect(hybrid.results[0].page).toBe(2);
    expect(hybrid.results[0].snippet).toContain("lighthouse");
    expect(hybrid.results.find((item) => item.path === "/keyword-only.pdf")?.page).toBeUndefined();
  });

  test.each([undefined, 2])("image matches retain markers and page %s when FTS also hits", async (page) => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    const path = page ? "/diagram.pdf" : "/diagram.png";
    addFile(db, { path, driveId, author: userId });
    addChunk(db, { path, driveId, distance: 0.2, kind: "text", page: 1 });
    addChunk(db, { path, driveId, distance: 0.1, kind: "image", page, chunkIndex: 1 });
    indexFile(db, { path, driveId, content: "basalt lighthouse maintenance log" });

    for (const result of [await vecSearch(ctx, { query: "basalt" }), await search(ctx, { query: "basalt" })]) {
      expect(result.results).toHaveLength(1);
      expect(result.results[0].kind).toBe("image");
      expect(result.results[0].page).toBe(page);
      expect(result.results[0].snippet).toBe(page ? `[PDF page ${page}]` : "[image]");
    }
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
    // One scan: it asked for 80 chunks and got all 5.
    expect(limits).toEqual([80]);
  });

  test("fetches several chunks per wanted file, so files with many chunks need few scans", async () => {
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
    // Worst case: each file holds 32 adjacent chunks. Every scan asks for 8
    // chunks per file still needed, so 10 scans instead of one per file.
    expect(limits).toEqual([256, 192, 144, 104, 72, 48, 32, 24, 16, 8]);
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
    expect(limits).toEqual([4096]);
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

describe("Hybrid image scoring", () => {
  test("puts the first vector image before three text files in both lists", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    addFile(db, { path: "/logo.png", driveId, author: userId });
    addChunk(db, { path: "/logo.png", driveId, distance: 0, kind: "image" });
    for (let i = 1; i <= 3; i++) {
      const path = `/text-${i}.md`;
      addFile(db, { path, driveId, author: userId });
      addChunk(db, { path, driveId, distance: i / 10 });
      indexFile(db, { path, driveId, content: "logo" });
    }
    const { results } = await search(ctx, { query: "logo" });
    expect(results.map((hit) => hit.path)).toEqual(["/logo.png", "/text-1.md", "/text-2.md", "/text-3.md"]);
    expect(results[0].score).toBe(1);
  });

  test("preserves text scores and order from two-list RRF", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    for (let i = 0; i < 4; i++) {
      const path = `/text-${i}.md`;
      addFile(db, { path, driveId, author: userId });
      addChunk(db, { path, driveId, distance: i / 10 });
      if (i > 0) indexFile(db, { path, driveId, content: "logo ".repeat(i) });
    }
    indexFile(db, { path: "/keyword.md", driveId, content: "logo" });
    const reference = [
      { path: "/text-3.md", score: 0.9765625 },
      { path: "/text-2.md", score: 0.9760624679979518 },
      { path: "/text-1.md", score: 0.9684979838709676 },
      { path: "/text-0.md", score: 0.5 },
      { path: "/keyword.md", score: 0.4841269841269841 },
    ];
    const result = await search(ctx, { query: "logo" });
    expect(result.results.map(({ path }) => path)).toEqual(reference.map(({ path }) => path));
    result.results.forEach((hit, index) => expect(hit.score).toBeCloseTo(reference[index].score, 12));
    expect(result.results.find((hit) => hit.path === "/keyword.md")?.kind).toBe("text");
  });

  test("returns the same first three results for limits 3 and 30", async () => {
    const { ctx, db, driveId, userId } = createTestContext();
    ctx.embeddingProvider = PROVIDER;
    for (let i = 0; i < 35; i++) {
      const path = `/text-${i}.md`;
      addFile(db, { path, driveId, author: userId });
      addChunk(db, { path, driveId, distance: i / 100 });
      if (i >= 20) indexFile(db, { path, driveId, content: "logo ".repeat(i - 19) });
    }
    const small = await search(ctx, { query: "logo", limit: 3 });
    const large = await search(ctx, { query: "logo", limit: 30 });
    expect(small.results).toEqual(large.results.slice(0, 3));
    expect(small.results.every((hit) => Number(hit.path.match(/\d+/)?.[0]) >= 20)).toBe(true);
  });

  test("marks keyword-only hits as text without a provider", async () => {
    const { ctx, db, driveId } = createTestContext();
    indexFile(db, { path: "/keyword.md", driveId, content: "logo" });
    const { results } = await search(ctx, { query: "logo" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: "/keyword.md", kind: "text", score: 1 });
  });
});
