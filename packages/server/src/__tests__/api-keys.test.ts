import { describe, test, expect, beforeAll } from "bun:test";
import { acceptInviteAsInvitee, createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import type { DB } from "@/core";

let db: DB;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = createTestDb();
  app = createApp(db, new MockS3Client() as any);
});

function keyReq(key: string, path: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (opts?.body) headers.set("Content-Type", "application/json");
  return app.request(path, { ...opts, headers });
}

async function register(email: string) {
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ apiKey: string; userId: string; orgId: string }>;
}

async function mintSelf(key: string, label: string) {
  const res = await keyReq(key, "/auth/keys", { method: "POST", body: JSON.stringify({ label }) });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; label: string; createdAt: string; apiKey: string }>;
}

/** Inviting an existing account is pending until they accept: accept as them. */
async function acceptAsInvitee(res: Response) {
  const body = await res.clone().json();
  if (body.status === "pending") acceptInviteAsInvitee(db, body.token);
}

/** An org owned by `admin` with `member` invited as a viewer (and accepted). */
async function orgWith(admin: { apiKey: string }, memberEmail: string, name: string) {
  const orgRes = await keyReq(admin.apiKey, "/orgs", { method: "POST", body: JSON.stringify({ name }) });
  expect(orgRes.status).toBe(201);
  const orgId = (await orgRes.json()).id as string;
  const inv = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
    method: "POST",
    body: JSON.stringify({ email: memberEmail, role: "viewer" }),
  });
  expect(inv.status).toBe(200);
  await acceptAsInvitee(inv);
  return orgId;
}

