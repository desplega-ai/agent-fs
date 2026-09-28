import { describe, test, expect, beforeEach } from "bun:test";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { createUser } from "../../identity/users.js";
import { setDriveMember } from "../../identity/drives.js";
import { dispatchOp, getOpDefinition } from "../index.js";
import {
  consumeShareView,
  canServeShareAssets,
  extractShareToken,
  findShareByToken,
  generateShareToken,
  getShareState,
  hashShareToken,
  isWellFormedShareToken,
  SHARE_ASSET_GRACE_SECONDS,
} from "../share.js";
import type { ShareCreateResult } from "../share.js";
import type { OpContext } from "../types.js";

let t: ReturnType<typeof createTestContext>;
let ctx: OpContext;

beforeEach(async () => {
  t = createTestContext();
  ctx = { ...t.ctx, apiUrl: "https://api.example.test" };
  await dispatchOp(ctx, "write", { path: "/docs/hello.md", content: "# Hello" });
});

const tokenOf = (r: ShareCreateResult) => r.sharePath.replace("/share/", "");

async function create(params: Record<string, unknown> = {}, c: OpContext = ctx) {
  return (await dispatchOp(c, "share-create", { path: "/docs/hello.md", ...params })) as ShareCreateResult;
}

describe("share token", () => {
  test("has at least 128 bits of entropy and a fixed shape", () => {
    const token = generateShareToken();
    expect(isWellFormedShareToken(token)).toBe(true);
    // 43 base64url chars = 256 bits.
    expect(token.length).toBe(43);
    expect(generateShareToken()).not.toBe(token);
  });

  test("hash is SHA-256 hex", () => {
    const hash = hashShareToken("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("extractShareToken takes a bare token or a full URL, and rejects junk", () => {
    const token = generateShareToken();
    expect(extractShareToken(token)).toBe(token);
    expect(extractShareToken(`https://x.fly.dev/share/${token}`)).toBe(token);
    expect(extractShareToken(`https://x.fly.dev/share/${token}?a=1#b`)).toBe(token);
    expect(extractShareToken("nope")).toBeNull();
    expect(extractShareToken("https://x.fly.dev/share/short")).toBeNull();
  });
});

describe("share-create", () => {
  test("is registered with viewer role and a strict schema", () => {
    const def = getOpDefinition("share-create")!;
    expect(def).toBeDefined();
    expect(def.schema.parse({ path: "/a" })).toEqual({ path: "/a" });
    expect(() => def.schema.parse({ path: "/a", expiresIn: 10 })).toThrow();
    expect(() => def.schema.parse({ path: "/a", expiresIn: 604801 })).toThrow();
    expect(() => def.schema.parse({ path: "/a", maxViews: 0 })).toThrow();
    expect(() => def.schema.parse({ path: "/a", maxViews: 1.5 })).toThrow();
    expect(def.schema.parse({ path: "/a", expiresIn: 604800, maxViews: 1 })).toEqual({
      path: "/a",
      expiresIn: 604800,
      maxViews: 1,
    });
  });

  test("mints an absolute link on the API host with a 24h default expiry", async () => {
    const before = Date.now();
    const r = await create();
    expect(r.url).toBe(`https://api.example.test${r.sharePath}`);
    expect(r.sharePath).toMatch(/^\/share\/[A-Za-z0-9_-]{43}$/);
    expect(r.path).toBe("/docs/hello.md");
    expect(r.expiresIn).toBe(86400);
    expect(r.maxViews).toBeNull();
    const ttl = new Date(r.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(86_400_000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(86_400_000 + 1_000);
  });

  test("still carries the viewer link for members when an app URL is configured", async () => {
    const r = await create({}, { ...ctx, appUrl: "https://live.example.test" });
    expect((r as any).appUrl).toBe(`https://live.example.test/file/~/${t.orgId}/${t.driveId}/docs/hello.md`);
  });

  test("returns only the relative link when the API address is unknown", async () => {
    const r = await create({}, { ...ctx, apiUrl: undefined });
    expect(r.url).toBe(r.sharePath);
  });

  test("stores only the token hash, with org, drive and path pinned", async () => {
    const r = await create({ maxViews: 3 });
    const token = tokenOf(r);
    const rows = t.db.select().from(schema.shares).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tokenHash).toBe(hashShareToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.orgId).toBe(t.orgId);
    expect(row.driveId).toBe(t.driveId);
    expect(row.path).toBe("/docs/hello.md");
    expect(row.maxViews).toBe(3);
    expect(row.createdBy).toBe(t.userId);
  });

  test("rejects a file that does not exist and creates no row", async () => {
    await expect(dispatchOp(ctx, "share-create", { path: "/nope.md" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(t.db.select().from(schema.shares).all()).toHaveLength(0);
  });

  test("a viewer can create a link; a non-member cannot", async () => {
    const viewer = createUser(t.db, { email: "viewer@example.com" });
    setDriveMember(t.db, { driveId: t.driveId, userId: viewer.user.id, role: "viewer" });
    const r = await create({}, { ...ctx, userId: viewer.user.id });
    expect(r.id).toBeTruthy();

    const stranger = createUser(t.db, { email: "stranger@example.com" });
    await expect(create({}, { ...ctx, userId: stranger.user.id })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("consumeShareView", () => {
  test("unlimited link: counts every view", async () => {
    const token = tokenOf(await create());
    for (let i = 1; i <= 5; i++) {
      const share = consumeShareView(t.db, token);
      expect(share?.views).toBe(i);
    }
  });

  test("maxViews=1 is one-off: the second view is refused", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    expect(consumeShareView(t.db, token)?.views).toBe(1);
    expect(consumeShareView(t.db, token)).toBeNull();
    expect(getShareState(findShareByToken(t.db, token)!)).toBe("exhausted");
  });

  test("never hands out more views than maxViews", async () => {
    const token = tokenOf(await create({ maxViews: 3 }));
    const results = Array.from({ length: 10 }, () => consumeShareView(t.db, token));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(findShareByToken(t.db, token)!.views).toBe(3);
  });

  test("refuses an expired link", async () => {
    const token = tokenOf(await create());
    t.db.update(schema.shares).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect(consumeShareView(t.db, token)).toBeNull();
    expect(getShareState(findShareByToken(t.db, token)!)).toBe("expired");
  });

  test("refuses a revoked link", async () => {
    const r = await create();
    await dispatchOp(ctx, "share-revoke", { id: r.id });
    expect(consumeShareView(t.db, tokenOf(r))).toBeNull();
    expect(getShareState(findShareByToken(t.db, tokenOf(r))!)).toBe("revoked");
  });

  test("refuses unknown and malformed tokens", () => {
    expect(consumeShareView(t.db, generateShareToken())).toBeNull();
    expect(consumeShareView(t.db, "short")).toBeNull();
    expect(consumeShareView(t.db, "' OR 1=1 --")).toBeNull();
  });
});

describe("canServeShareAssets", () => {
  test("unlimited link: served while active", async () => {
    const token = tokenOf(await create());
    expect(canServeShareAssets(findShareByToken(t.db, token)!)).toBe(true);
  });

  test("view-limited link: only after a view, and only for the grace window", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    expect(canServeShareAssets(findShareByToken(t.db, token)!)).toBe(false);

    const viewedAt = new Date();
    consumeShareView(t.db, token, viewedAt);
    const share = findShareByToken(t.db, token)!;
    expect(canServeShareAssets(share, viewedAt)).toBe(true);
    const later = new Date(viewedAt.getTime() + (SHARE_ASSET_GRACE_SECONDS + 5) * 1000);
    expect(canServeShareAssets(share, later)).toBe(false);
  });

  test("never once revoked or expired", async () => {
    const r = await create();
    const share = findShareByToken(t.db, tokenOf(r))!;
    expect(canServeShareAssets(share, new Date(share.expiresAt.getTime() + 1000))).toBe(false);
    await dispatchOp(ctx, "share-revoke", { id: r.id });
    expect(canServeShareAssets(findShareByToken(t.db, tokenOf(r))!)).toBe(false);
  });
});

describe("share-revoke", () => {
  test("revokes by id, by URL and by path", async () => {
    const a = await create();
    const b = await create();
    const c = await create();

    expect(await dispatchOp(ctx, "share-revoke", { id: a.id })).toEqual({ revoked: 1, ids: [a.id] });
    expect(await dispatchOp(ctx, "share-revoke", { token: b.url })).toEqual({ revoked: 1, ids: [b.id] });
    expect(await dispatchOp(ctx, "share-revoke", { path: "/docs/hello.md" })).toEqual({ revoked: 1, ids: [c.id] });
  });

  test("is idempotent", async () => {
    const r = await create();
    await dispatchOp(ctx, "share-revoke", { id: r.id });
    expect(await dispatchOp(ctx, "share-revoke", { id: r.id })).toEqual({ revoked: 0, ids: [] });
  });

  test("requires exactly one selector", async () => {
    const r = await create();
    await expect(dispatchOp(ctx, "share-revoke", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(dispatchOp(ctx, "share-revoke", { id: r.id, path: "/docs/hello.md" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("unknown id and junk token are 404 / 400", async () => {
    await expect(dispatchOp(ctx, "share-revoke", { id: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(dispatchOp(ctx, "share-revoke", { token: "nope" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("only the creator or a drive admin can revoke", async () => {
    const editor = createUser(t.db, { email: "editor@example.com" });
    setDriveMember(t.db, { driveId: t.driveId, userId: editor.user.id, role: "editor" });
    const viewer = createUser(t.db, { email: "viewer2@example.com" });
    setDriveMember(t.db, { driveId: t.driveId, userId: viewer.user.id, role: "viewer" });

    const byEditor = await create({}, { ...ctx, userId: editor.user.id });

    // A different non-admin member cannot revoke it...
    await expect(
      dispatchOp({ ...ctx, userId: viewer.user.id }, "share-revoke", { id: byEditor.id })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(getShareState(findShareByToken(t.db, tokenOf(byEditor))!)).toBe("active");

    // ...the creator can (as a mere viewer would be able to for their own link)...
    const byViewer = await create({}, { ...ctx, userId: viewer.user.id });
    expect((await dispatchOp({ ...ctx, userId: viewer.user.id }, "share-revoke", { id: byViewer.id }) as any).revoked).toBe(1);

    // ...and the drive admin can revoke anyone's.
    expect((await dispatchOp(ctx, "share-revoke", { id: byEditor.id }) as any).revoked).toBe(1);
  });

  test("cannot reach a share of another drive", async () => {
    const r = await create();
    // Same user and org, but the call is scoped to a different drive.
    await expect(
      dispatchOp({ ...ctx, driveId: "some-other-drive" }, "share-revoke", { id: r.id }, { skipAuth: true })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getShareState(findShareByToken(t.db, tokenOf(r))!)).toBe("active");
  });
});
