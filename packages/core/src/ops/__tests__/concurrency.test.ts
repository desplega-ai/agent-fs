import { describe, test, expect } from "bun:test";
import { eq, and } from "drizzle-orm";
import { write } from "../write.js";
import { schema } from "../../db/index.js";
import { EditConflictError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";

describe("write op — concurrent writers + UNIQUE(path, drive_id, version)", () => {
  test("two concurrent writes with the same expectedVersion: exactly one wins", async () => {
    const { ctx, db } = createTestContext();

    // Seed v1 so both racers can target expectedVersion: 1.
    await write(ctx, { path: "/race.txt", content: "v1" });

    // Issue two writes concurrently. With the new UNIQUE index on
    // (path, drive_id, version), the loser hits the constraint inside
    // createVersion and surfaces as EditConflictError.
    const results = await Promise.allSettled([
      write(ctx, {
        path: "/race.txt",
        content: "racerA",
        expectedVersion: 1,
      }),
      write(ctx, {
        path: "/race.txt",
        content: "racerB",
        expectedVersion: 1,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The loser is an EditConflictError (either from the app-layer check
    // or the DB-layer UNIQUE failure mapped to the same error type).
    const loser = rejected[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(EditConflictError);

    // Exactly one new version row was created (v2). v1 is the seed.
    const versions = db
      .select()
      .from(schema.fileVersions)
      .where(
        and(
          eq(schema.fileVersions.path, "/race.txt"),
          eq(schema.fileVersions.driveId, ctx.driveId)
        )
      )
      .all();

    const versionNumbers = versions.map((v) => v.version).sort();
    expect(versionNumbers).toEqual([1, 2]);
  });

  test("UNIQUE(path, drive_id, version) blocks duplicate version inserts directly", async () => {
    // Sanity check on the schema constraint itself: two version rows
    // with the same (path, drive_id, version) must fail at the DB layer.
    const { ctx, db } = createTestContext();

    // First insert succeeds
    db.insert(schema.fileVersions)
      .values({
        path: "/unique.txt",
        driveId: ctx.driveId,
        version: 1,
        s3VersionId: "s3-a",
        author: ctx.userId,
        operation: "write",
        message: null,
        diffSummary: null,
        size: 0,
        etag: null,
        contentHash: null,
        createdAt: new Date(),
      })
      .run();

    // Second insert at same (path, drive_id, version) must throw.
    expect(() =>
      db
        .insert(schema.fileVersions)
        .values({
          path: "/unique.txt",
          driveId: ctx.driveId,
          version: 1,
          s3VersionId: "s3-b",
          author: ctx.userId,
          operation: "write",
          message: null,
          diffSummary: null,
          size: 0,
          etag: null,
          contentHash: null,
          createdAt: new Date(),
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/);
  });
});
