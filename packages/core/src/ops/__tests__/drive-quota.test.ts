import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import { writeRaw } from "../write.js";

const KIB = new Uint8Array(1024).fill(97);
const original = process.env.AGENT_FS_MAX_DRIVE_BYTES;

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_FS_MAX_DRIVE_BYTES;
  else process.env.AGENT_FS_MAX_DRIVE_BYTES = original;
});

function storedBytes(ctx: ReturnType<typeof createTestContext>["ctx"]): number {
  const row = ctx.db
    .select({ n: sql<number>`COALESCE(SUM(${schema.fileVersions.size}), 0)` })
    .from(schema.fileVersions)
    .where(eq(schema.fileVersions.driveId, ctx.driveId))
    .get();
  return row?.n ?? 0;
}

describe("drive storage budget", () => {
  test("control: with no budget set, cp keeps working", async () => {
    delete process.env.AGENT_FS_MAX_DRIVE_BYTES;
    const { ctx } = createTestContext();
    await writeRaw(ctx, { path: "/a.bin", bytes: KIB });
    for (const to of ["/b.bin", "/c.bin", "/d.bin"]) {
      await dispatchOp(ctx, "cp", { from: "/a.bin", to });
    }
    expect(storedBytes(ctx)).toBe(4096);
  });

  test("cp past the drive budget is rejected", async () => {
    process.env.AGENT_FS_MAX_DRIVE_BYTES = "3072";
    const { ctx } = createTestContext();
    await writeRaw(ctx, { path: "/a.bin", bytes: KIB });
    await dispatchOp(ctx, "cp", { from: "/a.bin", to: "/b.bin" });
    await dispatchOp(ctx, "cp", { from: "/a.bin", to: "/c.bin" });
    expect(storedBytes(ctx)).toBe(3072);

    await expect(
      dispatchOp(ctx, "cp", { from: "/a.bin", to: "/d.bin" })
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(storedBytes(ctx)).toBe(3072);
    expect(await ctx.s3.headObject(`${ctx.orgId}/drives/${ctx.driveId}/d.bin`).catch(() => null)).toBeNull();
  });

  test("revert past the drive budget is rejected on a versioned bucket", async () => {
    process.env.AGENT_FS_MAX_DRIVE_BYTES = "3072";
    const { ctx } = createTestContext({ versioningEnabled: true });
    await writeRaw(ctx, { path: "/r.bin", bytes: KIB });
    await writeRaw(ctx, { path: "/r.bin", bytes: new Uint8Array(1024).fill(98) });
    await dispatchOp(ctx, "revert", { path: "/r.bin", version: 1 });
    expect(storedBytes(ctx)).toBe(3072);

    await expect(
      dispatchOp(ctx, "revert", { path: "/r.bin", version: 2 })
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(storedBytes(ctx)).toBe(3072);
  });
});

describe("drive storage budget: replaced bytes", () => {
  test("without versioning, overwriting or moving a file at the limit is allowed", async () => {
    process.env.AGENT_FS_MAX_DRIVE_BYTES = "2048";
    const { ctx } = createTestContext();
    await writeRaw(ctx, { path: "/a.bin", bytes: KIB });
    await writeRaw(ctx, { path: "/b.bin", bytes: KIB });

    await writeRaw(ctx, { path: "/a.bin", bytes: new Uint8Array(1024).fill(98) });
    await dispatchOp(ctx, "mv", { from: "/b.bin", to: "/c.bin" });
    await expect(
      writeRaw(ctx, { path: "/a.bin", bytes: new Uint8Array(1025) })
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});
