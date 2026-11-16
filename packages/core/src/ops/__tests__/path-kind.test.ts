import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { liveFolderPrefixes, resolvePathKind } from "../path-kind.js";
import { getS3Key } from "../versioning.js";

const databases: Database[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
  const { ctx } = createTestContext();
  databases.push((ctx.db as unknown as { $client: Database }).$client);
  return { ctx, key: (path: string) => getS3Key(ctx.orgId, ctx.driveId, path) };
}

describe("folder validation", () => {
  test("bounds storage requests and preserves prefix order when requests finish out of order", async () => {
    const { ctx, key } = setup();
    const prefixes = Array.from({ length: 40 }, (_, i) => key(`/folder-${i}/`));
    const live = prefixes.filter((_, i) => i % 3 !== 0);
    let active = 0;
    let peak = 0;
    let calls = 0;
    ctx.s3.listObjects = async (prefix, options) => {
      expect(options).toEqual({ maxKeys: 1 });
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, prefixes.indexOf(prefix) % 2 ? 0 : 5));
      active--;
      return {
        objects: live.includes(prefix) ? [{ key: prefix + "file", size: 1, lastModified: new Date(0) }] : [],
        prefixes: [],
      };
    };

    expect(await liveFolderPrefixes(ctx, prefixes)).toEqual(live);
    expect(calls).toBe(prefixes.length);
    expect(active).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("uses literal database prefixes and checks storage for missing or deleted metadata", async () => {
    const { ctx, key } = setup();
    const paths = ["/100%/", "/a_b/", "/東京/", "/deleted/", "/untracked/", "/empty/"];
    for (const path of ["/100%/file", "/aXb/file", "/東京/file", "/deleted/file"]) {
      ctx.db.insert(schema.files).values({
        path, driveId: ctx.driveId, size: 1, author: ctx.userId,
        createdAt: new Date(0), modifiedAt: new Date(0), isDeleted: path.startsWith("/deleted/"),
      }).run();
    }
    const calls: string[] = [];
    ctx.s3.listObjects = async (prefix) => {
      calls.push(prefix);
      return {
        objects: prefix === key("/untracked/") ? [{ key: prefix + "file", size: 1, lastModified: new Date(0) }] : [],
        prefixes: [],
      };
    };

    expect(await liveFolderPrefixes(ctx, paths.map(key))).toEqual([key("/100%/"), key("/東京/"), key("/untracked/")]);
    expect(calls).toEqual([key("/a_b/"), key("/deleted/"), key("/untracked/"), key("/empty/")]);
  });

  test("propagates storage errors", async () => {
    const { ctx, key } = setup();
    const failure = new Error("storage unavailable");
    ctx.s3.listObjects = async () => { throw failure; };
    await expect(liveFolderPrefixes(ctx, [key("/unknown/")])).rejects.toBe(failure);
  });

  test("keeps file, directory, marker, and missing path resolution", async () => {
    const { ctx, key } = setup();
    await ctx.s3.putObject(key("/file"), "file");
    await ctx.s3.putObject(key("/both"), "file");
    await ctx.s3.putObject(key("/both/nested/file"), "file");
    await ctx.s3.putObject(key("/marker/"), "");

    expect(await resolvePathKind(ctx, "/file")).toBe("file");
    expect(await resolvePathKind(ctx, "/both")).toBe("directory");
    expect(await resolvePathKind(ctx, "/marker")).toBe("directory");
    expect(await resolvePathKind(ctx, "/missing")).toBeNull();
    expect(await resolvePathKind(ctx, "/")).toBe("directory");
  });
});
