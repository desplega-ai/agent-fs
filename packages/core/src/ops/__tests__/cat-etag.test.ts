import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../../storage/local-adapter.js";
import { createTestContext } from "../../test-utils.js";
import { cat, stat, write } from "../index.js";
import type { OpContext } from "../types.js";

// A page reads a file with `cat` and pairs the bytes with a version through
// `stat`: both must name the object they saw by the same ETag.
describe("cat etag", () => {
  test("mock S3: cat carries the object's etag, the one stat reports", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/a.txt", content: "hello\n" });
    const read = await cat(ctx, { path: "/a.txt" });
    expect(read.etag).toBeString();
    expect(read.etag).toBe((await stat(ctx, { path: "/a.txt" })).etag);
  });

  describe("local adapter", () => {
    let root: string;
    let ctx: OpContext;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "afs-cat-etag-"));
      ctx = { ...createTestContext().ctx, s3: new LocalStorageAdapter({ root }) };
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("cat's etag follows the bytes and matches stat's", async () => {
      await write(ctx, { path: "/a.txt", content: "one\n" });
      const first = await cat(ctx, { path: "/a.txt" });
      expect(first.etag).toBeString();
      expect(first.etag).toBe((await stat(ctx, { path: "/a.txt" })).etag);

      await write(ctx, { path: "/a.txt", content: "two\n" });
      const second = await cat(ctx, { path: "/a.txt" });
      expect(second.etag).not.toBe(first.etag);
      expect(second.etag).toBe((await stat(ctx, { path: "/a.txt" })).etag);
    });

    test("an empty file has an etag too", async () => {
      await write(ctx, { path: "/empty.txt", content: "" });
      const read = await cat(ctx, { path: "/empty.txt" });
      expect(read.content).toBe("");
      expect(read.etag).toBe((await stat(ctx, { path: "/empty.txt" })).etag);
    });
  });
});
