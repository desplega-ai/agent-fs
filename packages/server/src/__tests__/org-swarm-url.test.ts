import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { runMigrations } from "../../../core/src/db/migrate.js";
import { createApp } from "../app.js";
import type { DB } from "@/core";

let db: DB;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = createTestDb();
  app = createApp(db, new MockS3Client() as any);
});

function keyReq(key: string, path: string, opts?: RequestInit): Promise<Response> {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (opts?.body) headers.set("Content-Type", "application/json");
  return Promise.resolve(app.request(path, { ...opts, headers }));
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

/** An org owned by `admin` with `memberEmail` invited at `role`. */
async function orgWith(admin: { apiKey: string }, memberEmail: string, role: string) {
  const orgRes = await keyReq(admin.apiKey, "/orgs", { method: "POST", body: JSON.stringify({ name: `org-${memberEmail}` }) });
  expect(orgRes.status).toBe(201);
  const orgId = (await orgRes.json()).id as string;
  const inv = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
    method: "POST",
    body: JSON.stringify({ email: memberEmail, role }),
  });
  expect(inv.status).toBe(200);
  return orgId;
}

const patch = (key: string, orgId: string, body: unknown) =>
  keyReq(key, `/orgs/${orgId}`, { method: "PATCH", body: JSON.stringify(body) });

