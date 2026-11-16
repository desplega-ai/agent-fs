import { describe, expect, test } from "bun:test";
import { AgentS3Client, isStorageUnavailable } from "../client.js";
import { StorageUnavailableError } from "../../errors.js";

function client(endpoint = "http://127.0.0.1:9") {
  return new AgentS3Client({
    provider: "minio",
    bucket: "b",
    region: "us-east-1",
    endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
  });
}

describe("storage failures", () => {
  test("classifies network errors and 5xx as unavailable, S3 4xx answers as not", () => {
    expect(isStorageUnavailable(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isStorageUnavailable(new Error("socket hang up"))).toBe(true);
    expect(isStorageUnavailable({ name: "TimeoutError" })).toBe(true);
    expect(isStorageUnavailable({ name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isStorageUnavailable({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isStorageUnavailable({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isStorageUnavailable(new TypeError("x is undefined"))).toBe(false);
  });

  test("a refused connection fails fast with StorageUnavailableError", async () => {
    const started = Date.now();
    const err = await client().putObject("o/drives/d/a.txt", "x").catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.toJSON()).toMatchObject({ error: "STORAGE_UNAVAILABLE", retryable: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a store that never answers fails at the deadline, not after the socket timeouts", async () => {
    // Accepts connections and never answers, like a partition.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const c = client(`http://127.0.0.1:${silent.port}`);
      (c as unknown as { deadlineMs: number }).deadlineMs = 300;
      const started = Date.now();
      const err = await c.getObject("o/drives/d/a.txt").catch((e) => e);
      expect(err).toBeInstanceOf(StorageUnavailableError);
      expect(err.message).toContain("did not answer");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      silent.stop(true);
    }
  });

  test("a 404 from storage passes through unchanged", async () => {
    const s3 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    try {
      const err = await client(`http://127.0.0.1:${s3.port}`).headObject("o/drives/d/a.txt").catch((e) => e);
      expect(err).not.toBeInstanceOf(StorageUnavailableError);
      expect(err.$metadata?.httpStatusCode).toBe(404);
    } finally {
      s3.stop(true);
    }
  });
});
