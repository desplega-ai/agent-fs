import { EmbeddingGemmaRuntime } from "../embeddings/embeddinggemma-runtime.mjs";
import { describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { write, writeRaw } from "../../ops/write.js";
import { reindex } from "../../ops/reindex.js";
import { mv } from "../../ops/mv.js";
import { getS3Key } from "../../ops/versioning.js";
import { extractPdfText, PDF_PAGE_IMAGES, renderPdfPages } from "../pdf.js";
import { ftsQuery, removeFromIndex } from "../fts.js";
import { prepareEmbeddingMigration, runPendingEmbeddings } from "../embedding-migration.js";
import { chunkPages, indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

const fixture = async (name: string) => new Uint8Array(await Bun.file(new URL(`fixtures/${name}.pdf`, import.meta.url)).arrayBuffer());
const raw = (db: DB) => (db as any).$client as Database;
const status = (db: DB, path: string) =>
  (raw(db).query("SELECT embedding_status AS status FROM files WHERE path = ?").get(path) as { status: string | null }).status;
const chunks = (db: DB) => raw(db).query("SELECT content, char_offset AS offset, page FROM content_chunks ORDER BY chunk_index").all() as
  { content: string; offset: number; page: number | null }[];

const provider: EmbeddingProvider = {
  name: "fake",
  dimensions: 768,
  async embedQuery() { return [1, ...new Array(767).fill(0)]; },
  async embedDocuments(texts) {
    if (texts.length === 0) throw new Error("Empty batches are invalid");
    return texts.map(() => [1, ...new Array(767).fill(0)]);
  },
};

async function waitForIndexed(db: DB, path: string) {
  for (let i = 0; i < 500 && status(db, path) === "pending"; i++) await Bun.sleep(2);
  expect(status(db, path)).toBe("indexed");
}

describe("PDF text", () => {
  test("extracts both pages with exact offsets and preserves the original bytes", async () => {
    const bytes = await fixture("text");
    const original = bytes.slice();
    const extracted = await extractPdfText(bytes);
    const normalized = extracted.text.replace(/\s+/g, " ");
    expect(normalized).toContain("quarterly aurora invoice");
    expect(normalized).toContain("basalt lighthouse maintenance log");
    expect(extracted.text).toHaveLength(5301);
    expect(extracted.pageStarts).toEqual([0, 2949]);
    expect(extracted.text.slice(2949)).toContain("basalt lighthouse maintenance log");
    expect(bytes).toEqual(original);
  });

  test("an image-only PDF has no extracted text", async () => {
    expect((await extractPdfText(await fixture("image-only"))).text).toBe("");
  });

  test("a truncated PDF returns empty text and still accepts a raw write", async () => {
    const bytes = await fixture("truncated");
    expect(await extractPdfText(bytes)).toEqual({ text: "", pageStarts: [] });
    const { ctx, s3, orgId, driveId } = createTestContext();
    await writeRaw(ctx, { path: "/broken.pdf", bytes });
    expect((await s3.getObject(getS3Key(orgId, driveId, "/broken.pdf"))).body).toEqual(bytes);
  });

  test("an image-only write ends indexed without calling the provider", async () => {
    const { ctx, db } = createTestContext();
    let calls = 0;
    ctx.embeddingProvider = {
      ...provider,
      async embedDocuments(texts, opts) {
        calls++;
        return provider.embedDocuments(texts, opts);
      },
    };
    await writeRaw(ctx, { path: "/image.pdf", bytes: await fixture("image-only") });
    await waitForIndexed(db, "/image.pdf");
    expect(chunks(db)).toEqual([]);
    expect(calls).toBe(0);
  });

  test("reindex marks an image-only PDF indexed without embedding an empty batch", async () => {
    const { ctx, db } = createTestContext();
    await writeRaw(ctx, { path: "/image.pdf", bytes: await fixture("image-only") });
    ctx.embeddingProvider = provider;
    expect(await reindex(ctx, {})).toEqual({ reindexed: 1, failed: 0, skipped: 0 });
    expect(status(db, "/image.pdf")).toBe("indexed");
    expect(chunks(db)).toEqual([]);
  });

  test("boot indexes NULL PDFs once, including empty PDFs, and restores FTS", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    for (const name of ["text", "image-only", "truncated"]) {
      const path = `/${name}.pdf`;
      await writeRaw(ctx, { path, bytes: await fixture(name) });
      raw(db).query("UPDATE files SET embedding_status = NULL WHERE path = ?").run(path);
      expect(status(db, path)).toBeNull();
      removeFromIndex(db, { path, driveId });
    }
    expect(ftsQuery(db, { pattern: "basalt", driveId })).toEqual([]);
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    for (const name of ["text", "image-only", "truncated"]) expect(status(db, `/${name}.pdf`)).toBe("pending");
    expect(await runPendingEmbeddings(db, s3, provider, { cpuShare: 1 })).toEqual({
      indexed: 3, failed: 0, skipped: 0, superseded: 0,
    });
    for (const name of ["text", "image-only", "truncated"]) expect(status(db, `/${name}.pdf`)).toBe("indexed");
    expect(ftsQuery(db, { pattern: "basalt lighthouse maintenance log", driveId }).map((hit) => hit.path)).toEqual(["/text.pdf"]);
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
  });

  test("a chunk that starts in the page separator maps to the next page", () => {
    expect(chunkPages([
      { content: "quarterly aurora invoice", charOffset: 0, tokenCount: 4 },
      { content: "\nbasalt lighthouse maintenance log", charOffset: 24, tokenCount: 6 },
    ], [0, 25])).toEqual([1, 2]);
  });

  test("the only chunk after a blank first page maps to page 2", () => {
    const content = "\n\nbasalt lighthouse maintenance log";
    expect(chunkPages([
      { content, charOffset: 0, tokenCount: 6 },
    ], [0, 2])).toEqual([2]);
  });

  test("PDF fixture chunks carry the page of each phrase", async () => {
    const { ctx, db, driveId } = createTestContext();
    const bytes = await fixture("text");
    const { text: content, pageStarts } = await extractPdfText(bytes);
    await writeRaw(ctx, { path: "/pages.pdf", bytes });
    expect(await indexFileEmbeddings(db, provider, {
      path: "/pages.pdf", driveId, content, pageStarts,
      version: readCurrentVersion(db, { path: "/pages.pdf", driveId }) ?? null,
    })).toBe(true);
    const stored = chunks(db);
    expect(stored).toHaveLength(2);
    expect(stored.find((chunk) => chunk.content.includes("quarterly aurora invoice"))?.page).toBe(1);
    expect(stored.find((chunk) => chunk.content.includes("basalt lighthouse maintenance log"))?.page).toBe(2);
  });

  test("a newer write prevents migration from restoring stale PDF text in FTS", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    await writeRaw(ctx, { path: "/report.pdf", bytes: await fixture("text") });
    prepareEmbeddingMigration(raw(db), provider);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embedding = new Promise<void>((resolve) => { started = resolve; });
    const pending = runPendingEmbeddings(db, s3, {
      ...provider,
      async embedDocuments(texts, opts) {
        started();
        await gate;
        return provider.embedDocuments(texts, opts);
      },
    }, { cpuShare: 1 });
    try {
      await embedding;
      await write(ctx, { path: "/report.pdf", content: "replacement currentcontent" });
    } finally {
      release();
    }
    expect(await pending).toEqual({ indexed: 0, failed: 0, skipped: 0, superseded: 1 });
    expect(ftsQuery(db, { pattern: "basalt", driveId })).toEqual([]);
    expect(ftsQuery(db, { pattern: "currentcontent", driveId }).map((hit) => hit.path)).toEqual(["/report.pdf"]);
  });

  test("a move preserves search data from a newer destination write", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    ctx.embeddingProvider = provider;
    await writeRaw(ctx, { path: "/source.pdf", bytes: await fixture("text") });
    await waitForIndexed(db, "/source.pdf");
    ctx.embeddingProvider = null;
    const deleteObject = s3.deleteObject.bind(s3);
    s3.deleteObject = async (key) => {
      await deleteObject(key);
      await write(ctx, { path: "/target.pdf", content: "replacement currentcontent" });
    };

    await mv(ctx, { from: "/source.pdf", to: "/target.pdf" });

    expect(ftsQuery(db, { pattern: "basalt", driveId })).toEqual([]);
    expect(ftsQuery(db, { pattern: "currentcontent", driveId }).map((hit) => hit.path)).toEqual(["/target.pdf"]);
    expect(raw(db).query("SELECT 1 FROM content_chunks WHERE file_path = '/target.pdf'").get()).toBeNull();
    expect(raw(db).query("SELECT 1 FROM content_chunks WHERE file_path = '/source.pdf'").get()).toBeNull();
    expect(raw(db).query("SELECT 1 FROM chunk_vectors LIMIT 1").get()).toBeNull();
  });
});

