import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
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

/** An org owned by `admin` with `member` invited as a viewer. */
async function orgWith(admin: { apiKey: string }, memberEmail: string, name: string) {
  const orgRes = await keyReq(admin.apiKey, "/orgs", { method: "POST", body: JSON.stringify({ name }) });
  expect(orgRes.status).toBe(201);
  const orgId = (await orgRes.json()).id as string;
  const inv = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
    method: "POST",
    body: JSON.stringify({ email: memberEmail, role: "viewer" }),
  });
  expect(inv.status).toBe(200);
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
      { id: "primary", label: "primary", createdAt: null, lastUsedAt: null, primary: true },
      { id: key.id, label: "cli", createdAt: key.createdAt, lastUsedAt: null, primary: false },
    ]);
    expect(text).not.toContain(key.apiKey);
    expect(text).not.toContain(user.apiKey);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(/hash/i);
  });

  test("revoking every key, the primary included, is allowed and reset-key recovers", async () => {
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
    expect((await keyReq(apiKey, "/auth/me")).status).toBe(200);
    const after = await (await keyReq(apiKey, "/auth/keys")).json();
    expect(after.keys.map((k: any) => k.id)).toEqual(["primary"]);
  });

  test("self reset-key rotates only the primary key", async () => {
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

    const me = await keyReq(body.apiKey, "/auth/me");
    expect((await me.json()).userId).toBe(member.userId);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);

    const events = db.$client
      .prepare("SELECT actor, target, metadata FROM events WHERE org_id = ? AND type = 'api_key_created'")
      .all(orgId) as Array<{ actor: string; target: string; metadata: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe(admin.userId);
    expect(events[0].target).toBe(member.userId);
    expect(JSON.parse(events[0].metadata!)).toEqual({ method: "admin", keyId: body.id, label: "agent-swarm" });
  });

  test("a non-admin member gets 403", async () => {
    const admin = await register("mint-nonadmin-admin@example.com");
    const viewer = await register("mint-nonadmin-viewer@example.com");
    const target = await register("mint-nonadmin-target@example.com");
    const orgId = await orgWith(admin, "mint-nonadmin-viewer@example.com", "mint-nonadmin-org");
    await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "mint-nonadmin-target@example.com", role: "viewer" }),
    });

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
