import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function resolveHome(): string {
  const home = process.env.AGENT_FS_HOME ?? join(process.env.HOME ?? "/tmp", ".agent-fs");
  // Expand ~ since env vars loaded by bun/.env don't do shell expansion
  if (home.startsWith("~/")) {
    return join(process.env.HOME ?? "/tmp", home.slice(2));
  }
  return home;
}

/**
 * S3 / MinIO storage backend config (the historical default). `provider` is an
 * open string — known labels are "minio" | "s3" | "r2" | "tigris", but any
 * S3-compatible provider name (or an env-supplied value) is accepted.
 */
export interface S3StorageConfig {
  provider: string;
  bucket: string;
  region: string;
  endpoint: string;
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  versioningEnabled?: boolean;
}

/** Local-filesystem storage backend config (no S3/Docker). */
export interface LocalStorageConfig {
  provider: "local";
  /** Directory the local-FS backend manages (keys map to nested paths under it). */
  root: string;
}

/**
 * Storage backend configuration — a tagged union discriminated by `provider`.
 * Existing S3 configs default to / migrate to the {@link S3StorageConfig}
 * variant, keeping the S3 path byte-for-byte behavior-compatible.
 */
export type AgentFSStorageConfig = S3StorageConfig | LocalStorageConfig;

/**
 * Narrow the storage union to its local-FS variant.
 *
 * A user-defined type guard is required (rather than a bare
 * `cfg.provider === "local"` check) because {@link S3StorageConfig.provider} is
 * an open `string` that structurally subsumes the `"local"` literal, so plain
 * control-flow narrowing can't discriminate the union on its own.
 */
export function isLocalStorageConfig(
  cfg: AgentFSStorageConfig
): cfg is LocalStorageConfig {
  return cfg.provider === "local";
}

export interface AgentFSConfig {
  /**
   * Storage backend. Field name kept as `s3` (legacy) to minimize churn across
   * the many `config.s3` consumers even though it now also carries the non-S3
   * `local` variant; discriminated by `config.s3.provider`. (Renaming to
   * `config.storage` is a larger refactor, recorded as a derail in the
   * multi-adapter plan — intentionally not done here.)
   */
  s3: AgentFSStorageConfig;
  embedding: {
    provider: "local" | "openai" | "gemini";
    model: string;
    apiKey: string;
  };
  server: {
    port: number;
    host: string;
    cors?: {
      origins: string[];
    };
    rateLimit?: {
      requestsPerMinute: number;
    };
  };
  auth: {
    apiKey: string;
  };
  minio: {
    containerId: string;
    managed: boolean;
  };
  appUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  defaultOrg?: string;
  defaultDrive?: string;
}

const DEFAULT_CONFIG: AgentFSConfig = {
  s3: {
    provider: "minio",
    bucket: "agentfs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "",
    secretAccessKey: "",
  },
  embedding: {
    provider: "local",
    model: "",
    apiKey: "",
  },
  server: {
    port: 7433,
    host: "127.0.0.1",
    cors: {
      origins: ["*"],
    },
    rateLimit: {
      requestsPerMinute: 1200,
    },
  },
  auth: {
    apiKey: "",
  },
  minio: {
    containerId: "",
    managed: true,
  },
};

export function getHome(): string {
  return resolveHome();
}

export function getConfigPath(): string {
  return join(getHome(), "config.json");
}

export function getDbPath(): string {
  return join(getHome(), "agent-fs.db");
}

function ensureHomeDir(): void {
  const home = getHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
}

/**
 * Two-level deep merge: for top-level keys whose value is a plain object,
 * spread defaults under the overrides so partial nested objects keep defaults.
 */
function deepMergeConfig(
  defaults: AgentFSConfig,
  overrides: Partial<AgentFSConfig>
): AgentFSConfig {
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof AgentFSConfig)[]) {
    const ov = overrides[key];
    // Storage is a tagged union: when the override switches `provider` to a
    // different-shaped variant (e.g. "local"), a shallow 2-level merge would
    // leave stale S3 fields (bucket/endpoint/…) bleeding under it. Replace
    // wholesale on a provider switch; otherwise shallow-merge (same/unset
    // provider) so partial S3 overrides keep their sibling defaults.
    if (key === "s3" && ov && typeof ov === "object" && !Array.isArray(ov)) {
      const ovS3 = ov as Partial<AgentFSStorageConfig>;
      if (ovS3.provider && ovS3.provider !== defaults.s3.provider) {
        result.s3 = { ...(ovS3 as AgentFSStorageConfig) };
      } else {
        result.s3 = {
          ...(defaults.s3 as object),
          ...(ovS3 as object),
        } as AgentFSStorageConfig;
      }
      continue;
    }
    if (ov && typeof ov === "object" && !Array.isArray(ov)) {
      result[key] = { ...(defaults[key] as any), ...(ov as any) } as any;
    } else if (ov !== undefined) {
      result[key] = ov as any;
    }
  }
  return result;
}

