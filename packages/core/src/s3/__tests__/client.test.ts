import { describe, test, expect } from "bun:test";
import {
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { glob } from "../../ops/glob.js";
import { ls } from "../../ops/ls.js";
import { tree } from "../../ops/tree.js";
import { getS3Key } from "../../ops/versioning.js";
import { createTestContext } from "../../test-utils.js";
import { AgentS3Client } from "../client.js";

type ListObjectsV2Response = Omit<ListObjectsV2CommandOutput, "$metadata">;

function createClient() {
  return new AgentS3Client({
    provider: "minio",
    bucket: "test-bucket",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  });
}

function mockListResponses(responses: Array<ListObjectsV2Response | Error>) {
  const client = createClient();
  const requests: ListObjectsV2Command[] = [];
  const mock = {
    send(command: ListObjectsV2Command) {
      requests.push(command);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected ListObjectsV2 request");
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    },
  };
  (client as unknown as { client: typeof mock }).client = mock;
  return { client, requests };
}

describe("S3 Client", () => {
  test("initializes with config", () => {
    const client = createClient();

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

  test("lists every page and preserves the request fields", async () => {
    const { client, requests } = mockListResponses([
      {
        Contents: [{ Key: "docs/first.txt", Size: 1 }],
        CommonPrefixes: [{ Prefix: "docs/a/" }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      },
      {
        Contents: [{ Key: "docs/later.txt", Size: 2 }],
        CommonPrefixes: [{ Prefix: "docs/a/" }, { Prefix: "docs/b/" }],
        IsTruncated: false,
      },
    ]);

    const result = await client.listObjects("docs/", { delimiter: "/" });

    expect(result.objects.map((object) => object.key)).toEqual([
      "docs/first.txt",
      "docs/later.txt",
    ]);
    expect(result.prefixes).toEqual(["docs/a/", "docs/b/"]);
    expect(requests.map((request) => request.input)).toEqual([
      { Bucket: "test-bucket", Prefix: "docs/", Delimiter: "/" },
      {
        Bucket: "test-bucket",
        Prefix: "docs/",
        Delimiter: "/",
        ContinuationToken: "next-page",
      },
    ]);
  });

  test("accepts delimiter-only and empty final pages", async () => {
    const { client } = mockListResponses([
      {
        CommonPrefixes: [{ Prefix: "docs/a/" }],
        IsTruncated: true,
        NextContinuationToken: "last-page",
      },
      { IsTruncated: false },
    ]);

    await expect(client.listObjects("docs/", { delimiter: "/" })).resolves.toEqual({
      objects: [],
      prefixes: ["docs/a/"],
    });
  });

  test("rejects a later-page failure instead of returning a partial listing", async () => {
    const { client } = mockListResponses([
      {
        Contents: [{ Key: "docs/first.txt", Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      },
      new Error("S3 unavailable"),
    ]);

    await expect(client.listObjects("docs/")).rejects.toThrow("S3 unavailable");
  });

  test("rejects truncated pages without a usable continuation token", async () => {
    const { client } = mockListResponses([{ IsTruncated: true }]);

    await expect(client.listObjects("docs/")).rejects.toThrow("without a continuation token");
  });

  test("rejects repeating continuation tokens", async () => {
    const { client } = mockListResponses([
      { IsTruncated: true, NextContinuationToken: "same-token" },
      { IsTruncated: true, NextContinuationToken: "same-token" },
    ]);

    await expect(client.listObjects("docs/")).rejects.toThrow("repeating continuation token");
  });

  test("glob and tree include an object from a later page", async () => {
    const { ctx } = createTestContext();
    const prefix = getS3Key(ctx.orgId, ctx.driveId, "/");

    const globClient = mockListResponses([
      { Contents: [{ Key: `${prefix}first.txt`, Size: 1 }], IsTruncated: true, NextContinuationToken: "next" },
      { Contents: [{ Key: `${prefix}later.txt`, Size: 2 }], IsTruncated: false },
    ]).client;
    ctx.s3 = globClient;
    await expect(glob(ctx, { pattern: "later.txt" })).resolves.toEqual({
      matches: [{ path: "/later.txt", size: 2, modifiedAt: expect.any(Date) }],
    });

    const treeClient = mockListResponses([
      { Contents: [{ Key: `${prefix}first.txt`, Size: 1 }], IsTruncated: true, NextContinuationToken: "next" },
      { Contents: [{ Key: `${prefix}later.txt`, Size: 2 }], IsTruncated: false },
    ]).client;
    ctx.s3 = treeClient;
    await expect(tree(ctx, {})).resolves.toEqual({
      tree: [
        { name: "first.txt", type: "file", size: 1, modifiedAt: expect.any(Date) },
        { name: "later.txt", type: "file", size: 2, modifiedAt: expect.any(Date) },
      ],
    });
  });

  test("ls includes prefixes returned on a later delimiter page", async () => {
    const { ctx } = createTestContext();
    const prefix = getS3Key(ctx.orgId, ctx.driveId, "/");
    ctx.s3 = mockListResponses([
      { CommonPrefixes: [{ Prefix: `${prefix}first/` }], IsTruncated: true, NextContinuationToken: "next" },
      { CommonPrefixes: [{ Prefix: `${prefix}later/` }], IsTruncated: false },
    ]).client;

    await expect(ls(ctx, {})).resolves.toEqual({
      entries: [
        { name: "first", type: "directory", size: 0 },
        { name: "later", type: "directory", size: 0 },
      ],
    });
  });
});
