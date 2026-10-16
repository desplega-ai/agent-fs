import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { write } from "../../ops/write.js";
import { rm } from "../../ops/rm.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
import { findVectorCandidates } from "../vector-candidates.js";
import {
  QUANTIZED_TABLE,
  isQuantizedIndexReady,
  prepareQuantizedIndex,
  runQuantizedIndexBackfill,
  vectorIndexMode,
} from "../quantized-index.js";

function raw(db: DB): Database {
  return (db as any).$client as Database;
}

/** Deterministic pseudo-random unit vector (mulberry32). */
function randomUnit(seed: number): Float32Array {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vec = new Float32Array(768);
  let norm = 0;
  for (let i = 0; i < 768; i++) {
    vec[i] = next() - 0.5;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) vec[i] /= norm;
  return vec;
}

function nudge(vec: Float32Array, seed: number): Float32Array {
  const noise = randomUnit(seed);
  const out = vec.map((x, i) => x + 0.3 * noise[i]);
  const norm = Math.hypot(...out);
  return out.map((x) => x / norm);
}

function addDrive(db: DB, orgId: string, driveId: string): void {
  db.insert(schema.drives).values({ id: driveId, orgId, name: driveId, isDefault: false, createdAt: new Date() }).run();
}

/** One file with `chunks` chunks; chunk i of file f gets vector randomUnit(f * 1000 + i). */
function addFile(db: DB, driveId: string, author: string, file: number, chunks: number): void {
  const now = new Date();
  const path = `/f${file}.md`;
  db.insert(schema.files)
    .values({ path, driveId, size: 1, author, createdAt: now, modifiedAt: now, isDeleted: false, embeddingStatus: "indexed" })
    .run();
  for (let i = 0; i < chunks; i++) {
    const { id } = db
      .insert(schema.contentChunks)
      .values({ filePath: path, driveId, chunkIndex: i, content: `${path}#${i}`, charOffset: i, tokenCount: 1 })
      .returning({ id: schema.contentChunks.id })
      .get();
    raw(db).prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)").run(id, randomUnit(file * 1000 + i));
  }
}

function bitRows(db: DB): number {
  return (raw(db).prepare(`SELECT count(*) AS n FROM ${QUANTIZED_TABLE}`).get() as { n: number }).n;
}

function tableExists(db: DB): boolean {
  return !!raw(db).prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(QUANTIZED_TABLE);
}

describe("vector int8 index", () => {
  test("is off unless AGENT_FS_VECTOR_INDEX is int8", () => {
    for (const value of [undefined, "", "exact", "binary", "1"]) expect(vectorIndexMode(value)).toBe("exact");
    expect(vectorIndexMode(" INT8 ")).toBe("int8");
  });

  test("backfills stored vectors, then finds the same nearest files as the exact scan, in the drive only", async () => {
    const { db, orgId, driveId, userId } = createTestContext();
    addDrive(db, orgId, "other");
    for (let f = 0; f < 60; f++) addFile(db, driveId, userId, f, 20);
    for (let f = 100; f < 110; f++) addFile(db, "other", userId, f, 20);

    expect(prepareQuantizedIndex(raw(db), "int8")).toBe(true);
    expect(isQuantizedIndexReady(raw(db))).toBe(false);
    expect(await runQuantizedIndexBackfill(raw(db), { batchSize: 250, sleep: async () => {} })).toBe(1400);
    expect(isQuantizedIndexReady(raw(db))).toBe(true);
    // A restart finds it ready and has nothing to copy.
    expect(prepareQuantizedIndex(raw(db), "int8")).toBe(false);

    for (const [target, seed] of [[7, 1], [33, 2], [58, 3]]) {
      const query = nudge(randomUnit(target * 1000 + 4), seed);
      const quantized = findVectorCandidates(db, driveId, query, 5);

      prepareQuantizedIndex(raw(db), "exact");
      const exact = findVectorCandidates(db, driveId, query, 5);
      prepareQuantizedIndex(raw(db), "int8");
      await runQuantizedIndexBackfill(raw(db), { sleep: async () => {} });

      // The near file ranks first with its exact distance. The other four are
      // unrelated random files (distance about 1.4), where the coarse step
      // may pick different ones.
      expect(quantized[0].path).toBe(`/f${target}.md`);
      expect(exact[0].path).toBe(`/f${target}.md`);
      expect(quantized[0].distance).toBeCloseTo(exact[0].distance, 5);
      expect(quantized).toHaveLength(5);
      expect(quantized.every((c) => Number(c.path.slice(2, -3)) < 60)).toBe(true);
    }
  });

  test("new embeddings join the index and deleted files leave it", async () => {
    const { ctx, db, driveId } = createTestContext();
    prepareQuantizedIndex(raw(db), "int8");
    await runQuantizedIndexBackfill(raw(db), { sleep: async () => {} });

    const provider: EmbeddingProvider = {
      name: "fake",
      dimensions: 768,
      async embed() {
        return Array.from(randomUnit(1));
      },
      async embedBatch(texts) {
        return texts.map((_, i) => Array.from(randomUnit(i + 2)));
      },
    };
    await write(ctx, { path: "/a.md", content: "alpha" });
    await indexFileEmbeddings(db, provider, {
      path: "/a.md",
      driveId,
      content: "alpha",
      version: readCurrentVersion(db, { path: "/a.md", driveId }) ?? null,
    });
    expect(bitRows(db)).toBe(1);

    await rm(ctx, { path: "/a.md" });
    expect(bitRows(db)).toBe(0);
  });

  test("turning it off drops the table, and turning it on again rebuilds it", async () => {
    const { db, driveId, userId } = createTestContext();
    addFile(db, driveId, userId, 1, 3);
    prepareQuantizedIndex(raw(db), "int8");
    await runQuantizedIndexBackfill(raw(db), { sleep: async () => {} });
    expect(bitRows(db)).toBe(3);

    expect(prepareQuantizedIndex(raw(db), "exact")).toBe(false);
    expect(tableExists(db)).toBe(false);
    expect(isQuantizedIndexReady(raw(db))).toBe(false);

    expect(prepareQuantizedIndex(raw(db), "int8")).toBe(true);
    expect(await runQuantizedIndexBackfill(raw(db), { sleep: async () => {} })).toBe(3);
  });
});
