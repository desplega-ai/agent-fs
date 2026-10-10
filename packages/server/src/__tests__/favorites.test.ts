import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;

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

describe("Favorites API", () => {
  let aliceKey: string;
  let aliceId: string;
  let bobKey: string;
  let outsiderKey: string;
  let orgId: string;
  let driveId: string;

  function op(key: string, body: Record<string, unknown>) {
    return keyReq(key, `/orgs/${orgId}/ops`, {
      method: "POST",
      body: JSON.stringify({ driveId, ...body }),
    });
  }

  async function favorites(key: string): Promise<string[]> {
    const res = await op(key, { op: "favorite-list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { favorites: Array<{ path: string }> };
    return body.favorites.map((f) => f.path);
  }

  beforeAll(async () => {
    app = createApp(createTestDb(), new MockS3Client() as any);
    const alice = await register("fav-alice@example.com");
    aliceKey = alice.apiKey;
    aliceId = alice.userId;
    bobKey = (await register("fav-bob@example.com")).apiKey;
    outsiderKey = (await register("fav-outsider@example.com")).apiKey;

    const orgRes = await keyReq(aliceKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "fav-team" }),
    });
    expect(orgRes.status).toBe(201);
    orgId = (await orgRes.json()).id;
    const invite = await keyReq(aliceKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "fav-bob@example.com", role: "viewer" }),
    });
    expect(invite.status).toBe(200);
    const drives = await keyReq(aliceKey, `/orgs/${orgId}/drives`);
    driveId = (await drives.json()).drives.find((d: any) => d.isDefault).id;

    for (const path of ["/plan.md", "/specs/api.md"]) {
      expect((await op(aliceKey, { op: "write", path, content: "x" })).status).toBe(200);
    }
  });

  test("add, list and remove round-trip for the signed-in user", async () => {
    const add = await op(aliceKey, { op: "favorite-add", path: "/plan.md" });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ path: "/plan.md", kind: "file", favorited: true });
    expect(await favorites(aliceKey)).toEqual(["/plan.md"]);

    const rm = await op(aliceKey, { op: "favorite-remove", path: "/plan.md" });
    expect(await rm.json()).toMatchObject({ path: "/plan.md", removed: true });
    expect(await favorites(aliceKey)).toEqual([]);
  });

  test("each user sees only their own favorites", async () => {
    await op(aliceKey, { op: "favorite-add", path: "/specs" });
    await op(bobKey, { op: "favorite-add", path: "/plan.md" });

    expect(await favorites(aliceKey)).toEqual(["/specs"]);
    expect(await favorites(bobKey)).toEqual(["/plan.md"]);
  });

  test("the user comes from the API key, never from the request body", async () => {
    const peek = await op(bobKey, { op: "favorite-list", userId: aliceId, user_id: aliceId });
    expect((await peek.json()).favorites.map((f: any) => f.path)).toEqual(["/plan.md"]);

    await op(bobKey, { op: "favorite-remove", path: "/specs", userId: aliceId });
    expect(await favorites(aliceKey)).toEqual(["/specs"]);
  });

  test("a non-member cannot reach the drive's favorites", async () => {
    const res = await op(outsiderKey, { op: "favorite-list" });
    expect([403, 404]).toContain(res.status);
  });

  test("unauthenticated requests are rejected", async () => {
    const res = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "favorite-list", driveId }),
    });
    expect(res.status).toBe(401);
  });
});
