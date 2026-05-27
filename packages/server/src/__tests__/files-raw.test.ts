import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;
let driveId: string;

beforeAll(async () => {
  const db = createTestDb();
  const s3 = new MockS3Client();
  app = createApp(db, s3 as any);

  // Register a user (auth is shared across these tests).
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "raw-test@example.com" }),
  });
  const body = await reg.json();
  apiKey = body.apiKey;
  orgId = body.orgId;

  // Pull the default drive id from /auth/me — we'll need it for the
  // file routes which take a driveId path param explicitly.
  const me = await app.request("/auth/me", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const meBody = await me.json();
  driveId = meBody.defaultDriveId;
});

function authedFetch(path: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return app.request(path, { ...opts, headers });
}

describe("GET /raw — head metadata headers", () => {
  test("returns ETag, X-Agent-FS-Version, X-Agent-FS-Content-Hash, Last-Modified", async () => {
    // Seed v1 via the JSON op route.
    const writeRes = await authedFetch(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "write",
        path: "/raw-headers.txt",
        content: "hello",
      }),
    });
    expect(writeRes.status).toBe(200);

    const getRes = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-headers.txt/raw`
    );
    expect(getRes.status).toBe(200);

    expect(getRes.headers.get("ETag")).toBe(`"1"`);
    expect(getRes.headers.get("X-Agent-FS-Version")).toBe("1");
    const hash = getRes.headers.get("X-Agent-FS-Content-Hash");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(getRes.headers.get("Last-Modified")).toBeTruthy();
  });
});

describe("PUT /raw — binary write path", () => {
  test("preserves arbitrary non-UTF-8 bytes", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
    ]);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");

    const put = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/nested/binary.png/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      }
    );
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.size).toBe(bytes.byteLength);
    expect(putBody.contentHash).toBe(expectedHash);
    expect(put.headers.get("X-Agent-FS-Content-Hash")).toBe(expectedHash);

    const get = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/nested/binary.png/raw`
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/png");
    expect(get.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    const out = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  test("without If-Match creates v1, with matching If-Match: 1 creates v2", async () => {
    const v1 = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-put.txt/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: "v1 body",
      }
    );
    expect(v1.status).toBe(200);
    const v1Body = await v1.json();
    expect(v1Body.version).toBe(1);
    expect(v1Body.deduped).toBe(false);
    expect(v1.headers.get("X-Agent-FS-Version")).toBe("1");
    expect(v1.headers.get("X-Agent-FS-Deduped")).toBe("0");
    expect(v1.headers.get("X-Agent-FS-Content-Hash")).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.headers.get("ETag")).toBe(`"1"`);

    const v2 = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-put.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": "1",
        },
        body: "v2 body",
      }
    );
    expect(v2.status).toBe(200);
    const v2Body = await v2.json();
    expect(v2Body.version).toBe(2);
  });

  test("If-Match accepts quoted ETag value", async () => {
    await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-quoted.txt/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: "q1",
      }
    );
    const res = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-quoted.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": `"1"`,
        },
        body: "q2",
      }
    );
    expect(res.status).toBe(200);
  });

  test("stale If-Match returns 409 EditConflict", async () => {
    // Seed v1.
    await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-stale.txt/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: "a",
      }
    );
    // Bump to v2.
    await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-stale.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": "1",
        },
        body: "b",
      }
    );
    // Stale If-Match: 1 (head is now 2).
    const stale = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-stale.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": "1",
        },
        body: "c",
      }
    );
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error).toBe("EDIT_CONFLICT");
    expect(body.path).toBe("/raw-stale.txt");
  });

  test("If-None-Match: * acts as create-only (expectedVersion: 0)", async () => {
    // First write succeeds.
    const v1 = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-create.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-None-Match": "*",
        },
        body: "first",
      }
    );
    expect(v1.status).toBe(200);

    // Repeating with If-None-Match: * after the file exists → 409.
    const dup = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-create.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-None-Match": "*",
        },
        body: "second",
      }
    );
    expect(dup.status).toBe(409);
  });

  test("identical body with If-Match returns deduped=1", async () => {
    await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-dedup.txt/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: "same bytes",
      }
    );
    const dup = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-dedup.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": "1",
        },
        body: "same bytes",
      }
    );
    expect(dup.status).toBe(200);
    const body = await dup.json();
    expect(body.deduped).toBe(true);
    expect(body.version).toBe(1);
    expect(dup.headers.get("X-Agent-FS-Deduped")).toBe("1");
    expect(dup.headers.get("X-Agent-FS-Version")).toBe("1");
  });

  test("Content-Type: application/json returns 415", async () => {
    const res = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-json.txt/raw`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/x", content: "y" }),
      }
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  test("non-integer If-Match returns 400", async () => {
    const res = await authedFetch(
      `/orgs/${orgId}/drives/${driveId}/files/raw-badmatch.txt/raw`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "If-Match": "abc",
        },
        body: "x",
      }
    );
    expect(res.status).toBe(400);
  });
});
