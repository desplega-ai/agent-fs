import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Files } from "files-sdk";
import { fs } from "files-sdk/fs";
import { UnsupportedOperation } from "../errors.js";
import { assertKeyInsideDrive } from "./key-guard.js";
import {
  assertLegacyWritable,
  isLegacyReservedKey,
  legacyDelete,
  legacyGet,
  legacyHead,
  legacyList,
  legacyPut,
} from "./legacy-reserved-keys.js";
import type {
  StorageAdapter,
  StorageCapabilities,
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "./adapter.js";

/**
 * Local-filesystem `StorageAdapter` backed by the `files-sdk` `fs` adapter.
 *
 * The first non-S3 backend. It gets the **full** versioning tier (`revert` +
 * historical `diff`) without any object-versioning primitive by storing every
 * version's bytes content-addressed:
 *
 *   - the *current* bytes live at the plain key (`<orgId>/drives/<driveId>/…`),
 *     exactly like S3 — so `ls`/`cat`/`/raw` read it directly;
 *   - every version's bytes ALSO live at a reserved top-level blob key
 *     `_afs-blobs/sha256/<hash>`. That prefix sits *outside* any drive listing
 *     prefix, so it never surfaces in `ls`/`glob`.
 *
 * The opaque per-adapter "version handle" the ops persist in
 * `file_versions.s3_version_id` is simply the SHA-256 hash. `revert`/`diff`
 * pass that handle back into {@link getObject}, which reads the blob. Identical
 * content dedups to a single blob for free (same hash → same key).
 *
 * ### Cross-store atomicity (see step-3 Change #4)
 * The write path stays object-then-commit (`putObject` then `createVersion`),
 * unchanged from the S3 path. Inside `putObject` the **blob is written first**,
 * then the plain key — so a crash between the two writes can only ever leave a
 * content-addressed blob with no referencing version row. Such an orphan is
 * dedup-shared and harmless (the hash may back another version), so it is
 * deliberately NOT cleaned up on failure. The partial-failure window matches
 * today's S3 path; real reconciliation/retry is deferred to the
 * remote/consumer adapter (follow-up plan).
 *
 * ### Tenant containment
 * Every drive is a sibling directory (`<orgId>/drives/<driveId>/`) under one
 * root, and `files-sdk` only stops a key from leaving the *root*. So every
 * method here first runs its key (or prefix) through {@link assertKeyInsideDrive},
 * which refuses `.`/`..` segments and NUL bytes. That covers every op, since
 * they all reach storage through this adapter. S3 is not affected: an
 * `a/../b` key is ordinary data there and that adapter is left alone.
 *
 * ### Keys files-sdk 3 reserves
 * files-sdk 2.0.0 stored a key ending in `.fls-tmp` like any other; files-sdk 3
 * refuses it and hides it from `list`. Every method routes such a key to
 * `legacy-reserved-keys.ts`, which serves it from the same on-disk layout, so
 * files written before the upgrade stay readable, writable and listed.
 */

const BLOB_PREFIX = "_afs-blobs/sha256/";

/** Reserved, never-listed key where a version's content-addressed bytes live. */
function blobKey(hash: string): string {
  return BLOB_PREFIX + hash;
}

/** files-sdk surfaces a missing object as `FilesError { code: "NotFound" }`. */
function isFilesNotFound(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "NotFound"
  );
}

/**
 * Translate a files-sdk error into the S3-compatible not-found shape every op
 * already branches on (`err.name === "NoSuchKey"`). Non-not-found errors are
 * returned unchanged so the caller can rethrow the original.
 */
function translateError(err: unknown, key: string): unknown {
  return isFilesNotFound(err) ? noSuchKey(key, err) : err;
}

function noSuchKey(key: string, cause?: unknown): Error {
  const e = new Error(`NoSuchKey: ${key}`);
  e.name = "NoSuchKey";
  (e as { cause?: unknown }).cause = cause;
  return e;
}

