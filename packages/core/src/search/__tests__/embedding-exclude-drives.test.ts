import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DB } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { createDrive } from "../../identity/drives.js";
import { write, writeRaw } from "../../ops/write.js";
import { search } from "../../ops/search.js";
import { ftsQuery, indexedContent } from "../fts.js";
import { indexFileEmbeddings, readCurrentVersion } from "../pipeline.js";
import { EXCLUDE_DRIVES_KEY, FORMAT_KEY, MAX_BYTES_KEY, embeddingFormat, prepareEmbeddingMigration, prepareEmbeddingMigrationWithWarmup, runPendingEmbeddings } from "../embedding-migration.js";
import { prepareImageEmbeddings, runPendingImageEmbeddings } from "../image-embedding.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

const raw = (db: DB) => (db as any).$client as Database;
const status = (db: DB, path: string) => raw(db).prepare(
  "SELECT embedding_status AS text, image_embedding_status AS image FROM files WHERE path = ?"
).get(path) as { text: string | null; image: string | null };
const vector = [1, ...new Array(767).fill(0)];
const provider: EmbeddingProvider = {
  name: "fake",
  dimensions: 768,
  supportsMime: (mime) => mime === "image/png",
  async embedQuery() { return vector; },
  async embedDocuments(texts) { return texts.map(() => vector); },
  async embedParts(parts) { return parts.map(() => vector); },
};
const options = { cpuShare: 1 };
const image = new Uint8Array([137, 80, 78, 71, 0, 255]);
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ["AGENT_FS_EMBEDDING_EXCLUDE_DRIVES", "AGENT_FS_EMBEDDING_MAX_BYTES"]) {
    saved[key] = process.env[key];
    process.env[key] = "";
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function embed(db: DB, driveId: string, path: string, content: string) {
  return indexFileEmbeddings(db, provider, {
    path, driveId, content, version: readCurrentVersion(db, { path, driveId }) ?? null,
  });
}

async function waitForStatus(db: DB, path: string, expected: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (status(db, path).text === expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path} to reach ${expected}. Current status: ${status(db, path).text}`);
}

describe("embedding drive exclusions", () => {
  test.each([undefined, "", " , , "])("list %s preserves text and image embedding", async (list) => {
    const { ctx, db, s3, driveId } = createTestContext();
    if (list === undefined) delete process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES;
    else process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = list;
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/text.md", content: "lighthouse" });
    expect(await embed(db, driveId, "/text.md", "lighthouse")).toBe("indexed");
    await writeRaw(ctx, { path: "/picture.png", bytes: image });
    expect(await prepareImageEmbeddings(raw(db), provider)).toBe(true);
    expect(await runPendingImageEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, failed: 0, superseded: 0 });
    expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 2 });
  });

  test("an excluded write keeps FTS and hybrid hits, deletes text vectors and skips the provider", async () => {
    const { ctx, db, driveId } = createTestContext();
    const path = "/text.md";
    await write(ctx, { path, content: "old" });
    await embed(db, driveId, path, "old");
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = ` , ${driveId}, `;
    const calls = spyOn(provider, "embedDocuments");
    try {
      ctx.embeddingProvider = provider;
      const content = "basalt lighthouse";
      await write(ctx, { path, content });
      await waitForStatus(db, path, "skipped");
      expect(status(db, path).text).toBe("skipped");
      expect(indexedContent(db, { path, driveId })).toBe(content);
      expect(ftsQuery(db, { pattern: "lighthouse", driveId }).map((match) => match.path)).toEqual([path]);
      expect(raw(db).prepare("SELECT count(*) AS n FROM content_chunks").get()).toEqual({ n: 0 });
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
      expect(calls).not.toHaveBeenCalled();
      expect((await search(ctx, { query: "lighthouse" })).results.map((hit) => hit.path)).toEqual([path]);
    } finally {
      calls.mockRestore();
    }
  });

  test("migration skips an excluded drive and embeds the same path in another drive", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext();
    const other = createDrive(db, { orgId, name: "other", creatorUserId: userId });
    await write(ctx, { path: "/text.md", content: "excluded" });
    await embed(db, driveId, "/text.md", "excluded");
    await write({ ...ctx, driveId: other.id }, { path: "/text.md", content: "included" });
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    prepareEmbeddingMigration(raw(db), provider);
    const calls = spyOn(provider, "embedDocuments");
    try {
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, skipped: 1, failed: 0, superseded: 0 });
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0][0]).toEqual(["included"]);
      expect(raw(db).prepare("SELECT drive_id FROM content_chunks").all()).toEqual([{ drive_id: other.id }]);
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 1 });
    } finally {
      calls.mockRestore();
    }
  });

  test("image preparation and the job exclude drives on boot and on write", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext();
    const other = createDrive(db, { orgId, name: "other", creatorUserId: userId });
    prepareEmbeddingMigration(raw(db), provider);
    await writeRaw(ctx, { path: "/excluded.png", bytes: image });
    await writeRaw({ ...ctx, driveId: other.id }, { path: "/included.png", bytes: image });
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    raw(db).prepare("INSERT INTO meta(key, value) VALUES ('image_job_current', ?)").run(
      JSON.stringify({ driveId, path: "/excluded.png", version: readCurrentVersion(db, { driveId, path: "/excluded.png" }) })
    );
    expect(await prepareImageEmbeddings(raw(db), provider)).toBe(true);
    expect(status(db, "/excluded.png").image).toBeNull();
    // A stale pending row must also stay outside the job's selection.
    raw(db).prepare("UPDATE files SET image_embedding_status = 'pending' WHERE drive_id = ?").run(driveId);
    const calls = spyOn(provider, "embedParts");
    const reads = spyOn(s3, "getObject");
    try {
      expect(await runPendingImageEmbeddings(db, s3, provider, { ...options, batchSize: 1 })).toEqual({ indexed: 1, failed: 0, superseded: 0 });
      expect(calls).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0][0]).toContain(other.id);
      ctx.embeddingProvider = provider;
      await writeRaw(ctx, { path: "/excluded.png", bytes: image });
      expect(status(db, "/excluded.png").image).toBeNull();
      const pdf = new Uint8Array(await Bun.file(new URL("fixtures/text.pdf", import.meta.url)).arrayBuffer());
      await writeRaw(ctx, { path: "/excluded.pdf", bytes: pdf });
      await waitForStatus(db, "/excluded.pdf", "skipped");
      expect(status(db, "/excluded.pdf")).toEqual({ text: "skipped", image: null });
      expect(calls).toHaveBeenCalledTimes(1);
      expect(await prepareImageEmbeddings(raw(db), provider)).toBe(false);
    } finally {
      calls.mockRestore();
      reads.mockRestore();
    }
  });

  test("adding and removing a drive requeues text and clears then restores image eligibility", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/indexed.md", content: "lighthouse" });
    await embed(db, driveId, "/indexed.md", "lighthouse");
    await write(ctx, { path: "/pending.md", content: "basalt" });
    await writeRaw(ctx, { path: "/picture.png", bytes: image });
    const pdf = new Uint8Array(await Bun.file(new URL("fixtures/text.pdf", import.meta.url)).arrayBuffer());
    await writeRaw(ctx, { path: "/report.pdf", bytes: pdf });
    await prepareImageEmbeddings(raw(db), provider);
    await runPendingImageEmbeddings(db, s3, provider, options);
    expect(status(db, "/picture.png").image).toBe("indexed");
    expect(status(db, "/report.pdf").image).toBe("indexed");
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/indexed.md").text).toBe("pending");
    expect(status(db, "/pending.md").text).toBe("pending");
    expect(status(db, "/picture.png").image).toBeNull();
    expect(status(db, "/report.pdf").image).toBeNull();
    expect(raw(db).prepare("SELECT count(*) AS n FROM content_chunks WHERE kind = 'image'").get()).toEqual({ n: 0 });
    const calls = spyOn(provider, "embedDocuments");
    try {
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 0, skipped: 3, failed: 0, superseded: 0 });
      expect(calls).not.toHaveBeenCalled();
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
      expect(await prepareImageEmbeddings(raw(db), provider)).toBe(false);
      expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
      process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = ` ${driveId},,${driveId} `;
      expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
      process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = "";
      expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
      expect(status(db, "/indexed.md").text).toBe("pending");
      expect(status(db, "/report.pdf").text).toBe("pending");
      expect(await prepareImageEmbeddings(raw(db), provider)).toBe(true);
      expect(status(db, "/picture.png").image).toBe("pending");
      expect(status(db, "/report.pdf").image).toBe("pending");
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 3, skipped: 0, failed: 0, superseded: 0 });
      await runPendingImageEmbeddings(db, s3, provider, options);
      expect(status(db, "/picture.png").image).toBe("indexed");
      expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(EXCLUDE_DRIVES_KEY)).toEqual({ value: "[]" });
    } finally {
      calls.mockRestore();
    }
  });

  test("prod boot keeps the same format and cap while applying a new exclusion list", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext();
    const excluded = createDrive(db, { orgId, name: "excluded", creatorUserId: userId });
    const excludedCtx = { ...ctx, driveId: excluded.id };
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "1048576";
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/done.md", content: "done" });
    await embed(db, driveId, "/done.md", "done");
    await write(ctx, { path: "/todo.md", content: "todo" });
    for (const path of ["/pending.json", "/failed.json"]) {
      await write(excludedCtx, { path, content: '{"a":1}' });
      await embed(db, excluded.id, path, '{"a":1}');
    }
    raw(db).exec("UPDATE files SET embedding_status = 'pending' WHERE path = '/pending.json'");
    raw(db).exec("UPDATE files SET embedding_status = 'failed' WHERE path = '/failed.json'");
    await writeRaw(excludedCtx, { path: "/picture.png", bytes: image });
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(FORMAT_KEY)).toEqual({ value: embeddingFormat(provider) });
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(MAX_BYTES_KEY)).toEqual({ value: "1048576" });
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = ` ${excluded.id}, other-id `;
    const reads = spyOn(s3, "getObject");
    const documents = spyOn(provider, "embedDocuments");
    const queries = spyOn(provider, "embedQuery");
    const parts = spyOn(provider, "embedParts");
    try {
      expect(await prepareEmbeddingMigrationWithWarmup(raw(db), provider)).toBe(true);
      expect(status(db, "/done.md").text).toBe("indexed");
      expect(status(db, "/failed.json").text).toBe("pending");
      expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, skipped: 2, failed: 0, superseded: 0 });
      expect(status(db, "/done.md").text).toBe("indexed");
      expect(status(db, "/pending.json").text).toBe("skipped");
      expect(status(db, "/failed.json").text).toBe("skipped");
      expect(indexedContent(db, { driveId: excluded.id, path: "/pending.json" })).toBe('{"a":1}');
      expect(raw(db).prepare("SELECT count(*) AS n FROM content_chunks WHERE drive_id = ?").get(excluded.id)).toEqual({ n: 0 });
      expect(raw(db).prepare("SELECT count(*) AS n FROM chunk_vectors").get()).toEqual({ n: 2 });
      expect(await prepareImageEmbeddings(raw(db), provider)).toBe(false);
      expect(status(db, "/picture.png").image).toBeNull();
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0][0]).toContain("/todo.md");
      expect(documents).toHaveBeenCalledTimes(1);
      expect(documents.mock.calls[0][0]).toEqual(["todo"]);
      expect(queries).not.toHaveBeenCalled();
      expect(parts).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      documents.mockRestore();
      queries.mockRestore();
      parts.mockRestore();
    }
  });

  test.each(["{corrupt", "null", "{}", '[null, 1]'])("boot recovers from an invalid stored exclusion list: %s", async (stored) => {
    const { ctx, db, s3, driveId } = createTestContext();
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/text.md", content: "lighthouse" });
    await embed(db, driveId, "/text.md", "lighthouse");
    raw(db).prepare("UPDATE meta SET value = ? WHERE key = ?").run(stored, EXCLUDE_DRIVES_KEY);
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 0, skipped: 1, failed: 0, superseded: 0 });
    expect(status(db, "/text.md").text).toBe("skipped");
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(EXCLUDE_DRIVES_KEY)).toEqual({ value: JSON.stringify([driveId]) });
  });

  test.each(["4", "8", ""])("cap change to %s leaves excluded skipped files alone", async (cap) => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext();
    const other = createDrive(db, { orgId, name: "other", creatorUserId: userId });
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "5";
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/excluded.md", content: "text" });
    await embed(db, driveId, "/excluded.md", "text");
    await write({ ...ctx, driveId: other.id }, { path: "/included.md", content: "oversized text" });
    await embed(db, other.id, "/included.md", "oversized text");
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = cap;
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(status(db, "/excluded.md").text).toBe("skipped");
    expect(status(db, "/included.md").text).toBe("pending");
    const reads = spyOn(s3, "getObject");
    try {
      await runPendingEmbeddings(db, s3, provider, options);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0][0]).toContain(other.id);
      expect(status(db, "/excluded.md").text).toBe("skipped");
    } finally {
      reads.mockRestore();
    }
  });

  test("format, cap and exclusion changes apply during the same boot", async () => {
    const { ctx, db, s3, driveId, orgId, userId } = createTestContext();
    const other = createDrive(db, { orgId, name: "other", creatorUserId: userId });
    prepareEmbeddingMigration(raw(db), provider);
    await write(ctx, { path: "/excluded.md", content: "short" });
    await embed(db, driveId, "/excluded.md", "short");
    await write({ ...ctx, driveId: other.id }, { path: "/capped.md", content: "long text" });
    await embed(db, other.id, "/capped.md", "long text");
    await write({ ...ctx, driveId: other.id }, { path: "/small.md", content: "small" });
    process.env.AGENT_FS_EMBEDDING_EXCLUDE_DRIVES = driveId;
    process.env.AGENT_FS_EMBEDDING_MAX_BYTES = "5";
    raw(db).prepare("UPDATE meta SET value = 'old:v1' WHERE key = ?").run(FORMAT_KEY);
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(true);
    expect(await runPendingEmbeddings(db, s3, provider, options)).toEqual({ indexed: 1, skipped: 2, failed: 0, superseded: 0 });
    expect(status(db, "/excluded.md").text).toBe("skipped");
    expect(status(db, "/capped.md").text).toBe("skipped");
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(MAX_BYTES_KEY)).toEqual({ value: "5" });
    expect(raw(db).prepare("SELECT value FROM meta WHERE key = ?").get(EXCLUDE_DRIVES_KEY)).toEqual({ value: JSON.stringify([driveId]) });
    expect(prepareEmbeddingMigration(raw(db), provider)).toBe(false);
  });
});