describe("PATCH /orgs/:orgId swarmUrl", () => {
  test("an org admin sets it, the org read shows it, and repeating it is a no-op", async () => {
    const admin = await register("swarm-admin@example.com");
    const before = await keyReq(admin.apiKey, `/orgs/${admin.orgId}`);
    expect((await before.json()).swarmUrl).toBeNull();

    const res = await patch(admin.apiKey, admin.orgId, { swarmUrl: "https://swarm.example.com/" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: admin.orgId, swarmUrl: "https://swarm.example.com" });

    const again = await patch(admin.apiKey, admin.orgId, { swarmUrl: "https://swarm.example.com" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);

    const read = await keyReq(admin.apiKey, `/orgs/${admin.orgId}`);
    expect((await read.json()).swarmUrl).toBe("https://swarm.example.com");
  });

  test("a path is kept without its trailing slash", async () => {
    const admin = await register("swarm-path@example.com");
    const res = await patch(admin.apiKey, admin.orgId, { swarmUrl: "http://localhost:5274/dash/" });
    expect(res.status).toBe(200);
    expect((await res.json()).swarmUrl).toBe("http://localhost:5274/dash");
  });

  test("null clears it", async () => {
    const admin = await register("swarm-clear@example.com");
    await patch(admin.apiKey, admin.orgId, { swarmUrl: "https://swarm.example.com" });
    const res = await patch(admin.apiKey, admin.orgId, { swarmUrl: null });
    expect(res.status).toBe(200);
    expect((await res.json()).swarmUrl).toBeNull();
    const pub = await app.request(`/orgs/${admin.orgId}/public`);
    expect(await pub.json()).toEqual({ swarmUrl: null });
  });

  test("a non-admin member gets 403 and a non-member 404", async () => {
    const admin = await register("swarm-owner@example.com");
    const viewer = await register("swarm-viewer@example.com");
    const editor = await register("swarm-editor@example.com");
    const orgId = await orgWith(admin, "swarm-viewer@example.com", "viewer");
    await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "swarm-editor@example.com", role: "editor" }),
    });
    expect((await patch(viewer.apiKey, orgId, { swarmUrl: "https://evil.test" })).status).toBe(403);
    expect((await patch(editor.apiKey, orgId, { swarmUrl: "https://evil.test" })).status).toBe(403);
    const outsider = await register("swarm-outsider@example.com");
    expect((await patch(outsider.apiKey, orgId, { swarmUrl: "https://evil.test" })).status).toBe(404);
    expect((await keyReq(admin.apiKey, `/orgs/${orgId}`).then((r) => r.json())).swarmUrl).toBeNull();
  });

  test("an invalid value gets 400 and leaves the stored value alone", async () => {
    const admin = await register("swarm-invalid@example.com");
    await patch(admin.apiKey, admin.orgId, { swarmUrl: "https://swarm.example.com" });
    for (const swarmUrl of [
      "not a url",
      "javascript:alert(1)",
      "ftp://swarm.example.com",
      "file:///etc/passwd",
      "https://user:pw@swarm.example.com",
      "https://swarm.example.com/?a=1",
      "https://swarm.example.com/#x",
      "",
      42,
      `https://swarm.example.com/${"a".repeat(2100)}`,
    ]) {
      const res = await patch(admin.apiKey, admin.orgId, { swarmUrl });
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("swarmUrl");
    }
    expect((await patch(admin.apiKey, admin.orgId, {})).status).toBe(400);
    expect((await keyReq(admin.apiKey, `/orgs/${admin.orgId}`, { method: "PATCH", body: "nope" })).status).toBe(400);
    expect((await keyReq(admin.apiKey, `/orgs/${admin.orgId}`).then((r) => r.json())).swarmUrl).toBe("https://swarm.example.com");
  });

  test("an org-scoped admin key may set it for its own org", async () => {
    const owner = await register("swarm-scope-owner@example.com");
    const member = await register("swarm-scope-admin@example.com");
    const orgId = await orgWith(owner, "swarm-scope-admin@example.com", "admin");
    const minted = await keyReq(owner.apiKey, `/orgs/${orgId}/members/${member.userId}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: "swarm" }),
    });
    const { apiKey } = await minted.json();
    expect((await patch(apiKey, orgId, { swarmUrl: "https://swarm.example.com" })).status).toBe(200);
    expect((await patch(apiKey, member.orgId, { swarmUrl: "https://swarm.example.com" })).status).toBe(403);
  });
});

describe("GET /orgs/:orgId/public", () => {
  test("answers without a key, with only the swarm URL", async () => {
    const admin = await register("swarm-public@example.com");
    await patch(admin.apiKey, admin.orgId, { swarmUrl: "https://swarm.example.com" });
    const res = await app.request(`/orgs/${admin.orgId}/public`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swarmUrl: "https://swarm.example.com" });
  });

  test("an unknown org looks like an org without a swarm URL", async () => {
    const res = await app.request(`/orgs/${crypto.randomUUID()}/public`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swarmUrl: null });
  });

  test("other /orgs routes still need a key", async () => {
    const admin = await register("swarm-public-auth@example.com");
    expect((await app.request(`/orgs/${admin.orgId}`)).status).toBe(401);
    expect((await app.request(`/orgs/${admin.orgId}`, { method: "PATCH", body: "{}" })).status).toBe(401);
  });
});

describe("orgs.swarm_url migration", () => {
  test("adds the column to an older database, once", () => {
    const sqlite = new Database(":memory:");
    // Every table runMigrations reads, in the shape before this column.
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, api_key_hash TEXT, created_at INTEGER);
      CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_personal INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE org_members (org_id TEXT, user_id TEXT, role TEXT);
      CREATE TABLE drives (id TEXT PRIMARY KEY, org_id TEXT);
      CREATE TABLE drive_members (drive_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (drive_id, user_id));
      CREATE TABLE file_versions (path TEXT, drive_id TEXT, version INTEGER);
      CREATE TABLE comments (id TEXT PRIMARY KEY);
      CREATE TABLE shares (id TEXT PRIMARY KEY);
      CREATE TABLE content_chunks (id TEXT PRIMARY KEY);
      CREATE TABLE files (path TEXT, drive_id TEXT);
    `);
    sqlite.exec("INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'old', 0)");
    runMigrations(sqlite);
    runMigrations(sqlite);
    const row = sqlite.prepare("SELECT swarm_url FROM orgs WHERE id = 'o1'").get() as { swarm_url: string | null };
    expect(row.swarm_url).toBeNull();
  });
});
