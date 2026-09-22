import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestConfigDir, createTestContext } from "../../../core/src/test-utils.js";
import { write, writeRaw } from "../../../core/src/ops/write.js";
import { createApp } from "../app.js";

const MiB = 1024 * 1024;
let cleanup: () => void;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENT_FS_MAX_UPLOAD_BYTES;
  ({ cleanup } = createTestConfigDir());
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_FS_MAX_UPLOAD_BYTES;
  else process.env.AGENT_FS_MAX_UPLOAD_BYTES = saved;
  cleanup();
});

describe("configured raw upload limits", () => {
  test("HTTP accepts more than 50 MiB and advertises the same limit", async () => {
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = String(51 * MiB);
    const { db, s3, apiKey, orgId, driveId } = createTestContext();
    const app = createApp(db, s3);
    const health = await (await app.request("/health")).json();
    expect(health.maxUploadBytes).toBe(51 * MiB);
    const path = `/orgs/${orgId}/drives/${driveId}/files/large.bin/raw`;
    const result = await app.request(path, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: new Uint8Array(51 * MiB),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).size).toBe(51 * MiB);
    // Content-Length exercises the HTTP gate without another large allocation.
    const rejected = await app.request(path, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Length": String(51 * MiB + 1) },
      body: "x",
    });
    expect(rejected.status).toBe(413);
  });

  test("raising the raw cap keeps non-raw requests at the default cap", async () => {
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = String(100 * MiB);
    const { db, s3, orgId, driveId } = createTestContext();
    const app = createApp(db, s3);
    for (const [method, path] of [
      ["POST", "/auth/register"],
      ["PUT", "/auth/register"],
      ["POST", `/orgs/${orgId}/drives/${driveId}/files/file.bin/raw`],
      ["PUT", `/orgs/${orgId}/drives/${driveId}/files/file.bin`],
    ]) {
      const result = await app.request(path, {
        method,
        headers: { "Content-Length": String(50 * MiB + 1) },
        body: "x",
      });
      expect(result.status).toBe(413);
      expect((await result.json()).message).toBe("Request body exceeds the 50MB limit");
    }
    const streamed = await app.request("/auth/register", {
      method: "POST",
      body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(50 * MiB + 1));
        controller.close();
      } }),
    });
    expect(streamed.status).toBe(413);
  });

  test("served health OpenAPI schema includes the upload limit", async () => {
    const { db, s3, apiKey } = createTestContext();
    const app = createApp(db, s3);
    const response = await app.request("/docs/openapi.json", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(200);
    const spec = await response.json();
    const schema = spec.paths["/health"].get.responses["200"].content["application/json"].schema;
    expect(schema.properties.maxUploadBytes).toEqual({
      type: "integer",
      minimum: 1,
      description: "Maximum raw upload size in bytes",
    });
    expect(schema.required).toContain("maxUploadBytes");
  });

  test("HTTP counts streamed bytes without Content-Length at a lowered limit", async () => {
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = "4";
    const { db, s3, apiKey, orgId, driveId } = createTestContext();
    const app = createApp(db, s3);
    const path = `/orgs/${orgId}/drives/${driveId}/files/small.bin/raw`;
    for (const size of [4, 5]) {
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(size));
        controller.close();
      } });
      const result = await app.request(path, {
        method: "PUT", headers: { Authorization: `Bearer ${apiKey}` }, body,
      });
      expect(result.status).toBe(size === 4 ? 200 : 413);
    }
  });

  test("embedded raw writes enforce the configured boundary and accurate error", async () => {
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = String(1.5 * MiB);
    const { ctx } = createTestContext();
    expect((await writeRaw(ctx, { path: "/boundary.bin", bytes: new Uint8Array(1.5 * MiB) })).size).toBe(1.5 * MiB);
    await expect(writeRaw(ctx, { path: "/too-large.bin", bytes: new Uint8Array(1.5 * MiB + 1) })).rejects.toThrow("1.5MB limit");
  });

  test("unset and invalid preserve the 50 MiB raw cap", async () => {
    const { ctx, db, s3 } = createTestContext();
    for (const value of [undefined, "invalid"]) {
      if (value === undefined) delete process.env.AGENT_FS_MAX_UPLOAD_BYTES;
      else process.env.AGENT_FS_MAX_UPLOAD_BYTES = value;
      expect((await (await createApp(db, s3).request("/health")).json()).maxUploadBytes).toBe(50 * MiB);
      await expect(writeRaw(ctx, { path: "/too-large.bin", bytes: new Uint8Array(50 * MiB + 1) })).rejects.toThrow("50MB limit");
    }
  });

  test("raising raw cap preserves the JSON write 10 MiB cap", async () => {
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = String(100 * MiB);
    const { ctx } = createTestContext();
    await expect(write(ctx, { path: "/large.txt", content: "x".repeat(10 * MiB + 1) })).rejects.toThrow("10MB limit");
  });
});
