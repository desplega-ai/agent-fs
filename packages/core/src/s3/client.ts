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
import type { AgentFSConfig } from "../config.js";

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

export class AgentS3Client {
  private client: S3Client;
  private bucket: string;
  versioningEnabled: boolean = false;

  constructor(config: AgentFSConfig["s3"]) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true, // Required for MinIO and most S3-compatible providers
    });
    this.versioningEnabled = config.versioningEnabled ?? false;
  }

  async putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>
  ): Promise<PutObjectResult> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === "string" ? Buffer.from(body) : body,
        Metadata: metadata,
      })
    );
    return {
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async getObject(key: string, versionId?: string): Promise<GetObjectResult> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(versionId && { VersionId: versionId }),
      })
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

  async listObjects(prefix: string): Promise<S3Object[]> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      })
    );
    return (result.Contents ?? []).map((obj) => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(),
      etag: obj.ETag,
    }));
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
}
