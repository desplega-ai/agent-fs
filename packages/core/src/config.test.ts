import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfig,
  setConfig,
  setConfigValue,
  getAgentFSHome,
} from "./config.js";

describe("Config system", () => {
  let originalAgentFSHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalAgentFSHome = process.env.AGENTFS_HOME;
    testHome = join(
      tmpdir(),
      `agentfs-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.AGENTFS_HOME = testHome;
  });

  afterEach(() => {
    if (originalAgentFSHome !== undefined) {
      process.env.AGENTFS_HOME = originalAgentFSHome;
    } else {
      delete process.env.AGENTFS_HOME;
    }
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
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
