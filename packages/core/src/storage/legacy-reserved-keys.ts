import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ValidationError } from "../errors.js";

/**
 * Keys that files-sdk 2.0.0 stored as ordinary files and files-sdk 3 refuses.
 *
 * files-sdk 2.3.0 started staging fs uploads at `<path>.<uuid>.fls-tmp` and
 * reserved every key whose last segment ends in `.fls-tmp` (case-insensitive,
 * trailing dots and spaces ignored). Under 2.0.0 such a key was valid, so a
 * local root written before the upgrade can hold one. files-sdk 3 then throws
 * `FilesError { code: "Invalid" }` on download/head/upload/delete of it, and its
 * `list` skips every file whose name ends in `.fls-tmp`.
 *
 * The bytes are still on disk in the 2.0.0 layout: the body at `<root>/<key>`
 * and the sidecar at `<root>/<key>.meta.json`. These helpers serve exactly
 * those keys from that layout, so they keep working with no migration.
 * `.meta.json` and `.fls-part` were already reserved in 2.0.0, so no stored key
 * ends in them; `.fls-tmp` is the only suffix the upgrade newly reserved.
 *
 * Containment matches files-sdk's: a key must resolve inside the root, and a
 * symlink may not lead a read or write outside it. Writes match its commit:
 * body and sidecar are both staged, then renamed in place under one per-path
 * lock, so concurrent writers never pair one body with another's sidecar.
 *
 * files-sdk 3 stages at `<final name>.<uuid>.fls-tmp`, which 2.0.0 also took
 * as a user key. A sidecar settles it: files-sdk never writes one for a
 * staging file and 2.0.0 always wrote one, so such a name with a valid sidecar
 * is a stored object and is listed and writable like any other. Without a
 * sidecar the name is ambiguous (a live or crashed staging file, or a 2.0.0
 * upload cut off before its sidecar). It is left on disk untouched and
 * readable by its exact key, but not listed, because a staging file mid-write
 * looks exactly like it. A put of that key writes a sidecar and adopts it.
 */

const TMP_SUFFIX = ".fls-tmp";
const SIDECAR_SUFFIX = ".meta.json";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/** files-sdk's own check strips trailing dots/spaces before matching. */
const FS_TRAILING_NOISE = /(?<![. ])[. ]+$/u;
/** The shape of files-sdk 3's staging files (`<final name>.<randomUUID()>.fls-tmp`). */
const SDK_STAGING_NAME =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.fls-tmp$/;

export interface LegacyObject {
  size: number;
  contentType: string;
  etag?: string;
  lastModified: number;
}

export interface LegacyListEntry extends LegacyObject {
  key: string;
}

/** Same match files-sdk 3 uses to refuse a key, limited to the new suffix. */
export function isLegacyReservedKey(key: string): boolean {
  return basename(key).replace(FS_TRAILING_NOISE, "").toLowerCase().endsWith(TMP_SUFFIX);
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function outsideRoot(key: string): ValidationError {
  return new ValidationError(`Path resolves outside the storage root: ${JSON.stringify(key)}`, {
    field: "path",
  });
}

function isInside(root: string, target: string): boolean {
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Resolve `key` under `root`, refusing a key that lexically leaves it. */
function keyPath(root: string, key: string): string {
  const target = resolve(root, key);
  if (!isInside(resolve(root), target)) throw outsideRoot(key);
  return target;
}

/**
 * Refuse a write whose nearest existing ancestor resolves outside the root.
 * A root that does not exist yet has no symlinks under it, so the lexical
 * check in `keyPath` is all there is to enforce; the first put creates it.
 */
async function assertParentInsideRoot(root: string, target: string, key: string): Promise<void> {
  const realRoot = await realpath(root).catch((err) => {
    if (isMissing(err)) return undefined;
    throw err;
  });
  if (realRoot === undefined) return;
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    const real = await realpath(dir).catch((err) => {
      if (isMissing(err)) return undefined;
      throw err;
    });
    if (real === undefined) continue;
    if (real !== realRoot && !isInside(realRoot, real)) throw outsideRoot(key);
    return;
  }
}

async function readSidecar(
  bodyPath: string,
): Promise<{ contentType: string; etag: string; lastModified: number } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(bodyPath + SIDECAR_SUFFIX, "utf-8"));
    if (
      typeof parsed?.contentType === "string" &&
      typeof parsed.etag === "string" &&
      typeof parsed.lastModified === "number"
    ) {
      return parsed;
    }
    return undefined;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** A files-sdk-shaped staging name with no sidecar, so nothing lists it. */
const stagingPath = (dest: string) => `${dest}.${randomUUID()}${TMP_SUFFIX}`;

const commitLocks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier commit on `bodyPath`, as files-sdk's fs adapter does. */
async function withCommitLock<T>(bodyPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = commitLocks.get(bodyPath);
  const current = (async () => {
    await previous?.catch(() => {});
    return fn();
  })();
  commitLocks.set(bodyPath, current);
  try {
    return await current;
  } finally {
    if (commitLocks.get(bodyPath) === current) commitLocks.delete(bodyPath);
  }
}

