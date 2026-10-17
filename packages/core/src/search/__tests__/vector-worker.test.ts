import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, schema, type DB } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { MockS3Client } from "../../test-utils.js";
import { search } from "../../ops/search.js";
import { vecSearch } from "../../ops/vec-search.js";
import type { OpContext } from "../../ops/types.js";
import { indexFile } from "../fts.js";
import { findVectorCandidates } from "../vector-candidates.js";
import { startVectorSearchWorker, stopVectorSearchWorker } from "../vector-worker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function raw(db: DB): Database {
  return (db as any).$client as Database;
}

/** A file-backed database with `files` files of 3 chunks each; chunk vectors sit at distance f + i/10 from e0. */
function setup(files: number) {
  const dir = mkdtempSync(join(tmpdir(), "agent-fs-vec-worker-"));
  dirs.push(dir);
  const path = join(dir, "agent-fs.db");
  const db = createDatabase(path);
  const { user } = createUser(db, { email: "worker@test.local" });
  const orgId = listUserOrgs(db, user.id)[0].id;
  const driveId = listDrives(db, orgId)[0].id;
  const now = new Date();
  for (let f = 0; f < files; f++) {
    db.insert(schema.files)
      .values({ path: `/f${f}.md`, driveId, size: 1, author: user.id, createdAt: now, modifiedAt: now, isDeleted: false, embeddingStatus: "indexed" })
      .run();
    for (let i = 0; i < 3; i++) {
      const { id } = db
        .insert(schema.contentChunks)
        .values({ filePath: `/f${f}.md`, driveId, chunkIndex: i, content: `f${f}#${i}`, charOffset: i, tokenCount: 1 })
        .returning({ id: schema.contentChunks.id })
        .get();
      const vec = new Float32Array(768);
      vec[0] = 1;
      vec[1] = f + i / 10;
      raw(db).prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)").run(id, vec);
    }
  }
  const query = new Float32Array(768);
  query[0] = 1;
  return { db, path, driveId, query, orgId, userId: user.id };
}

/** Makes the main connection refuse KNN queries, so only the worker can answer them. */
function forbidInlineKnn(db: DB): void {
  const sqlite = raw(db);
  const prepare = sqlite.prepare.bind(sqlite);
  (sqlite as any).prepare = (sql: string) => {
    if (sql.includes("embedding MATCH")) throw new Error("KNN ran on the main thread");
    return prepare(sql);
  };
}

describe("vector search worker", () => {
  test("answers KNN on its own connection with the same results as inline", async () => {
    const { db, path, driveId, query } = setup(20);
    const inline = await findVectorCandidates(db, driveId, query, 5);

    startVectorSearchWorker(raw(db), path, { log: () => {} });
    forbidInlineKnn(db);
    const viaWorker = await findVectorCandidates(db, driveId, query, 5);
    stopVectorSearchWorker(raw(db));

    expect(viaWorker.map((c) => c.path)).toEqual(["/f0.md", "/f1.md", "/f2.md", "/f3.md", "/f4.md"]);
    expect(viaWorker).toEqual(inline);
  });

  test.each(["text", "image"] as const)("search and vec-search carry the PDF page and %s kind through the worker", async (kind) => {
    const { db, path, driveId, query, orgId, userId } = setup(1);
    raw(db).prepare("UPDATE files SET path = '/report.pdf', content_type = 'application/pdf'").run();
    raw(db).prepare("UPDATE content_chunks SET file_path = '/report.pdf', page = 3 - chunk_index, kind = CASE WHEN chunk_index = 0 THEN ? ELSE 'text' END").run(kind);
    indexFile(db, { path: "/report.pdf", driveId, content: "basalt lighthouse maintenance log" });
    const ctx: OpContext = {
      db, driveId, orgId, userId, s3: new MockS3Client(),
      embeddingProvider: {
        name: "test", dimensions: 768,
        async embedQuery() { return Array.from(query); },
        async embedDocuments(texts) { return texts.map(() => Array.from(query)); },
      },
    };
    const inline = await findVectorCandidates(db, driveId, query, 1);
    startVectorSearchWorker(raw(db), path, { log: () => {} });
    forbidInlineKnn(db);
    try {
      expect(await findVectorCandidates(db, driveId, query, 1)).toEqual(inline);
      const semantic = await vecSearch(ctx, { query: "basalt" });
      expect(semantic.results[0].path).toBe("/report.pdf");
      expect(semantic.results[0].page).toBe(3);
      expect(semantic.results[0].kind).toBe(kind);
      if (kind === "image") expect(semantic.results[0].snippet).toBe("[PDF page 3]");
      const hybrid = await search(ctx, { query: "basalt" });
      expect(hybrid.results[0].page).toBe(3);
      expect(hybrid.results[0].kind).toBe(kind);
      if (kind === "image") expect(hybrid.results[0].snippet).toBe("[PDF page 3]");
      else expect(hybrid.results[0].snippet).toContain("lighthouse");
    } finally {
      stopVectorSearchWorker(raw(db));
    }
  });

  test("sees rows committed after it opened", async () => {
    const { db, path, driveId, query } = setup(2);
    startVectorSearchWorker(raw(db), path, { log: () => {} });
    expect((await findVectorCandidates(db, driveId, query, 10)).length).toBe(2);

    db.update(schema.files).set({ isDeleted: true }).run();
    expect(await findVectorCandidates(db, driveId, query, 10)).toEqual([]);
    stopVectorSearchWorker(raw(db));
  });

  test("falls back to the main thread when the worker cannot open the database", async () => {
    const { db, driveId, query } = setup(3);
    const logs: string[] = [];
    startVectorSearchWorker(raw(db), "/nonexistent/dir/agent-fs.db", { log: (m) => logs.push(m) });

    // The first search may be queued before the worker reports the failure; it is rejected, not lost.
    const first = await findVectorCandidates(db, driveId, query, 3).catch((err) => err as Error);
    if (first instanceof Error) expect(first.message).toContain("vector search worker stopped");
    const second = await findVectorCandidates(db, driveId, query, 3);

    expect(second.map((c) => c.path)).toEqual(["/f0.md", "/f1.md", "/f2.md"]);
    expect(logs.join("\n")).toContain("searches run on the main thread");
    stopVectorSearchWorker(raw(db));
  });
});

describe("0.16.7 int8 index leftovers", () => {
  test("opening the database drops the table, its trigger and its meta key", () => {
    const { db, path } = setup(1);
    raw(db).exec(`
      CREATE VIRTUAL TABLE chunk_vectors_int8 USING vec0(chunk_id INTEGER PRIMARY KEY, drive_id TEXT PARTITION KEY, embedding int8[768]);
      CREATE TRIGGER content_chunks_int8_delete AFTER DELETE ON content_chunks BEGIN DELETE FROM chunk_vectors_int8 WHERE chunk_id = OLD.id; END;
      INSERT INTO meta(key, value) VALUES ('vec_int8_index', 'ready');
    `);
    raw(db).close();

    const reopened = raw(createDatabase(path));
    const names = (reopened.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%int8%'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual([]);
    expect(reopened.prepare("SELECT 1 FROM meta WHERE key = 'vec_int8_index'").get()).toBeNull();
    reopened.close();
  });
});