export interface LocalStorageAdapterOptions {
  /** Directory the backend manages. Keys map to nested paths under it. */
  root: string;
  /** Optional URL prefix for files-sdk `url()` (unused — local never presigns). */
  urlBaseUrl?: string;
}

export class LocalStorageAdapter implements StorageAdapter {
  private files: Files;
  private readonly root: string;

  /** App-level (content-addressed) versioning is always on for local. */
  versioningEnabled = true;

  /** Local gets full versioning but cannot mint native presigned URLs. */
  get capabilities(): StorageCapabilities {
    return { versioning: true, presignedUrls: false };
  }

  constructor(opts: LocalStorageAdapterOptions) {
    this.root = opts.root;
    this.files = new Files({
      adapter: fs({
        root: opts.root,
        ...(opts.urlBaseUrl ? { urlBaseUrl: opts.urlBaseUrl } : {}),
      }),
    });
  }

  async putObject(
    key: string,
    body: string | Uint8Array,
    _metadata?: Record<string, string>,
    contentType?: string,
  ): Promise<PutObjectResult> {
    assertKeyInsideDrive(key);
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const hash = createHash("sha256").update(bytes).digest("hex");
    // A refused legacy key must fail before the history blob is written.
    const legacy = isLegacyReservedKey(key);
    if (legacy) await assertLegacyWritable(this.root, key);

    // Blob-first: persist the content-addressed history blob before the plain
    // key so a crash between the two never loses version history. Dedup:
    // identical content shares one blob, so skip the re-upload when present.
    const bk = blobKey(hash);
    if (!(await this.files.exists(bk))) {
      await this.files.upload(bk, bytes);
    }

    // Then the current/plain key — read directly by ls/cat/`/raw`.
    if (legacy) {
      await legacyPut(this.root, key, bytes, contentType);
      return { etag: hash, versionId: hash };
    }
    await this.files.upload(
      key,
      bytes,
      contentType ? { contentType } : undefined,
    );

    return { etag: hash, versionId: hash };
  }

