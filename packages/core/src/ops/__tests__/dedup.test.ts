import { describe, test, expect } from "bun:test";
import { eq, and } from "drizzle-orm";
import { write } from "../write.js";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";

describe("write op — content-hash dedup short-circuit", () => {
  test("identical content with matching expectedVersion → deduped, no new version", async () => {
    const { ctx, db, s3 } = createTestContext();

    // v1
    const first = await write(ctx, {
      path: "/dedup.txt",
      content: "hello world",
    });
    expect(first.version).toBe(1);
    expect(first.deduped).toBe(false);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Count rows + s3 puts before second call
    const versionsBefore = db
      .select()
      .from(schema.fileVersions)
      .where(
        and(
          eq(schema.fileVersions.path, "/dedup.txt"),
          eq(schema.fileVersions.driveId, ctx.driveId)
        )
      )
      .all();
    expect(versionsBefore.length).toBe(1);

    // Wrap s3.putObject to count calls during the dedup attempt
    let s3Puts = 0;
    const origPut = s3.putObject.bind(s3);
    (s3 as any).putObject = (...args: any[]) => {
      s3Puts += 1;
      return origPut(...(args as Parameters<typeof origPut>));
    };

    // Identical content with matching expectedVersion → dedup
    const second = await write(ctx, {
      path: "/dedup.txt",
      content: "hello world",
      expectedVersion: 1,
    });

    expect(second.deduped).toBe(true);
    expect(second.version).toBe(1); // unchanged
    expect(second.contentHash).toBe(first.contentHash);
    expect(s3Puts).toBe(0); // short-circuit hit, no S3 call

    // No new file_versions row
    const versionsAfter = db
      .select()
      .from(schema.fileVersions)
      .where(
        and(
          eq(schema.fileVersions.path, "/dedup.txt"),
          eq(schema.fileVersions.driveId, ctx.driveId)
        )
      )
      .all();
    expect(versionsAfter.length).toBe(1);
    expect(versionsAfter[0].version).toBe(1);
  });

  test("different content with matching expectedVersion → creates v2", async () => {
    const { ctx } = createTestContext();

    await write(ctx, { path: "/d2.txt", content: "v1" });
    const second = await write(ctx, {
      path: "/d2.txt",
      content: "v2",
      expectedVersion: 1,
    });

    expect(second.version).toBe(2);
    expect(second.deduped).toBe(false);
  });

  test("identical content without expectedVersion → NOT deduped (always creates new version)", async () => {
    // Without expectedVersion the caller hasn't proven they read head,
    // so we can't safely short-circuit; the write goes through normally.
    const { ctx } = createTestContext();

    await write(ctx, { path: "/d3.txt", content: "same" });
    const second = await write(ctx, { path: "/d3.txt", content: "same" });

    expect(second.version).toBe(2);
    expect(second.deduped).toBe(false);
  });
});
