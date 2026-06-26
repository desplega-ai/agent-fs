/**
 * Storage contract shared by every agent-fs storage backend.
 *
 * The object store is intentionally a dumb keyed blob store: almost all
 * "filesystem" semantics (version numbering, history, dedup, optimistic
 * concurrency, FTS search, comments) live in SQLite, not here. An adapter only
 * has to move bytes by key and report a small amount of metadata.
 *
 * ## Not-found error-shape contract
 *
 * Adapters MUST surface "object not found" as an error that agent-fs ops already
 * branch on. Throw an `Error` (or provider error) whose shape matches ONE of:
 *   - `err.name === "NoSuchKey"`, or
 *   - `err.name === "NotFound"`, or
 *   - `err.$metadata?.httpStatusCode === 404`
 *
 * Ops translate these into `NotFoundError` (see `ops/cat.ts:45`, `ops/stat.ts:18`,
 * `ops/signed-url.ts:31`, and the server's `routes/files.ts:77`). Surfacing any
 * other shape for a missing object would break those ~6 branches.
 *
 * These value/result types are the canonical home; `s3/client.ts` re-exports them
 * for back-compat. The names retain their historical `S3`-prefix even though they
 * are now backend-agnostic.
 */

export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface S3ObjectVersion {
  versionId: string;
  lastModified: Date;
  size: number;
  isLatest: boolean;
}

export interface PutObjectResult {
  etag?: string;
  versionId?: string;
}

export interface GetObjectResult {
  body: Uint8Array;
  contentType?: string;
  size?: number;
  versionId?: string;
  etag?: string;
}

export interface HeadObjectResult {
  contentType?: string;
  size: number;
  lastModified?: Date;
  etag?: string;
  versionId?: string;
}

/**
 * Static feature metadata an adapter advertises so ops can gate optional
 * behavior and surface a typed `UnsupportedOperation` instead of a raw backend
 * error when a backend can't satisfy a request.
 */
export interface StorageCapabilities {
  /** Old-content retrieval by version handle — powers `revert` and historical `diff`. */
  versioning: boolean;
  /** Native presigned download URLs. Backends without this fall back to the daemon `/raw` URL. */
  presignedUrls: boolean;
}

/**
 * The contract every storage backend implements. The signatures are the exact
 * 10-method surface that ops call through `OpContext.s3`, plus the mutable
 * `versioningEnabled` flag and the static `capabilities` metadata.
 */
export interface StorageAdapter {
  /** Whether object-level versioning is currently enabled on this backend. */
  versioningEnabled: boolean;
  /** Feature metadata for capability gating. */
  readonly capabilities: StorageCapabilities;

  putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>,
    contentType?: string,
  ): Promise<PutObjectResult>;

  getObject(
    key: string,
    versionId?: string,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<GetObjectResult>;

  deleteObject(key: string): Promise<void>;

  copyObject(fromKey: string, toKey: string): Promise<PutObjectResult>;

  listObjects(
    prefix: string,
    options?: { delimiter?: string },
  ): Promise<{ objects: S3Object[]; prefixes: string[] }>;

  headObject(key: string): Promise<HeadObjectResult>;

  listObjectVersions(key: string): Promise<S3ObjectVersion[]>;

  checkVersioningEnabled(): Promise<boolean>;

  enableVersioning(): Promise<boolean>;

  getPresignedUrl(
    key: string,
    expiresIn?: number,
    responseContentType?: string,
  ): Promise<string>;
}
