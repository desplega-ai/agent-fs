import { createHash } from "node:crypto";
import { Files } from "files-sdk";
import { fs } from "files-sdk/fs";
import { UnsupportedOperation } from "../errors.js";
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
  if (isFilesNotFound(err)) {
    const e = new Error(`NoSuchKey: ${key}`);
    e.name = "NoSuchKey";
    (e as { cause?: unknown }).cause = err;
    return e;
  }
  return err;
}

export interface LocalStorageAdapterOptions {
  /** Directory the backend manages. Keys map to nested paths under it. */
  root: string;
  /** Optional URL prefix for files-sdk `url()` (unused — local never presigns). */
  urlBaseUrl?: string;
}

export class LocalStorageAdapter implements StorageAdapter {
  private files: Files;

  /** App-level (content-addressed) versioning is always on for local. */
  versioningEnabled = true;

  /** Local gets full versioning but cannot mint native presigned URLs. */
  get capabilities(): StorageCapabilities {
    return { versioning: true, presignedUrls: false };
  }

  constructor(opts: LocalStorageAdapterOptions) {
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
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const hash = createHash("sha256").update(bytes).digest("hex");

    // Blob-first: persist the content-addressed history blob before the plain
    // key so a crash between the two never loses version history. Dedup:
    // identical content shares one blob, so skip the re-upload when present.
    const bk = blobKey(hash);
    if (!(await this.files.exists(bk))) {
      await this.files.upload(bk, bytes);
    }

    // Then the current/plain key — read directly by ls/cat/`/raw`.
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
    // A version handle reads the content-addressed blob; otherwise the plain
    // current key.
    const target = versionId ? blobKey(versionId) : key;
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
    try {
      await this.files.delete(key);
    } catch (err) {
      if (isFilesNotFound(err)) return;
      throw err;
    }
  }

  async copyObject(fromKey: string, toKey: string): Promise<PutObjectResult> {
    // Read source bytes, then re-put — ensures the blob exists for `toKey`'s
    // history and writes the plain destination key.
    const src = await this.getObject(fromKey);
    return this.putObject(toKey, src.body, undefined, src.contentType);
  }

  async listObjects(
    prefix: string,
    options?: { delimiter?: string },
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
        ...(options?.delimiter ? { delimiter: options.delimiter } : {}),
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

    return { objects, prefixes: Array.from(prefixes) };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    try {
      const stored = await this.files.head(key);
      return {
        contentType: stored.type,
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
