import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUser } from "../../identity/users.js";
import { createDrive, setDriveMember } from "../../identity/drives.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import { getS3Key } from "../versioning.js";
import { MAX_MULTIPART_UPLOAD_BYTES } from "../upload.js";

const MiB = 1024 * 1024;

async function start(ctx: ReturnType<typeof createTestContext>["ctx"], path: string, size: number) {
  return (await dispatchOp(ctx, "upload-start", { path, size })) as { uploadId: string; partSize: number; partCount: number };
}

describe("multipart upload ops", () => {
  test("start, parts, finish stores a versioned, hashed, searchable file", async () => {
    const { ctx, s3 } = createTestContext({ versioningEnabled: true });
    await dispatchOp(ctx, "write", { path: "/big.txt", content: "old needle" });
    const { uploadId, partSize, partCount } = await start(ctx, "/big.txt", 12);
    expect(partSize).toBe(32 * MiB);
    expect(partCount).toBe(1);

    const url = (await dispatchOp(ctx, "upload-part-url", { path: "/big.txt", uploadId, partNumber: 1 })) as { url: string; expiresIn: number };
    expect(url.url).toContain(`partNumber=1`);
    expect(url.expiresIn).toBe(900);

    const key = getS3Key(ctx.orgId, ctx.driveId, "/big.txt");
    s3.uploadPart(key, uploadId, 2, " haystack");
    s3.uploadPart(key, uploadId, 1, "new");
    // Before finish the old bytes still answer: nothing lands until upload-finish.
    expect((await dispatchOp(ctx, "cat", { path: "/big.txt" }) as { content: string }).content).toBe("old needle");

    const result = (await dispatchOp(ctx, "upload-finish", { path: "/big.txt", uploadId, size: 12, message: "upload" })) as any;
    expect(result).toMatchObject({ version: 2, path: "/big.txt", size: 12, deduped: false });
    expect(result.contentHash).toBe(createHash("sha256").update("new haystack").digest("hex"));
    expect((await dispatchOp(ctx, "cat", { path: "/big.txt" }) as { content: string }).content).toBe("new haystack");
    const log = (await dispatchOp(ctx, "log", { path: "/big.txt" })) as { versions: Array<{ version: number; message: string | null }> };
    expect(log.versions[0]).toMatchObject({ version: 2, message: "upload" });
    const search = async (pattern: string) => ((await dispatchOp(ctx, "fts", { pattern })) as { matches: unknown[] }).matches.length;
    expect(await search("haystack")).toBe(1);
    expect(await search("needle")).toBe(0);
  });

  test("a file over the raw upload limit is stored but not read back for search", async () => {
    const saved = process.env.AGENT_FS_MAX_UPLOAD_BYTES;
    process.env.AGENT_FS_MAX_UPLOAD_BYTES = "4";
    try {
      const { ctx, s3 } = createTestContext();
      await dispatchOp(ctx, "write", { path: "/v.txt", content: "oldtoken" });
      const { uploadId } = await start(ctx, "/v.txt", 8);
      s3.uploadPart(getS3Key(ctx.orgId, ctx.driveId, "/v.txt"), uploadId, 1, "newtoken");
      expect(await dispatchOp(ctx, "upload-finish", { path: "/v.txt", uploadId, size: 8 })).toMatchObject({ version: 2 });
      for (const pattern of ["oldtoken", "newtoken"]) {
        expect(((await dispatchOp(ctx, "fts", { pattern })) as { matches: unknown[] }).matches).toHaveLength(0);
      }
    } finally {
      if (saved === undefined) delete process.env.AGENT_FS_MAX_UPLOAD_BYTES;
      else process.env.AGENT_FS_MAX_UPLOAD_BYTES = saved;
    }
  });

  test("part size grows so a 5 GiB file stays within 10,000 parts", async () => {
    const { ctx } = createTestContext();
    const { partSize, partCount } = await start(ctx, "/huge.bin", MAX_MULTIPART_UPLOAD_BYTES);
    expect(partCount).toBeLessThanOrEqual(10_000);
    expect(partSize * partCount).toBeGreaterThanOrEqual(MAX_MULTIPART_UPLOAD_BYTES);
    await expect(start(ctx, "/huger.bin", MAX_MULTIPART_UPLOAD_BYTES + 1)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("finish refuses a missing part or a size that does not add up, and keeps the upload", async () => {
    const { ctx, s3 } = createTestContext();
    const { uploadId } = await start(ctx, "/a.bin", 6);
    const key = getS3Key(ctx.orgId, ctx.driveId, "/a.bin");
    s3.uploadPart(key, uploadId, 2, "def");
    await expect(dispatchOp(ctx, "upload-finish", { path: "/a.bin", uploadId, size: 6 })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("Part 1 is missing") });
    s3.uploadPart(key, uploadId, 1, "abc");
    await expect(dispatchOp(ctx, "upload-finish", { path: "/a.bin", uploadId, size: 7 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await dispatchOp(ctx, "upload-finish", { path: "/a.bin", uploadId, size: 6 })).toMatchObject({ version: 1, size: 6 });
  });

  test("finish honors expectedVersion before anything lands", async () => {
    const { ctx, s3 } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/c.txt", content: "v1" });
    const { uploadId } = await start(ctx, "/c.txt", 2);
    s3.uploadPart(getS3Key(ctx.orgId, ctx.driveId, "/c.txt"), uploadId, 1, "v2");
    await expect(dispatchOp(ctx, "upload-finish", { path: "/c.txt", uploadId, size: 2, expectedVersion: 0 })).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    expect((await dispatchOp(ctx, "cat", { path: "/c.txt" }) as { content: string }).content).toBe("v1");
  });

  test("an upload id is bound to its path: another path cannot finish it", async () => {
    const { ctx, s3 } = createTestContext();
    const { uploadId } = await start(ctx, "/mine.txt", 1);
    s3.uploadPart(getS3Key(ctx.orgId, ctx.driveId, "/mine.txt"), uploadId, 1, "x");
    await expect(dispatchOp(ctx, "upload-finish", { path: "/other.txt", uploadId, size: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("abort discards the upload", async () => {
    const { ctx, s3 } = createTestContext();
    const { uploadId } = await start(ctx, "/d.bin", 1);
    s3.uploadPart(getS3Key(ctx.orgId, ctx.driveId, "/d.bin"), uploadId, 1, "x");
    expect(await dispatchOp(ctx, "upload-abort", { path: "/d.bin", uploadId })).toMatchObject({ aborted: true });
    expect((s3 as any).uploads.size).toBe(0);
    await expect(dispatchOp(ctx, "upload-finish", { path: "/d.bin", uploadId, size: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("only the user who started an upload can sign, finish or abort it", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    const other = createUser(db, { email: "other-editor@example.com" }).user;
    setDriveMember(db, { driveId, userId: other.id, role: "editor" });
    const otherCtx = { ...ctx, userId: other.id };
    const { uploadId } = await start(ctx, "/owned.bin", 3);
    s3.uploadPart(getS3Key(ctx.orgId, driveId, "/owned.bin"), uploadId, 1, "abc");
    for (const [op, params] of [
      ["upload-part-url", { path: "/owned.bin", uploadId, partNumber: 1 }],
      ["upload-finish", { path: "/owned.bin", uploadId, size: 3 }],
      ["upload-abort", { path: "/owned.bin", uploadId }],
    ] as const) {
      await expect(dispatchOp(otherCtx, op, params)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    // The other editor's attempts left the upload intact for its owner.
    expect(await dispatchOp(ctx, "upload-finish", { path: "/owned.bin", uploadId, size: 3 })).toMatchObject({ version: 1, size: 3 });
  });

  test("a non-member is refused and another drive cannot see the upload", async () => {
    const { ctx, db, s3, driveId } = createTestContext();
    const outsider = createUser(db, { email: "outsider@example.com" }).user;
    const { uploadId } = await start(ctx, "/owned.bin", 3);
    s3.uploadPart(getS3Key(ctx.orgId, driveId, "/owned.bin"), uploadId, 1, "abc");
    await expect(dispatchOp({ ...ctx, userId: outsider.id }, "upload-finish", { path: "/owned.bin", uploadId, size: 3 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const second = createDrive(db, { orgId: ctx.orgId, name: "second", creatorUserId: ctx.userId });
    await expect(dispatchOp({ ...ctx, driveId: second.id }, "upload-finish", { path: "/owned.bin", uploadId, size: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("an abort sent while finish runs waits for it and leaves the committed file", async () => {
    const { ctx, s3 } = createTestContext();
    const { uploadId } = await start(ctx, "/late.bin", 3);
    s3.uploadPart(getS3Key(ctx.orgId, ctx.driveId, "/late.bin"), uploadId, 1, "abc");
    // Hold finish inside storage's complete call, as a slow 2 GB finish would be.
    const complete = s3.completeMultipartUpload.bind(s3);
    let entered!: () => void;
    const inComplete = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const spy = spyOn(s3, "completeMultipartUpload").mockImplementation(async (...args) => {
      entered();
      await released;
      return complete(...args);
    });
    const finishing = dispatchOp(ctx, "upload-finish", { path: "/late.bin", uploadId, size: 3 });
    await inComplete;
    const aborting = dispatchOp(ctx, "upload-abort", { path: "/late.bin", uploadId });
    release();
    spy.mockRestore();
    expect(await finishing).toMatchObject({ version: 1, size: 3 });
    await expect(aborting).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await dispatchOp(ctx, "cat", { path: "/late.bin" }) as { content: string }).content).toBe("abc");
  });

  test("viewers cannot start, sign or finish uploads", async () => {
    const { ctx, db, driveId } = createTestContext();
    const viewer = createUser(db, { email: "viewer@example.com" });
    setDriveMember(db, { driveId, userId: viewer.user.id, role: "viewer" });
    const viewerCtx = { ...ctx, userId: viewer.user.id };
    const { uploadId } = await start(ctx, "/e.bin", 1);
    for (const [op, params] of [
      ["upload-start", { path: "/e.bin", size: 1 }],
      ["upload-part-url", { path: "/e.bin", uploadId, partNumber: 1 }],
      ["upload-finish", { path: "/e.bin", uploadId, size: 1 }],
      ["upload-abort", { path: "/e.bin", uploadId }],
    ] as const) {
      await expect(dispatchOp(viewerCtx, op, params)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  test("the drive storage limit refuses an upload up front", async () => {
    const saved = process.env.AGENT_FS_MAX_DRIVE_BYTES;
    process.env.AGENT_FS_MAX_DRIVE_BYTES = "10";
    try {
      const { ctx } = createTestContext();
      await expect(start(ctx, "/f.bin", 11)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    } finally {
      if (saved === undefined) delete process.env.AGENT_FS_MAX_DRIVE_BYTES;
      else process.env.AGENT_FS_MAX_DRIVE_BYTES = saved;
    }
  });

  test("a backend without presigned uploads answers UNSUPPORTED_OPERATION", async () => {
    const { ctx } = createTestContext({ capabilities: { presignedUploads: false } });
    await expect(start(ctx, "/g.bin", 1)).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });
});
