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
 * symlink may not lead a read or write outside it.
 */

const TMP_SUFFIX = ".fls-tmp";
const SIDECAR_SUFFIX = ".meta.json";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/** files-sdk's own check strips trailing dots/spaces before matching. */
const FS_TRAILING_NOISE = /(?<![. ])[. ]+$/u;
/**
 * files-sdk 3's own staging files (`<final name>.<randomUUID()>.fls-tmp`).
 * They exist only mid-write or after a crash and are never user data.
 */
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

/** Refuse a write whose nearest existing ancestor resolves outside the root. */
async function assertParentInsideRoot(root: string, target: string, key: string): Promise<void> {
  const realRoot = await realpath(root);
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

async function writeThenRename(dest: string, data: string | Uint8Array): Promise<void> {
  // A files-sdk-shaped staging name, so neither files-sdk nor legacyList shows it.
  const staged = `${dest}.${randomUUID()}${TMP_SUFFIX}`;
  try {
    await writeFile(staged, data);
    await rename(staged, dest);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    throw err;
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

/** Write a legacy key in the 2.0.0 layout (body, then its sidecar). */
export async function legacyPut(
  root: string,
  key: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<void> {
  const bodyPath = keyPath(root, key);
  if (SDK_STAGING_NAME.test(basename(bodyPath))) {
    throw new ValidationError(
      "File names ending in .<uuid>.fls-tmp are reserved for in-progress local uploads",
      { field: "path" },
    );
  }
  await assertParentInsideRoot(root, bodyPath, key);
  await mkdir(dirname(bodyPath), { recursive: true });
  const etag = `"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"`;
  await writeThenRename(bodyPath, bytes);
  await writeThenRename(
    bodyPath + SIDECAR_SUFFIX,
    JSON.stringify({ contentType: contentType ?? DEFAULT_CONTENT_TYPE, etag, lastModified: Date.now() }),
  );
}

/** Delete a legacy key and its sidecar. A missing key or a folder is a no-op. */
export async function legacyDelete(root: string, key: string): Promise<void> {
  const bodyPath = keyPath(root, key);
  await assertParentInsideRoot(root, bodyPath, key);
  const entry = await lstat(bodyPath).catch((err) => {
    if (isMissing(err)) return undefined;
    throw err;
  });
  if (!entry || entry.isDirectory()) return;
  await rm(bodyPath, { force: true });
  await rm(bodyPath + SIDECAR_SUFFIX, { force: true });
}

/**
 * Every file under `prefix` that files-sdk 3's `list` skips but 2.0.0 listed:
 * names ending in exactly `.fls-tmp`, minus files-sdk's own staging files.
 * Variants such as `.FLS-TMP` are still listed by files-sdk, so they are not
 * repeated here. Like files-sdk, symlinks are not followed.
 */
export async function legacyList(root: string, prefix: string): Promise<LegacyListEntry[]> {
  const base = resolve(root);
  const start = resolve(base, prefix.slice(0, prefix.lastIndexOf("/") + 1));
  if (start !== base && !isInside(base, start)) throw outsideRoot(prefix);
  const found: LegacyListEntry[] = [];
  const stack = [start];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
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
      if (SDK_STAGING_NAME.test(entry.name)) continue;
      const key = relative(base, abs).split(sep).join("/");
      if (!key.startsWith(prefix)) continue;
      const info = await stat(abs).catch((err) => {
        if (isMissing(err)) return undefined;
        throw err;
      });
      if (!info) continue;
      const sidecar = await readSidecar(abs);
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
