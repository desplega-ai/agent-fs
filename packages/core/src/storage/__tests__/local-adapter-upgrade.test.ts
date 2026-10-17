import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

  const STAGING_SHAPED = "report.txt.0b6f3c1e-2d4a-4c5b-9e7f-1a2b3c4d5e6f.fls-tmp";

  test("a 2.0.0 key shaped like a files-sdk staging file is kept when its sidecar proves it", async () => {
    await writeV2(root, key("report.txt"), "control", "text/plain");
    await writeV2(root, key(STAGING_SHAPED), "user bytes", "text/plain");

    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([
      key("report.txt"),
      key(STAGING_SHAPED),
    ]);
    expect(dec((await adapter.getObject(key(STAGING_SHAPED))).body)).toBe("user bytes");

    await adapter.putObject(key(STAGING_SHAPED), "rewritten", undefined, "text/csv");
    const got = await adapter.getObject(key(STAGING_SHAPED));
    expect(dec(got.body)).toBe("rewritten");
    expect(got.contentType).toBe("text/csv");

    await adapter.deleteObject(key(STAGING_SHAPED));
    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([key("report.txt")]);
  });

  test("a sidecarless staging-shaped file is kept and readable but not listed, and a put adopts it", async () => {
    await writeV2(root, key("report.txt"), "control", "text/plain");
    await writeFile(join(root, key(STAGING_SHAPED)), "half-written");

    // Indistinguishable from files-sdk mid-write, so not listed, but never removed.
    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([key("report.txt")]);
    expect(dec((await adapter.getObject(key(STAGING_SHAPED))).body)).toBe("half-written");
    expect(existsSync(join(root, key(STAGING_SHAPED)))).toBe(true);

    await adapter.putObject(key(STAGING_SHAPED), "adopted", undefined, "text/plain");
    expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([
      key("report.txt"),
      key(STAGING_SHAPED),
    ]);
    expect(dec((await adapter.getObject(key(STAGING_SHAPED))).body)).toBe("adopted");
  });

  test("concurrent puts leave one writer's body, content type and etag together", async () => {
    const sha1Etag = (b: Uint8Array) =>
      `"${new Bun.CryptoHasher("sha1").update(b).digest("hex").slice(0, 16)}"`;
    // The ordinary key is the control: files-sdk commits it the same way.
    for (const name of ["race.fls-tmp", "race.txt"]) {
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          Array.from({ length: 32 }, (_, i) =>
            adapter.putObject(key(name), new Uint8Array(32768 + i).fill(i), undefined, `type/${i}`),
          ),
        );
        const got = await adapter.getObject(key(name));
        const writer = got.body.length - 32768;
        expect(got.body.every((b) => b === writer)).toBe(true);
        expect(got.contentType).toBe(`type/${writer}`);
        if (name.endsWith(".fls-tmp")) expect(got.etag).toBe(sha1Etag(got.body));
        expect((await adapter.headObject(key(name))).contentType).toBe(`type/${writer}`);
      }
    }
    // No staging file outlives its put.
    const left = (await readdir(join(root, DRIVE_PREFIX))).filter((n) => /\.[0-9a-f-]{36}\.fls-tmp$/.test(n));
    expect(left).toEqual([]);
  });

  test("a failed commit leaves no staging file behind", async () => {
    // Body rename fails: the key path is a non-empty folder.
    await mkdir(join(root, key("folder.fls-tmp/inner")), { recursive: true });
    await expect(adapter.putObject(key("folder.fls-tmp"), "x")).rejects.toThrow();
    // Sidecar rename fails: the sidecar path is a non-empty folder.
    await mkdir(join(root, key("side.fls-tmp.meta.json/inner")), { recursive: true });
    await expect(adapter.putObject(key("side.fls-tmp"), "next")).rejects.toThrow();

    const names = await readdir(join(root, DRIVE_PREFIX));
    expect(names.filter((n) => /\.[0-9a-f-]{36}\.fls-tmp$/.test(n))).toEqual([]);
    expect(existsSync(join(root, key("folder.fls-tmp/inner")))).toBe(true);
  });

  test("a refused put writes nothing, not even the history blob", async () => {
    const outside = await mkdtemp(join(tmpdir(), "afs-local-upgrade-outside-"));
    try {
      await mkdir(join(root, DRIVE_PREFIX), { recursive: true });
      await symlink(outside, join(root, key("escape")));
      await expect(adapter.putObject(key("escape/x.fls-tmp"), "payload")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(existsSync(join(root, "_afs-blobs"))).toBe(false);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a root that does not exist yet takes a first reserved write, ordinary key as control", async () => {
    const first = new LocalStorageAdapter({ root: join(root, "not-yet") });
    await first.putObject(key("first.fls-tmp"), "payload");
    expect(dec((await first.getObject(key("first.fls-tmp"))).body)).toBe("payload");

    const control = new LocalStorageAdapter({ root: join(root, "control") });
    await control.putObject(key("first.txt"), "payload");
    expect(dec((await control.getObject(key("first.txt"))).body)).toBe("payload");
  });

  test("a root that does not exist yet reads, deletes and lists as empty, and still refuses an escape", async () => {
    const fresh = join(root, "not-yet");
    const missing = new LocalStorageAdapter({ root: fresh });
    await expect(missing.getObject(key("first.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(missing.headObject(key("first.fls-tmp"))).rejects.toMatchObject({ name: "NoSuchKey" });
    await missing.deleteObject(key("first.fls-tmp"));
    expect(await missing.listObjects(DRIVE_PREFIX)).toEqual({ objects: [], prefixes: [] });
    await expect(missing.putObject(key("../../../../x.fls-tmp"), "payload")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(existsSync(fresh)).toBe(false);
  });

  test("a prefix through a symlink lists nothing from behind it, ancestors included", async () => {
    const outside = await mkdtemp(join(tmpdir(), "afs-local-upgrade-outside-"));
    try {
      await writeV2(outside, "secret.fls-tmp", "secret", "text/plain");
      await writeV2(outside, "sub/deeper.fls-tmp", "secret", "text/plain");
      await writeV2(outside, "plain.txt", "secret", "text/plain");
      await writeV2(root, key("report.txt"), "control", "text/plain");
      await symlink(outside, join(root, key("link")));

      for (const p of ["link/", "link/s", "link/sub/", "link/secret"]) {
        expect(await adapter.listObjects(key(p))).toEqual({ objects: [], prefixes: [] });
        expect(await adapter.listObjects(key(p), { delimiter: "/" })).toEqual({ objects: [], prefixes: [] });
      }
      // The whole drive's listing is the control: the symlink is skipped there too.
      expect((await adapter.listObjects(DRIVE_PREFIX)).objects.map((o) => o.key)).toEqual([key("report.txt")]);

      // The drive folder itself behind a symlink: nothing under it lists either.
      const other = await mkdtemp(join(tmpdir(), "afs-local-upgrade-root-"));
      try {
        await mkdir(join(other, "org1/drives"), { recursive: true });
        await symlink(outside, join(other, "org1/drives/drive1"));
        const viaAncestor = new LocalStorageAdapter({ root: other });
        expect((await viaAncestor.listObjects(DRIVE_PREFIX)).objects).toEqual([]);
        expect((await viaAncestor.listObjects(key("sub/"))).objects).toEqual([]);
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
