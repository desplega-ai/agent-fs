import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalStorageAdapter } from "../local-adapter.js";

const prefix = "org/drives/drive/";
const staging = "file.txt.0b6f3c1e-2d4a-4c5b-9e7f-1a2b3c4d5e6f.fls-tmp";

describe("bounded local listing", () => {
  let root: string;
  let adapter: LocalStorageAdapter;
  beforeEach(async () => {
    root = await filesystem.mkdtemp(join(tmpdir(), "afs-remaining-list-"));
    adapter = new LocalStorageAdapter({ root });
  });
  afterEach(async () => filesystem.rm(root, { recursive: true, force: true }));

  async function stored(key: string) {
    await filesystem.mkdir(dirname(join(root, key)), { recursive: true });
    await filesystem.writeFile(join(root, key), "data");
  }

  test("a delimiter reads one visible descendant and never enters another drive", async () => {
    await stored(prefix + "direct.txt");
    await stored(prefix + "nested/a.fls-tmp");
    for (let i = 0; i < 40; i++) {
      await stored(prefix + `nested/deep/${i}/file.txt`);
      await stored(`other/drives/other/${i}/secret.fls-tmp`);
    }
    const read = spyOn(filesystem, "readdir");
    try {
      const result = await adapter.listObjects(prefix, { delimiter: "/" });
      expect(result.objects.map(({ key }) => key)).toEqual([prefix + "direct.txt"]);
      expect(result.prefixes).toEqual([prefix + "nested/"]);
      expect(read.mock.calls.map(([path]) => String(path))).toEqual([
        resolve(root, prefix), join(root, prefix, "nested"),
      ]);
    } finally {
      read.mockRestore();
    }
  });

  test("maxKeys stops the walk after the first stored legacy file", async () => {
    await stored(prefix + "a.fls-tmp");
    await stored(prefix + "deep/nested/file.txt");
    const read = spyOn(filesystem, "readdir");
    const sidecar = spyOn(filesystem, "readFile");
    try {
      expect((await adapter.listObjects(prefix, { maxKeys: 1 })).objects.map(({ key }) => key)).toEqual([prefix + "a.fls-tmp"]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(sidecar).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
      sidecar.mockRestore();
    }
  });

  test("a capped delimiter listing gives objects priority without reading grouped descendants", async () => {
    await stored(prefix + "a/deep/file.fls-tmp");
    await stored(prefix + "z.txt");
    const read = spyOn(filesystem, "readdir");
    try {
      expect(await adapter.listObjects(prefix, { delimiter: "/", maxKeys: 1 })).toMatchObject({
        objects: [{ key: prefix + "z.txt" }], prefixes: [],
      });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test("depth limits prune both narrow and wide local trees", async () => {
    await stored(prefix + "direct.txt");
    for (let i = 0; i < 80; i++) await stored(prefix + `folder-${i}/deep/file.fls-tmp`);
    const read = spyOn(filesystem, "readdir");
    try {
      expect((await adapter.listObjects(prefix, { maxDepth: 1 })).objects.map(({ key }) => key)).toEqual([prefix + "direct.txt"]);
      expect(read).toHaveBeenCalledTimes(1);
      read.mockClear();
      expect((await adapter.listObjects(prefix, { maxDepth: 2 })).objects.map(({ key }) => key)).toEqual([prefix + "direct.txt"]);
      expect(read).toHaveBeenCalledTimes(81);
      expect(read.mock.calls.some(([path]) => String(path).endsWith("/deep"))).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test("keeps ordering, partial prefixes, custom delimiters, and legacy staging rules", async () => {
    const keys = ["a.txt", "a.fls-tmp", "a-b/c.txt", "a/b.fls-tmp", "a/z/leaf", "m.FLS-TMP", "noise.fls-tmp.", "UPPER.META.JSON", "partial.FLS-PART", "no_extension", "no_suffix/x", `stored/${staging}`];
    for (const key of keys) await stored(prefix + key);
    await filesystem.writeFile(join(root, prefix, `stored/${staging}.meta.json`), JSON.stringify({ contentType: "text/plain", etag: "legacy", lastModified: 1000 }));
    for (const hidden of [`staging/${staging}`, "hidden.meta.json", "partial.fls-part"]) await stored(prefix + hidden);
    await filesystem.mkdir(join(root, prefix, "empty"));

    for (const suffix of ["", "a", "a/", "no_"]) {
      for (const delimiter of [undefined, "/", ".", "_"]) {
        for (const maxKeys of [undefined, 0, 1, 3]) {
          const scoped = prefix + suffix;
          const objects: string[] = [];
          const prefixes = new Set<string>();
          for (const key of keys.map((key) => prefix + key).sort()) {
            if (!key.startsWith(scoped)) continue;
            const rest = key.slice(scoped.length);
            const cut = delimiter ? rest.indexOf(delimiter) : -1;
            if (cut >= 0) prefixes.add(scoped + rest.slice(0, cut + delimiter!.length));
            else objects.push(key);
          }
          const expectedObjects = maxKeys === undefined ? objects : objects.slice(0, maxKeys);
          const expectedPrefixes = maxKeys === undefined ? [...prefixes].sort() : [...prefixes].sort().slice(0, maxKeys - expectedObjects.length);
          const result = await adapter.listObjects(scoped, { delimiter, maxKeys });
          expect({ objects: result.objects.map(({ key }) => key), prefixes: result.prefixes }).toEqual({ objects: expectedObjects, prefixes: expectedPrefixes });
        }
      }
    }
  });
});
