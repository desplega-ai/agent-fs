import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Files } from "files-sdk";
import { fs } from "files-sdk/fs";
import { LocalStorageAdapter } from "../local-adapter.js";

/**
 * A root written by files-sdk 2.0.0 must stay readable after the bump to 3.x.
 *
 * 2.0.0 accepted keys ending in `.fls-tmp`; 2.3.0 reserved that suffix for its
 * upload staging, so 3.x refuses those keys and hides them from `list`.
 */

const DRIVE_PREFIX = "org1/drives/drive1/";
const key = (p: string) => DRIVE_PREFIX + p;
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Write `key` exactly as files-sdk 2.0.0's fs adapter did: the body at the key
 * path plus a `<key>.meta.json` sidecar. Captured from a real 2.0.0 upload:
 * `{"contentType":"text/plain","etag":"\"c22b5f9178342609\"","lastModified":…}`.
 */
async function writeV2(root: string, k: string, body: string, contentType: string) {
  const bodyPath = join(root, k);
  await mkdir(dirname(bodyPath), { recursive: true });
  await writeFile(bodyPath, body);
  await writeFile(
    bodyPath + ".meta.json",
    JSON.stringify({ contentType, etag: `"v2-${body.length}"`, lastModified: 1_700_000_000_000 }),
  );
}

describe("LocalStorageAdapter: files-sdk 2.0.0 root after the 3.x upgrade", () => {
  let root: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-local-upgrade-"));
    adapter = new LocalStorageAdapter({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Every 2.0.0-valid name files-sdk 3 refuses: its check is case-insensitive
  // and ignores trailing dots and spaces.
  const reserved = ["report.fls-tmp", "R.FLS-TMP", "dots.fls-tmp.", "nested/only.fls-tmp"];

  test("files-sdk 3 itself refuses the keys (premise of this suite)", async () => {
    await writeV2(root, key("report.txt"), "control", "text/plain");
    await writeV2(root, key("report.fls-tmp"), "legacy", "text/plain");
    const sdk = new Files({ adapter: fs({ root }) });
    expect((await sdk.head(key("report.txt"))).size).toBe(7);
    await expect(sdk.head(key("report.fls-tmp"))).rejects.toMatchObject({ code: "Invalid" });
    const listed = (await sdk.list({ prefix: DRIVE_PREFIX })).items.map((i) => i.key);
    expect(listed).toEqual([key("report.txt")]);
  });

  test("read, head and list still return every pre-upgrade key, ordinary key as control", async () => {
    await writeV2(root, key("report.txt"), "control", "text/plain");
    for (const name of reserved) await writeV2(root, key(name), `bytes of ${name}`, "text/markdown");

    const control = await adapter.getObject(key("report.txt"));
    expect(dec(control.body)).toBe("control");
    expect((await adapter.headObject(key("report.txt"))).size).toBe(7);

    for (const name of reserved) {
      const got = await adapter.getObject(key(name));
      expect(dec(got.body)).toBe(`bytes of ${name}`);
      expect(got.contentType).toBe("text/markdown");
      expect(got.etag).toBe(`"v2-${`bytes of ${name}`.length}"`);

      const head = await adapter.headObject(key(name));
      expect(head.size).toBe(`bytes of ${name}`.length);
      expect(head.contentType).toBe("text/markdown");
      expect(head.lastModified?.getTime()).toBe(1_700_000_000_000);
    }

    const all = await adapter.listObjects(DRIVE_PREFIX);
    expect(all.objects.map((o) => o.key)).toEqual(
      ["R.FLS-TMP", "dots.fls-tmp.", "nested/only.fls-tmp", "report.fls-tmp", "report.txt"].map(key),
    );
    expect(all.objects.find((o) => o.key === key("report.fls-tmp"))?.size).toBe(
      "bytes of report.fls-tmp".length,
    );

    // A folder holding only a reserved name still shows up as a prefix.
    const level = await adapter.listObjects(DRIVE_PREFIX, { delimiter: "/" });
    expect(level.prefixes).toEqual([key("nested/")]);
    expect(level.objects.map((o) => o.key)).toEqual(
      ["R.FLS-TMP", "dots.fls-tmp.", "report.fls-tmp", "report.txt"].map(key),
    );
    expect((await adapter.listObjects(key("nested/"), { delimiter: "/" })).objects.map((o) => o.key)).toEqual([
      key("nested/only.fls-tmp"),
    ]);
  });

  test("a pre-upgrade key without a sidecar reads as octet-stream", async () => {
    await mkdir(join(root, DRIVE_PREFIX), { recursive: true });
    await writeFile(join(root, key("bare.fls-tmp")), "bare");
    const got = await adapter.getObject(key("bare.fls-tmp"));
    expect(dec(got.body)).toBe("bare");
    expect(got.contentType).toBe("application/octet-stream");
  });

  test("missing reserved key and reserved-named folder answer NoSuchKey", async () => {
    await expect(adapter.getObject(key("missing.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(adapter.headObject(key("missing.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    await mkdir(join(root, key("dir.fls-tmp")), { recursive: true });
    await expect(adapter.headObject(key("dir.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    await adapter.deleteObject(key("dir.fls-tmp")); // no-op, not a crash
    expect(existsSync(join(root, key("dir.fls-tmp")))).toBe(true);
  });

  test("overwrite, copy and delete keep working on a reserved key", async () => {
    await writeV2(root, key("report.fls-tmp"), "old", "text/plain");

    const put = await adapter.putObject(key("report.fls-tmp"), "new bytes", undefined, "text/csv");
    const got = await adapter.getObject(key("report.fls-tmp"));
    expect(dec(got.body)).toBe("new bytes");
    expect(got.contentType).toBe("text/csv");
    // The version blob is written as for any key, so history still resolves.
    expect(dec((await adapter.getObject(key("report.fls-tmp"), put.versionId)).body)).toBe("new bytes");

    await adapter.copyObject(key("report.fls-tmp"), key("copy.fls-tmp"));
    expect(dec((await adapter.getObject(key("copy.fls-tmp"))).body)).toBe("new bytes");
    await adapter.copyObject(key("report.fls-tmp"), key("plain.txt"));
    expect(dec((await adapter.getObject(key("plain.txt"))).body)).toBe("new bytes");

    await adapter.deleteObject(key("report.fls-tmp"));
    await expect(adapter.headObject(key("report.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    expect(existsSync(join(root, key("report.fls-tmp.meta.json")))).toBe(false);
    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual(
      [key("copy.fls-tmp"), key("plain.txt")],
    );
  });

  test("files-sdk's own staging files never surface, and cannot be written as keys", async () => {
    await writeV2(root, key("report.txt"), "control", "text/plain");
    const staging = "report.txt.0b6f3c1e-2d4a-4c5b-9e7f-1a2b3c4d5e6f.fls-tmp";
    await writeFile(join(root, key(staging)), "half-written");
    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([key("report.txt")]);
    await expect(adapter.putObject(key(staging), "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("a reserved-named symlink cannot read outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "afs-local-upgrade-outside-"));
    try {
      await writeFile(join(outside, "secret"), "secret");
      await mkdir(join(root, DRIVE_PREFIX), { recursive: true });
      await symlink(join(outside, "secret"), join(root, key("link.fls-tmp")));
      await expect(adapter.getObject(key("link.fls-tmp"))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      await expect(adapter.headObject(key("link.fls-tmp"))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect((await adapter.listObjects(DRIVE_PREFIX)).objects).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
