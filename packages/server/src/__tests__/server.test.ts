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
