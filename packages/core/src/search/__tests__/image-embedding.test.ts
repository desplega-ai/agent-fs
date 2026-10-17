import { describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { write, writeRaw } from "../../ops/write.js";
import { rm } from "../../ops/rm.js";
import { mv } from "../../ops/mv.js";
import { reindex } from "../../ops/reindex.js";
import { cp } from "../../ops/cp.js";
import { revert } from "../../ops/revert.js";
import { edit } from "../../ops/edit.js";
import { append } from "../../ops/append.js";
import { createTestContext } from "../../test-utils.js";
import { EmbeddingInitializationError, type EmbeddingProvider } from "../embeddings/provider.js";
import { prepareEmbeddingMigration, runEmbeddingMigration, runPendingEmbeddings } from "../embedding-migration.js";
import { imageEligible, prepareImageEmbeddings, runPendingImageEmbeddings, scheduleImageEmbeddings } from "../image-embedding.js";
import { MAX_EMBED_CHARS, indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";

const IMAGE = new Uint8Array([137, 80, 78, 71, 0, 255]);
const VECTOR = Array.from({ length: 768 }, (_, i) => i === 0 ? 3 : i === 1 ? 4 : 0);
const PROVIDER = {
  name: "fake-images",
  dimensions: 768,
  supportsMime: (mime: string) => mime === "image/png",
  async embedQuery() { return VECTOR; },
  async embedDocuments(texts, _opts: { title: string }) { return texts.map(() => VECTOR); },
  async embedParts(parts) { return parts.map(() => VECTOR); },
} satisfies EmbeddingProvider;
const OPTIONS = { cpuShare: 1, log: () => {} };
function raw(db: DB): Database { return (db as any).$client; }
function status(db: DB, path: string): string | null {
  return (raw(db).prepare("SELECT image_embedding_status AS status FROM files WHERE path = ?").get(path) as { status: string | null }).status;
}
function chunks(db: DB, path: string, kind = "image") {
  return raw(db).prepare("SELECT id, kind, page, content FROM content_chunks WHERE file_path = ? AND kind = ? ORDER BY chunk_index").all(path, kind) as {
    id: number; kind: string; page: number | null; content: string;
  }[];
}
function pending(db: DB, path: string): void {
  raw(db).prepare("UPDATE files SET image_embedding_status = 'pending' WHERE path = ?").run(path);
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function pdfBytes(name = "text.pdf"): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer());
}

// These fake vectors exercise index ownership without loading a model.
describe("image embedding job", () => {
  test("a binary write queues one normalized image chunk", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    const gate = signal();
    const started = signal();
    ctx.embeddingProvider = {
      ...PROVIDER,
      async embedParts(parts) {
        started.resolve();
        await gate.promise;
        return PROVIDER.embedParts(parts);
      },
    };
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    await started.promise;
    const queuedStatus = status(db, "/picture.png");
    gate.resolve();
    await scheduleImageEmbeddings(db, s3, ctx.embeddingProvider, OPTIONS);
    expect(queuedStatus).toBe("pending");
    expect(status(db, "/picture.png")).toBe("indexed");
    expect(chunks(db, "/picture.png").map(({ kind, page, content }) => ({ kind, page, content })))
      .toEqual([{ kind: "image", page: null, content: "" }]);
    const stored = raw(db).prepare("SELECT embedding FROM chunk_vectors").get() as { embedding: Uint8Array };
    expect(Math.hypot(...new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, 768))).toBeCloseTo(1, 5);
  });

  test("an overwrite prevents an old image job from committing", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    pending(db, "/picture.png");
    const gate = signal();
    const started = signal();
    const provider: EmbeddingProvider = {
      ...PROVIDER,
      async embedParts(parts) { started.resolve(); await gate.promise; return PROVIDER.embedParts(parts); },
    };
    const run = runPendingImageEmbeddings(db, s3, provider, OPTIONS);
    await started.promise;
    await writeRaw(ctx, { path: "/picture.png", bytes: new Uint8Array([0, 255, 1]) });
    gate.resolve();
    await run;
    expect(chunks(db, "/picture.png")).toHaveLength(0);
    expect(status(db, "/picture.png")).toBeNull();
    pending(db, "/picture.png");
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(status(db, "/picture.png")).toBe("indexed");
  });

  test("move replaces target chunks and carries the image status, then rm removes both kinds", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    for (const path of ["/source.png", "/target.png"]) {
      await writeRaw(ctx, { path, bytes: IMAGE });
      pending(db, path);
    }
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    const sourceId = chunks(db, "/source.png")[0].id;
    const targetId = chunks(db, "/target.png")[0].id;
    ctx.embeddingProvider = PROVIDER;
    await mv(ctx, { from: "/source.png", to: "/target.png" });
    expect(chunks(db, "/source.png")).toHaveLength(0);
    expect(chunks(db, "/target.png").map((chunk) => chunk.id)).toEqual([sourceId]);
    expect(status(db, "/target.png")).toBe("indexed");
    expect(raw(db).prepare("SELECT chunk_id FROM chunk_vectors WHERE chunk_id = ?").get(targetId)).toBeNull();
    await indexFileEmbeddings(db, PROVIDER, {
      path: "/target.png", driveId, content: "caption text",
      version: readCurrentVersion(db, { path: "/target.png", driveId }) ?? null,
    });
    await rm(ctx, { path: "/target.png" });
    expect(chunks(db, "/target.png")).toHaveLength(0);
    expect(chunks(db, "/target.png", "text")).toHaveLength(0);
    expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
  });

  test("move carries a pending image and schedules its new path", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/source.png", bytes: IMAGE });
    pending(db, "/source.png");
    const started = signal();
    const gate = signal();
    ctx.embeddingProvider = {
      ...PROVIDER,
      async embedParts(parts) { started.resolve(); await gate.promise; return PROVIDER.embedParts(parts); },
    };
    await mv(ctx, { from: "/source.png", to: "/moved.png" });
    await started.promise;
    const queuedStatus = status(db, "/moved.png");
    gate.resolve();
    await scheduleImageEmbeddings(db, s3, ctx.embeddingProvider, OPTIONS);
    expect(queuedStatus).toBe("pending");
    expect(status(db, "/moved.png")).toBe("indexed");
    expect(chunks(db, "/source.png")).toHaveLength(0);
    expect(chunks(db, "/moved.png")).toHaveLength(1);
  });

  test.each([true, false])("move preserves PDF text and follows image capability %s", async (imagesSupported) => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/source.pdf", bytes: await pdfBytes() });
    await indexFileEmbeddings(db, PROVIDER, {
      path: "/source.pdf", driveId, content: "PDF caption", pageStarts: [0],
      version: readCurrentVersion(db, { path: "/source.pdf", driveId }) ?? null,
    });
    pending(db, "/source.pdf");
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    const text = chunks(db, "/source.pdf", "text");
    const images = chunks(db, "/source.pdf");
    const { supportsMime, embedParts, ...textOnly } = PROVIDER;
    ctx.embeddingProvider = imagesSupported ? PROVIDER : textOnly;
    // Preserve the PDF MIME type even when the destination extension changes.
    await mv(ctx, { from: "/source.pdf", to: "/moved.txt" });
    expect(chunks(db, "/moved.txt", "text")).toEqual(text);
    expect(chunks(db, "/moved.txt")).toEqual(imagesSupported ? images : []);
    expect(status(db, "/moved.txt")).toBe(imagesSupported ? "indexed" : null);
    expect(chunks(db, "/source.pdf", "text")).toHaveLength(0);
    expect(chunks(db, "/source.pdf")).toHaveLength(0);
    expect(raw(db).prepare("SELECT content FROM files_fts_docs WHERE path = '/moved.txt'").get()).not.toBeNull();
  });

  test("reindex preserves an indexed image and retries a failed image", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    pending(db, "/picture.png");
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    const before = chunks(db, "/picture.png");
    ctx.embeddingProvider = PROVIDER;
    await reindex(ctx, {});
    expect(chunks(db, "/picture.png")).toEqual(before);
    expect(status(db, "/picture.png")).toBe("indexed");
    raw(db).prepare("UPDATE files SET image_embedding_status = 'failed' WHERE path = '/picture.png'").run();
    await reindex(ctx, {});
    await scheduleImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(status(db, "/picture.png")).toBe("indexed");
    expect(chunks(db, "/picture.png")).toHaveLength(1);
  });

  test("a format change clears image vectors and permits a new boot backfill", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    pending(db, "/picture.png");
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(prepareEmbeddingMigration(raw(db), { ...PROVIDER, name: "new-model" })).toBe(false);
    expect(chunks(db, "/picture.png")).toHaveLength(0);
    expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
    expect(status(db, "/picture.png")).toBeNull();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await prepareImageEmbeddings(raw(db), PROVIDER);
    expect(status(db, "/picture.png")).toBe("pending");
  });

  test("PDF text and image reruns replace only their own chunks", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    const path = "/report.pdf";
    await writeRaw(ctx, { path, bytes: await pdfBytes() });
    pending(db, path);
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(chunks(db, path).map((chunk) => chunk.page)).toEqual([1, 2]);
    const images = chunks(db, path);
    raw(db).prepare("UPDATE files SET embedding_status = 'pending' WHERE path = ?").run(path);
    await runPendingEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(chunks(db, path)).toEqual(images);
    const text = chunks(db, path, "text");
    expect(text.length).toBeGreaterThan(0);
    pending(db, path);
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    expect(chunks(db, path, "text")).toEqual(text);
    expect(chunks(db, path)).toHaveLength(2);

    await indexFileEmbeddings(db, PROVIDER, {
      path, driveId, content: "x".repeat(MAX_EMBED_CHARS + 1), pageStarts: [0],
      version: readCurrentVersion(db, { path, driveId }) ?? null,
    });
    expect(chunks(db, path, "text")).toHaveLength(0);
    expect(chunks(db, path).map((chunk) => chunk.page)).toEqual([1, 2]);
    expect(status(db, path)).toBe("indexed");
    expect(raw(db).prepare("SELECT embedding_status FROM files WHERE path = ?").get(path)).toEqual({ embedding_status: "skipped" });
  });

  test("text-only providers skip image work without image methods", async () => {
    const { ctx, db, s3 } = createTestContext();
    const { supportsMime, embedParts, ...textOnly } = PROVIDER;
    ctx.embeddingProvider = textOnly;
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    await writeRaw(ctx, { path: "/report.pdf", bytes: await pdfBytes("image-only.pdf") });
    prepareEmbeddingMigration(raw(db), textOnly);
    await prepareImageEmbeddings(raw(db), textOnly);
    await runPendingImageEmbeddings(db, s3, textOnly, OPTIONS);
    expect(status(db, "/picture.png")).toBeNull();
    expect(status(db, "/report.pdf")).toBeNull();
  });

  test("eligibility follows provider MIME support and PDF capability", () => {
    expect(imageEligible(PROVIDER, "image/png", false)).toBe(true);
    expect(imageEligible(PROVIDER, "image/jpeg", true)).toBe(false);
    expect(imageEligible(PROVIDER, "application/pdf", false)).toBe(false);
    expect(imageEligible(PROVIDER, "application/pdf", true)).toBe(true);
    expect(imageEligible(null, "image/png", true)).toBe(false);
  });

  test("boot marks only the interrupted file failed before it queues new files", async () => {
    const { ctx, db, driveId } = createTestContext();
    await writeRaw(ctx, { path: "/poison.png", bytes: IMAGE });
    await writeRaw(ctx, { path: "/healthy.png", bytes: IMAGE });
    prepareEmbeddingMigration(raw(db), PROVIDER);
    const version = readCurrentVersion(db, { path: "/poison.png", driveId });
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('image_job_current', ?)")
      .run(JSON.stringify({ driveId, path: "/poison.png", version }));
    await prepareImageEmbeddings(raw(db), PROVIDER);
    expect(status(db, "/poison.png")).toBe("failed");
    expect(status(db, "/healthy.png")).toBe("pending");
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = 'image_job_current'").get()).toBeNull();
  });

  test("boot ignores an interrupted version after a newer write", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/picture.png";
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path, bytes: IMAGE });
    const version = readCurrentVersion(db, { path, driveId });
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('image_job_current', ?)")
      .run(JSON.stringify({ driveId, path, version }));
    await writeRaw(ctx, { path, bytes: new Uint8Array([0, 255, 3]) });
    await prepareImageEmbeddings(raw(db), PROVIDER);
    expect(status(db, path)).toBe("pending");
  });

  test("the job paces each image part with CPU time", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    pending(db, "/picture.png");
    let cpu = 0;
    const pauses: number[] = [];
    await runPendingImageEmbeddings(db, s3, PROVIDER, {
      cpuShare: 0.25,
      cpuMs: () => cpu += 4,
      sleep: async (ms) => { pauses.push(ms); },
    });
    expect(pauses).toEqual([12]);
    expect(status(db, "/picture.png")).toBe("indexed");
  });

  test("a provider initialization error leaves all files pending", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    for (const path of ["/first.png", "/second.png"]) {
      await writeRaw(ctx, { path, bytes: IMAGE });
      pending(db, path);
    }
    let calls = 0;
    const failing: EmbeddingProvider = {
      ...PROVIDER,
      async embedParts() { calls++; throw new EmbeddingInitializationError("Vision download failed"); },
    };
    await expect(runPendingImageEmbeddings(db, s3, failing, OPTIONS)).rejects.toBeInstanceOf(EmbeddingInitializationError);
    expect(calls).toBe(1);
    expect(status(db, "/first.png")).toBe("pending");
    expect(status(db, "/second.png")).toBe("pending");
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = 'image_job_current'").get()).toBeNull();
  });

  test("copy and revert queue fresh image embeddings", async () => {
    const { ctx, db, s3 } = createTestContext({ versioningEnabled: true });
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    await writeRaw(ctx, { path: "/picture.png", bytes: new Uint8Array([0, 255, 2]) });
    let calls = 0;
    ctx.embeddingProvider = {
      ...PROVIDER,
      async embedParts(parts) { calls++; return PROVIDER.embedParts(parts); },
    };
    await cp(ctx, { from: "/picture.png", to: "/copy.png" });
    await scheduleImageEmbeddings(db, s3, ctx.embeddingProvider, OPTIONS);
    expect(status(db, "/copy.png")).toBe("indexed");
    expect(chunks(db, "/copy.png")).toHaveLength(1);
    await revert(ctx, { path: "/picture.png", version: 1 });
    await scheduleImageEmbeddings(db, s3, ctx.embeddingProvider, OPTIONS);
    expect(status(db, "/picture.png")).toBe("indexed");
    expect(chunks(db, "/picture.png")).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test.each(["write", "edit", "append"])("%s clears stale images from a text file", async (operation) => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/note.txt";
    await write(ctx, { path, content: "old text" });
    const chunk = raw(db).prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count, kind) VALUES (?, ?, 0, '', 0, 0, 'image') RETURNING id"
    ).get(path, driveId) as { id: number };
    raw(db).prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)").run(chunk.id, new Float32Array(VECTOR));
    raw(db).prepare("UPDATE files SET image_embedding_status = 'indexed' WHERE path = ?").run(path);
    if (operation === "edit") await edit(ctx, { path, old_string: "old", new_string: "new" });
    else if (operation === "append") await append(ctx, { path, content: " appended" });
    else await write(ctx, { path, content: "new text" });
    expect(status(db, path)).toBeNull();
    expect(chunks(db, path)).toHaveLength(0);
    expect(raw(db).prepare("SELECT chunk_id FROM chunk_vectors WHERE chunk_id = ?").get(chunk.id)).toBeNull();
  });

  test("the image job waits until a text migration releases its slot", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await write(ctx, { path: "/note.txt", content: "migration text" });
    await writeRaw(ctx, { path: "/picture.png", bytes: IMAGE });
    pending(db, "/picture.png");
    const gate = signal();
    const textStarted = signal();
    let imageCalls = 0;
    const provider: EmbeddingProvider = {
      ...PROVIDER,
      async embedDocuments(texts, options) {
        textStarted.resolve();
        await gate.promise;
        return PROVIDER.embedDocuments(texts, options);
      },
      async embedParts(parts) { imageCalls++; return PROVIDER.embedParts(parts); },
    };
    const textRun = runPendingEmbeddings(db, s3, provider, OPTIONS);
    await textStarted.promise;
    const imageRun = runPendingImageEmbeddings(db, s3, provider, OPTIONS);
    await Bun.sleep(0);
    const callsDuringMigration = imageCalls;
    gate.resolve();
    await Promise.all([textRun, imageRun]);
    expect(callsDuringMigration).toBe(0);
    expect(imageCalls).toBe(1);
    expect(status(db, "/picture.png")).toBe("indexed");
  });

  test("failed warmup leaves image statuses unchanged", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    await writeRaw(ctx, { path: "/boot.png", bytes: IMAGE });
    await writeRaw(ctx, { path: "/poison.png", bytes: IMAGE });
    pending(db, "/poison.png");
    const version = readCurrentVersion(db, { path: "/poison.png", driveId });
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('image_job_current', ?)")
      .run(JSON.stringify({ driveId, path: "/poison.png", version }));
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('embedding_format', 'old:v2')").run();
    const provider = { ...PROVIDER, async embedQuery() { throw new Error("Model unavailable"); } };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const migration = await runEmbeddingMigration(db, s3, provider, {
        ...OPTIONS,
        afterMigration: async () => { expect(await prepareImageEmbeddings(raw(db), provider)).toBe(false); },
      });
      expect(migration).toBeNull();
      expect(status(db, "/boot.png")).toBeNull();
      expect(status(db, "/poison.png")).toBe("pending");
      expect(raw(db).prepare("SELECT value FROM meta WHERE key = 'image_job_current'").get()).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  test("failed warmup preserves indexed text, images, and vectors", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/old.png", bytes: IMAGE });
    pending(db, "/old.png");
    await runPendingImageEmbeddings(db, s3, PROVIDER, OPTIONS);
    await write(ctx, { path: "/old.txt", content: "old indexed text" });
    await indexFileEmbeddings(db, PROVIDER, {
      path: "/old.txt", driveId, content: "old indexed text",
      version: readCurrentVersion(db, { path: "/old.txt", driveId }) ?? null,
    });
    raw(db).prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('embedding_format', 'old:v2')").run();
    const images = chunks(db, "/old.png");
    const text = chunks(db, "/old.txt", "text");
    const vectors = raw(db).prepare("SELECT chunk_id, embedding FROM chunk_vectors ORDER BY chunk_id").all();
    const provider = { ...PROVIDER, async embedQuery() { throw new Error("Model unavailable"); } };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runEmbeddingMigration(db, s3, provider, {
        ...OPTIONS,
        afterMigration: async () => { await prepareImageEmbeddings(raw(db), provider); },
      });
      expect(status(db, "/old.png")).toBe("indexed");
      expect(chunks(db, "/old.png")).toEqual(images);
      expect(chunks(db, "/old.txt", "text")).toEqual(text);
      expect(raw(db).prepare("SELECT chunk_id, embedding FROM chunk_vectors ORDER BY chunk_id").all()).toEqual(vectors);
      expect(raw(db).prepare("SELECT value FROM meta WHERE key = 'embedding_format'").get()).toEqual({ value: "old:v2" });
    } finally {
      error.mockRestore();
    }
  });

  test("a queued image job waits for failed warmup and defers on the old format", async () => {
    const { ctx, db, s3 } = createTestContext();
    await writeRaw(ctx, { path: "/queued.png", bytes: IMAGE });
    pending(db, "/queued.png");
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('embedding_format', 'old:v2')").run();
    const started = signal();
    const gate = signal();
    let imageCalls = 0;
    const provider = {
      ...PROVIDER,
      async embedQuery() { started.resolve(); await gate.promise; throw new Error("Model unavailable"); },
      async embedParts(parts: Parameters<typeof PROVIDER.embedParts>[0]) { imageCalls++; return PROVIDER.embedParts(parts); },
    };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const migration = runEmbeddingMigration(db, s3, provider, OPTIONS);
      await started.promise;
      const queued = scheduleImageEmbeddings(db, s3, provider, OPTIONS);
      expect(imageCalls).toBe(0);
      gate.resolve();
      expect(await migration).toBeNull();
      await queued;
      expect(imageCalls).toBe(0);
      expect(status(db, "/queued.png")).toBe("pending");
    } finally {
      gate.resolve();
      error.mockRestore();
    }
  });

  test("the scheduler runs one job and processes files queued during it", async () => {
    const { ctx, db, s3 } = createTestContext();
    prepareEmbeddingMigration(raw(db), PROVIDER);
    await writeRaw(ctx, { path: "/first.png", bytes: IMAGE });
    pending(db, "/first.png");
    const gate = signal();
    const started = signal();
    let calls = 0;
    let active = 0;
    let peak = 0;
    const provider: EmbeddingProvider = {
      ...PROVIDER,
      async embedParts(parts) {
        peak = Math.max(peak, ++active);
        if (++calls === 1) { started.resolve(); await gate.promise; }
        active--;
        return PROVIDER.embedParts(parts);
      },
    };
    const first = scheduleImageEmbeddings(db, s3, provider, OPTIONS);
    await started.promise;
    await writeRaw(ctx, { path: "/second.png", bytes: IMAGE });
    pending(db, "/second.png");
    const second = scheduleImageEmbeddings(db, s3, provider, OPTIONS);
    gate.resolve();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    expect(calls).toBe(2);
    expect(status(db, "/first.png")).toBe("indexed");
    expect(status(db, "/second.png")).toBe("indexed");
  });
});
