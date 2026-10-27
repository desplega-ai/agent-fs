import { describe, expect, spyOn, test } from "bun:test";
import { MockS3Client, createTestContext } from "../../test-utils.js";
import type { S3Object } from "../../storage/adapter.js";
import { dispatchOp } from "../index.js";
import { getS3Key } from "../versioning.js";
import { resolvePathKind } from "../path-kind.js";
import type { FavoriteListResult, LsResult, OpContext } from "../types.js";

/**
 * MockS3Client that lists prefixes the way versioned MinIO does: a deleted
 * key keeps its noncurrent versions behind a delete marker, and a delimited
 * listing still reports the prefixes above it. Undelimited listings only see
 * current objects.
 */
class VersionedPrefixS3 extends MockS3Client {
  private deletedKeys = new Set<string>();

  constructor() {
    super({ versioningEnabled: true });
  }

  override async deleteObject(key: string): Promise<void> {
    this.deletedKeys.add(key);
    await super.deleteObject(key);
  }

  override async listObjects(
    prefix: string,
    options?: { delimiter?: string; maxKeys?: number }
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    const listing = await super.listObjects(prefix, options);
    const delimiter = options?.delimiter;
    if (!delimiter) return listing;
    const prefixes = new Set(listing.prefixes);
    for (const key of this.deletedKeys) {
      if (!key.startsWith(prefix)) continue;
      const cut = key.slice(prefix.length).indexOf(delimiter);
      if (cut >= 0) prefixes.add(key.slice(0, prefix.length + cut + 1));
    }
    return { objects: listing.objects, prefixes: Array.from(prefixes) };
  }
}

function setup() {
  const t = createTestContext({ versioningEnabled: true });
  const s3 = new VersionedPrefixS3();
  const ctx: OpContext = { ...t.ctx, s3 };
  return { ctx, s3 };
}

async function names(ctx: OpContext, path: string): Promise<string[]> {
  const r = (await dispatchOp(ctx, "ls", { path })) as LsResult;
  return r.entries.map((e) => `${e.type}:${e.name}`).sort();
}

describe("ls on a versioned bucket", () => {
  test("the mock reports a prefix that holds only deleted objects, as MinIO does", async () => {
    const { ctx, s3 } = setup();
    await dispatchOp(ctx, "write", { path: "/tmp-folder/sub/a.txt", content: "x" });
    await dispatchOp(ctx, "rm", { path: "/tmp-folder/sub/a.txt" });
    const root = getS3Key(ctx.orgId, ctx.driveId, "/");
    const level = await s3.listObjects(root, { delimiter: "/" });
    expect(level.prefixes).toEqual([root + "tmp-folder/"]);
  });

  test("a folder emptied by rm disappears from ls and resolves to nothing", async () => {
    const { ctx } = setup();
    await dispatchOp(ctx, "write", { path: "/tmp-folder/sub/a.txt", content: "x" });
    await dispatchOp(ctx, "write", { path: "/keep.md", content: "k" });
    await dispatchOp(ctx, "rm", { path: "/tmp-folder/sub/a.txt" });

    expect(await names(ctx, "/")).toEqual(["file:keep.md"]);
    expect(await names(ctx, "/tmp-folder")).toEqual([]);
    expect(await resolvePathKind(ctx, "/tmp-folder")).toBeNull();
    expect(await resolvePathKind(ctx, "/tmp-folder/sub")).toBeNull();
  });

  test("a folder emptied by mv disappears and the destination folder shows", async () => {
    const { ctx } = setup();
    await dispatchOp(ctx, "write", { path: "/tmp-folder/sub/a.txt", content: "x" });
    await dispatchOp(ctx, "mv", { from: "/tmp-folder/sub/a.txt", to: "/other/a.txt" });

    expect(await names(ctx, "/")).toEqual(["directory:other"]);
    expect(await names(ctx, "/other")).toEqual(["file:a.txt"]);
  });

  test("a folder that still holds one live file stays listed", async () => {
    const { ctx } = setup();
    await dispatchOp(ctx, "write", { path: "/docs/a.md", content: "a" });
    await dispatchOp(ctx, "write", { path: "/docs/deep/b.md", content: "b" });
    await dispatchOp(ctx, "rm", { path: "/docs/a.md" });

    expect(await names(ctx, "/")).toEqual(["directory:docs"]);
    expect(await names(ctx, "/docs")).toEqual(["directory:deep"]);
    expect(await resolvePathKind(ctx, "/docs")).toBe("directory");
  });

  test("a folder whose objects have no database row stays listed", async () => {
    const { ctx, s3 } = setup();
    await s3.putObject(getS3Key(ctx.orgId, ctx.driveId, "/imported/raw.bin"), "raw");

    expect(await names(ctx, "/")).toEqual(["directory:imported"]);
    expect(await names(ctx, "/imported")).toEqual(["file:raw.bin"]);
  });

  test("a folder with a live database row costs no storage read", async () => {
    const { ctx, s3 } = setup();
    await dispatchOp(ctx, "write", { path: "/a/x.md", content: "x" });
    await dispatchOp(ctx, "write", { path: "/b/y.md", content: "y" });
    const list = spyOn(s3, "listObjects");

    expect(await names(ctx, "/")).toEqual(["directory:a", "directory:b"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("the star on a folder emptied by rm is dropped", async () => {
    const { ctx } = setup();
    await dispatchOp(ctx, "write", { path: "/tmp-folder/sub/a.txt", content: "x" });
    await dispatchOp(ctx, "favorite-add", { path: "/tmp-folder" });
    await dispatchOp(ctx, "rm", { path: "/tmp-folder/sub/a.txt" });

    const r = (await dispatchOp(ctx, "favorite-list", {})) as FavoriteListResult;
    expect(r.favorites).toEqual([]);
  });

  test("a folder name that sorts next to a sibling's is judged by its own files", async () => {
    const { ctx } = setup();
    // `/ab` and `/a0` must not count as files under `/a/`.
    await dispatchOp(ctx, "write", { path: "/a/x.md", content: "x" });
    await dispatchOp(ctx, "write", { path: "/ab/y.md", content: "y" });
    await dispatchOp(ctx, "write", { path: "/a0.md", content: "z" });
    await dispatchOp(ctx, "rm", { path: "/a/x.md" });

    expect(await names(ctx, "/")).toEqual(["directory:ab", "file:a0.md"]);
  });
});