/** Read a legacy key; `undefined` when no file is there. */
export async function legacyGet(
  root: string,
  key: string,
): Promise<(LegacyObject & { body: Uint8Array }) | undefined> {
  const bodyPath = keyPath(root, key);
  try {
    const realBody = await realpath(bodyPath);
    if (!isInside(await realpath(root), realBody)) throw outsideRoot(key);
    const info = await stat(realBody);
    if (!info.isFile()) return undefined;
    const buf = await readFile(realBody);
    const sidecar = await readSidecar(bodyPath);
    return {
      body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      size: buf.byteLength,
      contentType: sidecar?.contentType ?? DEFAULT_CONTENT_TYPE,
      etag: sidecar?.etag,
      lastModified: sidecar?.lastModified ?? info.mtimeMs,
    };
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** Head a legacy key; `undefined` when no file is there (a folder included). */
export async function legacyHead(root: string, key: string): Promise<LegacyObject | undefined> {
  const bodyPath = keyPath(root, key);
  try {
    const realBody = await realpath(bodyPath);
    if (!isInside(await realpath(root), realBody)) throw outsideRoot(key);
    const info = await stat(realBody);
    if (!info.isFile()) return undefined;
    const sidecar = await readSidecar(bodyPath);
    return {
      size: info.size,
      contentType: sidecar?.contentType ?? DEFAULT_CONTENT_TYPE,
      etag: sidecar?.etag,
      lastModified: sidecar?.lastModified ?? info.mtimeMs,
    };
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/**
 * Throw if a put of `key` would be refused, without writing anything. Callers
 * run it before any other write the put depends on (the history blob).
 */
export async function assertLegacyWritable(root: string, key: string): Promise<string> {
  const bodyPath = keyPath(root, key);
  await assertParentInsideRoot(root, bodyPath, key);
  return bodyPath;
}

/**
 * Write a legacy key in the 2.0.0 layout. Body and sidecar are staged first,
 * then both renames run under the key's commit lock, so the last writer's body
 * and sidecar always land together.
 */
export async function legacyPut(
  root: string,
  key: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<void> {
  const bodyPath = await assertLegacyWritable(root, key);
  const sidecarPath = bodyPath + SIDECAR_SUFFIX;
  await mkdir(dirname(bodyPath), { recursive: true });
  const etag = `"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"`;
  const sidecar = { contentType: contentType ?? DEFAULT_CONTENT_TYPE, etag, lastModified: Date.now() };
  const stagedBody = stagingPath(bodyPath);
  const stagedSidecar = stagingPath(sidecarPath);
  try {
    await writeFile(stagedBody, bytes);
    await writeFile(stagedSidecar, JSON.stringify(sidecar));
    await withCommitLock(bodyPath, async () => {
      await rename(stagedBody, bodyPath);
      await rename(stagedSidecar, sidecarPath);
    });
  } catch (err) {
    await rm(stagedBody, { force: true }).catch(() => {});
    await rm(stagedSidecar, { force: true }).catch(() => {});
    throw err;
  }
}

/** Delete a legacy key and its sidecar. A missing key or a folder is a no-op. */
export async function legacyDelete(root: string, key: string): Promise<void> {
  const bodyPath = keyPath(root, key);
  await assertParentInsideRoot(root, bodyPath, key);
  // Under the commit lock, so a delete never lands between a put's two renames.
  await withCommitLock(bodyPath, async () => {
    const entry = await lstat(bodyPath).catch((err) => {
      if (isMissing(err)) return undefined;
      throw err;
    });
    if (!entry || entry.isDirectory()) return;
    await rm(bodyPath, { force: true });
    await rm(bodyPath + SIDECAR_SUFFIX, { force: true });
  });
}

/**
 * Every file under `prefix` that files-sdk 3's `list` skips but 2.0.0 listed:
 * names ending in exactly `.fls-tmp`, minus sidecarless staging-shaped names.
 * Variants such as `.FLS-TMP` are still listed by files-sdk, so they are not
 * repeated here. Like files-sdk's walk from the root, no symlink is followed:
 * not one met in the walk, and not one in the prefix's own path (a
 * `link/` prefix whose `link` is a symlink lists nothing).
 */
export async function legacyList(root: string, prefix: string): Promise<LegacyListEntry[]> {
  const base = resolve(root);
  const start = resolve(base, prefix.slice(0, prefix.lastIndexOf("/") + 1));
  if (start !== base && !isInside(base, start)) throw outsideRoot(prefix);
  const realBase = await realpath(base).catch((err) => {
    if (isMissing(err)) return undefined;
    throw err;
  });
  if (realBase === undefined) return [];
  const found: LegacyListEntry[] = [];
  const stack = [start];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    // A directory whose real path differs from its lexical one sits behind a
    // symlink, in the prefix or swapped in during the walk: skip it.
    const real = await realpath(dir).catch((err) => {
      if (isMissing(err) || (err as { code?: unknown } | null)?.code === "ELOOP") return undefined;
      throw err;
    });
    if (real !== join(realBase, relative(base, dir))) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(TMP_SUFFIX)) continue;
      const key = relative(base, abs).split(sep).join("/");
      if (!key.startsWith(prefix)) continue;
      const info = await lstat(abs).catch((err) => {
        if (isMissing(err)) return undefined;
        throw err;
      });
      if (!info?.isFile()) continue;
      const sidecar = await readSidecar(abs);
      if (!sidecar && SDK_STAGING_NAME.test(entry.name)) continue;
      found.push({
        key,
        size: info.size,
        contentType: sidecar?.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: sidecar?.etag,
        lastModified: sidecar?.lastModified ?? info.mtimeMs,
      });
    }
  }
  return found;
}
