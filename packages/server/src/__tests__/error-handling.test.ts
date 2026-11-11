import { describe, expect, test } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createUser, DEFAULT_MAX_UPLOAD_BYTES, listUserOrgs } from "@/core";
import type { GetObjectResult } from "@/core";
import { createApp } from "../app.js";

class FailingGetS3 extends MockS3Client {
  constructor(private readonly failure: Error) {
    super();
  }
  override async getObject(): Promise<GetObjectResult> {
    throw this.failure;
  }
}

function setup(s3 = new MockS3Client()) {
  const db = createTestDb();
  const app = createApp(db, s3);
  const { user, apiKey } = createUser(db, { email: "errors@example.com" });
  const orgId = listUserOrgs(db, user.id)[0].id;
  const post = (body: string, key = apiKey) =>
    app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    });
  return { db, post };
}

describe("POST /orgs/:orgId/ops client errors", () => {
  test("invalid params return 400 naming the field", async () => {
    const res = await setup().post(JSON.stringify({ op: "cat" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("path");
  });

  test("an unknown op returns 400", async () => {
    const res = await setup().post(JSON.stringify({ op: "nonexistent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("nonexistent");
  });

  test("a non-JSON body returns 400", async () => {
    const res = await setup().post("not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
  });

  test.each([["[]"], ['"x"'], ["null"]])("a JSON body that is not an object (%s) returns 400", async (body) => {
    const res = await setup().post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
  });

  test("an oversized chunked body still returns 413, not 400", async () => {
    const db = createTestDb();
    const app = createApp(db, new MockS3Client());
    const { user, apiKey } = createUser(db, { email: "big@example.com" });
    const orgId = listUserOrgs(db, user.id)[0].id;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    // No content-length, so bodyLimit counts bytes while the route reads them.
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ > DEFAULT_MAX_UPLOAD_BYTES / chunk.length) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const res = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("a caller without access gets the permission error, not a schema description", async () => {
    const { db, post } = setup();
    const { apiKey: outsiderKey } = createUser(db, { email: "outsider@example.com" });
    const res = await post(JSON.stringify({ op: "cat" }), outsiderKey);
    expect([403, 404]).toContain(res.status);
  });
});

describe("POST /orgs/:orgId/ops internal errors", () => {
  test.each([
    ["a plain error", new Error("bucket internal-name unreachable at 10.0.0.5"), ["internal-name", "10.0.0.5"]],
    [
      "an error with a code that is not an AgentFSError",
      Object.assign(new Error("EACCES: /var/data/secret"), { code: "EACCES" }),
      ["/var/data", "EACCES"],
    ],
  ])("%s returns a generic 500", async (_, failure, leaked) => {
    const { post } = setup(new FailingGetS3(failure));
    const written = await post(JSON.stringify({ op: "write", path: "/a.txt", content: "hi" }));
    expect(written.status).toBe(200);

    const res = await post(JSON.stringify({ op: "cat", path: "/a.txt" }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "INTERNAL_ERROR", message: "Internal server error" });
    for (const secret of leaked) expect(text).not.toContain(secret);
  });
});
