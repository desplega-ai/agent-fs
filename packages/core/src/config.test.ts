import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getConfig,
  setConfig,
  setConfigValue,
  getHome,
} from "./config.js";
import { createTestConfigDir } from "./test-utils.js";

/**
 * All env vars that applyEnvOverrides reads.
 * We save and clear these before each test to prevent .env leakage.
 */
const OVERRIDE_ENV_VARS = [
  "AWS_ENDPOINT_URL_S3",
  "S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "S3_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_SECRET_ACCESS_KEY",
  "BUCKET_NAME",
  "S3_BUCKET",
  "AWS_REGION",
  "S3_REGION",
  "S3_PROVIDER",
  "SERVER_PORT",
  "SERVER_HOST",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_API_KEY",
  "AUTH_API_KEY", // used in one test to verify it's NOT read
];

/**
 * Save current values and neutralize them in process.env.
 * We set to "" rather than delete because Bun auto-loads .env
 * and `delete process.env[key]` may not stick for .env-sourced vars.
 * The applyEnvOverrides function uses truthiness checks, so "" is safe.
 */
function clearOverrideEnvVars(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of OVERRIDE_ENV_VARS) {
    saved[key] = process.env[key];
    process.env[key] = "";
  }
  return saved;
}

/** Restore previously saved env vars */
function restoreEnvVars(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      process.env[key] = "";
    }
  }
}

describe("Config system", () => {
  let testHome: string;
  let cleanup: () => void;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = clearOverrideEnvVars();
    ({ dir: testHome, cleanup } = createTestConfigDir());
  });

  afterEach(() => {
    cleanup();
    restoreEnvVars(savedEnv);
  });

  test("getHome returns AGENT_FS_HOME when set", () => {
    const home = getHome();
    expect(home).toBe(testHome);
  });

  test("getConfig creates directory and config.json with defaults", () => {
    const config = getConfig();

    expect(config.s3.bucket).toBe("agentfs");
    expect(config.s3.endpoint).toBe("http://localhost:9000");
    expect(config.server.port).toBe(7433);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.embedding.provider).toBe("local");
    expect(config.minio.managed).toBe(true);

    const configPath = join(testHome, "config.json");
    expect(existsSync(configPath)).toBe(true);
  });

  test("setConfig persists section-level changes", () => {
    getConfig(); // initialize

    setConfig("server", { port: 8080, host: "0.0.0.0" });

    const configPath = join(testHome, "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.server.port).toBe(8080);
    expect(raw.server.host).toBe("0.0.0.0");
    expect(raw.s3.bucket).toBe("agentfs");
  });

  test("setConfigValue sets dot-path nested values", () => {
    getConfig();
    setConfigValue("s3.bucket", "custom-bucket");

    const configPath = join(testHome, "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(raw.s3.bucket).toBe("custom-bucket");
    expect(raw.s3.endpoint).toBe("http://localhost:9000");
  });
});

describe("Deep merge config", () => {
  let testHome: string;
  let cleanup: () => void;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = clearOverrideEnvVars();
    ({ dir: testHome, cleanup } = createTestConfigDir());
  });

  afterEach(() => {
    cleanup();
    restoreEnvVars(savedEnv);
  });

  test("deep merge preserves nested defaults when config.json has partial objects", () => {
    // Write a config.json with only server.port set (no host, cors, rateLimit)
    const configPath = join(testHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ server: { port: 9999 } }, null, 2)
    );

    const config = getConfig();

    // Overridden value
    expect(config.server.port).toBe(9999);
    // Preserved nested defaults
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.cors).toEqual({ origins: ["*"] });
    expect(config.server.rateLimit).toEqual({ requestsPerMinute: 1200 });
    // Other sections untouched
    expect(config.s3.bucket).toBe("agentfs");
    expect(config.s3.provider).toBe("minio");
    expect(config.embedding.provider).toBe("local");
  });

  test("deep merge preserves s3 defaults when config.json only sets bucket", () => {
    const configPath = join(testHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ s3: { bucket: "my-bucket" } }, null, 2)
    );

    const config = getConfig();

    expect(config.s3.bucket).toBe("my-bucket");
    expect(config.s3.provider).toBe("minio");
    expect(config.s3.region).toBe("us-east-1");
    expect(config.s3.endpoint).toBe("http://localhost:9000");
  });
});

