import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../../storage/local-adapter.js";
import { createTestContext } from "../../test-utils.js";
import { createUser } from "../../identity/users.js";
import { inviteToOrg } from "../../identity/orgs.js";
import { dispatchOp, ls, reveal, write } from "../index.js";
import { revealAncestors, REVEAL_MAX_DEPTH } from "../reveal.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors.js";
import type { OpContext } from "../types.js";

describe("revealAncestors", () => {
  test("lists every ancestor directory root first", () => {
    expect(revealAncestors("/a/b/c.md")).toEqual(["/", "/a", "/a/b"]);
    expect(revealAncestors("/top.md")).toEqual(["/"]);
  });
});

describe("reveal", () => {
  let root: string;
  let ctx: OpContext;
  let db: ReturnType<typeof createTestContext>["db"];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-reveal-"));
    const base = createTestContext();
    db = base.db;
    ctx = { ...base.ctx, s3: new LocalStorageAdapter({ root }) };

    await write(ctx, { path: "/root.md", content: "r" });
    await write(ctx, { path: "/a/sibling.md", content: "s" });
    await write(ctx, { path: "/a/b/c/deep.md", content: "deep file" });
    await write(ctx, { path: "/a/b/c/other.md", content: "o" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns the ls listing of every ancestor plus the file's stat", async () => {
    const res = await reveal(ctx, { path: "/a/b/c/deep.md" });

    expect(res.path).toBe("/a/b/c/deep.md");
    expect(res.stat.path).toBe("/a/b/c/deep.md");
    expect(res.stat.size).toBe("deep file".length);
    expect(res.listings.map((l) => l.path)).toEqual(["/", "/a", "/a/b", "/a/b/c"]);

    // Each listing is byte-for-byte what `ls` returns for that directory.
    for (const listing of res.listings) {
      const expected = await ls(ctx, { path: listing.path });
      expect(listing.entries).toEqual(expected.entries);
    }
    const names = (i: number) => res.listings[i]!.entries.map((e) => e.name).sort();
    expect(names(0)).toEqual(["a", "root.md"]);
    expect(names(3)).toEqual(["deep.md", "other.md"]);
  });

  test("accepts paths without a leading slash, as the live UI sends them", async () => {
    const res = await reveal(ctx, { path: "a/sibling.md" });
    expect(res.path).toBe("/a/sibling.md");
    expect(res.listings.map((l) => l.path)).toEqual(["/", "/a"]);
  });

  test("a missing file is NOT_FOUND, like stat", async () => {
    await expect(reveal(ctx, { path: "/a/nope.md" })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the drive root is rejected", async () => {
    await expect(reveal(ctx, { path: "/" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("dispatchOp applies ls permissions: viewers may reveal, non-members may not", async () => {
    const viewer = createUser(db, { email: "viewer@example.com" });
    inviteToOrg(db, { orgId: ctx.orgId, email: "viewer@example.com", role: "viewer" });
    const viewerRes = (await dispatchOp(
      { ...ctx, userId: viewer.user.id },
      "reveal",
      { path: "/a/b/c/deep.md" }
    )) as Awaited<ReturnType<typeof reveal>>;
    expect(viewerRes.listings).toHaveLength(4);

    const outsider = createUser(db, { email: "outsider@example.com" });
    await expect(
      dispatchOp({ ...ctx, userId: outsider.user.id }, "reveal", { path: "/a/b/c/deep.md" })
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("reveal input limits", () => {
  let ctx: OpContext;

  beforeEach(() => {
    ctx = createTestContext().ctx;
  });

  /** Wrap the context's storage so every listObjects call is counted. */
  function countListings(): { ctx: OpContext; calls: () => number } {
    let n = 0;
    const s3 = ctx.s3;
    const counted = Object.create(s3) as typeof s3;
    counted.listObjects = ((...args: Parameters<typeof s3.listObjects>) => {
      n++;
      return s3.listObjects(...args);
    }) as typeof s3.listObjects;
    return { ctx: { ...ctx, s3: counted }, calls: () => n };
  }

  async function rejection(path: string) {
    const counted = countListings();
    const err: unknown = await dispatchOp(counted.ctx, "reveal", { path }).catch((e: unknown) => e);
    // Compare the code, not the error object: its message echoes the whole path.
    return { code: (err as { code?: string } | undefined)?.code, isValidation: err instanceof ValidationError, listings: counted.calls() };
  }

  test("a file at the deepest allowed level is revealed with one listing per ancestor", async () => {
    const path = "/" + Array.from({ length: REVEAL_MAX_DEPTH - 1 }, (_, i) => `d${i}`).join("/") + "/f.md";
    await write(ctx, { path, content: "x" });
    const counted = countListings();
    const res = (await dispatchOp(counted.ctx, "reveal", { path })) as Awaited<ReturnType<typeof reveal>>;
    expect(res.listings).toHaveLength(REVEAL_MAX_DEPTH);
    expect(counted.calls()).toBe(REVEAL_MAX_DEPTH);
  });

  test("a path deeper than the limit is rejected before any listing", async () => {
    expect(await rejection("/" + Array.from({ length: REVEAL_MAX_DEPTH + 1 }, () => "a").join("/"))).toEqual({
      code: "VALIDATION_ERROR",
      isValidation: true,
      listings: 0,
    });
    // 2000 one-character segments stay under the length limit, so only the depth limit catches it.
    expect(await rejection("/" + Array.from({ length: 2000 }, () => "a").join("/"))).toEqual({
      code: "VALIDATION_ERROR",
      isValidation: true,
      listings: 0,
    });
  });

  test("a path longer than the limit is rejected before any listing", async () => {
    expect(await rejection("/" + "x".repeat(100_000) + "/f.md")).toEqual({
      code: "VALIDATION_ERROR",
      isValidation: true,
      listings: 0,
    });
  });
});
