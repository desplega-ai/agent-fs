import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../local-adapter.js";
import { UnsupportedOperation } from "../../errors.js";

const DRIVE_PREFIX = "org1/drives/drive1/";
const key = (p: string) => DRIVE_PREFIX + p;
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("LocalStorageAdapter", () => {
  let root: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-local-adapter-"));
    adapter = new LocalStorageAdapter({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("advertises full-versioning / no-presign capabilities", () => {
    expect(adapter.versioningEnabled).toBe(true);
    expect(adapter.capabilities).toEqual({
      versioning: true,
      presignedUrls: false,
    });
  });

  test("put → get round-trip returns identical bytes + a hash version handle", async () => {
    const put = await adapter.putObject(key("a.txt"), "hello world", undefined, "text/plain");
    expect(put.versionId).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
    expect(put.etag).toBe(put.versionId);

    const got = await adapter.getObject(key("a.txt"));
    expect(dec(got.body)).toBe("hello world");
    expect(got.size).toBe(11);
  });

  test("head returns size; head on a missing key throws name === 'NoSuchKey'", async () => {
    await adapter.putObject(key("h.txt"), "12345");
    const head = await adapter.headObject(key("h.txt"));
    expect(head.size).toBe(5);

    await expect(adapter.headObject(key("missing.txt"))).rejects.toMatchObject({
      name: "NoSuchKey",
    });
  });

  test("getObject on a missing key throws name === 'NoSuchKey'", async () => {
    await expect(adapter.getObject(key("nope.txt"))).rejects.toMatchObject({
      name: "NoSuchKey",
    });
  });

  test("delete removes the plain key but leaves version blobs intact", async () => {
    const put = await adapter.putObject(key("d.txt"), "to-delete");
    await adapter.deleteObject(key("d.txt"));

    // Plain key gone…
    await expect(adapter.getObject(key("d.txt"))).rejects.toMatchObject({
      name: "NoSuchKey",
    });
    // …but the historical blob is still retrievable by handle.
    const blob = await adapter.getObject(key("d.txt"), put.versionId);
    expect(dec(blob.body)).toBe("to-delete");

    // Deleting a missing key is a no-op (does not throw).
    await adapter.deleteObject(key("d.txt"));
  });

  test("copy materializes destination bytes", async () => {
    await adapter.putObject(key("src.txt"), "copy me");
    const res = await adapter.copyObject(key("src.txt"), key("dst.txt"));
    expect(res.versionId).toMatch(/^[0-9a-f]{64}$/);

    const got = await adapter.getObject(key("dst.txt"));
    expect(dec(got.body)).toBe("copy me");
  });

  test("version round-trip: getObject(key) is latest; getObject(key, oldHash) is the older bytes", async () => {
    const v1 = await adapter.putObject(key("ver.txt"), "version one");
    const v2 = await adapter.putObject(key("ver.txt"), "version two");
    expect(v1.versionId).not.toBe(v2.versionId);

    // Current key resolves to the latest write.
    expect(dec((await adapter.getObject(key("ver.txt"))).body)).toBe("version two");
    // Old content retrievable by its hash handle.
    expect(dec((await adapter.getObject(key("ver.txt"), v1.versionId!)).body)).toBe("version one");
    expect(dec((await adapter.getObject(key("ver.txt"), v2.versionId!)).body)).toBe("version two");
  });

  test("identical content across keys dedups to a single content-addressed blob", async () => {
    await adapter.putObject(key("dup-a.txt"), "same bytes");
    await adapter.putObject(key("dup-b.txt"), "same bytes");

    const blobDir = join(root, "_afs-blobs", "sha256");
    expect(existsSync(blobDir)).toBe(true);
    // The fs adapter writes a `<key>.meta.json` sidecar per object; count only
    // the actual content blobs. Identical content → one content-addressed blob.
    const blobs = readdirSync(blobDir).filter((f) => !f.endsWith(".meta.json"));
    expect(blobs.length).toBe(1);
  });

  test("listObjects(prefix, {delimiter}) returns files in objects, subdirs in prefixes, and NEVER surfaces _afs-blobs", async () => {
    await adapter.putObject(key("top.txt"), "t");
    await adapter.putObject(key("sub/nested.txt"), "n");

    const { objects, prefixes } = await adapter.listObjects(DRIVE_PREFIX, {
      delimiter: "/",
    });

    const objectKeys = objects.map((o) => o.key);
    expect(objectKeys).toContain(key("top.txt"));
    // Nested file is folded into the common prefix, not listed directly.
    expect(objectKeys).not.toContain(key("sub/nested.txt"));
    expect(prefixes).toContain(key("sub/"));

    // The reserved blob prefix is a top-level sibling of the drive prefix and
    // must never appear under a drive-scoped listing.
    const allKeys = [...objectKeys, ...prefixes].join("\n");
    expect(allKeys).not.toContain("_afs-blobs");
  });

  test("getPresignedUrl throws UnsupportedOperation (defensive — op gate should fall back first)", async () => {
    await expect(adapter.getPresignedUrl()).rejects.toBeInstanceOf(UnsupportedOperation);
  });

  test("listObjectVersions returns [] (versioning is content-addressed, not native)", async () => {
    await adapter.putObject(key("lv.txt"), "x");
    expect(await adapter.listObjectVersions(key("lv.txt"))).toEqual([]);
  });
});
