import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { write } from "../../ops/write.js";
import { indexTextForSearch } from "../../ops/search-index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { MAX_QUEUED_EMBED_CHARS } from "../pipeline.js";

const raw = (db: DB) => (db as any).$client as Database;
const pendingCount = (db: DB) =>
  (raw(db).prepare("SELECT COUNT(*) AS n FROM files WHERE embedding_status = 'pending'").get() as { n: number }).n;

/** JS heap after a full collection: strings count toward it, SQLite pages do not. */
function heapBytes(): number {
  Bun.gc(true);
  return heapStats().heapSize;
}

const TEXT_CHARS = 1_000_000;
const FILES = 24;
const QUEUE_BUDGET_CHARS = MAX_QUEUED_EMBED_CHARS;

describe("on-write embedding queue", () => {
  test("waiting jobs hold a bounded amount of text, and every file is embedded", async () => {
    const { ctx, db } = createTestContext();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let calls = 0;
    const provider: EmbeddingProvider = {
      name: "fake",
      dimensions: 768,
      async embedQuery() { return [1, ...new Array(767).fill(0)]; },
      async embedDocuments(texts) {
        calls++;
        await gate;
        return texts.map(() => [1, ...new Array(767).fill(0)]);
      },
    };
    ctx.embeddingProvider = provider;

    try {
      // Two jobs take both embedding slots and wait on the gate.
      await write(ctx, { path: "/busy-0.txt", content: "busy zero" });
      await write(ctx, { path: "/busy-1.txt", content: "busy one" });
      for (let i = 0; i < 200 && calls < 2; i++) await Bun.sleep(5);
      expect(calls).toBe(2);
      for (let i = 0; i < FILES; i++) await write(ctx, { path: `/big-${i}.txt`, content: `small ${i}` });

      // Control: the heap measure sees text the test itself keeps.
      const controlBase = heapBytes();
      let kept: string[] = [];
      for (let i = 0; i < FILES; i++) kept.push(Buffer.alloc(TEXT_CHARS, `k${i} `).toString());
      expect(heapBytes() - controlBase).toBeGreaterThan(FILES * TEXT_CHARS * 0.9);
      kept = [];

      const base = heapBytes();
      for (let i = 0; i < FILES; i++) {
        await indexTextForSearch(ctx, `/big-${i}.txt`, Buffer.alloc(TEXT_CHARS, `w${i} `).toString());
      }
      const retained = heapBytes() - base;
      expect(retained).toBeLessThan(QUEUE_BUDGET_CHARS + 4_000_000);
    } finally {
      open();
    }

    for (let i = 0; i < 3000 && pendingCount(db) > 0; i++) await Bun.sleep(10);
    expect(pendingCount(db)).toBe(0);
    const statuses = raw(db).prepare("SELECT embedding_status AS s FROM files WHERE path LIKE '/big-%'").all() as { s: string }[];
    expect(statuses.map((row) => row.s)).toEqual(new Array(FILES).fill("indexed"));
  }, 60_000);

  test("files past the budget are embedded from storage", async () => {
    const { ctx, db } = createTestContext();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const embedded: string[] = [];
    ctx.embeddingProvider = {
      name: "fake",
      dimensions: 768,
      async embedQuery() { return [1, ...new Array(767).fill(0)]; },
      async embedDocuments(texts) {
        await gate;
        embedded.push(texts.join(""));
        return texts.map(() => [1, ...new Array(767).fill(0)]);
      },
    };
    const files = Math.ceil(QUEUE_BUDGET_CHARS / TEXT_CHARS) + 2;
    const savedShare = process.env.AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE;
    process.env.AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE = "1";
    try {
      for (let i = 0; i < files; i++) {
        await write(ctx, { path: `/big-${i}.txt`, content: Buffer.alloc(TEXT_CHARS, `w${i} `).toString() });
      }
    } finally {
      open();
    }

    try {
      for (let i = 0; i < 3000 && pendingCount(db) > 0; i++) await Bun.sleep(10);
    } finally {
      if (savedShare === undefined) delete process.env.AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE;
      else process.env.AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE = savedShare;
    }
    expect(pendingCount(db)).toBe(0);
    for (let i = 0; i < files; i++) {
      const chunk = raw(db).prepare("SELECT content FROM content_chunks WHERE file_path = ? ORDER BY chunk_index LIMIT 1").get(`/big-${i}.txt`) as
        | { content: string }
        | null;
      expect(chunk?.content.startsWith(`w${i} `)).toBe(true);
    }
    expect(embedded.length).toBeGreaterThanOrEqual(files);
  }, 60_000);
});
