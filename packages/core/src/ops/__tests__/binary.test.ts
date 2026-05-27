import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTestContext } from "../../test-utils.js";
import { getS3Key } from "../versioning.js";
import { cat } from "../cat.js";
import { fts } from "../fts.js";
import { write, writeRaw } from "../write.js";

describe("binary-safe writes", () => {
  test("writeRaw stores bytes unchanged and hashes the original bytes", async () => {
    const { ctx } = createTestContext();
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
    ]);

    const result = await writeRaw(ctx, { path: "/image.png", bytes });
    expect(result.size).toBe(bytes.byteLength);
    expect(result.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));

    const object = await ctx.s3.getObject(getS3Key(ctx.orgId, ctx.driveId, "/image.png"));
    expect(Array.from(object.body)).toEqual(Array.from(bytes));
    expect(object.contentType).toBe("image/png");
  });

  test("raw binary overwrite clears stale text search data", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/asset.bin", content: "uniqueoldtoken searchable text" });

    const before = await fts(ctx, { pattern: "uniqueoldtoken" });
    expect(before.matches).toHaveLength(1);

    await writeRaw(ctx, {
      path: "/asset.bin",
      bytes: new Uint8Array([0x00, 0xff, 0xfe, 0xfd]),
    });

    const after = await fts(ctx, { pattern: "uniqueoldtoken" });
    expect(after.matches).toHaveLength(0);
    await expect(cat(ctx, { path: "/asset.bin" })).rejects.toThrow(
      /not readable as text/
    );
  });

  test("writeRaw keeps valid text searchable", async () => {
    const { ctx } = createTestContext();
    await writeRaw(ctx, {
      path: "/notes.md",
      bytes: new TextEncoder().encode("rawtexttoken remains searchable"),
    });

    const result = await fts(ctx, { pattern: "rawtexttoken" });
    expect(result.matches.map((m) => m.path)).toContain("/notes.md");
    const text = await cat(ctx, { path: "/notes.md" });
    expect(text.content).toBe("rawtexttoken remains searchable");
  });
});