/**
 * Apply environment-variable overrides to config.
 * Tigris AWS_* names take precedence over S3_* names.
 */
function applyEnvOverrides(config: AgentFSConfig): AgentFSConfig {
  const env = process.env;

  // Storage backend selection. AGENT_FS_STORAGE_PROVIDER switches the backend;
  // for the local-FS variant AGENT_FS_LOCAL_ROOT points at the managed dir.
  // When local is selected we REPLACE config.s3 with the local-shaped variant
  // (so no stale S3 fields linger) and SKIP the S3_*/AWS_* block below — those
  // env vars are meaningless for a filesystem backend.
  if (env.AGENT_FS_STORAGE_PROVIDER === "local" || config.s3.provider === "local") {
    const existingRoot = isLocalStorageConfig(config.s3) ? config.s3.root : undefined;
    const root =
      env.AGENT_FS_LOCAL_ROOT || existingRoot || join(getHome(), "storage");
    config.s3 = { provider: "local", root };
  } else {
    // Not the local backend → S3 variant. `provider` is an open string so it is
    // not a usable discriminant; cast to a mutable S3-typed reference (same
    // object) for the in-place field overrides.
    const s3 = config.s3 as S3StorageConfig;
    if (env.AGENT_FS_STORAGE_PROVIDER) s3.provider = env.AGENT_FS_STORAGE_PROVIDER;

    // S3 overrides (AWS_* takes precedence over S3_*)
    if (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT)
      s3.endpoint = (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT)!;
    if (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID)
      s3.accessKeyId = (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID)!;
    if (env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY)
      s3.secretAccessKey = (env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY)!;
    if (env.BUCKET_NAME || env.S3_BUCKET)
      s3.bucket = (env.BUCKET_NAME || env.S3_BUCKET)!;
    if (env.AWS_REGION || env.S3_REGION)
      s3.region = (env.AWS_REGION || env.S3_REGION)!;
    if (env.S3_PROVIDER) s3.provider = env.S3_PROVIDER;
    if (env.S3_PUBLIC_ENDPOINT) s3.publicEndpoint = env.S3_PUBLIC_ENDPOINT;
  }

  // Server overrides (SERVER_* takes precedence over generic PORT/HOST)
  if (env.SERVER_PORT || env.PORT)
    config.server.port = parseInt((env.SERVER_PORT || env.PORT)!, 10);
  if (env.SERVER_HOST || env.HOST)
    config.server.host = (env.SERVER_HOST || env.HOST)!;

  // Embedding overrides
  if (env.EMBEDDING_PROVIDER)
    config.embedding.provider = env.EMBEDDING_PROVIDER as "local" | "openai" | "gemini";
  if (env.EMBEDDING_MODEL) config.embedding.model = env.EMBEDDING_MODEL;
  if (env.EMBEDDING_API_KEY) config.embedding.apiKey = env.EMBEDDING_API_KEY;

  // Rate limit override
  if (env.AGENT_FS_RATE_LIMIT) {
    if (!config.server.rateLimit) config.server.rateLimit = { requestsPerMinute: 1200 };
    config.server.rateLimit.requestsPerMinute = parseInt(env.AGENT_FS_RATE_LIMIT, 10);
  }

  // App URL override
  if (env.AGENT_FS_APP_URL) config.appUrl = env.AGENT_FS_APP_URL;

  return config;
}

export function getConfig(): AgentFSConfig {
  ensureHomeDir();
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<AgentFSConfig>;
  return applyEnvOverrides(deepMergeConfig(DEFAULT_CONFIG, parsed));
}

export function setConfig<K extends keyof AgentFSConfig>(
  key: K,
  value: AgentFSConfig[K]
): void {
  const config = getConfig();
  config[key] = value;
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function setConfigValue(path: string, value: unknown): void {
  const config = getConfig();
  const keys = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any = config;
  for (let i = 0; i < keys.length - 1; i++) {
    obj = obj[keys[i]] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = value;
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