describe("Env var overrides", () => {
  let testHome: string;
  let cleanup: () => void;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = clearOverrideEnvVars();
    ({ dir: testHome, cleanup } = createTestConfigDir());
  });

  afterEach(() => {
    cleanup();
    restoreEnvVars(savedEnv);
  });

  test("S3_* env vars override config.json values", () => {
    process.env.S3_ENDPOINT = "https://s3.example.com";
    process.env.S3_ACCESS_KEY_ID = "my-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "my-secret-key";
    process.env.S3_BUCKET = "env-bucket";
    process.env.S3_REGION = "eu-west-1";
    process.env.S3_PROVIDER = "tigris";

    const config = getConfig();

    expect(config.s3.endpoint).toBe("https://s3.example.com");
    expect(config.s3.accessKeyId).toBe("my-access-key");
    expect(config.s3.secretAccessKey).toBe("my-secret-key");
    expect(config.s3.bucket).toBe("env-bucket");
    expect(config.s3.region).toBe("eu-west-1");
    expect(config.s3.provider).toBe("tigris");
  });

  test("Tigris AWS_* vars take precedence over S3_* vars", () => {
    // Set both AWS_* and S3_* — AWS_* should win
    process.env.AWS_ENDPOINT_URL_S3 = "https://tigris.example.com";
    process.env.S3_ENDPOINT = "https://s3-fallback.example.com";

    process.env.AWS_ACCESS_KEY_ID = "tigris-access-key";
    process.env.S3_ACCESS_KEY_ID = "s3-access-key";

    process.env.AWS_SECRET_ACCESS_KEY = "tigris-secret-key";
    process.env.S3_SECRET_ACCESS_KEY = "s3-secret-key";

    process.env.BUCKET_NAME = "tigris-bucket";
    process.env.S3_BUCKET = "s3-bucket";

    process.env.AWS_REGION = "auto";
    process.env.S3_REGION = "us-west-2";

    const config = getConfig();

    expect(config.s3.endpoint).toBe("https://tigris.example.com");
    expect(config.s3.accessKeyId).toBe("tigris-access-key");
    expect(config.s3.secretAccessKey).toBe("tigris-secret-key");
    expect(config.s3.bucket).toBe("tigris-bucket");
    expect(config.s3.region).toBe("auto");
  });

  test("SERVER_PORT is parsed as integer", () => {
    process.env.SERVER_PORT = "8080";

    const config = getConfig();

    expect(config.server.port).toBe(8080);
    expect(typeof config.server.port).toBe("number");
  });

  test("server and embedding env vars override config", () => {
    process.env.SERVER_PORT = "3000";
    process.env.SERVER_HOST = "0.0.0.0";
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.EMBEDDING_API_KEY = "sk-test-key";

    const config = getConfig();

    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.embedding.provider).toBe("openai");
    expect(config.embedding.model).toBe("text-embedding-3-small");
    expect(config.embedding.apiKey).toBe("sk-test-key");
  });

  test("env vars override defaults when no config.json exists", () => {
    process.env.S3_BUCKET = "env-only-bucket";
    process.env.SERVER_PORT = "5555";
    process.env.EMBEDDING_PROVIDER = "gemini";

    const config = getConfig();

    expect(config.s3.bucket).toBe("env-only-bucket");
    expect(config.server.port).toBe(5555);
    expect(config.embedding.provider).toBe("gemini");
    // Other defaults still intact
    expect(config.s3.endpoint).toBe("http://localhost:9000");
    expect(config.server.host).toBe("127.0.0.1");
  });

  test("env vars override config.json values (config.json exists with custom values)", () => {
    // Write a config.json with some values
    const configPath = join(testHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          s3: { bucket: "json-bucket", endpoint: "http://json-endpoint:9000" },
          server: { port: 7000 },
        },
        null,
        2
      )
    );

    // Env overrides should win over config.json
    process.env.S3_BUCKET = "env-wins-bucket";
    process.env.SERVER_PORT = "8888";

    const config = getConfig();

    expect(config.s3.bucket).toBe("env-wins-bucket");
    expect(config.s3.endpoint).toBe("http://json-endpoint:9000"); // not overridden by env
    expect(config.server.port).toBe(8888);
  });

  test("auth.apiKey is NOT overridable via env vars", () => {
    // Set a config with an auth apiKey
    const configPath = join(testHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ auth: { apiKey: "original-key" } }, null, 2)
    );

    // There's no AUTH_API_KEY env var support — verify the key stays as-is
    process.env.AUTH_API_KEY = "hacked-key";

    const config = getConfig();

    expect(config.auth.apiKey).toBe("original-key");
  });
});
