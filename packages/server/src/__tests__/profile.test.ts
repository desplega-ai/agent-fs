import { describe, test, expect } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createUser, createOrg, inviteToOrg, listDrives, getProfile } from "@/core";
import { createApp } from "../app.js";

function setup() {
  const db = createTestDb();
  const app = createApp(db, new MockS3Client());
  const admin = createUser(db, { email: "private-admin@example.com" });
  const editor = createUser(db, { email: "editor@example.com" });
  const viewer = createUser(db, { email: "viewer@example.com" });
  const outsider = createUser(db, { email: "outsider@example.com" });
  const org = createOrg(db, { name: "shared", userId: admin.user.id });
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const)
    inviteToOrg(db, { orgId: org.id, email: user.user.email, role });
  const driveId = listDrives(db, org.id)[0].id;
  const request = (key: string, path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const op = (key: string, op: string, params: object) => request(key, `/orgs/${org.id}/ops`, "POST", { op, driveId, ...params });
  return { db, app, admin, editor, viewer, outsider, org, request, op };
}

describe("own profile", () => {
  test("requires auth, validates input, trims names and never edits another user", async () => {
    const { db, app, editor, admin, request } = setup();
    expect((await app.request("/auth/profile")).status).toBe(401);
    expect((await request(editor.apiKey, "/auth/profile")).status).toBe(200);
    for (const body of [{}, { displayName: " " }, { displayName: "x".repeat(101) }, { displayName: 1 }, { displayName: "X", userId: admin.user.id }, { displayName: "X", email: "hijack@example.com" }]) {
      expect((await request(editor.apiKey, "/auth/profile", "PATCH", body)).status).toBe(400);
    }
    const saved = await (await request(editor.apiKey, "/auth/profile", "PATCH", { displayName: "  Taras  " })).json();
    expect(saved).toEqual({ userId: editor.user.id, email: editor.user.email, displayName: "Taras" });
    expect(getProfile(db, admin.user.id).displayName).toBeNull();
    expect((await (await request(editor.apiKey, "/auth/me")).json()).displayName).toBe("Taras");
    await request(editor.apiKey, "/auth/profile", "PATCH", { displayName: null });
    expect(getProfile(db, editor.user.id).displayName).toBeNull();
  });

  test("all drive members see current names on roots and replies without private author data", async () => {
    const { admin, editor, viewer, outsider, org, request, op } = setup();
    await request(admin.apiKey, "/auth/profile", "PATCH", { displayName: "Researcher" });
    const root = await (await op(admin.apiKey, "comment-add", { path: "/spec.md", body: "A root" })).json();
    expect(root.authorDisplayName).toBe("Researcher");
    await op(admin.apiKey, "comment-add", { parentId: root.id, body: "A reply" });
    for (const user of [editor, viewer]) {
      expect((await request(user.apiKey, `/orgs/${org.id}/members`)).status).toBe(403);
      const list = await (await op(user.apiKey, "comment-list", { path: "/spec.md" })).json();
      expect(list.comments[0].authorDisplayName).toBe("Researcher");
      expect(list.comments[0].replies[0].authorDisplayName).toBe("Researcher");
      expect(JSON.stringify(list)).not.toContain(admin.user.email);
      expect(list.comments[0]).not.toHaveProperty("role");
    }
    await request(admin.apiKey, "/auth/profile", "PATCH", { displayName: "Renamed" });
    const detail = await (await op(viewer.apiKey, "comment-get", { id: root.id })).json();
    expect(detail.comment.authorDisplayName).toBe("Renamed");
    expect(detail.replies[0].authorDisplayName).toBe("Renamed");
    expect((await op(outsider.apiKey, "comment-get", { id: root.id })).status).not.toBe(200);
    await request(admin.apiKey, "/auth/profile", "PATCH", { displayName: null });
    const cleared = await (await op(viewer.apiKey, "comment-get", { id: root.id })).json();
    expect(cleared.comment.authorDisplayName).toBeUndefined();
    expect(cleared.comment.author).toBe(admin.user.id);
  });
});
