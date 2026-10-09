import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { createUser } from "../../identity/users.js";
import { setDriveMember } from "../../identity/drives.js";
import { dispatchOp, getOpDefinition } from "../index.js";
import {
  consumeShareView,
  authorizeShareBytes,
  extractShareToken,
  findShareByToken,
  generateShareToken,
  getShareState,
  hashShareToken,
  isWellFormedShareToken,
  SHARE_VIEW_GRANT_TTL_SECONDS,
  openShareView,
  presignShareUrl,
  presignedUrlDeadline,
  siteObjectKey,
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

describe("openShareView", () => {
  const grantRows = () => t.db.select().from(schema.shareViewGrants).all();

  test("unlimited link: counts the view and mints no grant (the token already opens the page)", async () => {
    const token = tokenOf(await create());
    const opened = openShareView(t.db, token)!;
    expect(opened.share.views).toBe(1);
    expect(opened.grant).toBeNull();
    expect(grantRows()).toHaveLength(0);
  });

  test("view-limited link: the counted view carries its own grant, stored only as a hash", async () => {
    const token = tokenOf(await create({ maxViews: 2 }));
    const opened = openShareView(t.db, token)!;
    expect(opened.share.views).toBe(1);
    expect(isWellFormedShareToken(opened.grant!.token)).toBe(true);
    expect(opened.grant!.token).not.toBe(token);

    const rows = grantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].grantHash).toBe(hashShareToken(opened.grant!.token));
    expect(JSON.stringify(rows)).not.toContain(opened.grant!.token);
    expect(rows[0].shareId).toBe(opened.share.id);
  });

  test("one grant per counted view, never more than maxViews", async () => {
    const token = tokenOf(await create({ maxViews: 3 }));
    const results = Array.from({ length: 10 }, () => openShareView(t.db, token));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(grantRows()).toHaveLength(3);
    expect(new Set(results.filter(Boolean).map((r) => r!.grant!.token)).size).toBe(3);
  });

  test("a refused view (used up, revoked, expired) mints nothing", async () => {
    const one = await create({ maxViews: 1 });
    expect(openShareView(t.db, tokenOf(one))).not.toBeNull();
    expect(openShareView(t.db, tokenOf(one))).toBeNull();

    const revoked = await create({ maxViews: 5 });
    await dispatchOp(ctx, "share-revoke", { id: revoked.id });
    expect(openShareView(t.db, tokenOf(revoked))).toBeNull();

    const expired = await create({ maxViews: 5 });
    t.db.update(schema.shares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.shares.id, expired.id)).run();
    expect(openShareView(t.db, tokenOf(expired))).toBeNull();

    expect(grantRows()).toHaveLength(1);
  });

  test("the grant lives for the view TTL, and never past the share itself", async () => {
    const now = new Date();
    const long = await create({ maxViews: 2, expiresIn: 86_400 });
    const g1 = openShareView(t.db, tokenOf(long), now)!.grant!;
    expect(g1.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + SHARE_VIEW_GRANT_TTL_SECONDS * 1000);
    expect(g1.expiresAt.getTime()).toBeGreaterThan(now.getTime() + (SHARE_VIEW_GRANT_TTL_SECONDS - 2) * 1000);

    const short = await create({ maxViews: 2, expiresIn: 60 });
    const shareExpiry = findShareByToken(t.db, tokenOf(short))!.expiresAt;
    const g2 = openShareView(t.db, tokenOf(short), now)!.grant!;
    expect(g2.expiresAt.getTime()).toBeLessThanOrEqual(shareExpiry.getTime());
  });

  test("purges grants that have already expired", async () => {
    const token = tokenOf(await create({ maxViews: 5 }));
    openShareView(t.db, token);
    t.db.update(schema.shareViewGrants).set({ expiresAt: new Date(Date.now() - 5000) }).run();
    openShareView(t.db, token);
    expect(grantRows()).toHaveLength(1);
  });
});

