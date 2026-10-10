import { describe, expect, test } from "bun:test";
import { createUser } from "../../identity/users.js";
import { setDriveMember } from "../../identity/drives.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import type { OpContext, FavoriteAddResult, FavoriteListResult, FavoriteRemoveResult } from "../types.js";

/** Owner context plus a second drive member ("bob") in the same drive. */
async function setup() {
  const t = createTestContext();
  const bob = createUser(t.db, { email: "bob@example.com" });
  setDriveMember(t.db, { driveId: t.driveId, userId: bob.user.id, role: "editor" });
  const bobCtx: OpContext = { ...t.ctx, userId: bob.user.id };
  await dispatchOp(t.ctx, "write", { path: "/docs/a.md", content: "a" });
  await dispatchOp(t.ctx, "write", { path: "/docs/b.md", content: "b" });
  await dispatchOp(t.ctx, "write", { path: "/notes.md", content: "n" });
  return { ...t, bobCtx, bobId: bob.user.id };
}

async function list(ctx: OpContext): Promise<string[]> {
  const r = (await dispatchOp(ctx, "favorite-list", {})) as FavoriteListResult;
  return r.favorites.map((f) => `${f.kind}:${f.path}`);
}

describe("favorites", () => {
  test("add stars a file or folder and reports its kind", async () => {
    const { ctx } = await setup();
    const file = (await dispatchOp(ctx, "favorite-add", { path: "notes.md" })) as FavoriteAddResult;
    expect(file).toMatchObject({ path: "/notes.md", kind: "file", favorited: true });
    const folder = (await dispatchOp(ctx, "favorite-add", { path: "/docs/" })) as FavoriteAddResult;
    expect(folder).toMatchObject({ path: "/docs", kind: "directory", favorited: true });
    expect(await list(ctx)).toEqual(["directory:/docs", "file:/notes.md"]);
  });

  test("adding twice keeps one star and the first createdAt", async () => {
    const { ctx } = await setup();
    const first = (await dispatchOp(ctx, "favorite-add", { path: "/notes.md" })) as FavoriteAddResult;
    await new Promise((r) => setTimeout(r, 1100));
    const second = (await dispatchOp(ctx, "favorite-add", { path: "/notes.md" })) as FavoriteAddResult;
    expect(second.createdAt).toBe(first.createdAt);
    expect(await list(ctx)).toEqual(["file:/notes.md"]);
  });

  test("missing paths, the root and climbing paths are refused", async () => {
    const { ctx } = await setup();
    await expect(dispatchOp(ctx, "favorite-add", { path: "/nope.md" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(dispatchOp(ctx, "favorite-add", { path: "/" })).rejects.toBeInstanceOf(ValidationError);
    await expect(dispatchOp(ctx, "favorite-add", { path: "/docs/../notes.md" })).rejects.toBeInstanceOf(ValidationError);
    expect(await list(ctx)).toEqual([]);
  });

  test("remove drops only the caller's star and reports whether one existed", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/notes.md" });

    const r = (await dispatchOp(ctx, "favorite-remove", { path: "notes.md" })) as FavoriteRemoveResult;
    expect(r).toMatchObject({ path: "/notes.md", removed: true });
    const again = (await dispatchOp(ctx, "favorite-remove", { path: "/notes.md" })) as FavoriteRemoveResult;
    expect(again.removed).toBe(false);

    expect(await list(ctx)).toEqual([]);
    expect(await list(bobCtx)).toEqual(["file:/notes.md"]);
  });

  test("user A's favorites are invisible to user B", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });
    await dispatchOp(ctx, "favorite-add", { path: "/docs" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs/a.md" });

    expect(await list(ctx)).toEqual(["directory:/docs", "file:/notes.md"]);
    expect(await list(bobCtx)).toEqual(["file:/docs/a.md"]);
  });

  test("a user id in the params is ignored: the caller is always ctx.userId", async () => {
    const { ctx, bobCtx, userId } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });

    // Bob tries to read and write the owner's favorites by naming the owner.
    const peek = (await dispatchOp(bobCtx, "favorite-list", { userId })) as FavoriteListResult;
    expect(peek.favorites).toEqual([]);
    await dispatchOp(bobCtx, "favorite-remove", { path: "/notes.md", userId });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs/a.md", userId });

    expect(await list(ctx)).toEqual(["file:/notes.md"]);
    expect(await list(bobCtx)).toEqual(["file:/docs/a.md"]);
  });

  test("favorites are per drive", async () => {
    const { ctx, db, orgId } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });
    const { createDrive } = await import("../../identity/drives.js");
    const other = createDrive(db, { orgId, name: "other" });
    setDriveMember(db, { driveId: other.id, userId: ctx.userId, role: "admin" });
    expect(await list({ ...ctx, driveId: other.id })).toEqual([]);
  });

  test("a non-member of the drive cannot list or add favorites", async () => {
    const { ctx, db } = await setup();
    const outsider = createUser(db, { email: "outsider@example.com" });
    const outsiderCtx = { ...ctx, userId: outsider.user.id };
    await expect(dispatchOp(outsiderCtx, "favorite-list", {})).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(dispatchOp(outsiderCtx, "favorite-add", { path: "/notes.md" })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("a viewer can star files", async () => {
    const { ctx, db, driveId } = await setup();
    const viewer = createUser(db, { email: "viewer@example.com" });
    setDriveMember(db, { driveId, userId: viewer.user.id, role: "viewer" });
    const viewerCtx = { ...ctx, userId: viewer.user.id };
    await dispatchOp(viewerCtx, "favorite-add", { path: "/notes.md" });
    expect(await list(viewerCtx)).toEqual(["file:/notes.md"]);
  });

  test("mv moves every user's star with the file", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/docs/a.md" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs/a.md" });

    await dispatchOp(ctx, "mv", { from: "/docs/a.md", to: "/archive/a.md" });

    expect(await list(ctx)).toEqual(["file:/archive/a.md"]);
    expect(await list(bobCtx)).toEqual(["file:/archive/a.md"]);
  });

  test("mv onto a path the user already starred keeps one star", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/docs/a.md" });
    await dispatchOp(ctx, "favorite-add", { path: "/docs/b.md" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs/a.md" });

    await dispatchOp(ctx, "mv", { from: "/docs/a.md", to: "/docs/b.md" });

    expect(await list(ctx)).toEqual(["file:/docs/b.md"]);
    expect(await list(bobCtx)).toEqual(["file:/docs/b.md"]);
  });

  test("rm drops every user's star on the file", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/notes.md" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs/a.md" });

    await dispatchOp(ctx, "rm", { path: "/notes.md" });

    expect(await list(ctx)).toEqual([]);
    expect(await list(bobCtx)).toEqual(["file:/docs/a.md"]);
  });

  test("a folder star stays while the folder has files and goes once it is empty", async () => {
    const { ctx, bobCtx } = await setup();
    await dispatchOp(ctx, "favorite-add", { path: "/docs" });
    await dispatchOp(bobCtx, "favorite-add", { path: "/docs" });

    await dispatchOp(ctx, "rm", { path: "/docs/a.md" });
    expect(await list(ctx)).toEqual(["directory:/docs"]);

    // Moving the last file out empties the folder.
    await dispatchOp(ctx, "mv", { from: "/docs/b.md", to: "/b.md" });
    expect(await list(ctx)).toEqual([]);
    expect(await list(bobCtx)).toEqual([]);
  });

  test("a star survives rm of a different file with the same name elsewhere", async () => {
    const { ctx } = await setup();
    await dispatchOp(ctx, "write", { path: "/other/notes.md", content: "x" });
    await dispatchOp(ctx, "favorite-add", { path: "/notes.md" });
    await dispatchOp(ctx, "rm", { path: "/other/notes.md" });
    expect(await list(ctx)).toEqual(["file:/notes.md"]);
  });

  test("remove works on a star whose target is gone", async () => {
    const { ctx, db, driveId, userId } = await setup();
    const { schema } = await import("../../db/index.js");
    db.insert(schema.favorites)
      .values({ userId, driveId, path: "/ghost", kind: "directory", createdAt: new Date() })
      .run();
    const r = (await dispatchOp(ctx, "favorite-remove", { path: "/ghost" })) as FavoriteRemoveResult;
    expect(r.removed).toBe(true);
  });
});
