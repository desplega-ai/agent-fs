import "./db/setup-sqlite.js";

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./db/schema.js";
import { CREATE_TABLES_SQL, VIRTUAL_TABLE_SQL } from "./db/raw.js";
import { createUser } from "./identity/users.js";
import { listUserOrgs } from "./identity/orgs.js";
import { listDrives } from "./identity/drives.js";
import type { DB } from "./db/index.js";
import type { OpContext } from "./ops/types.js";
import type {
  PutObjectResult,
  GetObjectResult,
  HeadObjectResult,
  S3Object,
  S3ObjectVersion,
} from "./s3/client.js";

// Check if MinIO is available at localhost:9000
export async function isMinioAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:9000/minio/health/live");
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create an in-memory SQLite database with full schema for testing.
 */
export function createTestDb(): DB {
  const sqlite = new Database(":memory:");
  sqliteVec.load(sqlite);
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VIRTUAL_TABLE_SQL);
  return drizzle(sqlite, { schema });
}

/**
 * In-memory mock of AgentS3Client for testing without MinIO.
 */
export class MockS3Client {
  private store = new Map<string, { body: Uint8Array; metadata?: Record<string, string>; versions: Array<{ versionId: string; body: Uint8Array; timestamp: Date }> }>();
  versioningEnabled: boolean;

  constructor(opts?: { versioningEnabled?: boolean }) {
    this.versioningEnabled = opts?.versioningEnabled ?? false;
  }

  async putObject(
    key: string,
    body: string | Uint8Array,
    metadata?: Record<string, string>
  ): Promise<PutObjectResult> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const versionId = this.versioningEnabled ? crypto.randomUUID() : undefined;

    const existing = this.store.get(key);
    const versions = existing?.versions ?? [];
    if (versionId) {
      versions.push({ versionId, body: bytes, timestamp: new Date() });
    }

    this.store.set(key, { body: bytes, metadata, versions });
    return { etag: `"${crypto.randomUUID()}"`, versionId };
  }

  async getObject(key: string, versionId?: string): Promise<GetObjectResult> {
    const entry = this.store.get(key);
    if (!entry) {
      const err = new Error(`NoSuchKey: ${key}`);
      err.name = "NoSuchKey";
      throw err;
    }

    let body = entry.body;
    let resolvedVersionId = versionId;

    if (versionId && entry.versions.length > 0) {
      const version = entry.versions.find((v) => v.versionId === versionId);
      if (!version) throw new Error(`NoSuchVersion: ${versionId}`);
      body = version.body;
    } else if (entry.versions.length > 0) {
      resolvedVersionId = entry.versions[entry.versions.length - 1].versionId;
    }

    return {
      body,
      contentType: "application/octet-stream",
      size: body.length,
      versionId: resolvedVersionId,
      etag: `"mock-etag"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  async copyObject(fromKey: string, toKey: string): Promise<PutObjectResult> {
    const entry = this.store.get(fromKey);
    if (!entry) {
      const err = new Error(`NoSuchKey: ${fromKey}`);
      err.name = "NoSuchKey";
      throw err;
    }
    return this.putObject(toKey, entry.body, entry.metadata);
  }

  async listObjects(
    prefix: string,
    options?: { delimiter?: string }
  ): Promise<{ objects: S3Object[]; prefixes: string[] }> {
    const objects: S3Object[] = [];
    const prefixSet = new Set<string>();

    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix)) continue;

      if (options?.delimiter) {
        const rest = key.slice(prefix.length);
        const delimIdx = rest.indexOf(options.delimiter);
        if (delimIdx >= 0) {
          prefixSet.add(prefix + rest.slice(0, delimIdx + 1));
          continue;
        }
      }

      objects.push({
        key,
        size: entry.body.length,
        lastModified: new Date(),
        etag: `"mock-etag"`,
      });
    }

    return { objects, prefixes: Array.from(prefixSet) };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const entry = this.store.get(key);
    if (!entry) {
      const err = new Error(`Not found: ${key}`);
      err.name = "NotFound";
      throw err;
    }
    return {
      contentType: "application/octet-stream",
      size: entry.body.length,
      lastModified: new Date(),
      etag: `"mock-etag"`,
    };
  }

  async listObjectVersions(key: string): Promise<S3ObjectVersion[]> {
    const entry = this.store.get(key);
    if (!entry) return [];
    return entry.versions.map((v, i) => ({
      versionId: v.versionId,
      lastModified: v.timestamp,
      size: v.body.length,
      isLatest: i === entry.versions.length - 1,
    }));
  }

  async checkVersioningEnabled(): Promise<boolean> {
    return this.versioningEnabled;
  }

  async enableVersioning(): Promise<boolean> {
    this.versioningEnabled = true;
    return true;
  }

  /** Reset all stored objects */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Create a full test context with DB, mock S3, and a pre-created user/org/drive.
 */
export function createTestContext(opts?: {
  versioningEnabled?: boolean;
}): {
  ctx: OpContext;
  db: DB;
  s3: MockS3Client;
  userId: string;
  orgId: string;
  driveId: string;
  apiKey: string;
} {
  const db = createTestDb();
  const s3 = new MockS3Client({ versioningEnabled: opts?.versioningEnabled ?? false });

  const { user, apiKey } = createUser(db, { email: "test@example.com" });
  const orgs = listUserOrgs(db, user.id);
  const drives = listDrives(db, orgs[0].id);

  const ctx: OpContext = {
    db,
    s3: s3 as any, // MockS3Client implements the same interface
    orgId: orgs[0].id,
    driveId: drives[0].id,
    userId: user.id,
    embeddingProvider: null,
  };

  return {
    ctx,
    db,
    s3,
    userId: user.id,
    orgId: orgs[0].id,
    driveId: drives[0].id,
    apiKey,
  };
}

/**
 * Create a unique temp directory and set AGENT_FS_HOME to it.
 * Returns the dir path and a cleanup function that restores the env var and removes the temp dir.
 */
export function createTestConfigDir(): { dir: string; cleanup: () => void } {
  const originalHome = process.env.AGENT_FS_HOME;
  const dir = join(
    tmpdir(),
    `agent-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_FS_HOME = dir;

  const cleanup = () => {
    if (originalHome !== undefined) {
      process.env.AGENT_FS_HOME = originalHome;
    } else {
      delete process.env.AGENT_FS_HOME;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  return { dir, cleanup };
}
