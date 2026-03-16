import { describe, test, expect, beforeAll } from "bun:test";
import { isMinioAvailable } from "../../test-utils.js";
import { AgentS3Client } from "../client.js";

const SKIP = !(await isMinioAvailable());
const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_BUCKET = "agentfs";

describe.skipIf(SKIP)("S3 Integration (MinIO)", () => {
  let s3: AgentS3Client;

  beforeAll(() => {
    s3 = new AgentS3Client({
      provider: "minio",
      bucket: MINIO_BUCKET,
      region: "us-east-1",
      endpoint: MINIO_ENDPOINT,
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });
  });

  test("putObject + getObject roundtrip", async () => {
    const key = `test/roundtrip-${Date.now()}.txt`;
    const content = "Hello from agent-fs integration test!";

    const putResult = await s3.putObject(key, content);
    expect(putResult.etag).toBeTruthy();

    const getResult = await s3.getObject(key);
    const body = new TextDecoder().decode(getResult.body);
    expect(body).toBe(content);

    // Cleanup
    await s3.deleteObject(key);
  });

  test("putObject with metadata", async () => {
    const key = `test/metadata-${Date.now()}.txt`;
    await s3.putObject(key, "content", { "x-agent-fs-author": "test-user" });

    const head = await s3.headObject(key);
    expect(head.size).toBe(7);

    await s3.deleteObject(key);
  });

  test("listObjects returns matching keys", async () => {
    const prefix = `test/list-${Date.now()}/`;
    await s3.putObject(`${prefix}a.txt`, "a");
    await s3.putObject(`${prefix}b.txt`, "b");
    await s3.putObject(`${prefix}c.txt`, "c");

    const { objects } = await s3.listObjects(prefix);
    expect(objects.length).toBe(3);
    const keys = objects.map((o) => o.key);
    expect(keys).toContain(`${prefix}a.txt`);
    expect(keys).toContain(`${prefix}b.txt`);
    expect(keys).toContain(`${prefix}c.txt`);

    // Cleanup
    for (const k of keys) await s3.deleteObject(k);
  });

  test("copyObject copies content", async () => {
    const srcKey = `test/copy-src-${Date.now()}.txt`;
    const dstKey = `test/copy-dst-${Date.now()}.txt`;
    await s3.putObject(srcKey, "copy me");

    await s3.copyObject(srcKey, dstKey);

    const result = await s3.getObject(dstKey);
    expect(new TextDecoder().decode(result.body)).toBe("copy me");

    await s3.deleteObject(srcKey);
    await s3.deleteObject(dstKey);
  });

  test("headObject returns size and content type", async () => {
    const key = `test/head-${Date.now()}.txt`;
    await s3.putObject(key, "hello world");

    const head = await s3.headObject(key);
    expect(head.size).toBe(11);

    await s3.deleteObject(key);
  });

  test("deleteObject removes the object", async () => {
    const key = `test/delete-${Date.now()}.txt`;
    await s3.putObject(key, "delete me");

    await s3.deleteObject(key);

    const { objects } = await s3.listObjects(key);
    expect(objects.length).toBe(0);
  });

  test("checkVersioningEnabled returns false by default", async () => {
    const enabled = await s3.checkVersioningEnabled();
    // MinIO bucket starts without versioning
    expect(typeof enabled).toBe("boolean");
  });

  test("enableVersioning enables versioning on bucket", async () => {
    const result = await s3.enableVersioning();
    expect(result).toBe(true);
    expect(s3.versioningEnabled).toBe(true);

    const check = await s3.checkVersioningEnabled();
    expect(check).toBe(true);
  });

  test("listObjectVersions returns version history", async () => {
    // Versioning should be enabled from previous test
    const key = `test/versions-${Date.now()}.txt`;
    await s3.putObject(key, "version 1");
    await s3.putObject(key, "version 2");

    const versions = await s3.listObjectVersions(key);
    expect(versions.length).toBe(2);
    expect(versions.some((v) => v.isLatest)).toBe(true);

    await s3.deleteObject(key);
  });
});
