import { describe, expect, test } from "bun:test";
import { createTestContext } from "../../test-utils.js";
import { glob } from "../glob.js";
import { write } from "../write.js";
import { getS3Key } from "../versioning.js";
import {
  getCachedDriveListing,
  invalidateDriveGlobListings,
} from "../glob-cache.js";

const emptyListing = { objects: [], prefixes: [] };

describe("drive glob listing cache", () => {
  test("deduplicates a burst of five identical listings and reuses the result", async () => {
    const { ctx, s3 } = createTestContext();
    const listObjects = s3.listObjects.bind(s3);
    let calls = 0;
    s3.listObjects = async (...args) => {
      calls++;
      return listObjects(...args);
    };
    await write(ctx, { path: "/burst.txt", content: "burst" });

    // The former glob path called listObjects once per request.
    const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, "/");
    for (let i = 0; i < 5; i++) await s3.listObjects(s3Prefix);
    expect(calls).toBe(5);

    calls = 0;
    await Promise.all(
      Array.from({ length: 5 }, () => glob(ctx, { pattern: "**" })),
    );
    await glob(ctx, { pattern: "**" });

    // With one S3 page, the same burst now makes one ListObjectsV2 call.
    expect(calls).toBe(1);
  });

  test("expires entries after the short TTL", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    try {
      let calls = 0;
      const load = async () => {
        calls++;
        return emptyListing;
      };

      await getCachedDriveListing("org-expiry", "drive-expiry", "/", load);
      now += 3_000;
      await getCachedDriveListing("org-expiry", "drive-expiry", "/", load);

      expect(calls).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a write invalidates the drive listing cache", async () => {
    const { ctx, s3 } = createTestContext();
    const listObjects = s3.listObjects.bind(s3);
    let calls = 0;
    s3.listObjects = async (...args) => {
      calls++;
      return listObjects(...args);
    };

    await write(ctx, { path: "/before.txt", content: "before" });
    await glob(ctx, { pattern: "**" });
    await glob(ctx, { pattern: "**" });
    expect(calls).toBe(1);

    await write(ctx, { path: "/after.txt", content: "after" });
    const result = await glob(ctx, { pattern: "**" });

    expect(calls).toBe(2);
    expect(result.matches.map((match) => match.path)).toContain("/after.txt");
  });

  test("invalidation prevents an older in-flight result from repopulating cache", async () => {
    let resolveFirst!: (value: typeof emptyListing) => void;
    const first = getCachedDriveListing(
      "org-inflight",
      "drive-inflight",
      "/",
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    await Promise.resolve();

    invalidateDriveGlobListings("org-inflight", "drive-inflight");
    const freshListing = { objects: [], prefixes: ["fresh/"] };
    await getCachedDriveListing(
      "org-inflight",
      "drive-inflight",
      "/",
      async () => freshListing,
    );
    resolveFirst(emptyListing);
    await first;

    let calls = 0;
    const cached = await getCachedDriveListing(
      "org-inflight",
      "drive-inflight",
      "/",
      async () => {
        calls++;
        return emptyListing;
      },
    );

    expect(cached).toBe(freshListing);
    expect(calls).toBe(0);
  });
});
