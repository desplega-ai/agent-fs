import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { tree } from "../tree.js";
import { getS3Key } from "../versioning.js";

const databases: ReturnType<typeof createTestContext>["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.$client.close(); });

function setup() {
  const { ctx, db } = createTestContext();
  databases.push(db);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  ctx.db = drizzle(db.$client, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } });
  const prefix = getS3Key(ctx.orgId, ctx.driveId, "/");
  const requests: unknown[] = [];
  ctx.s3.listObjects = async (_prefix, options) => {
    requests.push(options);
    return { objects: ["a", "a/", "a/direct.txt", "a/deep/hidden.txt", "b/deep/hidden.txt", "deleted.txt", "untracked.txt", "z/"].map((key) => ({ key: prefix + key, size: 7, lastModified: new Date(0) })), prefixes: [] };
  };
  return { ctx, db, queries, requests };
}

describe("tree depth and metadata", () => {
  test("filters adapters that ignore depth hints and preserves explicit boundary markers", async () => {
    const { ctx, requests } = setup();
    expect((await tree(ctx, { depth: 1 })).tree).toEqual([
      { name: "a", type: "file", size: 7, modifiedAt: new Date(0) },
      { name: "a", type: "directory", children: [] },
      { name: "deleted.txt", type: "file", size: 7, modifiedAt: new Date(0) },
      { name: "untracked.txt", type: "file", size: 7, modifiedAt: new Date(0) },
      { name: "z", type: "directory", children: [] },
    ]);
    expect(requests).toEqual([{ maxDepth: 1 }]);
  });

  test("reads only returned file metadata and keeps deleted or untracked storage objects", async () => {
    const { ctx, db, queries } = setup();
    db.$client.query("INSERT INTO drives (id, org_id, name, created_at) VALUES ('other-drive', ?, 'other', 0)").run(ctx.orgId);
    const insert = db.$client.prepare("INSERT INTO files (path, drive_id, size, author, created_at, modified_at, is_deleted) VALUES (?, ?, ?, 'metadata-author', 0, 1, ?)");
    insert.run("/a/direct.txt", ctx.driveId, 42, 0);
    insert.run("/a/direct.txt", "other-drive", 999, 0);
    insert.run("/deleted.txt", ctx.driveId, 999, 1);
    db.$client.transaction(() => {
      for (let i = 0; i < 20_000; i++) insert.run(`/deep/nested/${i}.txt`, ctx.driveId, 99, 0);
    })();
    const result = await tree(ctx, { depth: 2 });
    expect(result.tree.find(({ name, type }) => name === "a" && type === "directory")?.children).toEqual([
      { name: "direct.txt", type: "file", size: 42, author: "metadata-author", modifiedAt: new Date(1000) },
    ]);
    expect(result.tree.some(({ name }) => name === "b")).toBe(false);
    expect(result.tree.find(({ name }) => name === "deleted.txt")).toEqual({ name: "deleted.txt", type: "file", size: 7, modifiedAt: new Date(0) });
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual([ctx.driveId, "/a", "/a/direct.txt", "/deleted.txt", "/untracked.txt", 0]);
    expect(queries[0].sql).toContain('"path" in');
  });
});
