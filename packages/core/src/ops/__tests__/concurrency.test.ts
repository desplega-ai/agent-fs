import { describe, test, expect } from "bun:test";
import { eq, and } from "drizzle-orm";
import { write } from "../write.js";
import { edit } from "../edit.js";
import { append } from "../append.js";
import { mv } from "../mv.js";
import { cat } from "../cat.js";
import { schema } from "../../db/index.js";
import { EditConflictError } from "../../errors.js";
import { createTestContext, MockS3Client } from "../../test-utils.js";

/** MockS3Client whose uploads take a per-content delay, like real storage. */
class SlowPutS3 extends MockS3Client {
  delays = new Map<string, number>();
  override async putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>,
    contentType?: string
  ) {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    await Bun.sleep(this.delays.get(text) ?? 1);
    return super.putObject(key, body, metadata, contentType);
  }
}

function slowContext() {
  const base = createTestContext();
  const slow = new SlowPutS3();
  return { ...base, slow, ctx: { ...base.ctx, s3: slow } };
}

function versionNumbers(db: ReturnType<typeof createTestContext>["db"], driveId: string, path: string) {
  return db
    .select()
    .from(schema.fileVersions)
    .where(and(eq(schema.fileVersions.path, path), eq(schema.fileVersions.driveId, driveId)))
    .all()
    .map((v) => v.version)
    .sort();
}

describe("concurrent mutations with slow storage", () => {
  test("write: slow first writer cannot bypass expectedVersion", async () => {
    const { ctx, db, slow } = slowContext();
    await write(ctx, { path: "/race.txt", content: "v1" });
    slow.delays.set("racerA", 30);
    slow.delays.set("racerB", 5);

    const results = await Promise.allSettled([
      write(ctx, { path: "/race.txt", content: "racerA", expectedVersion: 1 }),
      write(ctx, { path: "/race.txt", content: "racerB", expectedVersion: 1 }),
    ]);

    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(EditConflictError);
    expect(versionNumbers(db, ctx.driveId, "/race.txt")).toEqual([1, 2]);
    const winner = results[0].status === "fulfilled" ? "racerA" : "racerB";
    expect((await cat(ctx, { path: "/race.txt" })).content).toBe(winner);
  });

  test("edit: slow first editor cannot bypass expectedVersion", async () => {
    const { ctx, slow } = slowContext();
    await write(ctx, { path: "/e.txt", content: "hello" });
    slow.delays.set("A", 30);
    slow.delays.set("B", 5);

    const results = await Promise.allSettled([
      edit(ctx, { path: "/e.txt", old_string: "hello", new_string: "A", expectedVersion: 1 }),
      edit(ctx, { path: "/e.txt", old_string: "hello", new_string: "B", expectedVersion: 1 }),
    ]);

    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(EditConflictError);
  });

  test("append: concurrent appends both land", async () => {
    const { ctx, slow } = slowContext();
    await write(ctx, { path: "/log.txt", content: "base\n" });
    slow.delays.set("base\nA\n", 30);
    slow.delays.set("base\nB\n", 5);

    const results = await Promise.allSettled([
      append(ctx, { path: "/log.txt", content: "A\n" }),
      append(ctx, { path: "/log.txt", content: "B\n" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const { content } = await cat(ctx, { path: "/log.txt" });
    expect(content).toContain("base");
    expect(content).toContain("A");
    expect(content).toContain("B");
    expect(content.length).toBe(9);
  });

  test("mv in opposite directions does not deadlock", async () => {
    const { ctx } = slowContext();
    await write(ctx, { path: "/a.txt", content: "a" });
    await write(ctx, { path: "/b.txt", content: "b" });

    await Promise.allSettled([
      mv(ctx, { from: "/a.txt", to: "/b.txt" }),
      mv(ctx, { from: "/b.txt", to: "/a.txt" }),
    ]);
  });
});

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
