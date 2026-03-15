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
});
