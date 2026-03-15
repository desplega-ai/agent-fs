import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../../../server/src/app.js";
// We test ApiClient by pointing it at a real in-memory Hono server.
let server: ReturnType<typeof Bun.serve>;
let port = 0;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  const db = createTestDb();
  const s3 = new MockS3Client();
  const app = createApp(db, s3 as any);

  // Start on a random port
  server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  });
  port = server.port!;

  // Register a user to get an API key
  const res = await fetch(`http://localhost:${port}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cli-test@example.com" }),
  });
  const body = await res.json();
  apiKey = body.apiKey;
  orgId = body.orgId;

  // Set env vars so ApiClient picks them up
  process.env.AGENTFS_API_URL = `http://localhost:${port}`;
  process.env.AGENTFS_API_KEY = apiKey;
});

afterAll(() => {
  server?.stop();
  delete process.env.AGENTFS_API_URL;
  delete process.env.AGENTFS_API_KEY;
});

describe("ApiClient", () => {
  // Dynamic import so env vars are set before constructor runs
  async function makeClient() {
    const { ApiClient } = await import("../api-client.js");
    return new ApiClient();
  }

  test("get() fetches data", async () => {
    const client = await makeClient();
    const result = await client.get("/orgs");
    expect(result.orgs).toBeDefined();
    expect(result.orgs.length).toBeGreaterThan(0);
  });

  test("post() sends data", async () => {
    const client = await makeClient();
    const result = await client.post("/orgs", { name: "cli-test-org" });
    expect(result.name).toBe("cli-test-org");
  });

  test("callOp() dispatches operation", async () => {
    const client = await makeClient();

    // Write a file
    const writeResult = await client.callOp(orgId, "write", {
      path: "/cli-test.txt",
      content: "Hello from CLI",
    });
    expect(writeResult.version).toBe(1);

    // Read it back
    const catResult = await client.callOp(orgId, "cat", {
      path: "/cli-test.txt",
    });
    expect(catResult.content).toBe("Hello from CLI");
  });

  test("setApiKey() changes auth", async () => {
    const client = await makeClient();
    client.setApiKey("af_invalid_key");

    // Should fail with auth error
    await expect(client.get("/orgs")).rejects.toThrow();
  });

  test("connection error gives helpful message", async () => {
    process.env.AGENTFS_API_URL = "http://localhost:1"; // Nothing running
    const client = await makeClient();

    await expect(client.get("/health")).rejects.toThrow(/Cannot connect/);

    // Restore
    process.env.AGENTFS_API_URL = `http://localhost:${port}`;
  });

  test("server error includes message from response", async () => {
    const client = await makeClient();

    await expect(
      client.callOp(orgId, "cat", { path: "/nonexistent.txt" })
    ).rejects.toThrow(/not found|NoSuchKey/i);
  });
});
