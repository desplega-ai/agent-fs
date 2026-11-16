import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../config.js";
import type {
  StorageAdapter,
  StorageCapabilities,
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "../storage/adapter.js";
import { assertKeyInsideDrive } from "../storage/key-guard.js";
import { StorageUnavailableError } from "../errors.js";

// These value/result types now live in storage/adapter.ts (canonical home).
// Re-exported here for back-compat with existing `s3/client.js` / `@/core` imports.
export type {
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "../storage/adapter.js";

const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_SOCKET_TIMEOUT_MS = 30_000;
const S3_MAX_ATTEMPTS = 3;
/**
 * Total time one storage call may take, retries included. Without it a
 * partition holds a request for 3 attempts x the 30 s socket timeout, longer
 * than the CLI's 60 s timeout. Bodies get 1 s more per MiB on top.
 */
const S3_DEADLINE_MS = 15_000;

/** Network-level failures: the request never got an HTTP answer. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ConnectionRefused",
]);

/** True when an S3 error means "storage unreachable or failing", not "bad request". */
export function isStorageUnavailable(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  if (typeof status === "number") return status >= 500;
  return (
    NETWORK_ERROR_CODES.has(err?.code) ||
    ["TimeoutError", "RequestTimeout", "RequestTimeoutException"].includes(err?.name) ||
    /socket hang up|socket connection was closed|unable to connect/i.test(String(err?.message ?? ""))
  );
}

/** URL-encode each `/`-separated segment of a key, keeping the slashes. */
function encodeCopySourceKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// Every key (or prefix) goes through assertKeyInsideDrive first: S3-compatible
// providers differ on whether they resolve `..` in a key, so a key must not carry one.
export class AgentS3Client implements StorageAdapter {
  private client: S3Client;
  private presignClient: S3Client;
  private bucket: string;
  versioningEnabled: boolean = false;
  /** Per-call deadline; a field so tests can shorten it. */
  private deadlineMs = S3_DEADLINE_MS;

  /** S3/MinIO supports both bucket versioning and native presigned URLs. */
  get capabilities(): StorageCapabilities {
    return { versioning: this.versioningEnabled, presignedUrls: true };
  }

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    // socketTimeout only closes an idle socket. requestTimeout measures the
    // entire request, including a streaming upload, so it would cap large uploads.
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials,
      forcePathStyle: true, // Required for MinIO and most S3-compatible providers
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        socketTimeout: S3_SOCKET_TIMEOUT_MS,
      },
      maxAttempts: S3_MAX_ATTEMPTS,
    });
    this.presignClient = new S3Client({
      region: config.region,
      endpoint: config.publicEndpoint ?? config.endpoint,
      credentials,
      forcePathStyle: true,
    });
    this.versioningEnabled = config.versioningEnabled ?? false;
  }

  private bodyDeadlineMs(bytes: number): number {
    return this.deadlineMs + Math.floor(bytes / (1024 * 1024)) * 1000;
  }

  /**
   * Run one SDK call. A call that fails to reach storage, or a read past its
   * deadline, throws StorageUnavailableError (HTTP 503); S3's own 4xx answers
   * (NoSuchKey, AccessDenied) pass through unchanged. `rearm` restarts the
   * deadline, for a body whose size is known only from the headers.
   *
   * Writes get no deadline here (`deadlineMs: null`): closing a socket that
   * still holds a PUT lets the kernel deliver it later, after a newer write to
   * the same key, and the stale bytes win. The op answers on time instead and
   * finishes in the background (ops/answer-within.ts).
   */
  private async call<T>(
    deadlineMs: number | null,
    fn: (signal: AbortSignal, rearm: (ms: number) => void) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    // An abort that already happened never fires its event, so check it before any work.
    callerSignal?.throwIfAborted();
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire!: (err: Error) => void;
    // Raced as well as aborted: a body stream the SDK no longer watches still fails on time.
    const deadline = new Promise<never>((_, reject) => { expire = reject; });
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expire(new StorageUnavailableError(`Storage did not answer within ${Math.round(ms / 1000)} s`));
        ac.abort();
      }, ms);
    };
    // Writes never pass a caller signal, so a caller abort cannot cancel a PUT.
    const forward = () => {
      expire(callerSignal!.reason);
      ac.abort(callerSignal!.reason);
    };
    callerSignal?.addEventListener("abort", forward, { once: true });
    if (deadlineMs !== null) arm(deadlineMs);
    const work = fn(ac.signal, arm);
    work.catch(() => {}); // the loser of the race below must not surface as unhandled
    try {
      return await Promise.race([work, deadline]);
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw err;
      if (!callerSignal?.aborted && isStorageUnavailable(err)) {
        throw new StorageUnavailableError("Storage is unreachable", { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forward);
    }
  }

  async putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>,
    contentType?: string,
  ): Promise<PutObjectResult> {
    assertKeyInsideDrive(key);
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    const result = await this.call(null, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          Metadata: metadata,
          ...(contentType && { ContentType: contentType }),
        })
      )
    );
    return {
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async getObject(
    key: string,
    versionId?: string,
    opts?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectResult> {
    assertKeyInsideDrive(key);
    return this.call(this.deadlineMs, async (abortSignal, rearm) => {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(versionId && { VersionId: versionId }),
        }),
        { abortSignal }
      );
      rearm(this.bodyDeadlineMs(result.ContentLength ?? 0));
      const body = await result.Body!.transformToByteArray();
      return {
        body,
        contentType: result.ContentType,
        size: result.ContentLength,
        versionId: result.VersionId,
        etag: result.ETag,
      };
    }, opts?.abortSignal);
  }

  async deleteObject(key: string): Promise<void> {
    assertKeyInsideDrive(key);
    await this.call(null, () =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    );
  }

  async copyObject(fromKey: string, toKey: string, contentType?: string): Promise<PutObjectResult> {
    assertKeyInsideDrive(fromKey);
    assertKeyInsideDrive(toKey);
    const result = await this.call(null, () => this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        // The SDK encodes `Key` but sends `CopySource` as given, and the
        // provider URL-decodes it. Encode each segment so the source key is
        // read back exactly as written (a `%2e%2e` stays literal, and `%`,
        // `?`, `#` or a space in a name survive).
        CopySource: `${this.bucket}/${encodeCopySourceKey(fromKey)}`,
        Key: toKey,
        // COPY (the default) keeps the source type; REPLACE is the only way to set a new one.
        ...(contentType && { MetadataDirective: "REPLACE", ContentType: contentType }),
      })
    ));
    return {
      etag: result.CopyObjectResult?.ETag,
      versionId: result.VersionId,
    };
  }

  async listObjects(
    prefix: string,
    options?: { delimiter?: string; maxKeys?: number }
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    assertKeyInsideDrive(prefix);
    const objects: S3Object[] = [];
    const prefixes: string[] = [];
    const seenPrefixes = new Set<string>();
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;

    while (true) {
      const result = await this.call(this.deadlineMs, (abortSignal) => this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(options?.delimiter !== undefined && { Delimiter: options.delimiter }),
          ...(options?.maxKeys !== undefined && { MaxKeys: options.maxKeys }),
          ...(continuationToken !== undefined && { ContinuationToken: continuationToken }),
        }),
        { abortSignal }
      ));

      objects.push(
        ...(result.Contents ?? []).map((obj) => ({
          key: obj.Key!,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(),
          etag: obj.ETag,
        }))
      );
      for (const { Prefix: commonPrefix } of result.CommonPrefixes ?? []) {
        if (commonPrefix && !seenPrefixes.has(commonPrefix)) {
          seenPrefixes.add(commonPrefix);
          prefixes.push(commonPrefix);
        }
      }

      // A capped listing is one page: S3 never returns more than MaxKeys.
      if (!result.IsTruncated || options?.maxKeys !== undefined) return { objects, prefixes };

      const nextToken = result.NextContinuationToken;
      if (!nextToken) {
        throw new Error("S3 returned a truncated listing without a continuation token");
      }
      if (seenTokens.has(nextToken)) {
        throw new Error("S3 returned a repeating continuation token");
      }
      seenTokens.add(nextToken);
      continuationToken = nextToken;
    }
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    assertKeyInsideDrive(key);
    const result = await this.call(this.deadlineMs, (abortSignal) =>
      this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal })
    );
    return {
      contentType: result.ContentType,
      size: result.ContentLength ?? 0,
      lastModified: result.LastModified,
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async listObjectVersions(key: string): Promise<S3ObjectVersion[]> {
    assertKeyInsideDrive(key);
    const result = await this.call(this.deadlineMs, (abortSignal) =>
      this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key }), { abortSignal })
    );
    return (result.Versions ?? [])
      .filter((v) => v.Key === key)
      .map((v) => ({
        versionId: v.VersionId!,
        lastModified: v.LastModified ?? new Date(),
        size: v.Size ?? 0,
        isLatest: v.IsLatest ?? false,
      }));
  }

  async checkVersioningEnabled(): Promise<boolean> {
    try {
      const result = await this.call(this.deadlineMs, (abortSignal) =>
        this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }), { abortSignal })
      );
      return result.Status === "Enabled";
    } catch {
      return false;
    }
  }

  async enableVersioning(): Promise<boolean> {
    try {
      await this.call(this.deadlineMs, (abortSignal) =>
        this.client.send(
          new PutBucketVersioningCommand({
            Bucket: this.bucket,
            VersioningConfiguration: { Status: "Enabled" },
          }),
          { abortSignal }
        )
      );
      this.versioningEnabled = true;
      return true;
    } catch {
      return false;
    }
  }

  async getPresignedUrl(
    key: string,
    expiresIn: number = 86400,
    responseContentType?: string,
    responseContentDisposition?: string,
    signingDate?: Date,
  ): Promise<string> {
    assertKeyInsideDrive(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(responseContentType && { ResponseContentType: responseContentType }),
      ...(responseContentDisposition && { ResponseContentDisposition: responseContentDisposition }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK type mismatch between client-s3 and s3-request-presigner
    return getSignedUrl(this.presignClient as any, command, { expiresIn, ...(signingDate && { signingDate }) });
  }
}
