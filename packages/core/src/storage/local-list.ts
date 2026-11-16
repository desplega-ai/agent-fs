import { readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ValidationError } from "../errors.js";
import { isLegacyStagingKey, legacyHead, type LegacyObject } from "./legacy-reserved-keys.js";
import type { S3Object } from "./adapter.js";

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as { code?: string })?.code ?? "");

/** List stored files without entering unrelated directories or following symlinks. */
export async function listLocalObjects(
  root: string,
  prefix: string,
  options?: { delimiter?: string; maxKeys?: number; maxDepth?: number },
): Promise<{ objects: S3Object[]; prefixes: string[] }> {
  const base = resolve(root);
  const start = resolve(base, prefix.slice(0, prefix.lastIndexOf("/") + 1));
  if (start !== base && !start.startsWith(base + sep)) {
    throw new ValidationError(`Path resolves outside the storage root: ${JSON.stringify(prefix)}`, { field: "path" });
  }
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  const max = options?.maxKeys ?? Infinity;
  if (max <= 0 || (options?.maxDepth !== undefined && options.maxDepth <= 0)) {
    return { objects, prefixes };
  }
  const realBase = await realpath(base).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (realBase === undefined) return { objects, prefixes };

  const delimiter = options?.delimiter;
  const groups = new Map<string, Array<{ path: string; directory: boolean }>>();
  const keyFor = (path: string) => relative(base, path).split(sep).join("/");

  async function* walk(directory: string, group: boolean): AsyncGenerator<string> {
    const real = await realpath(directory).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    // Also refuse symlinks inside the prefix or swapped during traversal.
    if (real !== join(realBase!, relative(base, directory))) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    });
    entries.sort((a, b) => byKey(a.name + (a.isDirectory() ? "/" : ""), b.name + (b.isDirectory() ? "/" : "")));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (entry.isFile() && (entry.name.endsWith(".meta.json") || entry.name.endsWith(".fls-part"))) continue;
      const path = join(directory, entry.name);
      const key = keyFor(path) + (entry.isDirectory() ? "/" : "");
      if (!key.startsWith(prefix) && !(entry.isDirectory() && prefix.startsWith(key))) continue;
      const rest = key.slice(prefix.length);
      const depth = rest.split("/").filter(Boolean).length;
      if (options?.maxDepth !== undefined && (entry.isDirectory() ? depth >= options.maxDepth : depth > options.maxDepth)) continue;
      const cut = group && delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0) {
        const common = prefix + rest.slice(0, cut + delimiter!.length);
        const candidates = groups.get(common) ?? [];
        candidates.push({ path, directory: entry.isDirectory() });
        groups.set(common, candidates);
      } else if (entry.isDirectory()) {
        yield* walk(path, group);
      } else if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }

  async function metadata(key: string): Promise<LegacyObject | undefined> {
    // Read the disk layout directly. SDK head rejects some names that SDK list returns.
    const result = await legacyHead(root, key);
    // Only a valid sidecar distinguishes a stored legacy key from SDK staging.
    if (isLegacyStagingKey(key) && result?.etag === undefined) return undefined;
    return result;
  }

  // Objects take precedence over prefixes when maxKeys truncates a local listing.
  for await (const key of walk(start, true)) {
    const info = await metadata(key);
    if (!info) continue;
    objects.push({ key, size: info.size, lastModified: new Date(info.lastModified), etag: info.etag });
    if (objects.length >= max) return { objects, prefixes };
  }

  // One visible file proves a common prefix. Empty and staging-only folders stay hidden.
  async function visible(key: string): Promise<boolean> {
    return key.endsWith(".fls-tmp") ? (await metadata(key)) !== undefined : true;
  }
  for (const common of Array.from(groups.keys()).sort(byKey)) {
    let found = false;
    for (const candidate of groups.get(common)!) {
      if (candidate.directory) {
        for await (const key of walk(candidate.path, false)) {
          if (await visible(key)) {
            found = true;
            break;
          }
        }
      } else {
        found = await visible(keyFor(candidate.path));
      }
      if (found) break;
    }
    if (found) prefixes.push(common);
    if (objects.length + prefixes.length >= max) break;
  }
  return { objects, prefixes };
}