describe("authorizeShareBytes", () => {
  const gone = { ok: false, reason: "gone" } as const;
  const needGrant = { ok: false, reason: "grant_required" } as const;

  test("unknown and malformed tokens are not found", () => {
    expect(authorizeShareBytes(t.db, generateShareToken(), null)).toEqual({ ok: false, reason: "not_found" });
    expect(authorizeShareBytes(t.db, "short", null)).toEqual({ ok: false, reason: "not_found" });
  });

  test("unlimited link: the token alone is enough while it is active", async () => {
    const r = await create();
    const token = tokenOf(r);
    expect(authorizeShareBytes(t.db, token, null).ok).toBe(true);

    const share = findShareByToken(t.db, token)!;
    expect(authorizeShareBytes(t.db, token, null, new Date(share.expiresAt.getTime() + 1000))).toEqual(gone);
    await dispatchOp(ctx, "share-revoke", { id: r.id });
    expect(authorizeShareBytes(t.db, token, null)).toEqual(gone);
  });

  test("view-limited link: the bare token never opens the bytes, before or after the view", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    expect(authorizeShareBytes(t.db, token, null)).toEqual(needGrant);
    openShareView(t.db, token);
    expect(authorizeShareBytes(t.db, token, null)).toEqual(gone); // used up
    expect(authorizeShareBytes(t.db, token, "")).toEqual(gone);
  });

  test("view-limited link: the grant from the counted view opens the bytes, even once the link is used up", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    const { grant } = openShareView(t.db, token)!;
    expect(getShareState(findShareByToken(t.db, token)!)).toBe("exhausted");
    expect(authorizeShareBytes(t.db, token, grant!.token).ok).toBe(true);
  });

  test("a grant is bound to its own share", async () => {
    const a = tokenOf(await create({ maxViews: 1 }));
    const b = tokenOf(await create({ maxViews: 1 }));
    const gA = openShareView(t.db, a)!.grant!;
    openShareView(t.db, b);
    expect(authorizeShareBytes(t.db, b, gA.token)).toEqual(gone);
    expect(authorizeShareBytes(t.db, a, gA.token).ok).toBe(true);
  });

  test("a guessed, malformed or truncated grant is refused", async () => {
    const token = tokenOf(await create({ maxViews: 3 }));
    const { grant } = openShareView(t.db, token)!;
    for (const bad of [generateShareToken(), "short", "' OR 1=1 --", grant!.token.slice(0, 42), token]) {
      expect(authorizeShareBytes(t.db, token, bad).ok).toBe(false);
    }
  });

  test("a grant stops working at its own expiry", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    const now = new Date();
    const { grant } = openShareView(t.db, token, now)!;
    const justBefore = new Date(grant!.expiresAt.getTime() - 1000);
    expect(authorizeShareBytes(t.db, token, grant!.token, justBefore).ok).toBe(true);
    expect(authorizeShareBytes(t.db, token, grant!.token, grant!.expiresAt).ok).toBe(false);
    expect(authorizeShareBytes(t.db, token, grant!.token, new Date(grant!.expiresAt.getTime() + 60_000))).toEqual(gone);
  });

  test("revoking or expiring the share kills its grants immediately", async () => {
    const r = await create({ maxViews: 5 });
    const token = tokenOf(r);
    const { grant } = openShareView(t.db, token)!;
    expect(authorizeShareBytes(t.db, token, grant!.token).ok).toBe(true);

    const share = findShareByToken(t.db, token)!;
    expect(authorizeShareBytes(t.db, token, grant!.token, new Date(share.expiresAt.getTime() + 1000))).toEqual(gone);

    await dispatchOp(ctx, "share-revoke", { id: r.id });
    expect(authorizeShareBytes(t.db, token, grant!.token)).toEqual(gone);
  });

  test("an independent client holding only the spent token is refused while the viewer's grant still works", async () => {
    const token = tokenOf(await create({ maxViews: 1 }));
    const viewer = openShareView(t.db, token)!;
    expect(openShareView(t.db, token)).toBeNull(); // the second client cannot open a view
    expect(authorizeShareBytes(t.db, token, null).ok).toBe(false); // ...nor fetch bytes
    expect(authorizeShareBytes(t.db, token, viewer.grant!.token).ok).toBe(true);
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

describe("site shares (folders)", () => {
  const siteTokenOf = (r: ShareCreateResult) => r.sharePath.replace(/^\/site\/|\/$/g, "");

  beforeEach(async () => {
    await dispatchOp(ctx, "write", { path: "/site/index.html", content: "<h1>hi</h1>" });
    await dispatchOp(ctx, "write", { path: "/site/sub/page.html", content: "<p>sub</p>" });
  });

  test("a folder becomes a site share with a /site/<token>/ link", async () => {
    for (const path of ["/site", "site/", "/site/"]) {
      const r = await create({ path });
      expect(r.kind).toBe("site");
      expect(r.path).toBe("/site");
      expect(r.sharePath).toMatch(/^\/site\/[A-Za-z0-9_-]{43}\/$/);
      expect(r.url).toBe(`https://api.example.test${r.sharePath}`);
      expect(r.maxViews).toBeNull();
      expect(findShareByToken(t.db, siteTokenOf(r))!.kind).toBe("site");
    }
    // A folder with only sub-folders is still a folder.
    expect((await create({ path: "/site/sub" })).kind).toBe("site");
  });

  test("a file stays a file share", async () => {
    const r = await create();
    expect(r.kind).toBe("file");
    expect(findShareByToken(t.db, tokenOf(r))!.kind).toBe("file");
  });

  test("the drive root can be shared as a site", async () => {
    const r = await create({ path: "/" });
    expect(r.kind).toBe("site");
    expect(r.path).toBe("/");
  });

  test("a missing folder is not found and creates no row", async () => {
    await expect(create({ path: "/nope/" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("File or folder not found"),
    });
    expect(t.db.select().from(schema.shares).all()).toHaveLength(0);
  });

  test("maxViews is refused for a folder and creates no row", async () => {
    await expect(create({ path: "/site", maxViews: 1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(t.db.select().from(schema.shares).all()).toHaveLength(0);
  });

  test("share-revoke by path matches the folder with or without the trailing slash", async () => {
    const a = await create({ path: "/site" });
    expect(await dispatchOp(ctx, "share-revoke", { path: "site/" })).toEqual({ revoked: 1, ids: [a.id] });
    const b = await create({ path: "site/" });
    expect(await dispatchOp(ctx, "share-revoke", { path: "site" })).toEqual({ revoked: 1, ids: [b.id] });
    const root = await create({ path: "/" });
    expect(await dispatchOp(ctx, "share-revoke", { path: "/" })).toEqual({ revoked: 1, ids: [root.id] });
  });

  test("share-revoke takes the site URL as the token", async () => {
    const r = await create({ path: "/site" });
    expect(extractShareToken(r.url)).toBe(siteTokenOf(r));
    expect(extractShareToken(`${r.url}sub/page.html?x=1`)).toBe(siteTokenOf(r));
    expect(await dispatchOp(ctx, "share-revoke", { token: r.url })).toEqual({ revoked: 1, ids: [r.id] });
  });

  test("siteObjectKey decodes once, stays inside the folder, and refuses file shares", async () => {
    const site = findShareByToken(t.db, siteTokenOf(await create({ path: "/site" })))!;
    const base = `${t.orgId}/drives/${t.driveId}/site/`;
    expect(siteObjectKey(site, "index.html")).toBe(`${base}index.html`);
    expect(siteObjectKey(site, "sub/a%20b.html")).toBe(`${base}sub/a b.html`);
    expect(siteObjectKey(site, "a%2Fb")).toBe(`${base}a/b`);
    // Decoded once only: the literal name `%2e%2e`, not `..`.
    expect(siteObjectKey(site, "%252e%252e/x")).toBe(`${base}%2e%2e/x`);
    for (const bad of ["../x", "%2e%2e/x", "..%2Fx", "a/%2E%2E/%2E%2E/x", "./x", "a%5C..%5Cx", "a%00b", "%E0%A4%A"]) {
      expect(siteObjectKey(site, bad)).toBeNull();
    }

    const root = findShareByToken(t.db, siteTokenOf(await create({ path: "/" })))!;
    expect(siteObjectKey(root, "site/index.html")).toBe(`${base}index.html`);

    const file = findShareByToken(t.db, tokenOf(await create()))!;
    expect(siteObjectKey(file, "x")).toBeNull();
  });
});

describe("presignedUrlDeadline", () => {
  test("is the SigV4 signing time plus the lifetime", () => {
    const url = "https://s3.example/b/k?X-Amz-Date=20260929T120002Z&X-Amz-Expires=6&X-Amz-Signature=abc";
    expect(presignedUrlDeadline(url)?.toISOString()).toBe("2026-09-29T12:00:08.000Z");
  });

  test("is null unless both parts can be read", () => {
    expect(presignedUrlDeadline("https://s3.example/b/k?X-Amz-Expires=6")).toBeNull();
    expect(presignedUrlDeadline("https://s3.example/b/k?X-Amz-Date=20260929T120002Z")).toBeNull();
    expect(presignedUrlDeadline("https://s3.example/b/k?X-Amz-Date=nope&X-Amz-Expires=6")).toBeNull();
    expect(presignedUrlDeadline("https://s3.example/b/k?X-Amz-Date=20260929T120002Z&X-Amz-Expires=-1")).toBeNull();
    expect(presignedUrlDeadline("not a url")).toBeNull();
  });
});

describe("presignShareUrl", () => {
  const sigv4 = (signedAt: Date, ttl: number) =>
    `https://s3.example/k?X-Amz-Date=${signedAt.toISOString().replace(/[-:]|\.\d{3}/g, "")}&X-Amz-Expires=${ttl}`;

  async function shareExpiringIn(seconds: number) {
    const r = await create();
    const row = findShareByToken(t.db, tokenOf(r))!;
    return { ...row, expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000) };
  }

  test("pins the signing time and the TTL to one reading of the clock", async () => {
    const share = await shareExpiringIn(60);
    let seen: { ttl?: number; signedAt?: Date } = {};
    const url = await presignShareUrl(
      {
        getPresignedUrl: async (_key: string, ttl?: number, _ct?: string, _cd?: string, signedAt?: Date) => {
          seen = { ttl, signedAt };
          return sigv4(signedAt!, ttl!);
        },
      } as any,
      share,
      "k",
      { capSeconds: 3600 }
    );
    expect(url).not.toBeNull();
    // The share, not the ceiling, sets the TTL; the timestamp is the one the TTL was sized at.
    expect(seen.ttl).toBeLessThanOrEqual(60);
    expect(seen.signedAt!.getTime() + seen.ttl! * 1000).toBeLessThanOrEqual(share.expiresAt.getTime());
  });

  test("hands the content type and disposition through", async () => {
    const share = await shareExpiringIn(60);
    let args: unknown[] = [];
    await presignShareUrl(
      { getPresignedUrl: async (...a: unknown[]) => ((args = a), sigv4(a[4] as Date, a[1] as number)) } as any,
      share,
      "the/key",
      { capSeconds: 300, contentType: "image/png", disposition: "inline" }
    );
    expect(args.slice(0, 4)).toEqual(["the/key", args[1], "image/png", "inline"]);
    expect(args[1]).toBeLessThanOrEqual(300);
  });

  test("issues nothing when less than a second is left", async () => {
    const share = await shareExpiringIn(0);
    let called = false;
    const url = await presignShareUrl(
      { getPresignedUrl: async () => ((called = true), "https://s3.example/k") } as any,
      share,
      "k",
      { capSeconds: 300 }
    );
    expect(url).toBeNull();
    expect(called).toBe(false);
  });

  test("withholds a URL from a signer that ignored the pinned timestamp", async () => {
    const share = await shareExpiringIn(6);
    const late = async (_key: string, ttl?: number) => sigv4(new Date(Date.now() + 2000), ttl!);
    expect(await presignShareUrl({ getPresignedUrl: late } as any, share, "k", { capSeconds: 300 })).toBeNull();
  });

  test("withholds a URL whose deadline cannot be read", async () => {
    const share = await shareExpiringIn(60);
    const opaque = async () => "https://s3.example/k?sig=abc";
    expect(await presignShareUrl({ getPresignedUrl: opaque } as any, share, "k", { capSeconds: 300 })).toBeNull();
  });
});