describe("PDF page images", () => {
  test("retries worker failures and caches only canvas import failures", async () => {
    const workerPath = new URL("../embeddings/embeddinggemma-worker.ts", import.meta.url).pathname;
    const pdfPath = new URL("../pdf.ts", import.meta.url).pathname;
    // A fresh process isolates the module cache from earlier PDF indexing tests.
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, spyOn } from "bun:test";
      import { embeddingGemmaWorker } from ${JSON.stringify(workerPath)};
      import { canRenderPdfPages } from ${JSON.stringify(pdfPath)};
      const call = spyOn(embeddingGemmaWorker, "call")
        .mockRejectedValueOnce(new Error("EmbeddingGemma worker stopped: crashed"))
        .mockRejectedValueOnce(Object.assign(new Error("@napi-rs/canvas import failed: missing"), { name: "CanvasImportError" }));
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const images = { supportsMime: (mime) => mime === "image/png" };
      expect(await canRenderPdfPages(images)).toBe(false);
      expect(warn.mock.calls[0][0]).toContain("worker stopped");
      expect(warn.mock.calls[0][0]).not.toContain("Install canvas");
      expect(await canRenderPdfPages(images)).toBe(false);
      expect(warn.mock.calls[1][0]).toContain("Install canvas");
      expect(await canRenderPdfPages(images)).toBe(false);
      expect(call).toHaveBeenCalledTimes(2);
    `], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
  });

  test("renders capped pages as PNGs and preserves source bytes", async () => {
    const bytes = await fixture("text");
    const original = bytes.slice();
    const pages = await renderPdfPages(bytes, 1);
    expect(PDF_PAGE_IMAGES).toBe(3);
    expect(pages.map((page) => page.page)).toEqual([1]);
    expect(Array.from(pages[0].data.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes).toEqual(original);
  });

  test("keeps original page locators after a render error and cleans the document", async () => {
    const unpdf = await import("unpdf");
    const destroy = async () => {};
    const pdf = { numPages: 3, loadingTask: { destroy } };
    const open = spyOn(unpdf, "getDocumentProxy").mockResolvedValue(pdf as any);
    const cleanup = spyOn(pdf.loadingTask, "destroy");
    let inFlight = false;
    const render = spyOn(unpdf, "renderPageAsImage").mockImplementation((async (
      document: unknown, page: number, options?: { width?: number; canvasImport?: () => Promise<unknown> }
    ) => {
      expect(document).toBe(pdf);
      expect(options?.width).toBe(1024);
      expect(typeof options?.canvasImport).toBe("function");
      expect(inFlight).toBe(false);
      inFlight = true;
      await Promise.resolve();
      inFlight = false;
      if (page === 2) throw new Error("broken page");
      return new Uint8Array([page]).buffer;
    }) as any);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const runtime = new EmbeddingGemmaRuntime({ paths: { unpdf: "unpdf" }, cacheDir: "", conflict: null, version: "4.3.1", hint: "" }, async () => unpdf);
      const pages = await runtime.renderPdfPages(bytes, PDF_PAGE_IMAGES);
      expect(pages.map(({ page, data }) => [page, ...data])).toEqual([[1, 1], [3, 3]]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).not.toBe(bytes);
      expect(render).toHaveBeenCalledTimes(3);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      render.mockRestore();
      cleanup.mockRestore();
      error.mockRestore();
    }
  });
});
