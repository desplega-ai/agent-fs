import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

// In-process daemon test: point createApp at a forced no-versioning backend and
// prove an unsupported op surfaces cleanly as HTTP 422 with the typed body —
// no raw S3/FS stack escaping the error layer.

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  const db = createTestDb();
  const s3 = new MockS3Client({ capabilities: { versioning: false } });
  app = createApp(db, s3 as any);

  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cap-gating@example.com" }),
  });
  const body = await reg.json();
  apiKey = body.apiKey;
  orgId = body.orgId;

  // Seed a file so the version row exists; revert must still be gated.
  const write = await app.request(`/orgs/${orgId}/ops`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ op: "write", path: "/cap.txt", content: "v1" }),
  });
  expect(write.status).toBe(200);
});

describe("UnsupportedOperation surfacing through the daemon", () => {
  test("POST ops op=revert on a no-versioning backend returns 422 with typed body", async () => {
    const res = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ op: "revert", path: "/cap.txt", version: 1 }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("UNSUPPORTED_OPERATION");
    expect(body.message).toContain("not supported");
    expect(body.suggestion).toBeTruthy();
    expect(body.operation).toBe("revert");
  });
});
