import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, AgentS3Client } from "@/core";

const MINIO_AVAILABLE = await (async () => {
  try { const r = await fetch("http://localhost:9000/minio/health/live"); return r.ok; } catch { return false; }
})();
const SKIP = !MINIO_AVAILABLE;
import { createApp } from "../app.js";

const TEST_DB = join(tmpdir(), `agent-fs-api-test-${Date.now()}.db`);

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  if (SKIP) return;
  const db = createDatabase(TEST_DB);
  const s3 = new AgentS3Client({
    provider: "minio",
    bucket: "agentfs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  });
  await s3.enableVersioning();
  app = createApp(db, s3);
});

afterAll(() => {
  if (SKIP) return;
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

function req(path: string, opts?: RequestInit) {
  return app.request(path, opts);
}

function authReq(path: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return app.request(path, { ...opts, headers });
}

describe.skipIf(SKIP)("Health check", () => {
  test("GET /health returns 200", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe.skipIf(SKIP)("Auth", () => {
  test("POST /auth/register creates user and returns API key", async () => {
    const res = await req("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "api-test@example.com" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^af_/);
    expect(body.userId).toBeTruthy();
    expect(body.orgId).toBeTruthy();
    apiKey = body.apiKey;
    orgId = body.orgId;
  });

  test("GET /auth/me returns user info", async () => {
    const res = await authReq("/auth/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("api-test@example.com");
  });

  test("Unauthenticated request returns 401", async () => {
    const res = await req("/auth/me");
    expect(res.status).toBe(401);
  });

  test("Invalid API key returns 401", async () => {
    const res = await req("/auth/me", {
      headers: { Authorization: "Bearer af_invalid" },
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(SKIP)("Ops API", () => {
  test("write + cat roundtrip via API", async () => {
    // Write
    const writeRes = await authReq(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "write",
        path: "/api-test.md",
        content: "# API Test\n\nHello from the API!",
      }),
    });

    expect(writeRes.status).toBe(200);
    const writeBody = await writeRes.json();
    expect(writeBody.version).toBe(1);

    // Cat
    const catRes = await authReq(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "cat", path: "/api-test.md" }),
    });

    expect(catRes.status).toBe(200);
    const catBody = await catRes.json();
    expect(catBody.content).toBe("# API Test\n\nHello from the API!");
  });

  test("missing op returns 400", async () => {
    const res = await authReq(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/test.md" }),
    });

    expect(res.status).toBe(400);
  });

  test("unknown op returns error", async () => {
    const res = await authReq(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "nonexistent" }),
    });

    expect(res.status).toBe(500);
  });
});

describe.skipIf(SKIP)("Orgs API", () => {
  test("GET /orgs returns user orgs", async () => {
    const res = await authReq("/orgs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs.length).toBeGreaterThan(0);
  });

  test("GET /orgs/:orgId returns org details", async () => {
    const res = await authReq(`/orgs/${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(orgId);
  });

  test("GET /orgs/:orgId/drives returns drives", async () => {
    const res = await authReq(`/orgs/${orgId}/drives`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drives.length).toBeGreaterThan(0);
  });
});
