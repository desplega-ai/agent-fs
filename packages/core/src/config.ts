import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function resolveHome(): string {
  return process.env.AGENT_FS_HOME ?? join(process.env.HOME ?? "/tmp", ".agent-fs");
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
  };
  auth: {
    apiKey: string;
  };
  minio: {
    containerId: string;
    managed: boolean;
  };
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

export function getConfig(): AgentFSConfig {
  ensureHomeDir();
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<AgentFSConfig>;
  // Merge with defaults to handle missing keys from older configs
  return { ...DEFAULT_CONFIG, ...parsed };
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
