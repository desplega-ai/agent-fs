import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../index.js";
import {
  CONTENT_CHUNKS_INDEX_NAME,
  INLINE_BUILD_MAX_ROWID,
  buildContentChunksIndexInHelperProcess,
  contentChunksMaxRowid,
  hasContentChunksIndex,
} from "../content-chunks-index.js";

const testDbPaths: string[] = [];

function makeTestDbPath(): string {
  const p = join(
    tmpdir(),
    `agent-fs-cc-index-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  testDbPaths.push(p);
  return p;
}

function rawOf(db: ReturnType<typeof createDatabase>): Database {
  return (db as any).$client as Database;
}

function dropIndex(sqlite: Database): void {
  sqlite.exec(`DROP INDEX IF EXISTS ${CONTENT_CHUNKS_INDEX_NAME}`);
}

function insertChunks(sqlite: Database, count: number): void {
  const insert = sqlite.prepare(
    "INSERT INTO content_chunks (file_path, drive_id, chunk_index, content, char_offset, token_count) " +
      "VALUES (?, 'drive', 0, 'x', 0, 1)",
  );
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`/f${i}.txt`);
  })();
}

afterEach(() => {
  for (const p of testDbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {}
    }
  }
  testDbPaths.length = 0;
});

describe("content_chunks index placement", () => {
  test("createDatabase builds the index inline by default", () => {
    const sqlite = rawOf(createDatabase(makeTestDbPath()));
    expect(hasContentChunksIndex(sqlite)).toBe(true);
    sqlite.close();
  });

  test("deferring on a fresh database still builds inline (small table)", () => {
    const sqlite = rawOf(createDatabase(makeTestDbPath(), { deferContentChunksIndex: true }));
    expect(hasContentChunksIndex(sqlite)).toBe(true);
    sqlite.close();
  });

  test("deferring on a large table leaves the index for the helper, which builds it", async () => {
    const path = makeTestDbPath();
    const first = rawOf(createDatabase(path));
    dropIndex(first);
    insertChunks(first, INLINE_BUILD_MAX_ROWID + 1);
    expect(contentChunksMaxRowid(first)).toBe(INLINE_BUILD_MAX_ROWID + 1);
    first.close();

    const daemon = rawOf(createDatabase(path, { deferContentChunksIndex: true }));
    expect(hasContentChunksIndex(daemon)).toBe(false);

    const { elapsedMs } = await buildContentChunksIndexInHelperProcess(path);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(hasContentChunksIndex(daemon)).toBe(true);

    // The daemon connection keeps working once the helper has released the lock.
    insertChunks(daemon, 1);
    expect(contentChunksMaxRowid(daemon)).toBe(INLINE_BUILD_MAX_ROWID + 2);
    daemon.close();
  });

  test("the helper rejects with its stderr when the path is unusable", async () => {
    await expect(buildContentChunksIndexInHelperProcess(tmpdir())).rejects.toThrow(
      /index helper exited with code/,
    );
  });

  test("connections get synchronous=NORMAL and a short busy_timeout", () => {
    const sqlite = rawOf(createDatabase(makeTestDbPath()));
    const sync = sqlite.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const busy = sqlite.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(sync.synchronous).toBe(1);
    expect(busy.timeout).toBe(250);
    sqlite.close();
  });
});
