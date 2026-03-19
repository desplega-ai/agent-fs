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

export interface AgentFSConfig {
  s3: {
    provider: string;
    bucket: string;
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    versioningEnabled?: boolean;
  };
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
    if (
      overrides[key] &&
      typeof overrides[key] === "object" &&
      !Array.isArray(overrides[key])
    ) {
      result[key] = { ...(defaults[key] as any), ...(overrides[key] as any) } as any;
    } else if (overrides[key] !== undefined) {
      result[key] = overrides[key] as any;
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

  // S3 overrides (AWS_* takes precedence over S3_*)
  if (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT)
    config.s3.endpoint = (env.AWS_ENDPOINT_URL_S3 || env.S3_ENDPOINT)!;
  if (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID)
    config.s3.accessKeyId = (env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID)!;
  if (env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY)
    config.s3.secretAccessKey = (env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY)!;
  if (env.BUCKET_NAME || env.S3_BUCKET)
    config.s3.bucket = (env.BUCKET_NAME || env.S3_BUCKET)!;
  if (env.AWS_REGION || env.S3_REGION)
    config.s3.region = (env.AWS_REGION || env.S3_REGION)!;
  if (env.S3_PROVIDER) config.s3.provider = env.S3_PROVIDER;

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
