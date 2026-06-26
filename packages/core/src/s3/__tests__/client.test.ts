import { describe, test, expect } from "bun:test";
import { AgentS3Client } from "../client.js";

describe("S3 Client", () => {
  test("initializes with config", () => {
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });

    expect(client).toBeDefined();
    expect(client.versioningEnabled).toBe(false);
  });

  test("initializes with versioningEnabled from config", () => {
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      versioningEnabled: true,
    });

    expect(client.versioningEnabled).toBe(true);
  });

  test("capabilities.versioning tracks the mutable versioningEnabled flag (startup reconciliation)", () => {
    // The daemon reconciles `versioningEnabled` with the bucket's real state at
    // startup (`s3.versioningEnabled = await s3.checkVersioningEnabled()`); this
    // only fixes the revert/diff gate if the `capabilities` getter reads the
    // live field rather than a value frozen at construction.
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });

    expect(client.capabilities.versioning).toBe(false);
    client.versioningEnabled = true;
    expect(client.capabilities.versioning).toBe(true);
  });

  test("getPresignedUrl uses publicEndpoint host when set", async () => {
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://internal-minio:9000",
      publicEndpoint: "https://public.s3.example.com",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });

    const url = await client.getPresignedUrl("some/key.txt", 3600);
    const parsed = new URL(url);
    expect(parsed.host).toBe("public.s3.example.com");
    expect(parsed.host).not.toBe("internal-minio:9000");
  });

  test("getPresignedUrl falls back to endpoint when publicEndpoint is not set", async () => {
    const client = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });

    const url = await client.getPresignedUrl("some/key.txt", 3600);
    const parsed = new URL(url);
    expect(parsed.host).toBe("localhost:9000");
  });
});
