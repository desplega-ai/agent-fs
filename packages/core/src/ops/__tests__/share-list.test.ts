import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { createUser } from "../../identity/users.js";
import { createDrive, listDrives, setDriveMember } from "../../identity/drives.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { dispatchOp, getOpDefinition } from "../index.js";
import { hashShareToken } from "../share.js";
import type { ShareCreateResult } from "../share.js";
import type { ShareListItem, ShareListResult } from "../share-list.js";
import type { OpContext } from "../types.js";

let t: ReturnType<typeof createTestContext>;
/** Org A: D1 (default, t's drive) and D2. Org B: creator's personal org with D3. */
let d2: string;
let orgB: string;
let d3: string;
let users: Record<"creator" | "peer" | "driveAdmin" | "orgAdmin" | "outsider", string>;

function as(userId: string, over: Partial<OpContext> = {}): OpContext {
  return { ...t.ctx, userId, ...over };
}

async function share(c: OpContext, path: string, params: Record<string, unknown> = {}) {
  return (await dispatchOp(c, "share-create", { path, ...params })) as ShareCreateResult;
}

async function list(c: OpContext, params: Record<string, unknown> = {}) {
  return (await dispatchOp(c, "share-list", params)) as ShareListResult;
}

const ids = (r: ShareListResult) => r.shares.map((s) => s.id).sort();

function addOrgMember(orgId: string, userId: string, role: "viewer" | "editor" | "admin") {
  t.db.insert(schema.orgMembers).values({ orgId, userId, role }).run();
}

beforeEach(async () => {
  t = createTestContext();
  const mk = (email: string) => createUser(t.db, { email: email + "@example.com" }).user.id;
  users = {
    creator: mk("creator"),
    peer: mk("peer"),
    driveAdmin: mk("drive-admin"),
    orgAdmin: mk("org-admin"),
    outsider: mk("outsider"),
  };
  await t.db.update(schema.users).set({ displayName: "Cre Ator" }).where(eq(schema.users.id, users.creator)).run();

  d2 = createDrive(t.db, { orgId: t.orgId, name: "second", creatorUserId: t.userId }).id;
  addOrgMember(t.orgId, users.creator, "editor");
  addOrgMember(t.orgId, users.peer, "viewer");
  addOrgMember(t.orgId, users.driveAdmin, "editor");
  addOrgMember(t.orgId, users.orgAdmin, "admin");
  addOrgMember(t.orgId, users.outsider, "viewer");
  setDriveMember(t.db, { driveId: t.driveId, userId: users.creator, role: "editor" });
  setDriveMember(t.db, { driveId: d2, userId: users.creator, role: "viewer" });
  setDriveMember(t.db, { driveId: t.driveId, userId: users.peer, role: "viewer" });
  setDriveMember(t.db, { driveId: t.driveId, userId: users.driveAdmin, role: "admin" });
  setDriveMember(t.db, { driveId: t.driveId, userId: users.orgAdmin, role: "viewer" });

  orgB = listUserOrgs(t.db, users.creator).find((o) => o.id !== t.orgId)!.id;
  d3 = listDrives(t.db, orgB)[0].id;

  await dispatchOp(t.ctx, "write", { path: "/a/b.md", content: "b" });
  await dispatchOp(t.ctx, "write", { path: "/a/c.md", content: "c" });
  await dispatchOp(t.ctx, "write", { path: "/ab/x.md", content: "x" });
  await dispatchOp(as(t.userId, { driveId: d2 }), "write", { path: "/a/b.md", content: "d2" });
  await dispatchOp(as(users.creator, { orgId: orgB, driveId: d3 }), "write", { path: "/a/b.md", content: "d3" });
});

describe("share-list registration", () => {
  test("has a strict schema", () => {
    const def = getOpDefinition("share-list")!;
    expect(def.schema.parse({})).toEqual({});
    expect(() => def.schema.parse({ scope: "everything" })).toThrow();
    expect(() => def.schema.parse({ limit: 0 })).toThrow();
    expect(() => def.schema.parse({ limit: 501 })).toThrow();
    expect(() => def.schema.parse({ offset: -1 })).toThrow();
    expect(() => def.schema.parse({ limit: 1.5 })).toThrow();
  });
});

