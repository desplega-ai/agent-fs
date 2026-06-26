import { describe, test, expect } from "bun:test";
import type { StorageAdapter } from "../adapter.js";
import { MockS3Client } from "../../test-utils.js";
import { AgentS3Client } from "../../s3/client.js";
import { UnsupportedOperation } from "../../errors.js";

describe("StorageAdapter contract", () => {
  test("MockS3Client implements the full surface (capabilities + getPresignedUrl)", async () => {
    const mock = new MockS3Client();
    expect(mock.capabilities).toEqual({
      versioning: false,
      presignedUrls: true,
    });

    const mockVersioned = new MockS3Client({ versioningEnabled: true });
    expect(mockVersioned.capabilities).toEqual({
      versioning: true,
      presignedUrls: true,
    });

    const url = await mock.getPresignedUrl("k");
    expect(typeof url).toBe("string");
    expect(url).toContain("k");
  });

  test("MockS3Client and AgentS3Client are assignable to StorageAdapter", () => {
    // Type-level assignability check — compiles only if both fully implement the interface.
    const _mock: StorageAdapter = new MockS3Client();
    const _s3: StorageAdapter = new AgentS3Client({
      provider: "minio",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    });
    expect(_mock.capabilities.presignedUrls).toBe(true);
    expect(_s3.capabilities.presignedUrls).toBe(true);
  });
});

describe("UnsupportedOperation", () => {
  test("carries code, operation, backend, and message", () => {
    const err = new UnsupportedOperation("revert", "local");
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.operation).toBe("revert");
    expect(err.backend).toBe("local");

    const json = err.toJSON();
    expect(json.operation).toBe("revert");
    expect(json.backend).toBe("local");
    expect(json.message).toContain("revert");
    expect(json.message).toContain("local");
  });

  test("works without a backend label", () => {
    const err = new UnsupportedOperation("signed-url");
    expect(err.code).toBe("UNSUPPORTED_OPERATION");
    expect(err.operation).toBe("signed-url");
    expect(err.backend).toBeUndefined();
    expect(err.toJSON().backend).toBeUndefined();
  });
});
