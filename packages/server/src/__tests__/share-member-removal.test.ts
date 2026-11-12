import { describe, test, expect, beforeAll } from "bun:test";
import { acceptInviteAsInvitee, createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import type { DB } from "@/core";

// Many public requests from one "IP".
process.env.AGENT_FS_SHARE_RATE_LIMIT = "0";
process.env.AGENT_FS_SITE_RATE_LIMIT = "0";

let db: DB;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = createTestDb();
  app = createApp(db, new MockS3Client({ capabilities: { presignedUrls: false } }) as any);
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
  return res.json() as Promise<{ apiKey: string; userId: string }>;
}

function op(key: string, orgId: string, driveId: string, body: Record<string, unknown>) {
  return keyReq(key, `/orgs/${orgId}/ops`, { method: "POST", body: JSON.stringify({ ...body, driveId }) });
}

async function write(key: string, orgId: string, driveId: string, path: string, content: string) {
  expect((await op(key, orgId, driveId, { op: "write", path, content })).status).toBe(200);
}

async function share(key: string, orgId: string, driveId: string, path: string) {
  const res = await op(key, orgId, driveId, { op: "share-create", path, expiresIn: 3600 });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.sharePath as string; // "/site/<token>/" or "/share/<token>"
}

/** A team org owned by an admin, with a second user added as a viewer of its drive. */
async function team(tag: string) {
  const admin = await register(`${tag}-admin@example.com`);
  const viewer = await register(`${tag}-viewer@example.com`);
  const orgRes = await keyReq(admin.apiKey, "/orgs", { method: "POST", body: JSON.stringify({ name: `${tag}-org` }) });
  expect(orgRes.status).toBe(201);
  const orgId = (await orgRes.json()).id as string;
  const drives = (await (await keyReq(admin.apiKey, `/orgs/${orgId}/drives`)).json()).drives;
  const driveId = drives[0].id as string;
  const inv = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
    method: "POST",
    body: JSON.stringify({ email: `${tag}-viewer@example.com`, role: "viewer" }),
  });
  expect(inv.status).toBe(200);
  const invite = await inv.json();
  if (invite.status === "pending") acceptInviteAsInvitee(db, invite.token);
  await write(admin.apiKey, orgId, driveId, "/before.txt", `${tag}-BEFORE`);
  return { admin, viewer, orgId, driveId };
}

const read = (path: string) => app.request(path);

async function expectServed(path: string, content: string) {
  const res = await read(path);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(content);
}

async function expectGone(path: string, content: string) {
  const res = await read(path);
  expect([404, 410]).toContain(res.status);
  expect(await res.text()).not.toContain(content);
}

describe("share links follow their creator's membership", () => {
  test("control: removing one member leaves links minted by the remaining members working", async () => {
    const t = await team("ctrl");
    const adminSite = await share(t.admin.apiKey, t.orgId, t.driveId, "/");
    const adminFile = await share(t.admin.apiKey, t.orgId, t.driveId, "/before.txt");
    const rm = await keyReq(t.admin.apiKey, `/orgs/${t.orgId}/members/${t.viewer.userId}`, { method: "DELETE" });
    expect(rm.status).toBe(200);
    await write(t.admin.apiKey, t.orgId, t.driveId, "/after.txt", "ctrl-AFTER");
    await expectServed(`${adminSite}after.txt`, "ctrl-AFTER");
    await expectServed(`${adminFile}/download`, "ctrl-BEFORE");
  });

  test("removing the creator from the org ends their site and file links; other links keep working", async () => {
    const t = await team("orgrm");
    const site = await share(t.viewer.apiKey, t.orgId, t.driveId, "/");
    const file = await share(t.viewer.apiKey, t.orgId, t.driveId, "/before.txt");
    const adminSite = await share(t.admin.apiKey, t.orgId, t.driveId, "/");

    // Control: the links work while the creator is a member.
    await expectServed(`${site}before.txt`, "orgrm-BEFORE");
    await expectServed(`${file}/download`, "orgrm-BEFORE");

    const rm = await keyReq(t.admin.apiKey, `/orgs/${t.orgId}/members/${t.viewer.userId}`, { method: "DELETE" });
    expect(rm.status).toBe(200);
    await write(t.admin.apiKey, t.orgId, t.driveId, "/after.txt", "orgrm-AFTER");

    // Control: the removed user's own key no longer reads the drive.
    expect((await op(t.viewer.apiKey, t.orgId, t.driveId, { op: "cat", path: "/after.txt" })).status).not.toBe(200);
    // Control: a link minted by a remaining member is unaffected.
    await expectServed(`${adminSite}after.txt`, "orgrm-AFTER");

    await expectGone(`${site}after.txt`, "orgrm-AFTER");
    await expectGone(`${site}before.txt`, "orgrm-BEFORE");
    await expectGone(`${file}/download`, "orgrm-BEFORE");
  });

  test("removing the creator from the drive ends their links on that drive", async () => {
    const t = await team("drvrm");
    const site = await share(t.viewer.apiKey, t.orgId, t.driveId, "/");
    const adminFile = await share(t.admin.apiKey, t.orgId, t.driveId, "/before.txt");
    await expectServed(`${site}before.txt`, "drvrm-BEFORE");

    const rm = await keyReq(t.admin.apiKey, `/orgs/${t.orgId}/drives/${t.driveId}/members/${t.viewer.userId}`, {
      method: "DELETE",
    });
    expect(rm.status).toBe(200);
    await write(t.admin.apiKey, t.orgId, t.driveId, "/after.txt", "drvrm-AFTER");

    expect((await op(t.viewer.apiKey, t.orgId, t.driveId, { op: "cat", path: "/after.txt" })).status).not.toBe(200);
    await expectServed(`${adminFile}/download`, "drvrm-BEFORE");

    await expectGone(`${site}after.txt`, "drvrm-AFTER");
  });
});
