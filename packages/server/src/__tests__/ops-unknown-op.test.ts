import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

// Inherited Object.prototype names must answer exactly like any other unknown op
// (they used to reach `op.schema.parse` and surface as a TypeError 500).

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;

beforeAll(async () => {
  app = createApp(createTestDb(), new MockS3Client() as any);
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "unknown-op@example.com" }),
  });
  const body = await reg.json();
  apiKey = body.apiKey;
  orgId = body.orgId;
});

function postOp(op: string) {
  return app.request(`/orgs/${orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ op }),
  });
}

describe("POST /orgs/:orgId/ops with inherited op names", () => {
  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s answers like an unknown op", async (name) => {
    const control = await postOp("nope");
    const controlBody = await control.json();
    // Control: an unknown op is already a handled error, not a TypeError 500.
    expect(controlBody.error).toBeTruthy();

    const res = await postOp(name);
    const body = await res.json();
    expect(res.status).toBe(control.status);
    expect(body.error).toBe(controlBody.error);
    expect(body.message).toBe(controlBody.message.replace("nope", name));
  });
});
