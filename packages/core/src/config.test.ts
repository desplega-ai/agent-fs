import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getConfig,
  setConfig,
  setConfigValue,
  getAgentFSHome,
} from "./config.js";
import { createTestConfigDir } from "./test-utils.js";

describe("Config system", () => {
  let testHome: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir: testHome, cleanup } = createTestConfigDir());
  });

  afterEach(() => {
    cleanup();
  });

  test("getAgentFSHome returns AGENTFS_HOME when set", () => {
    const home = getAgentFSHome();
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
