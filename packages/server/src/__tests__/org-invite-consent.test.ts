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

function post(key: string, path: string, body: unknown = {}) {
  return keyReq(key, path, { method: "POST", body: JSON.stringify(body) });
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

async function createOrg(key: string, name: string) {
  const res = await post(key, "/orgs", { name });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

function catSecret(key: string, orgId: string) {
  return post(key, `/orgs/${orgId}/ops`, { op: "cat", path: "/secret.txt" });
}

async function invite(adminKey: string, orgId: string, email: string, role = "viewer") {
  const res = await post(adminKey, `/orgs/${orgId}/members/invite`, { email, role });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ status: "added" | "pending"; token?: string; inviteId?: string; email: string }>;
}

async function memberIds(adminKey: string, orgId: string) {
  const body = await (await keyReq(adminKey, `/orgs/${orgId}/members`)).json();
  return (body.members as Array<{ userId: string }>).map((m) => m.userId);
}

/**
 * An org admin's power over a member ends at the org. Inviting an account
 * that already exists needs that person's consent, and an admin reset-key of
 * someone else hands back a key that only reaches the admin's own org.
 */
describe("an org admin cannot reach a member's account outside the org", () => {
  test("invite + admin reset-key yields no key to the member's personal drive and keeps their key", async () => {
    const member = await register("consent-member@example.com");
    const write = await post(member.apiKey, `/orgs/${member.orgId}/ops`, {
      op: "write",
      path: "/secret.txt",
      content: "personal",
    });
    expect(write.status).toBe(200);

    const admin = await register("consent-admin@example.com");
    const orgId = await createOrg(admin.apiKey, "consent-admin-org");
    await post(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      email: "consent-member@example.com",
      role: "viewer",
    });

    const reset = await post(admin.apiKey, `/orgs/${orgId}/members/${member.userId}/reset-key`);
    const minted = reset.status === 200 ? ((await reset.json()).apiKey as string | undefined) : undefined;

    if (minted) {
      const read = await catSecret(minted, member.orgId);
      expect(read.status).not.toBe(200);
    }
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);
    expect((await catSecret(member.apiKey, member.orgId)).status).toBe(200);
  });

  test("inviting an existing account creates a pending invite; they join only by accepting", async () => {
    const admin = await register("consent-admin-a@example.com");
    const guest = await register("consent-guest-a@example.com");
    const orgId = await createOrg(admin.apiKey, "consent-org-a");

    const inv = await invite(admin.apiKey, orgId, "consent-guest-a@example.com");
    expect(inv.status).toBe("pending");
    expect(typeof inv.token).toBe("string");
    expect(await memberIds(admin.apiKey, orgId)).not.toContain(guest.userId);
    // Not a member yet, so the member routes do not reach them.
    expect((await post(admin.apiKey, `/orgs/${orgId}/members/${guest.userId}/reset-key`)).status).toBe(404);
    expect((await post(admin.apiKey, `/orgs/${orgId}/members/${guest.userId}/keys`, { label: "x" })).status).toBe(404);

    const accept = await post(guest.apiKey, `/invites/${inv.token}/accept`);
    expect(accept.status).toBe(200);
    expect(await memberIds(admin.apiKey, orgId)).toContain(guest.userId);
  });

  test("the invite response does not reveal whether the email has an account", async () => {
    const admin = await register("consent-admin-b@example.com");
    await register("consent-known-b@example.com");
    const orgId = await createOrg(admin.apiKey, "consent-org-b");
    const known = await invite(admin.apiKey, orgId, "consent-known-b@example.com");
    const unknown = await invite(admin.apiKey, orgId, "consent-unknown-b@example.com");
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known.status).toBe("pending");
  });

  test("inviting someone already in the org applies the grants at once", async () => {
    const admin = await register("consent-admin-c@example.com");
    const guest = await register("consent-guest-c@example.com");
    const orgId = await createOrg(admin.apiKey, "consent-org-c");
    const inv = await invite(admin.apiKey, orgId, "consent-guest-c@example.com");
    expect((await post(guest.apiKey, `/invites/${inv.token}/accept`)).status).toBe(200);

    const again = await invite(admin.apiKey, orgId, "consent-guest-c@example.com", "editor");
    expect(again.status).toBe("added");
    expect((again as any).orgRole).toBe("editor");
  });

  test("an admin reset-key of a member returns a key scoped to the org and leaves their own keys working", async () => {
    const admin = await register("consent-admin-d@example.com");
    const member = await register("consent-member-d@example.com");
    expect((await post(member.apiKey, `/orgs/${member.orgId}/ops`, { op: "write", path: "/secret.txt", content: "mine" })).status).toBe(200);
    const orgId = await createOrg(admin.apiKey, "consent-org-d");
    const inv = await invite(admin.apiKey, orgId, "consent-member-d@example.com");
    expect((await post(member.apiKey, `/invites/${inv.token}/accept`)).status).toBe(200);

    const first = await post(admin.apiKey, `/orgs/${orgId}/members/${member.userId}/reset-key`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.orgId).toBe(orgId);
    expect(firstBody.userId).toBe(member.userId);

    // The new key works inside the org only.
    expect((await post(firstBody.apiKey, `/orgs/${orgId}/ops`, { op: "ls", path: "/" })).status).toBe(200);
    expect((await catSecret(firstBody.apiKey, member.orgId)).status).toBe(403);
    expect((await post(firstBody.apiKey, "/auth/reset-key")).status).toBe(403);
    // The member's own key is untouched.
    expect((await catSecret(member.apiKey, member.orgId)).status).toBe(200);

    // A second reset replaces the first scoped key.
    const second = await post(admin.apiKey, `/orgs/${orgId}/members/${member.userId}/reset-key`);
    expect(second.status).toBe(200);
    const secondKey = (await second.json()).apiKey as string;
    expect((await keyReq(firstBody.apiKey, `/orgs/${orgId}`)).status).toBe(401);
    expect((await keyReq(secondKey, `/orgs/${orgId}`)).status).toBe(200);
    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(200);

    // The key carries the admin's grant: removing the member revokes it.
    expect((await keyReq(admin.apiKey, `/orgs/${orgId}/members/${member.userId}`, { method: "DELETE" })).status).toBe(200);
    expect((await keyReq(secondKey, `/orgs/${orgId}`)).status).toBe(401);
  });

  test("an admin reset-key of themselves still rotates their primary key", async () => {
    const admin = await register("consent-admin-e@example.com");
    const orgId = await createOrg(admin.apiKey, "consent-org-e");
    const res = await post(admin.apiKey, `/orgs/${orgId}/members/${admin.userId}/reset-key`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBeUndefined();
    expect((await keyReq(admin.apiKey, "/auth/me")).status).toBe(401);
    expect((await post(body.apiKey, `/orgs/${admin.orgId}/ops`, { op: "ls", path: "/" })).status).toBe(200);
  });
});