describe("share-list authorization", () => {
  test("a non-member of the drive is refused", async () => {
    await expect(list(as(users.outsider))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(list(as(users.outsider), { scope: "mine" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("a viewer sees only their own links, even on someone else's path", async () => {
    const theirs = await share(as(users.creator), "/a/b.md");
    const mine = await share(as(users.peer), "/a/b.md");
    const r = await list(as(users.peer), { path: "/a/b.md" });
    expect(r.visibility).toBe("own");
    expect(ids(r)).toEqual([mine.id]);
    expect(ids(r)).not.toContain(theirs.id);
    expect(r.shares[0].canRevoke).toBe(true);
  });

  test("the creator sees their own links and can revoke them", async () => {
    const a = await share(as(users.creator), "/a/b.md");
    await share(t.ctx, "/a/c.md");
    const r = await list(as(users.creator));
    expect(ids(r)).toEqual([a.id]);
    expect(r.shares[0].createdBy).toEqual({
      userId: users.creator,
      email: "creator@example.com",
      displayName: "Cre Ator",
    });
    expect(r.shares[0].canRevoke).toBe(true);
  });

  test("a drive admin sees every link in the drive and none of another drive", async () => {
    const a = await share(as(users.creator), "/a/b.md");
    const b = await share(as(users.peer), "/a/c.md");
    const other = await share(as(t.userId, { driveId: d2 }), "/a/b.md");
    const r = await list(as(users.driveAdmin));
    expect(r.visibility).toBe("all");
    expect(ids(r)).toEqual([a.id, b.id].sort());
    expect(ids(r)).not.toContain(other.id);
    expect(r.shares.every((s) => s.canRevoke)).toBe(true);
  });

  test("an org admin who is a drive member sees every link; without membership the call is refused", async () => {
    const a = await share(as(users.creator), "/a/b.md");
    const r = await list(as(users.orgAdmin));
    expect(r.visibility).toBe("all");
    expect(ids(r)).toEqual([a.id]);
    await expect(list(as(users.orgAdmin, { driveId: d2 }))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("a link on the same path in another drive never shows up", async () => {
    const d1 = await share(t.ctx, "/a/b.md");
    const other = await share(as(t.userId, { driveId: d2 }), "/a/b.md");
    const r = await list(t.ctx, { path: "/a/b.md" });
    expect(ids(r)).toEqual([d1.id]);
    const r2 = await list(as(t.userId, { driveId: d2 }), { path: "/a/b.md" });
    expect(ids(r2)).toEqual([other.id]);
  });
});

describe("share-list scope mine", () => {
  test("spans every drive of the current org the caller is on, never another org", async () => {
    const one = await share(as(users.creator), "/a/b.md");
    const two = await share(as(users.creator, { driveId: d2 }), "/a/b.md");
    const inB = await share(as(users.creator, { orgId: orgB, driveId: d3 }), "/a/b.md");
    await share(t.ctx, "/a/c.md");

    const r = await list(as(users.creator), { scope: "mine" });
    expect(r.scope).toBe("mine");
    expect(r.visibility).toBe("own");
    expect(ids(r)).toEqual([one.id, two.id].sort());
    expect(r.shares.find((s) => s.id === two.id)!.drive).toEqual({ id: d2, name: "second" });

    const rb = await list(as(users.creator, { orgId: orgB, driveId: d3 }), { scope: "mine" });
    expect(ids(rb)).toEqual([inB.id]);
  });

  test("drops the links of a drive the caller has left", async () => {
    await share(as(users.creator), "/a/b.md");
    const two = await share(as(users.creator, { driveId: d2 }), "/a/b.md");
    t.db.delete(schema.driveMembers).where(eq(schema.driveMembers.userId, users.creator)).run();
    setDriveMember(t.db, { driveId: t.driveId, userId: users.creator, role: "editor" });
    const r = await list(as(users.creator), { scope: "mine" });
    expect(ids(r)).not.toContain(two.id);
    expect(r.total).toBe(1);
  });

  test("an admin's own view does not include other people's links", async () => {
    await share(as(users.creator), "/a/b.md");
    const own = await share(as(users.driveAdmin), "/a/c.md");
    const r = await list(as(users.driveAdmin), { scope: "mine" });
    expect(ids(r)).toEqual([own.id]);
  });

  test("rejects path", async () => {
    await expect(list(t.ctx, { scope: "mine", path: "/a/b.md" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("share-list path coverage", () => {
  test("returns exact links and folder links that publish the path", async () => {
    const file = await share(t.ctx, "/a/b.md");
    const root = await share(t.ctx, "/");
    const folder = await share(t.ctx, "/a");
    const sibling = await share(t.ctx, "/ab");
    const otherFile = await share(t.ctx, "/a/c.md");
    const r = await list(t.ctx, { path: "a/b.md" });
    expect(ids(r)).toEqual([file.id, root.id, folder.id].sort());
    const rel = Object.fromEntries(r.shares.map((s) => [s.id, s.relation]));
    expect(rel[file.id]).toBe("exact");
    expect(rel[folder.id]).toBe("covering");
    expect(rel[root.id]).toBe("covering");
    expect(ids(r)).not.toContain(sibling.id);
    expect(ids(r)).not.toContain(otherFile.id);
  });

  test("a folder path lists its own link as exact", async () => {
    const folder = await share(t.ctx, "/a");
    const r = await list(t.ctx, { path: "/a/" });
    expect(r.shares.map((s) => [s.id, s.relation])).toEqual([[folder.id, "exact"]]);
  });

  test("matches % and _ literally", async () => {
    await dispatchOp(t.ctx, "write", { path: "/p%_/f.md", content: "f" });
    await dispatchOp(t.ctx, "write", { path: "/pxx/f.md", content: "f" });
    const lit = await share(t.ctx, "/p%_");
    await share(t.ctx, "/pxx");
    const r = await list(t.ctx, { path: "/p%_/f.md" });
    expect(ids(r)).toEqual([lit.id]);
    const r2 = await list(t.ctx, { path: "/pxx/f.md" });
    expect(ids(r2)).not.toContain(lit.id);
  });

  test("rejects a path that leaves the drive", async () => {
    await expect(list(t.ctx, { path: "/a/../b" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("no relation field without a path", async () => {
    await share(t.ctx, "/a/b.md");
    const r = await list(t.ctx);
    expect("relation" in r.shares[0]).toBe(false);
  });
});

describe("share-list status", () => {
  async function seedStates() {
    const active = await share(t.ctx, "/a/b.md");
    const forever = await share(t.ctx, "/a/b.md", { expiresIn: null });
    const revoked = await share(t.ctx, "/a/b.md");
    const revokedAndExpired = await share(t.ctx, "/a/b.md");
    const expired = await share(t.ctx, "/a/b.md");
    const exhausted = await share(t.ctx, "/a/b.md", { maxViews: 2 });
    await dispatchOp(t.ctx, "share-revoke", { id: revoked.id });
    await dispatchOp(t.ctx, "share-revoke", { id: revokedAndExpired.id });
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    t.db.update(schema.shares).set({ expiresAt: past }).where(eq(schema.shares.id, expired.id)).run();
    t.db.update(schema.shares).set({ expiresAt: past }).where(eq(schema.shares.id, revokedAndExpired.id)).run();
    t.db.update(schema.shares).set({ views: 2 }).where(eq(schema.shares.id, exhausted.id)).run();
    return { active, forever, revoked, revokedAndExpired, expired, exhausted };
  }

  test("classifies every state and lists only active links by default", async () => {
    const s = await seedStates();
    const r = await list(t.ctx);
    expect(ids(r)).toEqual([s.active.id, s.forever.id].sort());
    expect(r.total).toBe(2);
    expect(r.shares.find((x) => x.id === s.forever.id)!.expiresAt).toBeNull();
    expect(r.shares.find((x) => x.id === s.active.id)!.expiresAt).not.toBeNull();

    const all = await list(t.ctx, { includeInactive: true });
    expect(all.total).toBe(6);
    const status = Object.fromEntries(all.shares.map((x) => [x.id, x.status]));
    expect(status).toEqual({
      [s.active.id]: "active",
      [s.forever.id]: "active",
      [s.revoked.id]: "revoked",
      [s.revokedAndExpired.id]: "revoked",
      [s.expired.id]: "expired",
      [s.exhausted.id]: "exhausted",
    });
    const revokedRow = all.shares.find((x) => x.id === s.revoked.id)!;
    expect(revokedRow.revokedAt).not.toBeNull();
    expect(revokedRow.canRevoke).toBe(false);
    expect(all.shares.find((x) => x.id === s.exhausted.id)!).toMatchObject({ views: 2, maxViews: 2 });
  });

  test("pages newest first with a stable total", async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await share(t.ctx, "/a/b.md")).id);
    const p1 = await list(t.ctx, { limit: 2 });
    const p2 = await list(t.ctx, { limit: 2, offset: 2 });
    const p3 = await list(t.ctx, { limit: 2, offset: 4 });
    expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
    const seen = [...p1.shares, ...p2.shares, ...p3.shares].map((x) => x.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(made.sort());
    const all = (await list(t.ctx)).shares;
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      expect(prev.createdAt > cur.createdAt || (prev.createdAt === cur.createdAt && prev.id > cur.id)).toBe(true);
    }
  });
});

describe("share-list never exposes the link", () => {
  const KEYS = [
    "canRevoke", "createdAt", "createdBy", "drive", "expiresAt", "id", "kind", "lastViewedAt",
    "maxViews", "path", "revokedAt", "status", "views",
  ];

  test("returns exactly the documented fields and no token, hash or URL", async () => {
    const file = await share(t.ctx, "/a/b.md");
    const site = await share(t.ctx, "/a");
    const r = await list(t.ctx, { includeInactive: true });
    for (const item of r.shares) expect(Object.keys(item).sort()).toEqual(KEYS);
    expect(Object.keys(r).sort()).toEqual(["limit", "offset", "scope", "shares", "total", "visibility"]);

    const withPath = await list({ ...t.ctx, appUrl: "https://live.example.test" }, { path: "/a/b.md" });
    for (const item of withPath.shares) expect(Object.keys(item).sort()).toEqual([...KEYS, "appUrl", "relation"].sort());
    const fileRow = withPath.shares.find((x) => x.id === file.id) as ShareListItem;
    expect(fileRow.appUrl).toBe(`https://live.example.test/file/~/${t.orgId}/${t.driveId}/a/b.md`);

    const json = JSON.stringify([r, withPath]);
    for (const made of [file, site]) {
      const token = made.sharePath.replace(/^\/(share|site)\//, "").replace(/\/$/, "");
      expect(json).not.toContain(token);
      expect(json).not.toContain(hashShareToken(token));
    }
    expect(json).not.toContain("/share/");
    expect(json).not.toContain("/site/");
  });
});
