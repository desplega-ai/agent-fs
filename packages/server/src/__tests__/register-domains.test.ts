import { describe, test, expect, afterEach } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

const ENV = "AGENT_FS_REGISTER_ALLOWED_DOMAINS";
const original = process.env[ENV];

function register(email: unknown) {
  const app = createApp(createTestDb(), new MockS3Client());
  return app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("POST /auth/register domain allowlist", () => {
  test("unset or only empty entries keeps registration open", async () => {
    delete process.env[ENV];
    expect((await register("a@anything.dev")).status).toBe(200);
    expect((await register("nodomain")).status).toBe(200);
    process.env[ENV] = " , ,";
    expect((await register("b@other.org")).status).toBe(200);
  });

  test("allowed domain registers in any letter case", async () => {
    process.env[ENV] = " Acme.com , ,acme.io,";
    const res = await register("Agent@ACME.COM");
    expect(res.status).toBe(200);
    expect((await res.json()).apiKey).toBeString();
    expect((await register("bot@acme.io")).status).toBe(200);
  });

  test("other domains, subdomains and lookalikes get 403", async () => {
    process.env[ENV] = "acme.com";
    for (const email of ["a@evil.com", "a@sub.acme.com", "a@acme.com.evil", "a@acme.com@evil.com"]) {
      const res = await register(email);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("REGISTRATION_DOMAIN_NOT_ALLOWED");
    }
  });

  test("email with no domain gets 400 when the allowlist is set", async () => {
    process.env[ENV] = "acme.com";
    for (const email of ["foo", "foo@", "foo@  "]) {
      const res = await register(email);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
    }
  });
});
