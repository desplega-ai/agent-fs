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
import type { AgentFSConfig } from "../config.js";
import type {
  StorageAdapter,
  StorageCapabilities,
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "../storage/adapter.js";

// These value/result types now live in storage/adapter.ts (canonical home).
// Re-exported here for back-compat with existing `s3/client.js` / `@/core` imports.
export type {
  S3Object,
  S3ObjectVersion,
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
} from "../storage/adapter.js";

export class AgentS3Client implements StorageAdapter {
  private client: S3Client;
  private presignClient: S3Client;
  private bucket: string;
  versioningEnabled: boolean = false;

  /** S3/MinIO supports both bucket versioning and native presigned URLs. */
  get capabilities(): StorageCapabilities {
    return { versioning: this.versioningEnabled, presignedUrls: true };
  }

  constructor(config: AgentFSConfig["s3"]) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials,
      forcePathStyle: true, // Required for MinIO and most S3-compatible providers
    });
    this.presignClient = new S3Client({
      region: config.region,
      endpoint: config.publicEndpoint ?? config.endpoint,
      credentials,
      forcePathStyle: true,
    });
    this.versioningEnabled = config.versioningEnabled ?? false;
  }

  async putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>,
    contentType?: string,
  ): Promise<PutObjectResult> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === "string" ? Buffer.from(body) : body,
        Metadata: metadata,
        ...(contentType && { ContentType: contentType }),
      })
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
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(versionId && { VersionId: versionId }),
      }),
      { abortSignal: opts?.abortSignal }
    );
    const body = await result.Body!.transformToByteArray();
    return {
      body,
      contentType: result.ContentType,
      size: result.ContentLength,
      versionId: result.VersionId,
      etag: result.ETag,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async copyObject(fromKey: string, toKey: string): Promise<PutObjectResult> {
    const result = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${fromKey}`,
        Key: toKey,
      })
    );
    return {
      etag: result.CopyObjectResult?.ETag,
      versionId: result.VersionId,
    };
  }

  async listObjects(
    prefix: string,
    options?: { delimiter?: string }
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(options?.delimiter && { Delimiter: options.delimiter }),
      })
    );
    return {
      objects: (result.Contents ?? []).map((obj) => ({
        key: obj.Key!,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(),
        etag: obj.ETag,
      })),
      prefixes: (result.CommonPrefixes ?? []).map((p) => p.Prefix!),
    };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
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
    const result = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: key,
      })
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
      const result = await this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket })
      );
      return result.Status === "Enabled";
    } catch {
      return false;
    }
  }

  async enableVersioning(): Promise<boolean> {
    try {
      await this.client.send(
        new PutBucketVersioningCommand({
          Bucket: this.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        })
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
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(responseContentType && { ResponseContentType: responseContentType }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK type mismatch between client-s3 and s3-request-presigner
    return getSignedUrl(this.presignClient as any, command, { expiresIn });
  }
}
