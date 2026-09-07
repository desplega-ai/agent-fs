import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;

beforeAll(() => {
  const db = createTestDb();
  const s3 = new MockS3Client();
  app = createApp(db, s3 as any);
});

function req(path: string, opts?: RequestInit) {
  return app.request(path, opts);
}

function authReq(path: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return app.request(path, { ...opts, headers });
}

function jsonPost(path: string, body: any, headers?: Record<string, string>) {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function authJsonPost(path: string, body: any) {
  return authReq(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Health check ---

describe("Health check", () => {
  test("GET /health returns 200", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
  });
});

// --- Auth middleware ---

describe("Auth middleware", () => {
  test("public paths bypass auth", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
  });

  test("missing Authorization header returns 401", async () => {
    const res = await req("/orgs");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.suggestion).toBeDefined();
  });

  test("malformed Authorization header returns 401", async () => {
    const res = await req("/orgs", {
      headers: { Authorization: "Token abc123" },
    });
    expect(res.status).toBe(401);
  });

  test("invalid API key returns 401", async () => {
    const res = await req("/orgs", {
      headers: { Authorization: "Bearer af_invalid_key_here" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Invalid API key");
  });
});

// --- Auth routes ---

describe("Auth routes", () => {
  test("POST /auth/register creates user", async () => {
    const res = await jsonPost("/auth/register", { email: "test@example.com" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^af_/);
    expect(body.userId).toBeTruthy();
    expect(body.orgId).toBeTruthy();
    apiKey = body.apiKey;
    orgId = body.orgId;
  });

  test("POST /auth/register with missing email returns 400", async () => {
    const res = await jsonPost("/auth/register", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  test("POST /auth/register with duplicate email returns 409", async () => {
    const res = await jsonPost("/auth/register", { email: "test@example.com" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("CONFLICT");
  });

  test("GET /auth/me returns user info", async () => {
    const res = await authReq("/auth/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("test@example.com");
  });
});

// --- Org routes ---

describe("Org routes", () => {
  test("GET /orgs returns user orgs", async () => {
    const res = await authReq("/orgs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs.length).toBeGreaterThan(0);
  });

  test("POST /orgs creates new org", async () => {
    const res = await authJsonPost("/orgs", { name: "test-org" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("test-org");
  });

  test("GET /orgs/:orgId returns org", async () => {
    const res = await authReq(`/orgs/${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(orgId);
  });

  test("GET /orgs/:orgId with invalid id returns 404", async () => {
    const res = await authReq("/orgs/nonexistent");
    expect(res.status).toBe(404);
  });

  test("GET /orgs/:orgId/drives returns drives", async () => {
    const res = await authReq(`/orgs/${orgId}/drives`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drives.length).toBeGreaterThan(0);
  });

  test("POST /orgs/:orgId/drives creates drive", async () => {
    const res = await authJsonPost(`/orgs/${orgId}/drives`, { name: "extra" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("extra");
  });
});

// --- Ops routes ---

describe("Ops routes", () => {
  test("write + cat roundtrip", async () => {
    const writeRes = await authJsonPost(`/orgs/${orgId}/ops`, {
      op: "write",
      path: "/server-test.txt",
      content: "Hello from server test",
    });
    expect(writeRes.status).toBe(200);
    const writeBody = await writeRes.json();
    expect(writeBody.version).toBe(1);

    const catRes = await authJsonPost(`/orgs/${orgId}/ops`, {
      op: "cat",
      path: "/server-test.txt",
    });
    expect(catRes.status).toBe(200);
    const catBody = await catRes.json();
    expect(catBody.content).toBe("Hello from server test");
  });

  test("missing op returns 400", async () => {
    const res = await authJsonPost(`/orgs/${orgId}/ops`, { path: "/x.txt" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  test("unknown op returns error", async () => {
    const res = await authJsonPost(`/orgs/${orgId}/ops`, { op: "nonexistent" });
    expect(res.status).not.toBe(200);
  });
});

// --- Error middleware ---

describe("Error handling", () => {
  test("NotFoundError returns 404", async () => {
    const res = await authJsonPost(`/orgs/${orgId}/ops`, {
      op: "cat",
      path: "/nonexistent.txt",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  test("RBAC violation returns 403", async () => {
    // Register a second user
    const regRes = await jsonPost("/auth/register", { email: "viewer@example.com" });
    const viewerKey = (await regRes.json()).apiKey;

    // Write a file as admin first
    await authJsonPost(`/orgs/${orgId}/ops`, {
      op: "write",
      path: "/admin-file.txt",
      content: "admin content",
    });

    // Invite viewer to org
    await authJsonPost(`/orgs/${orgId}/members/invite`, {
      email: "viewer@example.com",
      role: "viewer",
    });

    // Viewer tries to write
    const writeRes = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerKey}`,
      },
      body: JSON.stringify({
        op: "write",
        path: "/blocked.txt",
        content: "should fail",
      }),
    });

    expect(writeRes.status).toBe(403);
    const body = await writeRes.json();
    expect(body.error).toBe("PERMISSION_DENIED");
  });
});

// --- Multi-tenant RBAC on org/member/drive routes ---

describe("Multi-tenant RBAC", () => {
  let ownerKey: string;
  let viewerKey: string;
  let editorKey: string;
  let outsiderKey: string;
  let outsiderUserId: string;
  let ownerUserId: string;
  let viewerUserId: string;
  let editorUserId: string;
  let removableUserId: string;
  let tenantOrgId: string;
  let tenantDriveId: string; // tenant org default drive
  let outsiderOrgId: string;
  let outsiderDriveId: string; // outsider's personal default drive

  function keyReq(key: string, path: string, opts?: RequestInit) {
    const headers = new Headers(opts?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    if (opts?.body) headers.set("Content-Type", "application/json");
    return app.request(path, { ...opts, headers });
  }

  async function register(email: string) {
    const res = await jsonPost("/auth/register", { email });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ apiKey: string; userId: string; orgId: string }>;
  }

  beforeAll(async () => {
    const owner = await register("rbac-owner@example.com");
    ownerKey = owner.apiKey;
    ownerUserId = owner.userId;

    const viewer = await register("rbac-viewer@example.com");
    viewerKey = viewer.apiKey;
    viewerUserId = viewer.userId;

    const editor = await register("rbac-editor@example.com");
    editorKey = editor.apiKey;
    editorUserId = editor.userId;

    const outsider = await register("rbac-outsider@example.com");
    outsiderKey = outsider.apiKey;
    outsiderUserId = outsider.userId;
    outsiderOrgId = outsider.orgId;

    const removable = await register("rbac-removable@example.com");
    removableUserId = removable.userId;

    // Owner creates a shared (non-personal) tenant org
    const orgRes = await keyReq(ownerKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "rbac-tenant" }),
    });
    expect(orgRes.status).toBe(201);
    tenantOrgId = (await orgRes.json()).id;

    // Owner (org admin) invites members
    for (const [email, role] of [
      ["rbac-viewer@example.com", "viewer"],
      ["rbac-editor@example.com", "editor"],
      ["rbac-removable@example.com", "viewer"],
    ] as const) {
      const res = await keyReq(ownerKey, `/orgs/${tenantOrgId}/members/invite`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      expect(res.status).toBe(200);
    }

    // Resolve drive ids
    const tenantDrives = await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives`);
    tenantDriveId = (await tenantDrives.json()).drives.find((d: any) => d.isDefault).id;

    const outsiderDrives = await keyReq(outsiderKey, `/orgs/${outsiderOrgId}/drives`);
    outsiderDriveId = (await outsiderDrives.json()).drives[0].id;
  });

  test("cross-tenant org and drive routes are invisible to non-members", async () => {
    // Org details / drive listing: same 404 as a missing org (no existence oracle)
    expect((await keyReq(outsiderKey, `/orgs/${tenantOrgId}`)).status).toBe(404);
    expect((await keyReq(outsiderKey, `/orgs/${tenantOrgId}/drives`)).status).toBe(404);

    // Drive creation in a foreign org is rejected (previously returned 201)
    const createRes = await keyReq(outsiderKey, `/orgs/${tenantOrgId}/drives`, {
      method: "POST",
      body: JSON.stringify({ name: "intruder-drive" }),
    });
    expect(createRes.status).toBe(404);

    // Org member surfaces
    expect((await keyReq(outsiderKey, `/orgs/${tenantOrgId}/members`)).status).toBe(404);
    expect(
      (
        await keyReq(outsiderKey, `/orgs/${tenantOrgId}/members/invite`, {
          method: "POST",
          body: JSON.stringify({ email: "rbac-outsider@example.com", role: "admin" }),
        })
      ).status
    ).toBe(404);
    expect(
      (
        await keyReq(outsiderKey, `/orgs/${tenantOrgId}/members/${ownerUserId}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status
    ).toBe(404);
    expect(
      (
        await keyReq(outsiderKey, `/orgs/${tenantOrgId}/members/${ownerUserId}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(404);

    // Drive member surface: driveId is bound to the route orgId, so a
    // foreign drive under the outsider's own org is a 404...
    expect(
      (await keyReq(outsiderKey, `/orgs/${outsiderOrgId}/drives/${tenantDriveId}/members`)).status
    ).toBe(404);
    // ...and with the real org+drive pair, the outsider has no drive/org
    // admin role, so the request is denied.
    expect(
      (await keyReq(outsiderKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members`)).status
    ).toBe(403);

    // Ops route binding: a body driveId from another org is rejected before dispatch
    const opsRes = await keyReq(outsiderKey, `/orgs/${outsiderOrgId}/ops`, {
      method: "POST",
      body: JSON.stringify({ op: "ls", path: "/", driveId: tenantDriveId }),
    });
    expect(opsRes.status).toBe(404);

    // Raw route binding: foreign driveId under the caller's org is rejected
    const rawRes = await keyReq(
      outsiderKey,
      `/orgs/${outsiderOrgId}/drives/${tenantDriveId}/files/secret.txt/raw`
    );
    expect(rawRes.status).toBe(404);

    // Verify the intruder drive was never created
    const drives = await (await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives`)).json();
    expect(drives.drives.some((d: any) => d.name === "intruder-drive")).toBe(false);
  });

  test("viewer and editor org members cannot administer org or drives", async () => {
    // Members can see org details and their drives
    expect((await keyReq(viewerKey, `/orgs/${tenantOrgId}`)).status).toBe(200);
    expect((await keyReq(viewerKey, `/orgs/${tenantOrgId}/drives`)).status).toBe(200);

    // Drive creation requires org admin
    for (const key of [viewerKey, editorKey]) {
      const res = await keyReq(key, `/orgs/${tenantOrgId}/drives`, {
        method: "POST",
        body: JSON.stringify({ name: "nope" }),
      });
      expect(res.status).toBe(403);
    }

    // Org member list/invite/update/remove require org admin
    expect((await keyReq(viewerKey, `/orgs/${tenantOrgId}/members`)).status).toBe(403);
    expect((await keyReq(editorKey, `/orgs/${tenantOrgId}/members`)).status).toBe(403);
    expect(
      (
        await keyReq(editorKey, `/orgs/${tenantOrgId}/members/invite`, {
          method: "POST",
          body: JSON.stringify({ email: "rbac-outsider@example.com", role: "viewer" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await keyReq(viewerKey, `/orgs/${tenantOrgId}/members/${editorUserId}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "admin" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await keyReq(editorKey, `/orgs/${tenantOrgId}/members/${viewerUserId}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(403);

    // Drive member management requires drive admin or org admin — viewer and
    // editor hold non-admin roles on the default drive (granted by invite)
    expect(
      (await keyReq(viewerKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members`)).status
    ).toBe(403);
    expect(
      (
        await keyReq(viewerKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members`, {
          method: "POST",
          body: JSON.stringify({ userId: editorUserId, role: "viewer" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await keyReq(editorKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members/${viewerUserId}`, {
          method: "PATCH",
          body: JSON.stringify({ role: "admin" }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await keyReq(viewerKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members/${editorUserId}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(403);
  });

  test("org admin can create list and manage drive members", async () => {
    // Create a drive — creator gets an explicit admin membership row
    const createRes = await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives`, {
      method: "POST",
      body: JSON.stringify({ name: "team-docs" }),
    });
    expect(createRes.status).toBe(201);
    const newDriveId = (await createRes.json()).id;

    // The freshly created drive is visible to its creator (strict membership)
    const drives = await (await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives`)).json();
    expect(drives.drives.some((d: any) => d.id === newDriveId)).toBe(true);

    // Creator shows up as the drive admin
    const newMembers = await (
      await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${newDriveId}/members`)
    ).json();
    expect(newMembers.members).toEqual([
      expect.objectContaining({ userId: ownerUserId, role: "admin" }),
    ]);

    // Add an existing org member by email, then re-add by user id. The upsert
    // changes the role without creating a duplicate membership.
    const addRes = await keyReq(
      ownerKey,
      `/orgs/${tenantOrgId}/drives/${newDriveId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ email: "rbac-editor@example.com", role: "viewer" }),
      }
    );
    expect(addRes.status).toBe(200);
    const readdRes = await keyReq(
      ownerKey,
      `/orgs/${tenantOrgId}/drives/${newDriveId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: editorUserId, role: "editor" }),
      }
    );
    expect(readdRes.status).toBe(200);
    const afterAdd = await (
      await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${newDriveId}/members`)
    ).json();
    expect(
      afterAdd.members.filter((m: any) => m.userId === editorUserId)
    ).toEqual([expect.objectContaining({ role: "editor" })]);

    // A user outside the owning org cannot be granted drive access.
    const nonMemberRes = await keyReq(
      ownerKey,
      `/orgs/${tenantOrgId}/drives/${newDriveId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: outsiderUserId, role: "viewer" }),
      }
    );
    expect(nonMemberRes.status).toBe(400);

    // Org admin manages default-drive members (granted by invite)
    const patchRes = await keyReq(
      ownerKey,
      `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members/${viewerUserId}`,
      { method: "PATCH", body: JSON.stringify({ role: "editor" }) }
    );
    expect(patchRes.status).toBe(200);

    const afterPatch = await (
      await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members`)
    ).json();
    expect(
      afterPatch.members.find((m: any) => m.userId === viewerUserId).role
    ).toBe("editor");

    const deleteRes = await keyReq(
      ownerKey,
      `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members/${editorUserId}`,
      { method: "DELETE" }
    );
    expect(deleteRes.status).toBe(200);

    const afterDelete = await (
      await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${tenantDriveId}/members`)
    ).json();
    expect(afterDelete.members.some((m: any) => m.userId === editorUserId)).toBe(false);

    // Org/drive mismatch is still a 404 even for an org admin
    expect(
      (await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${outsiderDriveId}/members`)).status
    ).toBe(404);
    expect(
      (
        await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives/${outsiderDriveId}/members`, {
          method: "POST",
          body: JSON.stringify({ userId: editorUserId, role: "viewer" }),
        })
      ).status
    ).toBe(404);
  });

  test("org admin can manage org members", async () => {
    const listRes = await keyReq(ownerKey, `/orgs/${tenantOrgId}/members`);
    expect(listRes.status).toBe(200);
    const members = (await listRes.json()).members;
    expect(members.some((m: any) => m.userId === removableUserId)).toBe(true);

    const patchRes = await keyReq(ownerKey, `/orgs/${tenantOrgId}/members/${removableUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "editor" }),
    });
    expect(patchRes.status).toBe(200);

    const deleteRes = await keyReq(ownerKey, `/orgs/${tenantOrgId}/members/${removableUserId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const after = await (await keyReq(ownerKey, `/orgs/${tenantOrgId}/members`)).json();
    expect(after.members.some((m: any) => m.userId === removableUserId)).toBe(false);
  });

  test("inaccessible drive is indistinguishable from a missing drive on ops (404)", async () => {
    // Owner creates a drive the viewer has no membership row on
    const createRes = await keyReq(ownerKey, `/orgs/${tenantOrgId}/drives`, {
      method: "POST",
      body: JSON.stringify({ name: "viewer-blind" }),
    });
    expect(createRes.status).toBe(201);
    const hiddenDriveId = (await createRes.json()).id;

    const probe = (driveId: string) =>
      keyReq(viewerKey, `/orgs/${tenantOrgId}/ops`, {
        method: "POST",
        body: JSON.stringify({ op: "ls", path: "/", driveId }),
      });

    const missingId = "00000000-0000-4000-8000-000000000000";
    const missingRes = await probe(missingId);
    const hiddenRes = await probe(hiddenDriveId);

    expect(missingRes.status).toBe(404);
    expect(hiddenRes.status).toBe(404); // was a 500 INTERNAL_ERROR oracle

    // Bodies are byte-identical modulo the caller-supplied driveId
    const missingBody = (await missingRes.text()).replaceAll(missingId, "DRIVE_ID");
    const hiddenBody = (await hiddenRes.text()).replaceAll(hiddenDriveId, "DRIVE_ID");
    expect(hiddenBody).toBe(missingBody);
  });
});

// --- API key reset routes ---

describe("API key reset routes", () => {
  function keyReq(key: string, path: string, opts?: RequestInit) {
    const headers = new Headers(opts?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    if (opts?.body) headers.set("Content-Type", "application/json");
    return app.request(path, { ...opts, headers });
  }

  async function register(email: string) {
    const res = await jsonPost("/auth/register", { email });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ apiKey: string; userId: string; orgId: string }>;
  }

  test("self-reset returns a fresh key and invalidates the old one", async () => {
    const user = await register("reset-self@example.com");

    const resetRes = await keyReq(user.apiKey, "/auth/reset-key", { method: "POST" });
    expect(resetRes.status).toBe(200);
    const { apiKey: newKey } = await resetRes.json();
    expect(newKey).toMatch(/^af_[0-9a-f]{64}$/);
    expect(newKey).not.toBe(user.apiKey);

    const oldKeyRes = await keyReq(user.apiKey, "/auth/me");
    expect(oldKeyRes.status).toBe(401);

    const newKeyRes = await keyReq(newKey, "/auth/me");
    expect(newKeyRes.status).toBe(200);
    expect((await newKeyRes.json()).email).toBe("reset-self@example.com");
  });

  test("admin reset by an org admin returns 200 and invalidates the member's old key", async () => {
    const admin = await register("reset-admin@example.com");
    const member = await register("reset-member@example.com");

    const orgRes = await keyReq(admin.apiKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "reset-org" }),
    });
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).id;

    const inviteRes = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "reset-member@example.com", role: "viewer" }),
    });
    expect(inviteRes.status).toBe(200);

    const resetRes = await keyReq(
      admin.apiKey,
      `/orgs/${orgId}/members/${member.userId}/reset-key`,
      { method: "POST" }
    );
    expect(resetRes.status).toBe(200);
    const body = await resetRes.json();
    expect(body.apiKey).toMatch(/^af_[0-9a-f]{64}$/);
    expect(body.userId).toBe(member.userId);
    expect(body.email).toBe("reset-member@example.com");

    expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(401);
    expect((await keyReq(body.apiKey, "/auth/me")).status).toBe(200);
  });

  test("a non-admin member gets 403 resetting another member's key", async () => {
    const admin = await register("reset-nonadmin-admin@example.com");
    const viewer = await register("reset-nonadmin-viewer@example.com");
    const target = await register("reset-nonadmin-target@example.com");

    const orgRes = await keyReq(admin.apiKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "reset-nonadmin-org" }),
    });
    const orgId = (await orgRes.json()).id;

    for (const email of ["reset-nonadmin-viewer@example.com", "reset-nonadmin-target@example.com"]) {
      const res = await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
        method: "POST",
        body: JSON.stringify({ email, role: "viewer" }),
      });
      expect(res.status).toBe(200);
    }

    const resetRes = await keyReq(
      viewer.apiKey,
      `/orgs/${orgId}/members/${target.userId}/reset-key`,
      { method: "POST" }
    );
    expect(resetRes.status).toBe(403);
  });

  test("a caller outside the org gets 404", async () => {
    const admin = await register("reset-outside-admin@example.com");
    const target = await register("reset-outside-target@example.com");
    const outsider = await register("reset-outside-outsider@example.com");

    const orgRes = await keyReq(admin.apiKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "reset-outside-org" }),
    });
    const orgId = (await orgRes.json()).id;
    await keyReq(admin.apiKey, `/orgs/${orgId}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email: "reset-outside-target@example.com", role: "viewer" }),
    });

    const resetRes = await keyReq(
      outsider.apiKey,
      `/orgs/${orgId}/members/${target.userId}/reset-key`,
      { method: "POST" }
    );
    expect(resetRes.status).toBe(404);
  });

  test("an admin reset for a non-member userId gets 404", async () => {
    const admin = await register("reset-nonmember-admin@example.com");
    const stranger = await register("reset-nonmember-stranger@example.com");

    const orgRes = await keyReq(admin.apiKey, "/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "reset-nonmember-org" }),
    });
    const orgId = (await orgRes.json()).id;

    const resetRes = await keyReq(
      admin.apiKey,
      `/orgs/${orgId}/members/${stranger.userId}/reset-key`,
      { method: "POST" }
    );
    expect(resetRes.status).toBe(404);
  });
});
