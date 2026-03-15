import { describe, test, expect } from "bun:test";
import { getNextVersion, createVersion } from "../versioning.js";
import { createTestContext } from "../../test-utils.js";

describe("getNextVersion", () => {
  test("returns 1 for new file", async () => {
    const { ctx } = createTestContext();
    const v = await getNextVersion(ctx, "/new-file.txt");
    expect(v).toBe(1);
  });

  test("increments for existing file", async () => {
    const { ctx } = createTestContext();

    await createVersion(ctx, {
      path: "/inc.txt",
      s3VersionId: "v1",
      operation: "write",
      size: 10,
    });

    const v = await getNextVersion(ctx, "/inc.txt");
    expect(v).toBe(2);
  });

  test("independent per path", async () => {
    const { ctx } = createTestContext();

    await createVersion(ctx, {
      path: "/a.txt",
      s3VersionId: "v1",
      operation: "write",
    });
    await createVersion(ctx, {
      path: "/a.txt",
      s3VersionId: "v2",
      operation: "edit",
    });

    expect(await getNextVersion(ctx, "/a.txt")).toBe(3);
    expect(await getNextVersion(ctx, "/b.txt")).toBe(1);
  });
});

describe("createVersion", () => {
  test("inserts version record and file metadata", async () => {
    const { ctx, db } = createTestContext();

    const version = await createVersion(ctx, {
      path: "/test.txt",
      s3VersionId: "s3v1",
      operation: "write",
      message: "initial write",
      size: 42,
    });

    expect(version).toBe(1);

    // Verify file metadata was created
    const { schema } = await import("../../db/index.js");
    const { eq, and } = await import("drizzle-orm");
    const file = db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.path, "/test.txt"),
          eq(schema.files.driveId, ctx.driveId)
        )
      )
      .get();

    expect(file).toBeDefined();
    expect(file!.size).toBe(42);
    expect(file!.author).toBe(ctx.userId);
    expect(file!.isDeleted).toBe(false);
  });

  test("upserts file metadata on subsequent versions", async () => {
    const { ctx, db } = createTestContext();

    await createVersion(ctx, {
      path: "/up.txt",
      s3VersionId: "v1",
      operation: "write",
      size: 10,
    });

    await createVersion(ctx, {
      path: "/up.txt",
      s3VersionId: "v2",
      operation: "edit",
      size: 20,
    });

    const { schema } = await import("../../db/index.js");
    const { eq, and } = await import("drizzle-orm");
    const file = db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.path, "/up.txt"),
          eq(schema.files.driveId, ctx.driveId)
        )
      )
      .get();

    expect(file!.size).toBe(20);
    expect(file!.currentVersionId).toBe("2");
  });

  test("delete operation marks file as deleted", async () => {
    const { ctx, db } = createTestContext();

    await createVersion(ctx, {
      path: "/del.txt",
      s3VersionId: "v1",
      operation: "write",
      size: 5,
    });

    await createVersion(ctx, {
      path: "/del.txt",
      s3VersionId: "v2",
      operation: "delete",
    });

    const { schema } = await import("../../db/index.js");
    const { eq, and } = await import("drizzle-orm");
    const file = db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.path, "/del.txt"),
          eq(schema.files.driveId, ctx.driveId)
        )
      )
      .get();

    expect(file!.isDeleted).toBe(true);
  });
});
