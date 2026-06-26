import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../local-adapter.js";
import { createTestContext } from "../../test-utils.js";
import { getS3Key } from "../../ops/versioning.js";
import { write, edit, append, log, diff, revert, signedUrl, stat } from "../../ops/index.js";
import { UnsupportedOperation, NotFoundError } from "../../errors.js";
import type { OpContext } from "../../ops/types.js";

const PATH = "/doc.txt";
const APP_URL = "http://localhost:7777";
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Proves the local-FS adapter gets the FULL versioning tier end-to-end: the
 * version-critical ops (`diff`/`revert`) return REAL historical content via the
 * content-addressed blob handles, with no native object versioning.
 */
describe("LocalStorageAdapter — op-level versioning (full tier)", () => {
  let root: string;
  let ctx: OpContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-local-ops-"));
    const base = createTestContext();
    ctx = {
      ...base.ctx,
      s3: new LocalStorageAdapter({ root }),
      appUrl: APP_URL,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("write → edit → append → log → diff(v1,v2) → revert(v1) round-trips real content", async () => {
    const w = await write(ctx, { path: PATH, content: "line1\n" });
    expect(w.version).toBe(1);

    const e = await edit(ctx, {
      path: PATH,
      old_string: "line1",
      new_string: "LINE-ONE",
    });
    expect(e.version).toBe(2);

    const a = await append(ctx, { path: PATH, content: "line2\n" });
    expect(a.version).toBe(3);

    const history = await log(ctx, { path: PATH });
    expect(history.versions.length).toBeGreaterThanOrEqual(3);

    // diff must read the two versions' actual bytes (by hash handle), not the
    // stored diffSummary fallback. v1 "line1\n" → v3 "LINE-ONE\n…line2\n".
    const d = await diff(ctx, { path: PATH, v1: 1, v2: 3 });
    expect(d.changes.length).toBeGreaterThan(0);
    expect(d.changes.some((c) => c.type === "remove" && c.content.includes("line1"))).toBe(true);
    expect(d.changes.some((c) => c.type === "add" && c.content.includes("LINE-ONE"))).toBe(true);
    expect(d.changes.some((c) => c.type === "add" && c.content.includes("line2"))).toBe(true);

    // revert reads v1's bytes by hash and writes them as the new head.
    const r = await revert(ctx, { path: PATH, version: 1 });
    expect(r.revertedTo).toBe(1);
    expect(r.version).toBe(4);

    // The current object now holds exactly the v1 content again.
    const current = await ctx.s3.getObject(getS3Key(ctx.orgId, ctx.driveId, PATH));
    expect(dec(current.body)).toBe("line1\n");
  });

  test("signed-url falls back to an app link (no presigned URL) and is marked kind:'app'", async () => {
    await write(ctx, { path: PATH, content: "hi" });

    const res = await signedUrl(ctx, { path: PATH });
    expect(res.kind).toBe("app");
    expect(res.url).toBe(`${APP_URL}/file/~/${ctx.orgId}/${ctx.driveId}/doc.txt`);
    expect(res.expiresIn).toBe(0);
    expect(res.url).not.toContain("X-Amz-Signature"); // not a presigned S3 URL
  });

  test("signed-url throws UnsupportedOperation when no appUrl is configured to fall back to", async () => {
    await write(ctx, { path: PATH, content: "hi" });
    const noAppUrlCtx: OpContext = { ...ctx, appUrl: undefined };

    await expect(signedUrl(noAppUrlCtx, { path: PATH })).rejects.toBeInstanceOf(
      UnsupportedOperation,
    );
  });

  test("stat on a missing file maps the adapter's NoSuchKey miss to NotFoundError", async () => {
    // The local adapter translates a miss to the `NoSuchKey` shape (not S3's
    // `NotFound`); stat must still surface a clean NOT_FOUND rather than letting
    // the raw error bubble as a 500.
    await expect(stat(ctx, { path: "/does-not-exist.txt" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