describe("self-service API keys", () => {
  test("a secondary key authenticates and the primary keeps working", async () => {
    const user = await register("keys-secondary@example.com");
    const key = await mintSelf(user.apiKey, "dashboard");
    expect(key.apiKey).toMatch(/^af_[0-9a-f]{64}$/);
    expect(key.label).toBe("dashboard");
    expect(typeof key.id).toBe("string");
    expect(Number.isNaN(Date.parse(key.createdAt))).toBe(false);

    const me = await keyReq(key.apiKey, "/auth/me");
    expect(me.status).toBe(200);
    expect((await me.json()).userId).toBe(user.userId);
    expect((await keyReq(user.apiKey, "/auth/me")).status).toBe(200);
  });

  test("a revoked key is rejected; other keys keep working", async () => {
    const user = await register("keys-revoke@example.com");
    const a = await mintSelf(user.apiKey, "a");
    const b = await mintSelf(user.apiKey, "b");

    const del = await keyReq(user.apiKey, `/auth/keys/${a.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await keyReq(a.apiKey, "/auth/me")).status).toBe(401);
    expect((await keyReq(b.apiKey, "/auth/me")).status).toBe(200);
    expect((await keyReq(user.apiKey, "/auth/me")).status).toBe(200);

    // Revoking again is a 404, so is someone else's key.
    expect((await keyReq(user.apiKey, `/auth/keys/${a.id}`, { method: "DELETE" })).status).toBe(404);
    const other = await register("keys-revoke-other@example.com");
    expect((await keyReq(other.apiKey, `/auth/keys/${b.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await keyReq(b.apiKey, "/auth/me")).status).toBe(200);
  });

  test("list returns ids, labels and timestamps, never hashes or plaintext", async () => {
    const user = await register("keys-list@example.com");
    const key = await mintSelf(user.apiKey, "cli");
    const res = await keyReq(user.apiKey, "/auth/keys");
    expect(res.status).toBe(200);
    const text = await res.text();
    const { keys } = JSON.parse(text);
    expect(keys).toEqual([
      { id: "primary", label: "primary", createdAt: null, lastUsedAt: null, primary: true, orgId: null, createdByUserId: user.userId, current: true },
      { id: key.id, label: "cli", createdAt: key.createdAt, lastUsedAt: null, primary: false, orgId: null, createdByUserId: user.userId, current: false },
    ]);
    expect(text).not.toContain(key.apiKey);
    expect(text).not.toContain(user.apiKey);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(/hash/i);
  });

  test("list marks the key the request came in with as current", async () => {
    const user = await register("keys-current@example.com");
    const key = await mintSelf(user.apiKey, "laptop");
    const current = async (apiKey: string) =>
      (await (await keyReq(apiKey, "/auth/keys")).json()).keys.filter((k: any) => k.current).map((k: any) => k.id);
    expect(await current(user.apiKey)).toEqual(["primary"]);
    expect(await current(key.apiKey)).toEqual([key.id]);
  });

  test("revoking every key, the primary included, is allowed; an admin reset-key restores that org only", async () => {
    const admin = await register("keys-last-admin@example.com");
    const user = await register("keys-last@example.com");
    const orgId = await orgWith(admin, "keys-last@example.com", "keys-last-org");
    const extra = await mintSelf(user.apiKey, "only");

    expect((await keyReq(extra.apiKey, "/auth/keys/primary", { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(user.apiKey, "/auth/me")).status).toBe(401);
    const list = await (await keyReq(extra.apiKey, "/auth/keys")).json();
    expect(list.keys.map((k: any) => k.id)).toEqual([extra.id]);

    // The last key can revoke itself.
    expect((await keyReq(extra.apiKey, `/auth/keys/${extra.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(extra.apiKey, "/auth/me")).status).toBe(401);

    const reset = await keyReq(admin.apiKey, `/orgs/${orgId}/members/${user.userId}/reset-key`, { method: "POST" });
    expect(reset.status).toBe(200);
    const { apiKey } = await reset.json();
    expect((await keyReq(apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
    expect((await (await keyReq(apiKey, "/auth/me")).json()).scopedOrgId).toBe(orgId);
    // Not a key to the whole account: the user's own key routes stay closed.
    expect((await keyReq(apiKey, "/auth/keys")).status).toBe(403);
    expect((await keyReq(apiKey, "/auth/reset-key", { method: "POST" })).status).toBe(403);
  });

  test("self reset-key rotates the primary key and keeps the user's own keys", async () => {
    const user = await register("keys-reset-primary@example.com");
    const extra = await mintSelf(user.apiKey, "swarm");
    const reset = await keyReq(user.apiKey, "/auth/reset-key", { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await keyReq(user.apiKey, "/auth/me")).status).toBe(401);
    expect((await keyReq(extra.apiKey, "/auth/me")).status).toBe(200);
  });

  test("label is required and bounded", async () => {
    const user = await register("keys-label@example.com");
    for (const body of [{}, { label: "" }, { label: "   " }, { label: 42 }, { label: "x".repeat(101) }]) {
      const res = await keyReq(user.apiKey, "/auth/keys", { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });

  test("last_used_at is set on first use and not rewritten within the throttle window", async () => {
    const user = await register("keys-last-used@example.com");
    const key = await mintSelf(user.apiKey, "throttle");
    expect((await keyReq(key.apiKey, "/auth/me")).status).toBe(200);
    const first = (await (await keyReq(user.apiKey, "/auth/keys")).json()).keys[1].lastUsedAt;
    expect(first).not.toBeNull();

    // Pin last_used_at to a known recent value; a request inside the window keeps it.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
    const setLastUsed = (d: Date) =>
      db.$client.prepare("UPDATE user_api_keys SET last_used_at = ? WHERE id = ?").run(d.getTime() / 1000, key.id);
    setLastUsed(pinned);
    expect((await keyReq(key.apiKey, "/auth/me")).status).toBe(200);
    const kept = (await (await keyReq(user.apiKey, "/auth/keys")).json()).keys[1].lastUsedAt;
    expect(kept).toBe(pinned.toISOString());

    // Outside the window it moves forward.
    const stale = new Date(pinned.getTime() - 120_000);
    setLastUsed(stale);
    expect((await keyReq(key.apiKey, "/auth/me")).status).toBe(200);
    const moved = (await (await keyReq(user.apiKey, "/auth/keys")).json()).keys[1].lastUsedAt;
    expect(Date.parse(moved)).toBeGreaterThan(pinned.getTime());
  });
});

describe("org admin mints a member key", () => {
  test("admin mints a key for a member without touching existing keys, and an event is recorded", async () => {
    const admin = await register("mint-admin@example.com");
    const member = await register("mint-member@example.com");
    const orgId = await orgWith(admin, "mint-member@example.com", "mint-org");

    const res = await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: "agent-swarm" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^af_[0-9a-f]{64}$/);
    expect(body.label).toBe("agent-swarm");
    expect(body.userId).toBe(member.userId);
    expect(body.orgId).toBe(orgId);

    // The minted key acts as the member inside this org only.
    expect((await keyReq(body.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);

    const events = db.$client
      .prepare("SELECT actor, target, metadata FROM events WHERE org_id = ? AND type = 'api_key_created'")
      .all(orgId) as Array<{ actor: string; target: string; metadata: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe(admin.userId);
    expect(events[0].target).toBe(member.userId);
    expect(JSON.parse(events[0].metadata!)).toEqual({ method: "admin", keyId: body.id, label: "agent-swarm", scopeOrgId: orgId });
  });

  test("a non-admin member gets 403", async () => {
    const admin = await register("mint-nonadmin-admin@example.com");
    const viewer = await register("mint-nonadmin-viewer@example.com");
    const target = await register("mint-nonadmin-target@example.com");
    const orgId = await orgWith(admin, "mint-nonadmin-viewer@example.com", "mint-nonadmin-org");
    await acceptAsInvitee(await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "mint-nonadmin-target@example.com", role: "viewer" }),
    }));

    const res = await keyReq(viewer.apiKey, `/orgs/${orgId}/members/${target.userId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("a target outside the org is rejected with 404", async () => {
    const admin = await register("mint-nonmember-admin@example.com");
    const stranger = await register("mint-nonmember-stranger@example.com");
    const orgRes = await keyReq(admin.apiKey, "/orgs", { method: "POST", body: JSON.stringify({ name: "mint-nm" }) });
    const orgId = (await orgRes.json()).id;

    const res = await keyReq(admin.apiKey, `/orgs/${orgId}/members/${stranger.userId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await keyReq(stranger.apiKey, "/auth/keys")).status).toBe(200);
    expect((await (await keyReq(stranger.apiKey, "/auth/keys")).json()).keys).toHaveLength(1);
  });

  test("a caller outside the org gets 404", async () => {
    const admin = await register("mint-outside-admin@example.com");
    const outsider = await register("mint-outside-outsider@example.com");
    const member = await register("mint-outside-member@example.com");
    const orgId = await orgWith(admin, "mint-outside-member@example.com", "mint-outside-org");

    const res = await keyReq(outsider.apiKey, `/orgs/${orgId}/members/${member.userId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

async function mintFor(admin: { apiKey: string }, orgId: string, userId: string, label = "agent-swarm") {
  const res = await keyReq(admin.apiKey, `/orgs/${orgId}/members/${userId}/keys`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; apiKey: string; orgId: string }>;
}

async function invite(admin: { apiKey: string }, orgId: string, email: string, role: "viewer" | "editor" | "admin") {
  const res = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
  expect(res.status).toBe(200);
  await acceptAsInvitee(res);
}

// An admin-minted key is a credential someone else created for the member. It
// must reach only the minting org and must not outlive the grant behind it.
describe("admin-minted keys are scoped to the org and die with the grant", () => {
  test("the key cannot leave the org: auth routes but GET /auth/me, MCP, other orgs and the org list are refused", async () => {
    const admin = await register("scope-admin@example.com");
    const member = await register("scope-member@example.com");
    const orgId = await orgWith(admin, "scope-member@example.com", "scope-org");
    const key = await mintFor(admin, orgId, member.userId);

    expect((await keyReq(key.apiKey, `/orgs/${orgId}`)).status).toBe(200);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);

    // GET /auth/me answers with identity only: no personal defaults.
    const me = await keyReq(key.apiKey, "/auth/me");
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody).toEqual({ userId: member.userId, email: "scope-member@example.com", displayName: null, scopedOrgId: orgId });
    expect(meBody).not.toHaveProperty("defaultOrgId");
    expect(meBody).not.toHaveProperty("defaultDriveId");

    const refused: Array<[string, RequestInit?]> = [
      ["/auth/me", { method: "POST" }],
      ["/auth/me/"],
      ["/auth/profile"],
      ["/auth/profile", { method: "PATCH", body: JSON.stringify({ displayName: "escape" }) }],
      ["/auth/keys"],
      ["/auth/keys", { method: "POST", body: JSON.stringify({ label: "escape" }) }],
      ["/auth/keys/primary", { method: "DELETE" }],
      ["/auth/reset-key", { method: "POST" }],
      ["/orgs"],
      [`/orgs/${member.orgId}`],
      [`/orgs/${member.orgId}/drives`],
      [`/orgs/${orgId}x/drives`],
      ["/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }],
    ];
    for (const [path, opts] of refused) {
      const res = await keyReq(key.apiKey, path, opts);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    // Nothing above touched the member's own keys or profile.
    const ownMe = await keyReq(member.apiKey, "/auth/me");
    expect(ownMe.status).toBe(200);
    const ownMeBody = await ownMe.json();
    expect(ownMeBody.scopedOrgId).toBeNull();
    expect(ownMeBody.displayName).toBeNull();
    expect(ownMeBody.defaultOrgId).toBe(member.orgId);
    const own = await (await keyReq(member.apiKey, "/auth/keys")).json();
    expect(own.keys.map((k: any) => [k.id, k.orgId, k.createdByUserId])).toEqual([
      ["primary", null, member.userId],
      [key.id, orgId, admin.userId],
    ]);
  });

  test("review repro: invite, mint, remove member, victim reset-key leaves the attacker with nothing", async () => {
    const victim = await register("scope-repro-victim@example.com");
    const attacker = await register("scope-repro-attacker@example.com");
    const orgId = await orgWith(attacker, "scope-repro-victim@example.com", "scope-repro-org");
    const stolen = await mintFor(attacker, orgId, victim.userId);

    expect((await keyReq(attacker.apiKey, `/orgs/${orgId}/members/${victim.userId}`, { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(victim.apiKey, "/auth/reset-key", { method: "POST" })).status).toBe(200);
    expect((await keyReq(stolen.apiKey, "/auth/me")).status).toBe(401);
  });

  test("removing the member revokes the key", async () => {
    const admin = await register("scope-remove-admin@example.com");
    const member = await register("scope-remove-member@example.com");
    const orgId = await orgWith(admin, "scope-remove-member@example.com", "scope-remove-org");
    const key = await mintFor(admin, orgId, member.userId);
    const own = await mintSelf(member.apiKey, "cli");

    expect((await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}`, { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(key.apiKey, "/auth/me")).status).toBe(401);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    // Re-adding the member does not bring the key back.
    await invite(admin, orgId, "scope-remove-member@example.com", "viewer");
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    // The member's own keys are untouched.
    expect((await keyReq(own.apiKey, "/auth/me")).status).toBe(200);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);
  });

  test("the member's own reset-key revokes keys others minted for them, not their own", async () => {
    const admin = await register("scope-reset-admin@example.com");
    const member = await register("scope-reset-member@example.com");
    const orgId = await orgWith(admin, "scope-reset-member@example.com", "scope-reset-org");
    const key = await mintFor(admin, orgId, member.userId);
    const own = await mintSelf(member.apiKey, "cli");

    expect((await keyReq(member.apiKey, "/auth/reset-key", { method: "POST" })).status).toBe(200);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    expect((await keyReq(own.apiKey, "/auth/me")).status).toBe(200);
  });

  test("a key minted through the member's own scoped key dies with the member's reset-key", async () => {
    const owner = await register("scope-chain-owner@example.com");
    const member = await register("scope-chain-member@example.com");
    const orgId = await orgWith(owner, "scope-chain-member@example.com", "scope-chain-org");
    await keyReq(owner.apiKey, `/orgs/${orgId}/members/${member.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    const first = await mintFor(owner, orgId, member.userId);
    // The scoped key acts as the member (an admin here) and mints another one
    // for the member, so its created_by is the member, not the owner.
    const second = await mintFor({ apiKey: first.apiKey }, orgId, member.userId, "chained");

    expect((await keyReq(member.apiKey, "/auth/reset-key", { method: "POST" })).status).toBe(200);
    expect((await keyReq(first.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    expect((await keyReq(second.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
  });

  test("review repro: a scoped key cannot reset-key itself (or anyone) into a full-account key", async () => {
    const admin = await register("scope-escape-admin@example.com");
    const member = await register("scope-escape-member@example.com");
    const orgId = await orgWith(admin, "scope-escape-member@example.com", "scope-escape-org");
    const scoped = await mintFor(admin, orgId, admin.userId);

    for (const path of [
      `/orgs/${orgId}/members/${admin.userId}/reset-key`,
      `/orgs/${orgId}/members/${member.userId}/reset-key`,
      `/orgs/${orgId}/members/${admin.userId}/reset%2Dkey`,
    ]) {
      const res = await keyReq(scoped.apiKey, path, { method: "POST" });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    // Nothing was rotated: both primary keys still work, and so does the scoped key.
    expect((await keyReq(admin.apiKey, "/auth/keys")).status).toBe(200);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);
    expect((await keyReq(scoped.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
  });

  test("an admin reset-key of the member replaces their keys scoped to that org", async () => {
    const admin = await register("scope-adminreset-admin@example.com");
    const member = await register("scope-adminreset-member@example.com");
    const orgId = await orgWith(admin, "scope-adminreset-member@example.com", "scope-adminreset-org");
    const key = await mintFor(admin, orgId, member.userId);

    const reset = await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}/reset-key`, { method: "POST" });
    expect(reset.status).toBe(200);
    const fresh = await reset.json();
    expect(fresh.orgId).toBe(orgId);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    expect((await keyReq(fresh.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);
  });

  test("demoting the minting admin revokes the keys they minted for others", async () => {
    const owner = await register("scope-demote-owner@example.com");
    const minter = await register("scope-demote-minter@example.com");
    const member = await register("scope-demote-member@example.com");
    const orgId = await orgWith(owner, "scope-demote-member@example.com", "scope-demote-org");
    await invite(owner, orgId, "scope-demote-minter@example.com", "admin");
    const key = await mintFor(minter, orgId, member.userId);
    const byOwner = await mintFor(owner, orgId, member.userId, "owner");

    const res = await keyReq(owner.apiKey, `/orgs/${orgId}/members/${minter.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "editor" }),
    });
    expect(res.status).toBe(200);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    // Keys other admins minted are unaffected.
    expect((await keyReq(byOwner.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
  });

  test("demoting the member keeps the key, which acts with the member's current role", async () => {
    const admin = await register("scope-memberdemote-admin@example.com");
    const member = await register("scope-memberdemote-member@example.com");
    const orgId = await orgWith(admin, "scope-memberdemote-member@example.com", "scope-memberdemote-org");
    await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    const key = await mintFor(admin, orgId, member.userId);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/invites`)).status).toBe(200);

    await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "viewer" }),
    });
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(200);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/invites`)).status).toBe(403);
  });

  test("removing the minting admin revokes the keys they minted for others", async () => {
    const owner = await register("scope-minterleft-owner@example.com");
    const minter = await register("scope-minterleft-minter@example.com");
    const member = await register("scope-minterleft-member@example.com");
    const orgId = await orgWith(owner, "scope-minterleft-member@example.com", "scope-minterleft-org");
    await invite(owner, orgId, "scope-minterleft-minter@example.com", "admin");
    const key = await mintFor(minter, orgId, member.userId);

    expect((await keyReq(owner.apiKey, `/orgs/${orgId}/members/${minter.userId}`, { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(key.apiKey, `/orgs/${orgId}/drives`)).status).toBe(401);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);
  });
});
