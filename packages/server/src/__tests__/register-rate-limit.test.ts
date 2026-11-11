import { describe, test, expect, afterEach } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

const ENV = "AGENT_FS_REGISTER_RATE_LIMIT";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

type App = ReturnType<typeof createApp>;

function register(app: App, i: number, headers: Record<string, string> = {}) {
  return app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email: `user${i}@example.com` }),
  });
}

function newApp(limit?: string): App {
  if (limit === undefined) delete process.env[ENV];
  else process.env[ENV] = limit;
  return createApp(createTestDb(), new MockS3Client());
}

describe("POST /auth/register rate limit", () => {
  test("limits by client address and sends Retry-After", async () => {
    const app = newApp("2");
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await register(app, i));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 429, 429]);
    expect(Number(responses[2].headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("a different Authorization header per request does not reset the limit", async () => {
    const app = newApp("2");
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await register(app, i, { Authorization: `Bearer random-${i}` })).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  test("a different X-Forwarded-For header per request does not reset the limit", async () => {
    const app = newApp("2");
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await register(app, i, { "X-Forwarded-For": `10.0.0.${i}` })).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  test("0 disables the limit", async () => {
    const app = newApp("0");
    for (let i = 0; i < 6; i++) expect((await register(app, i)).status).toBe(200);
  });

  test("the default is not tiny", async () => {
    const app = newApp();
    for (let i = 0; i < 3; i++) expect((await register(app, i)).status).toBe(200);
  });
});

describe("public path matching", () => {
  test("only the exact public paths skip authentication", async () => {
    const app = newApp();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(401);
    expect((await app.request("/health/x")).status).toBe(401);
    expect((await app.request("/auth/register-extra", { method: "POST" })).status).toBe(401);
  });
});