  async getObject(
    key: string,
    versionId?: string,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<GetObjectResult> {
    assertKeyInsideDrive(key);
    // A version handle reads the content-addressed blob; otherwise the plain
    // current key. The handle is spliced into a path, so it is checked too.
    const target = versionId ? blobKey(versionId) : key;
    assertKeyInsideDrive(target);
    if (!versionId && isLegacyReservedKey(key)) {
      const legacy = await legacyGet(this.root, key);
      if (!legacy) throw noSuchKey(key);
      return {
        body: legacy.body,
        contentType: legacy.contentType,
        size: legacy.size,
        versionId,
        etag: legacy.etag,
      };
    }
    try {
      const stored = await this.files.download(
        target,
        opts?.abortSignal ? { signal: opts.abortSignal } : undefined,
      );
      const body = new Uint8Array(await stored.arrayBuffer());
      return {
        body,
        contentType: stored.type,
        size: stored.size,
        versionId,
        etag: stored.etag,
      };
    } catch (err) {
      throw translateError(err, key);
    }
  }

  async deleteObject(key: string): Promise<void> {
    // Delete the plain key only — blobs ARE the version history and stay put
    // (mirrors S3 delete-marker semantics: prior versions stay retrievable by
    // handle). A missing key is a no-op.
    assertKeyInsideDrive(key);
    if (isLegacyReservedKey(key)) return legacyDelete(this.root, key);
    try {
      await this.files.delete(key);
    } catch (err) {
      if (isFilesNotFound(err)) return;
      throw err;
    }
  }

  async copyObject(fromKey: string, toKey: string): Promise<PutObjectResult> {
    // Check both ends before reading anything, so a hostile destination does
    // not even cost a read of the source.
    assertKeyInsideDrive(fromKey);
    assertKeyInsideDrive(toKey);
    // Read source bytes, then re-put — ensures the blob exists for `toKey`'s
    // history and writes the plain destination key.
    const src = await this.getObject(fromKey);
    return this.putObject(toKey, src.body, undefined, src.contentType);
  }

  async listObjects(
    prefix: string,
    options?: { delimiter?: string; maxKeys?: number },
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    assertKeyInsideDrive(prefix);
    const listing = await this.listAll(prefix, options?.delimiter);
    const max = options?.maxKeys;
    if (max === undefined) return listing;
    const objects = listing.objects.slice(0, max);
    return { objects, prefixes: listing.prefixes.slice(0, max - objects.length) };
  }

  private async listAll(
    prefix: string,
    delimiter: string | undefined,
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    const objects: S3Object[] = [];
    const prefixes = new Set<string>();
    let cursor: string | undefined;

    // Drain every page (fs caps at ~1000 items/page and returns a cursor).
    // The `_afs-blobs/…` prefix is a top-level sibling of `<orgId>/…`, so a
    // drive-scoped prefix never matches it — blobs never surface here.
    do {
      const page = await this.files.list({
        prefix,
        ...(delimiter ? { delimiter } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const it of page.items) {
        objects.push({
          key: it.key,
          size: it.size,
          lastModified:
            it.lastModified != null ? new Date(it.lastModified) : new Date(),
          etag: it.etag,
        });
      }
      for (const p of page.prefixes ?? []) prefixes.add(p);
      cursor = page.cursor;
    } while (cursor);

    // Add the `.fls-tmp` files files-sdk 3 skips, grouped like S3 would.
    const legacy = await legacyList(this.root, prefix);
    if (legacy.length === 0) return { objects, prefixes: Array.from(prefixes) };
    for (const it of legacy) {
      const rest = it.key.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (delimiter && cut >= 0) {
        prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
        continue;
      }
      objects.push({
        key: it.key,
        size: it.size,
        lastModified: new Date(it.lastModified),
        etag: it.etag,
      });
    }
    const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    objects.sort((a, b) => byKey(a.key, b.key));
    return { objects, prefixes: Array.from(prefixes).sort(byKey) };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    assertKeyInsideDrive(key);
    if (isLegacyReservedKey(key)) {
      const legacy = await legacyHead(this.root, key);
      if (!legacy) throw noSuchKey(key);
      return {
        contentType: legacy.contentType,
        size: legacy.size,
        lastModified: new Date(legacy.lastModified),
        etag: legacy.etag,
      };
    }
    try {
      const stored = await this.files.head(key);
      // A folder (the fs also keeps emptied ones) must not answer as a file:
      // S3 has no object at a folder key, and the ops rely on that. files-sdk
      // 3's fs `head` already reports NotFound for folders (2.x did not); this
      // check keeps that guarantee independent of the dependency.
      const entry = await stat(resolve(this.root, key)).catch(() => undefined);
      if (entry?.isDirectory()) throw noSuchKey(key);
      return {
        contentType: stored.contentType,
        size: stored.size,
        lastModified:
          stored.lastModified != null
            ? new Date(stored.lastModified)
            : undefined,
        etag: stored.etag,
      };
    } catch (err) {
      throw translateError(err, key);
    }
  }

  /** Unused by ops on this backend (versioning is content-addressed, not native). */
  async listObjectVersions(_key: string): Promise<S3ObjectVersion[]> {
    return [];
  }

  async checkVersioningEnabled(): Promise<boolean> {
    return true;
  }

  async enableVersioning(): Promise<boolean> {
    // App-level versioning is always on — nothing to toggle.
    this.versioningEnabled = true;
    return true;
  }

  /**
   * Defensive: local can't mint native presigned URLs. The op-level capability
   * check (`signed-url` op) should fall back to the daemon app URL *before*
   * reaching here; this throw guards any caller that bypasses that gate.
   */
  async getPresignedUrl(): Promise<string> {
    throw new UnsupportedOperation("signed-url", "local");
  }
}
