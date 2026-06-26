import { describe, test, expect, afterEach } from "bun:test";
import { createStorageAdapter } from "../factory.js";
import { LocalStorageAdapter } from "../local-adapter.js";
import { AgentS3Client } from "../../s3/client.js";
import type { AgentFSConfig } from "../../config.js";

const S3_CFG: AgentFSConfig["s3"] = {
  provider: "minio",
  bucket: "agentfs",
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

const LOCAL_CFG: AgentFSConfig["s3"] = {
  provider: "local",
  root: "/tmp/agent-fs-factory-test",
};

describe("createStorageAdapter", () => {
  const savedOverride = process.env.AGENT_FS_CAPABILITY_OVERRIDE;

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.AGENT_FS_CAPABILITY_OVERRIDE;
    } else {
      process.env.AGENT_FS_CAPABILITY_OVERRIDE = savedOverride;
    }
  });

  test('provider "local" selects LocalStorageAdapter', () => {
    delete process.env.AGENT_FS_CAPABILITY_OVERRIDE;
    const adapter = createStorageAdapter(LOCAL_CFG);
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(adapter.capabilities).toEqual({ versioning: true, presignedUrls: false });
  });

  test('provider "minio" selects AgentS3Client', () => {
    delete process.env.AGENT_FS_CAPABILITY_OVERRIDE;
    const adapter = createStorageAdapter(S3_CFG);
    expect(adapter).toBeInstanceOf(AgentS3Client);
    expect(adapter.capabilities.presignedUrls).toBe(true);
  });

  test("custom S3-compatible provider string still selects AgentS3Client", () => {
    delete process.env.AGENT_FS_CAPABILITY_OVERRIDE;
    const adapter = createStorageAdapter({ ...S3_CFG, provider: "tigris" });
    expect(adapter).toBeInstanceOf(AgentS3Client);
  });

  test("AGENT_FS_CAPABILITY_OVERRIDE overlays advertised capabilities (test-only hook)", () => {
    process.env.AGENT_FS_CAPABILITY_OVERRIDE = JSON.stringify({ versioning: false });
    const adapter = createStorageAdapter(LOCAL_CFG);
    expect(adapter.capabilities.versioning).toBe(false);
    // Untouched capabilities are preserved.
    expect(adapter.capabilities.presignedUrls).toBe(false);
  });
});
